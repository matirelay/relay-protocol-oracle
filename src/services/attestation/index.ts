import {
  ActionType,
  decodeWithdrawal,
  DepositoryDepositMessage,
  DepositoryWithdrawalMessage,
  DepositoryWithdrawalStatus,
  encodeAction,
  ExecutionMessage,
  getDecodedWithdrawalAmount,
  getOrderId,
  Order,
  SolverFillMessage,
  SolverFillStatus,
  SolverRefundMessage,
  SolverRefundStatus,
  getOrderAddress,
  ExecutionMessageMetadata,
  getVmTypeNativeCurrency,
  generateTokenId,
  generateAddress,
  getWithdrawalAddress,
  GenericMappingMessage,
  getNoFillOrRefundMessage,
  getNonceMappingMessage,
  encodeWithdrawal,
  getWithdrawRequestHash,
  DenormalizedWithdrawRequest,
  normalizeWithdrawRequest,
  encodeWithdrawRequestAdditionalData,
  WithdrawRequestAdditionalData,
  WithdrawRequest,
  DepositAddressTrigger,
  getDepositAddressTriggerHash,
  encodeAddress,
  encodeAddressToHex,
  ExecuteAndWithdrawFee,
  ExecuteAndWithdrawRequest,
  VmType,
} from "@relay-protocol/settlement-sdk";
import * as bitcoin from "bitcoinjs-lib";
import {
  Address,
  decodeAbiParameters,
  getContract,
  Hex,
  parseAbi,
  verifyMessage,
  verifyTypedData,
  zeroAddress,
  zeroHash,
} from "viem";

import { getVmAttestor } from "./vm";
import { DepositMode, EnhancedDepositoryDepositMessage } from "./vm/types";
import { FeeCommitment, resolveFastMintFee } from "./fee-commitment";
import { getDeterministicId, resolveRateLimiter } from "./utils";
import {
  Chain,
  getChain,
  getChainVmType,
  getGatewayDestination,
  getGatewaySource,
  getHubInfo,
  getSdkChainsConfig,
  RELAY_CHAIN_ID,
} from "../../common/chains";
import { externalError, internalError } from "../../common/error";
import {
  getBalanceOnHub,
  getHubBatchHttpRpc,
  getHubHttpRpc,
} from "../../common/hub";
import { logger } from "../../common/logger";
import { GatewayVmAttestor } from "./vm/gateway-vm";

type ExecutionMetadata = Omit<
  ExecutionMessageMetadata,
  "oracleContract" | "oracleChainId"
>;

type DepositHubContext = {
  chain: Chain;
  gatewaySource?: Awaited<ReturnType<typeof getGatewaySource>>;
  tokenChainId: string;
  tokenVmType: VmType;
  addressChainId: string;
  addressVmType: VmType;
};

type WithdrawalAddressRequest = {
  chainId: string;
  depository?: string;
  currency: string;
  withdrawer: string;
  withdrawerChainId: string;
  recipient: string;
  withdrawalNonce: string;
};

export type TxHints = {
  "hyperliquid-vm"?: {
    user: string;
    timestamp: number;
  };
  "ton-vm"?: {
    // Solver wallet — required for fill/refund (TON has no global tx-hash
    // lookup). Unused for deposit (account = chain.depository).
    solverAddress?: string;
    // Tx logical time — required for deposit (direct lookup only, no scan
    // fallback on high-throughput depositories). Optional for fill/refund
    // (enables O(1) lookup vs scan-window fallback).
    lt?: string;
  };
};

// Per-input deposit hints, parallel to the fill-tx `hints` field.
export type InputHints = Array<
  { inputIndex: number } & Pick<TxHints, "ton-vm">
>;

export type WithdrawRequestAttestationContext = {
  chainId: number;
  allocator: string;
  withdrawRequestHash: string;
};

export type WithdrawRequestAttestationMessage =
  WithdrawRequestAttestationContext & {
    hashesToSign: string[];
  };

const getInputHints = (
  inputIndex: number,
  inputHints: InputHints | undefined,
): TxHints | undefined => {
  const entry = inputHints?.find((h) => h.inputIndex === inputIndex);
  if (!entry) {
    return undefined;
  }
  const { inputIndex: _idx, ...rest } = entry;
  return rest;
};

const findEquivalentAddress = (
  address: string,
  candidates: string[],
  vmType: Chain["vmType"],
) => {
  try {
    const encodedAddress = encodeAddressToHex(address, vmType);
    return candidates.find(
      (candidate) => encodeAddressToHex(candidate, vmType) === encodedAddress,
    );
  } catch {
    return undefined;
  }
};

export class AttestationService {
  private async _getDepositHubContext(data: {
    chainId: string;
  }): Promise<DepositHubContext> {
    const chain = await getChain(data.chainId);
    const gatewaySource =
      chain.vmType === "gateway-vm" ? await getGatewaySource(chain) : undefined;

    const physicalChain = gatewaySource?.chain ?? chain;

    // Handle Gateway chains by separating token identity from address identity:
    // Gateway tokens are identified by the Gateway chain, while account/order
    // addresses are derived from the physical source chain where the deposit
    // transaction was submitted.
    return {
      chain,
      gatewaySource,
      tokenChainId: chain.id,
      tokenVmType: physicalChain.vmType,
      addressChainId: physicalChain.id,
      addressVmType: physicalChain.vmType,
    };
  }

  public async attestWithdrawAndFill(
    data: {
      chainId: string;
      transactionId: string;
      mode?: DepositMode;
      feeCommitment?: FeeCommitment;
      onchainId: string;
      inputCurrency?: string;
      order: Order;
      orderSignature: string;
      nonce: string;
      additionalData?: WithdrawRequestAdditionalData;
      useGatewaySource?: string;
    } & { hints?: TxHints },
  ): Promise<{
    execution: ExecutionMessage;
    executeAndWithdrawRequest: ExecuteAndWithdrawRequest;
  }> {
    if (data.order.output.calls.length !== 0) {
      throw externalError("Fill orders with calls are not supported");
    }

    const attested = await this._attestExecuteAndWithdrawDeposit(data);

    const executeAndWithdrawRequest =
      await this._getExecuteAndWithdrawFillRequest({
        attested,
        nonce: data.nonce,
        additionalData: data.additionalData,
        useGatewaySource: data.useGatewaySource,
      });

    return {
      execution: attested.execution,
      executeAndWithdrawRequest,
    };
  }

  public async attestWithdrawAndRefund(
    data: {
      chainId: string;
      transactionId: string;
      mode?: DepositMode;
      feeCommitment?: FeeCommitment;
      onchainId: string;
      inputCurrency?: string;
      refundIndex?: number;
      order: Order;
      orderSignature: string;
      nonce: string;
      additionalData?: WithdrawRequestAdditionalData;
      useGatewaySource?: string;
    } & { hints?: TxHints },
  ): Promise<{
    execution: ExecutionMessage;
    executeAndWithdrawRequest: ExecuteAndWithdrawRequest;
  }> {
    const attested = await this._attestExecuteAndWithdrawDeposit(data);

    const executeAndWithdrawRequest =
      await this._getExecuteAndWithdrawRefundRequest({
        attested,
        refundIndex: data.refundIndex,
        nonce: data.nonce,
        additionalData: data.additionalData,
        useGatewaySource: data.useGatewaySource,
      });

    return {
      execution: attested.execution,
      executeAndWithdrawRequest,
    };
  }

  // Shared validation for the solver withdraw-and-{fill,refund} flows: verifies
  // the order signature, attests the depository deposit, links it to the order,
  // resolves the currency to pull from the order address and validates the
  // order output (fill) and refund (refund) targets. Returns the Hub execution,
  // matched deposit and derived input/output/refund data.
  private async _attestExecuteAndWithdrawDeposit(
    data: {
      chainId: string;
      transactionId: string;
      mode?: DepositMode;
      feeCommitment?: FeeCommitment;
      onchainId: string;
      inputCurrency?: string;
      order: Order;
      orderSignature: string;
      nonce: string;
      useGatewaySource?: string;
    } & { hints?: TxHints },
  ): Promise<{
    execution: ExecutionMessage;
    deposit: EnhancedDepositoryDepositMessage;
    orderAddress: string;
    inCurrency: string;
    output: {
      chainId: string;
      currency: string;
      minimumAmount: string;
      recipient: string;
      deadline: number;
      fees: ExecuteAndWithdrawFee[];
    };
    // Every refund option the solver signed, left unresolved here — only the
    // refund flow picks one, and only it accepts a caller refund currency
    refunds: {
      chainId: string;
      currency: string;
      minimumAmount: string;
      recipient: string;
      deadline: number;
      fees: ExecuteAndWithdrawFee[];
    }[];
  }> {
    // Get the order id
    const orderId = getOrderId(data.order, await getSdkChainsConfig());

    // Verify the order signature
    const isSignatureValid = await verifyMessage({
      address: data.order.solver as Address,
      message: {
        raw: orderId,
      },
      signature: data.orderSignature as Hex,
    }).catch(() => false);
    if (!isSignatureValid) {
      throw externalError("Invalid order signature");
    }

    const depositoryDepositMessages = await this.attestDepositoryDeposits(data);
    if (!depositoryDepositMessages.execution) {
      throw externalError("No depository-deposit messages attested");
    }

    // Validate the deposit against the order
    const deposit = depositoryDepositMessages.messages.find(
      (d) => d.result.onchainId === data.onchainId,
    );
    if (!deposit) {
      throw externalError("Could not find corresponding deposit");
    }
    if (deposit.result.depositId !== orderId) {
      throw externalError("Deposit does not reference order id");
    }

    // Only single-input orders are allowed
    if (data.order.inputs.length !== 1) {
      throw externalError("Only single-input orders are allowed");
    }

    // Validate the order input against the deposit
    const orderInput = data.order.inputs[0];
    if (BigInt(orderInput.payment.weight) !== 1n) {
      throw externalError("Wrong weight for order input");
    }
    if (deposit.data.chainId !== orderInput.payment.chainId) {
      throw externalError(
        "Deposit chain id does not match order input chain id",
      );
    }

    const orderOutput = data.order.output;

    // Only single-output payment orders are allowed
    if (data.order.output.payments.length !== 1) {
      throw externalError("Only single-output payment orders are allowed");
    }

    const orderOutputPayment = orderOutput.payments[0];

    const inChain = await getChain(deposit.data.chainId);
    const orderAddress = await this._getOrderAddress({
      chainId: inChain.id,
      vmType: inChain.vmType,
      timestamp: deposit.extraData.timestamp,
      depositor: deposit.result.depositor,
      depositId: deposit.result.depositId,
    });

    // Compare currencies through the input VM's encoding so that the same
    // token written in different notations (casing, formatting) matches
    const encodeInCurrency = (currency: string) =>
      encodeAddressToHex(currency, inChain.vmType);

    // The currency pulled from the order address. Defaults to what was
    // deposited, which is the only option until the order's fees are charged.
    const inCurrency = encodeInCurrency(
      data.inputCurrency ?? deposit.result.currency,
    );

    // `RelayExecutor` charges the order's fees out of the pulled funds, but
    // only on the first execution. Until that happens the deposit, the order's
    // declared input payment and every fee must all be denominated in the
    // currency being pulled. Afterwards none of them constrain the pull.
    const feesCharged =
      await this._getExecuteAndWithdrawFeesCharged(orderAddress);
    if (!feesCharged) {
      if (encodeInCurrency(deposit.result.currency) !== inCurrency) {
        throw externalError(
          "Input currency must match the deposit currency until order fees are charged",
        );
      }
      if (encodeInCurrency(orderInput.payment.currency) !== inCurrency) {
        throw externalError(
          "Deposit currency does not match order input currency",
        );
      }
      for (const fee of data.order.fees) {
        if (
          fee.currencyChainId !== deposit.data.chainId ||
          encodeInCurrency(fee.currency) !== inCurrency
        ) {
          throw externalError("Fee currency must match the input currency");
        }
      }
    }

    // The fees are structured as follows:
    // - fees[0]: fill gas fee
    // - fees[1]: refund gas fee
    // - fees[2:]: additional fill fees
    // Once charged they cannot be charged again, so leave them out entirely
    // rather than signing over amounts that no longer apply.
    const allFees = feesCharged
      ? []
      : await this._getExecuteAndWithdrawFees(data.order);
    const outputFees: ExecuteAndWithdrawFee[] = [];
    const refundFees: ExecuteAndWithdrawFee[] = [];
    allFees.forEach((fee, index) => {
      if (index === 1) {
        refundFees.push(fee);
      } else {
        outputFees.push(fee);
      }
    });

    return {
      execution: depositoryDepositMessages.execution,
      deposit: deposit as EnhancedDepositoryDepositMessage,
      orderAddress,
      inCurrency,
      output: {
        chainId: orderOutput.chainId,
        currency: orderOutputPayment.currency,
        minimumAmount: orderOutputPayment.minimumAmount,
        recipient: orderOutputPayment.recipient,
        deadline: orderOutput.deadline,
        fees: outputFees,
      },
      refunds: orderInput.refunds.map((refund) => ({
        chainId: refund.chainId,
        currency: refund.currency,
        minimumAmount: refund.minimumAmount,
        recipient: refund.recipient,
        deadline: refund.deadline,
        fees: refundFees,
      })),
    };
  }

  public async attestDepositoryDeposits(
    data: DepositoryDepositMessage["data"] & {
      hints?: TxHints;
      mode?: DepositMode;
      feeCommitment?: FeeCommitment;
    },
  ): Promise<{
    messages: EnhancedDepositoryDepositMessage[];
    execution?: ExecutionMessage;
  }> {
    const mode = data.mode ?? "slow";

    const attestor = await getVmAttestor(data.chainId);
    const depositHubContext = await this._getDepositHubContext(data);
    const { chain, gatewaySource } = depositHubContext;

    const messages = await attestor.getDepositoryDepositMessages(
      data.chainId,
      data.transactionId,
      data.hints,
      { mode },
    );

    // Generate Hub execution
    let execution: ExecutionMessage | undefined;
    if (messages.length) {
      const fastMode = (gatewaySource?.chain ?? chain).additionalData?.fastMode;

      const hubInfo = await getHubInfo();

      // Fast messages share the requester's fee commitment and the rate-limiter
      // budget, so both are checked once per transaction rather than per message
      const fastMessages = messages
        .filter((m) => m.extraData.mode === "fast")
        .map((m) => ({
          tokenId: generateTokenId({
            address: m.result.currency,
            chainId: depositHubContext.tokenChainId,
            family: depositHubContext.tokenVmType,
          }),
          amount: BigInt(m.result.amount),
          feeBps: m.extraData.fastFeeBps ?? "0",
        }));
      let fastContext:
        | {
            rateLimiter: string;
            rateLimiterData: string;
            feeCalculator: string;
            feeCalculatorData: string;
          }
        | undefined;
      if (fastMessages.length) {
        const rateLimiter = hubInfo.rateLimiter;
        if (!rateLimiter) {
          throw internalError("Missing fast mode rate-limiter configuration");
        }

        const { withinBudget, rateLimiterData } = await resolveRateLimiter({
          type: rateLimiter.type,
          address: rateLimiter.address,
          // The chain whose fastMode configuration authorized the fast path
          chainId: (gatewaySource?.chain ?? chain).id,
          entries: fastMessages,
        });
        if (!withinBudget) {
          throw externalError("Fast mode rate limit exceeded");
        }

        fastContext = {
          rateLimiter: rateLimiter.address,
          rateLimiterData,
          ...(await resolveFastMintFee({
            fastMessages,
            fastMode,
            feeCalculator: hubInfo.feeCalculator,
            chainId: data.chainId,
            transactionId: data.transactionId,
            commitment: data.feeCommitment,
          })),
        };
      }

      const messageEntries = await Promise.all(
        messages.map(async (m) => {
          const hubTokenId = generateTokenId({
            address: m.result.currency,
            chainId: depositHubContext.tokenChainId,
            family: depositHubContext.tokenVmType,
          });

          const metadataEntry: ExecutionMetadata = {
            hubTokenId,
            origin: {
              address: m.result.currency,
              chainId: depositHubContext.tokenChainId,
              family: depositHubContext.tokenVmType,
            },
          };

          const hubToAddress =
            m.result.depositId !== zeroHash
              ? await this._getOrderAddress({
                  chainId: depositHubContext.addressChainId,
                  vmType: depositHubContext.addressVmType,
                  timestamp: m.extraData.timestamp,
                  depositor: m.result.depositor,
                  depositId: m.result.depositId,
                })
              : // In case no deposit id is attached, use the depositor alias on the hub
                generateAddress({
                  address: m.result.depositor,
                  chainId: depositHubContext.addressChainId,
                  family: depositHubContext.addressVmType,
                });

          const amount = m.result.amount;

          let action: string;
          if (m.extraData.mode === "fast") {
            if (!fastContext) {
              throw internalError("Missing fast attestation context");
            }
            // Fee-free fast deposits skip fee calculation entirely (zero address)
            const hasFee = BigInt(m.extraData.fastFeeBps ?? "0") > 0n;

            action = encodeAction({
              type: ActionType.FAST_MINT,
              data: {
                hubTokenId,
                hubToAddress,
                amount,
                feeCalculator: hasFee ? fastContext.feeCalculator : zeroAddress,
                feeCalculatorData: hasFee
                  ? fastContext.feeCalculatorData
                  : "0x",
                rateLimiter: fastContext.rateLimiter,
                rateLimiterData: fastContext.rateLimiterData,
              },
            });
          } else {
            action = encodeAction({
              type: ActionType.MINT,
              data: {
                hubTokenId,
                hubToAddress,
                amount,
              },
            });
          }

          return { action, metadataEntry };
        }),
      );

      // Map in messages order (Promise.all preserves it) so the signed bytes[] is peer-deterministic.
      const actions = messageEntries.map((p) => p.action);
      const metadata = messageEntries.map((p) => p.metadataEntry);

      execution = {
        idempotencyKey: getDeterministicId(data.chainId, data.transactionId),
        actions,
        metadata: metadata.map((md) => ({
          ...md,
          oracleChainId: hubInfo.evmChainId,
          oracleContract: hubInfo.oracleAddress as Address,
        })),
      };
    }

    return {
      messages,
      execution,
    };
  }

  public async attestTransfer(data: {
    chainId: string;
    currency: string;
    amount: string;
    from: string;
    to: string;
    nonce: string;
  }): Promise<{
    execution: ExecutionMessage;
  }> {
    // Ensure the amount is non-zero
    if (BigInt(data.amount) <= 0) {
      throw externalError("Transfer amount must be non-zero");
    }

    const hubContext = await this._getDepositHubContext({
      chainId: data.chainId,
    });

    // The hub token being transferred
    const hubTokenId = generateTokenId({
      address: data.currency,
      chainId: hubContext.tokenChainId,
      family: hubContext.tokenVmType,
    });

    // Safety check to ensure the alias has sufficient balance
    const balance = await getBalanceOnHub(data.from, hubTokenId);
    if (!balance || BigInt(balance) < BigInt(data.amount)) {
      throw externalError("Insufficient balance for requested transfer");
    }

    const hubInfo = await getHubInfo();
    const execution: ExecutionMessage = {
      idempotencyKey: getDeterministicId(
        hubInfo.id,
        hubTokenId.toString(),
        data.from,
        data.to,
        data.nonce,
      ),
      actions: [
        encodeAction({
          type: ActionType.TRANSFER,
          data: {
            hubTokenId,
            hubFromAddress: data.from,
            hubToAddress: data.to,
            amount: data.amount,
          },
        }),
      ],
    };

    return {
      execution,
    };
  }

  public async attestDepositoryWithdrawal(
    data: DepositoryWithdrawalMessage["data"] & {
      transactionId?: string;
      hints?: TxHints;
      withdrawalAddressRequest: WithdrawalAddressRequest;
    },
  ): Promise<{
    message: DepositoryWithdrawalMessage;
    execution?: ExecutionMessage;
  }> {
    const message = await getVmAttestor(data.chainId).then((attestor) =>
      attestor.getDepositoryWithdrawalMessage(
        data.chainId,
        data.withdrawal,
        data.transactionId,
        data.hints,
      ),
    );

    // Generate onchain hub execution
    const { withdrawalAddress, hubTokenId, withdrawerAlias } =
      await this._getWithdrawalAddress(data.withdrawalAddressRequest);

    const decodedWithdrawal = decodeWithdrawal(
      data.withdrawal,
      await getChainVmType(data.chainId),
    );
    const amount = getDecodedWithdrawalAmount(decodedWithdrawal);

    let execution: ExecutionMessage | undefined;
    if (message.result.status === DepositoryWithdrawalStatus.EXECUTED) {
      // Burn the funds from withdrawal address
      execution = {
        idempotencyKey: getDeterministicId(
          message.result.withdrawalId,
          data.transactionId!,
        ),
        actions: [
          encodeAction({
            type: ActionType.BURN,
            data: {
              hubTokenId,
              hubFromAddress: withdrawalAddress,
              amount,
            },
          }),
        ],
      };
    } else if (message.result.status === DepositoryWithdrawalStatus.EXPIRED) {
      // Transfer back the funds from withdrawal address to depositor
      execution = {
        idempotencyKey: getDeterministicId(
          message.result.withdrawalId,
          data.transactionId!,
          DepositoryWithdrawalStatus.EXPIRED.toString(),
        ),
        actions: [
          encodeAction({
            type: ActionType.TRANSFER,
            data: {
              hubTokenId,
              hubFromAddress: withdrawalAddress,
              hubToAddress: withdrawerAlias,
              amount,
            },
          }),
        ],
      };
    }

    return {
      message,
      execution,
    };
  }

  public async attestDepositoryWithdrawalV3(
    data: DenormalizedWithdrawRequest & {
      transactionId?: string;
      hints?: TxHints;
    },
  ): Promise<{
    status: DepositoryWithdrawalStatus;
    execution?: ExecutionMessage;
  }> {
    const chain = await getChain(data.chainId);
    const depository = await this._getConfiguredDepository(
      chain,
      data.depository,
    );

    const withdrawRequest = normalizeWithdrawRequest({
      ...data,
      depository,
      vmType: await getChainVmType(data.chainId),
      spenderVmType: await getChainVmType(data.spenderChainId),
    });

    const message = await getVmAttestor(withdrawRequest.chainId).then(
      async (attestor) =>
        attestor.getDepositoryWithdrawalMessage(
          withdrawRequest.chainId,
          await this._getEncodedWithdrawalV3(withdrawRequest),
          data.transactionId,
          data.hints,
        ),
    );

    let execution: ExecutionMessage | undefined;
    if (message.result.status === DepositoryWithdrawalStatus.EXPIRED) {
      const withdrawRequestHash = getWithdrawRequestHash(withdrawRequest);
      const hubContext = await this._getDepositHubContext({
        chainId: withdrawRequest.chainId,
      });

      const hubTokenId = generateTokenId({
        address: data.currency,
        chainId: hubContext.tokenChainId,
        family: hubContext.tokenVmType,
      });

      const spenderAlias = generateAddress({
        address: data.spender,
        chainId: withdrawRequest.spenderChainId,
        family: await getChainVmType(withdrawRequest.spenderChainId),
      });
      const hubInfo = await getHubInfo();
      const executorAlias = generateAddress({
        address: hubInfo.executorAddress,
        chainId: RELAY_CHAIN_ID,
        family: await getChainVmType(RELAY_CHAIN_ID),
      });

      let hubToAddress = spenderAlias;
      if (spenderAlias.toLowerCase() === executorAlias.toLowerCase()) {
        const executor = getContract({
          address: hubInfo.executorAddress as Address,
          abi: parseAbi([
            "function orderAddressByWithdrawRequestHash(bytes32 withdrawRequestHash) view returns (address)",
          ]),
          client: await getHubHttpRpc(),
        });
        const orderAddress =
          await executor.read.orderAddressByWithdrawRequestHash([
            withdrawRequestHash as Hex,
          ]);
        if (orderAddress === zeroAddress) {
          throw externalError("Withdrawal has no corresponding order address");
        }

        hubToAddress = orderAddress;
      }

      // Mint back the funds to the spender
      execution = {
        idempotencyKey: getDeterministicId(
          withdrawRequestHash,
          DepositoryWithdrawalStatus.EXPIRED.toString(),
        ),
        actions: [
          encodeAction({
            type: ActionType.MINT,
            data: {
              hubTokenId,
              hubToAddress,
              amount: withdrawRequest.amount,
            },
          }),
        ],
      };
    }

    return {
      status: message.result.status,
      execution,
    };
  }

  public async attestSolverFill(
    data: SolverFillMessage["data"] & {
      hints?: TxHints;
      inputHints?: InputHints;
      force?: boolean;
    },
  ): Promise<{ message: SolverFillMessage; execution?: ExecutionMessage }> {
    const orderId = getOrderId(data.order, await getSdkChainsConfig());
    if (data.force) {
      const depositoryDeposits: EnhancedDepositoryDepositMessage[] = [];
      for (const input of data.inputs) {
        const chainId =
          (input as any).chainId ??
          data.order.inputs[input.inputIndex].payment.chainId;
        depositoryDeposits.push(
          ...(await getVmAttestor(chainId)
            .then((attestor) =>
              attestor.getDepositoryDepositMessages(
                chainId,
                input.transactionId,
                getInputHints(input.inputIndex, data.inputHints),
              ),
            )
            .then((deposits) =>
              deposits.filter((d) => d.result.depositId === orderId),
            )),
        );
      }

      const execution = await this._getSolverFillOrRefundExecution({
        order: data.order,
        depositoryDeposits,
        totalWeightedInputPaymentBpsDiff: 0n,
        type: "fill",
      });

      return {
        message: {
          data,
          result: {
            orderId,
            status: SolverFillStatus.SUCCESSFUL,
            totalWeightedInputPaymentBpsDiff: "0",
          },
        },
        execution,
      };
    }

    const { totalWeightedInputPaymentBpsDiff, depositoryDeposits } =
      await this._getDepositsDetails(data);

    // Verify the fill
    for (
      let outputPaymentIndex = 0;
      outputPaymentIndex < data.order.output.payments.length;
      outputPaymentIndex++
    ) {
      const payment = data.order.output.payments[outputPaymentIndex];

      const attestor = await getVmAttestor(data.order.output.chainId);
      const paidAmount = await attestor.getSolverPaidAmount(
        data.order.output.chainId,
        data.fill.transactionId,
        {
          currency: payment.currency,
          recipient: payment.recipient,
          orderId,
          extraData: data.order.output.extraData,
          deadline: data.order.output.deadline,
        },
        data.hints,
      );

      const minimumAmount = BigInt(payment.minimumAmount);
      if (paidAmount < minimumAmount) {
        throw externalError(
          `Insufficient fill amount for order output payment ${outputPaymentIndex} (paidAmount=${paidAmount}, minimumAmount=${minimumAmount})`,
        );
      }
    }

    // Verify any calls to be executed
    if (data.order.output.calls.length) {
      const attestor = await getVmAttestor(data.order.output.chainId);

      if (
        !(await attestor.verifySolverCalls(
          data.order.output.chainId,
          data.fill.transactionId,
          data.order.output.calls,
          data.order.output.extraData,
        ))
      ) {
        throw externalError(`Missing call executions`);
      }
    }

    return {
      message: {
        data,
        result: {
          orderId: getOrderId(data.order, await getSdkChainsConfig()),
          status: SolverFillStatus.SUCCESSFUL,
          totalWeightedInputPaymentBpsDiff:
            totalWeightedInputPaymentBpsDiff.toString(),
        },
      },
      execution: await this._getSolverFillOrRefundExecution({
        order: data.order,
        totalWeightedInputPaymentBpsDiff,
        depositoryDeposits,
        type: "fill",
      }),
    };
  }

  public async attestSolverRefund(
    data: SolverRefundMessage["data"] & {
      hints?: TxHints;
      inputHints?: InputHints;
      force?: boolean;
    },
  ): Promise<{ message: SolverRefundMessage; execution?: ExecutionMessage }> {
    const orderId = getOrderId(data.order, await getSdkChainsConfig());
    if (data.force) {
      const depositoryDeposits: EnhancedDepositoryDepositMessage[] = [];
      for (const input of data.inputs) {
        const chainId =
          (input as any).chainId ??
          data.order.inputs[input.inputIndex].payment.chainId;
        depositoryDeposits.push(
          ...(await getVmAttestor(chainId)
            .then((attestor) =>
              attestor.getDepositoryDepositMessages(
                chainId,
                input.transactionId,
                getInputHints(input.inputIndex, data.inputHints),
              ),
            )
            .then((deposits) =>
              deposits.filter((d) => d.result.depositId === orderId),
            )),
        );
      }

      const execution = await this._getSolverFillOrRefundExecution({
        order: data.order,
        depositoryDeposits,
        totalWeightedInputPaymentBpsDiff: 0n,
        type: "refund",
      });

      return {
        message: {
          data,
          result: {
            orderId,
            status: SolverRefundStatus.SUCCESSFUL,
            totalWeightedInputPaymentBpsDiff: "0",
          },
        },
        execution,
      };
    }

    const { totalWeightedInputPaymentBpsDiff, depositoryDeposits } =
      await this._getDepositsDetails(data);

    // Verify the refunds
    for (
      let inputPaymentIndex = 0;
      inputPaymentIndex < data.order.inputs.length;
      inputPaymentIndex++
    ) {
      // Get the refund information corresponding to the current input payment
      const refundInformation = data.refunds.find(
        ({ inputIndex }) => inputIndex === inputPaymentIndex,
      );
      if (!refundInformation) {
        throw externalError(
          `Missing refund information for order input payment ${inputPaymentIndex}`,
        );
      }

      const orderRefund =
        data.order.inputs[inputPaymentIndex].refunds[
          refundInformation.refundIndex
        ];
      if (!orderRefund) {
        throw externalError(
          `Invalid refund information for order input payment ${inputPaymentIndex}`,
        );
      }

      const paidAmount = await getVmAttestor(orderRefund.chainId).then(
        async (attestor) =>
          attestor.getSolverPaidAmount(
            orderRefund.chainId,
            refundInformation.transactionId,
            {
              currency: orderRefund.currency,
              // If the refund recipient matches the address of the native currency on the chain, refund to the depositor
              recipient:
                orderRefund.recipient ===
                getVmTypeNativeCurrency(
                  await getChainVmType(orderRefund.chainId),
                )
                  ? depositoryDeposits[inputPaymentIndex].result.depositor
                  : orderRefund.recipient,
              orderId,
              extraData: orderRefund.extraData,
              deadline: orderRefund.deadline,
            },
            data.hints,
          ),
      );

      // Ensure the paid amount matches the minimum amount requested by the user (adjusted for any under/over-payment)
      const minimumAmount =
        BigInt(orderRefund.minimumAmount) +
        (BigInt(orderRefund.minimumAmount) * totalWeightedInputPaymentBpsDiff) /
          10n ** 18n;
      if (paidAmount < minimumAmount) {
        throw externalError(
          `Insufficient refund amount for order input payment ${inputPaymentIndex} (paidAmount=${paidAmount}, minimumAmount=${minimumAmount})`,
        );
      }
    }

    return {
      message: {
        data,
        result: {
          orderId,
          status: SolverRefundStatus.SUCCESSFUL,
          totalWeightedInputPaymentBpsDiff:
            totalWeightedInputPaymentBpsDiff.toString(),
        },
      },
      execution: await this._getSolverFillOrRefundExecution({
        order: data.order,
        totalWeightedInputPaymentBpsDiff,
        depositoryDeposits,
        type: "refund",
      }),
    };
  }

  public async attestDepositAddressTrigger(
    data: DepositAddressTrigger,
  ): Promise<{
    chainId: string;
    depositAddressManager: string;
    inputDepository: string;
    triggerHash: string;
  }> {
    const hubInfo = await getHubInfo();
    if (!hubInfo.depositAddressManagerAddress) {
      throw externalError("Missing deposit address manager config");
    }

    const inputChain = await getChain(data.input.chainId);
    if (!inputChain?.depository) {
      throw externalError(
        `Missing depository for input chain ${data.input.chainId}`,
      );
    }
    const inputDepository = `0x${Buffer.from(
      encodeAddress(inputChain.depository, inputChain.vmType),
    ).toString("hex")}`;

    const triggerHash = getDepositAddressTriggerHash(data);

    const depositAddressManager = getContract({
      address: hubInfo.depositAddressManagerAddress as Address,
      abi: parseAbi([
        "function triggers(bytes32 triggerHash) view returns (bytes32)",
      ]),
      client: await getHubHttpRpc(),
    });
    const triggeredOrderId = await depositAddressManager.read.triggers([
      triggerHash as Hex,
    ]);
    if (triggeredOrderId !== data.orderId) {
      throw externalError("Trigger hash does not map to the provided order id");
    }

    return {
      chainId: hubInfo.evmChainId,
      depositAddressManager: hubInfo.depositAddressManagerAddress,
      inputDepository,
      triggerHash,
    };
  }

  public async attestNonceMappingSignature(data: {
    walletChainId: string;
    wallet: string;
    nonce: string;
    id: string;
    depositor: string;
    signatureChainId: string;
    signature: string;
  }): Promise<{
    genericMapping: GenericMappingMessage;
  }> {
    const NONCE_MAPPING_DOMAIN = (chainId: number) => ({
      name: "RelayNonceMapping",
      version: "2",
      chainId,
      verifyingContract: zeroAddress,
    });

    const NONCE_MAPPING_TYPES = {
      NonceMapping: [
        { name: "chainId", type: "string" },
        { name: "wallet", type: "address" },
        { name: "depositor", type: "address" },
        { name: "id", type: "bytes32" },
        { name: "nonce", type: "uint256" },
      ],
    };

    const message = {
      chainId: data.walletChainId,
      wallet: data.wallet as Address,
      depositor: data.depositor as Address,
      id: data.id as Hex,
      nonce: BigInt(data.nonce),
    };

    const signatureChain = await getChain(data.signatureChainId);
    if (signatureChain.vmType !== "ethereum-vm") {
      throw externalError("Unsupported signature chain");
    }

    const isValidSignature = await verifyTypedData({
      address: data.wallet as Address,
      domain: NONCE_MAPPING_DOMAIN(
        Number(signatureChain.additionalData?.evmChainId),
      ),
      types: NONCE_MAPPING_TYPES,
      primaryType: "NonceMapping",
      message,
      signature: data.signature as Hex,
    }).catch(() => false);
    if (!isValidSignature) {
      throw externalError("Invalid signature");
    }

    const walletChain = await getChain(data.walletChainId);
    const user = generateAddress({
      family: walletChain.vmType,
      chainId: walletChain.id,
      address: data.wallet,
    });

    return {
      genericMapping: getNonceMappingMessage(
        user,
        data.nonce,
        data.id,
        data.depositor,
      ),
    };
  }

  public async attestNoFillOrRefundSignature(data: {
    solverChainId: string;
    solver: string;
    orderId: string;
    signature: string;
  }): Promise<{
    genericMapping: GenericMappingMessage;
  }> {
    const NO_FILL_OR_REFUND_DOMAIN = (chainId: number) => ({
      name: "RelayNoFillOrRefund",
      version: "1",
      chainId,
      verifyingContract: zeroAddress,
    });

    const NO_FILL_OR_REFUND_TYPES = {
      NoFillOrRefund: [
        { name: "chainId", type: "string" },
        { name: "solver", type: "address" },
        { name: "orderId", type: "bytes32" },
      ],
    };

    const solverChain = await getChain(data.solverChainId);
    if (solverChain.vmType !== "ethereum-vm") {
      throw externalError("Unsupported signature chain");
    }

    const message = {
      chainId: data.solverChainId,
      solver: data.solver as Address,
      orderId: data.orderId as Hex,
    };

    const isValidSignature = await verifyTypedData({
      address: data.solver as Address,
      domain: NO_FILL_OR_REFUND_DOMAIN(
        Number(solverChain.additionalData?.evmChainId),
      ),
      types: NO_FILL_OR_REFUND_TYPES,
      primaryType: "NoFillOrRefund",
      message,
      signature: data.signature as Hex,
    }).catch(() => false);
    if (!isValidSignature) {
      throw externalError("Invalid signature");
    }

    const solver = generateAddress({
      family: solverChain.vmType,
      chainId: solverChain.id,
      address: data.solver,
    });

    return {
      genericMapping: getNoFillOrRefundMessage(solver, data.orderId),
    };
  }

  public async attestWithdrawRequest(
    data: DenormalizedWithdrawRequest & { hashIndexes: number[] },
  ): Promise<WithdrawRequestAttestationMessage> {
    const context = await this.getWithdrawRequestAttestationContext(data);
    const hashesToSign = await this.getWithdrawRequestHashesToSign(
      context,
      data.hashIndexes,
    );

    return {
      ...context,
      hashesToSign,
    };
  }

  public async getWithdrawRequestHashesToSign(
    context: WithdrawRequestAttestationContext,
    hashIndexes: number[],
  ): Promise<string[]> {
    const uniqueIndexes = [...new Set(hashIndexes)];
    const readHashes = async (
      client: Awaited<ReturnType<typeof getHubHttpRpc>>,
    ) => {
      const allocator = getContract({
        address: context.allocator as Address,
        abi: parseAbi([
          "function hashesToSign(bytes32 withdrawRequestHash, uint256 index) view returns (bytes32)",
        ]),
        client,
      });
      return Promise.all(
        uniqueIndexes.map((hashIndex) =>
          allocator.read.hashesToSign([
            context.withdrawRequestHash as Hex,
            BigInt(hashIndex),
          ]),
        ),
      );
    };

    let uniqueHashes: string[];
    if (uniqueIndexes.length === 1) {
      uniqueHashes = await readHashes(await getHubHttpRpc());
    } else {
      try {
        uniqueHashes = await readHashes(await getHubBatchHttpRpc());
      } catch {
        logger.warn(
          "attestation-service",
          JSON.stringify({
            msg: "Batched withdrawal hash lookup failed, using concurrent requests",
            hashCount: uniqueIndexes.length,
          }),
        );
        uniqueHashes = await readHashes(await getHubHttpRpc());
      }
    }

    const hashesByIndex = new Map<number, string>();
    uniqueIndexes.forEach((hashIndex, position) => {
      const hashToSign = uniqueHashes[position];
      if (hashToSign === zeroHash) {
        throw externalError(
          `Hash to sign not set for withdraw request at index ${hashIndex}`,
        );
      }
      hashesByIndex.set(hashIndex, hashToSign);
    });
    return hashIndexes.map((hashIndex) => hashesByIndex.get(hashIndex)!);
  }

  public async getWithdrawRequestAttestationContext(
    data: DenormalizedWithdrawRequest,
  ): Promise<WithdrawRequestAttestationContext> {
    const hubInfo = await getHubInfo();
    const withdrawRequest = normalizeWithdrawRequest({
      ...data,
      vmType: await getChainVmType(data.chainId),
      spenderVmType: await getChainVmType(data.spenderChainId),
    });
    const withdrawRequestHash = getWithdrawRequestHash(withdrawRequest);

    return {
      chainId: Number(hubInfo.evmChainId),
      allocator: hubInfo.allocatorAddress,
      withdrawRequestHash,
    };
  }

  // Shared validation: order matches on-chain deposit + solver signed it +
  // solver declared no-fill-or-refund on hub. Used by attestRecover (≤7d path)
  // and recoverMode-based withdrawal initiation (slow refund).
  public async validateOrderForDeposit(params: {
    deposit: DepositoryDepositMessage;
    order: Order;
    orderSignature: string;
  }): Promise<{ orderId: string }> {
    const orderId = getOrderId(params.order, await getSdkChainsConfig());
    if (params.deposit.result.depositId !== orderId) {
      throw externalError(
        "Deposit depositId does not match the computed orderId",
      );
    }

    const isSignatureValid = await verifyMessage({
      address: params.order.solver as Address,
      message: { raw: orderId },
      signature: params.orderSignature as Hex,
    }).catch(() => false);
    if (!isSignatureValid) {
      throw externalError("Invalid order signature");
    }

    const solverAlias = generateAddress({
      address: params.order.solver,
      chainId: params.order.solverChainId,
      family: await getChainVmType(params.order.solverChainId),
    });

    const noFillOrRefundMessage = getNoFillOrRefundMessage(
      solverAlias,
      orderId,
    );

    const hubInfo = await getHubInfo();
    const genericMappingContract = getContract({
      address: hubInfo.genericMappingAddress as Address,
      abi: parseAbi([
        "function getEntry(address user, bytes32 id) view returns (bytes data, uint256 createdAt)",
      ]),
      client: await getHubHttpRpc(),
    });

    const [, createdAt] = await genericMappingContract.read.getEntry([
      noFillOrRefundMessage.user as Address,
      noFillOrRefundMessage.id as Hex,
    ]);
    if (createdAt === 0n) {
      throw externalError("No fill or refund entry not found for this order");
    }

    return { orderId };
  }

  public async attestRecover(data: {
    chainId: string;
    transactionId: string;
    onchainId: string;
    order?: Order;
    orderSignature?: string;
    hints?: TxHints;
  }): Promise<{ execution: ExecutionMessage }> {
    // Fetch all deposits from the transaction
    const attestor = await getVmAttestor(data.chainId);
    const deposits = await attestor.getDepositoryDepositMessages(
      data.chainId,
      data.transactionId,
      data.hints,
    );

    // Find the specific deposit
    const deposit = deposits.find((d) => d.result.onchainId === data.onchainId);
    if (!deposit) {
      throw externalError(
        `Deposit with onchainId ${data.onchainId} not found in transaction`,
      );
    }

    // Must have a depositId (linked to an order)
    if (deposit.result.depositId === zeroHash) {
      throw externalError("Deposit does not have a depositId");
    }

    const vmType = await getChainVmType(data.chainId);

    // Compute the order address on the hub
    const orderAddress = await this._getOrderAddress({
      chainId: data.chainId,
      vmType,
      timestamp: deposit.extraData.timestamp,
      depositor: deposit.result.depositor,
      depositId: deposit.result.depositId,
    });

    // Compute hubTokenId
    const hubTokenId = generateTokenId({
      address: deposit.result.currency,
      chainId: data.chainId,
      family: vmType,
    });

    // Balance check
    const balance = await getBalanceOnHub(orderAddress, hubTokenId);
    if (balance < BigInt(deposit.result.amount)) {
      throw externalError("Insufficient balance at order address for recovery");
    }

    // Compute depositor hub alias
    const depositorAlias = generateAddress({
      address: deposit.result.depositor,
      chainId: data.chainId,
      family: await getChainVmType(data.chainId),
    });

    // Check deposit age
    const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;
    const depositTimestamp = Number(deposit.extraData.timestamp);
    const now = Math.floor(Date.now() / 1000);
    const isOlderThan7Days = now - depositTimestamp > SEVEN_DAYS_SECONDS;

    if (!isOlderThan7Days) {
      // Require order data for deposits <= 7 days old
      if (!data.order || !data.orderSignature) {
        throw externalError(
          "Order data and signature are required for deposits less than 7 days old",
        );
      }

      await this.validateOrderForDeposit({
        deposit,
        order: data.order,
        orderSignature: data.orderSignature,
      });
    }

    // Sign TRANSFER from order address to depositor alias
    const execution: ExecutionMessage = {
      idempotencyKey: getDeterministicId(deposit.result.onchainId, "recover"),
      actions: [
        encodeAction({
          type: ActionType.TRANSFER,
          data: {
            hubTokenId,
            hubFromAddress: orderAddress,
            hubToAddress: depositorAlias,
            amount: deposit.result.amount,
          },
        }),
      ],
    };

    return { execution };
  }

  private async _getExecuteAndWithdrawFillRequest(data: {
    attested: Awaited<
      ReturnType<AttestationService["_attestExecuteAndWithdrawDeposit"]>
    >;
    nonce: string;
    additionalData?: WithdrawRequestAdditionalData;
    useGatewaySource?: string;
  }): Promise<ExecuteAndWithdrawRequest> {
    const { deposit, orderAddress, inCurrency, output } = data.attested;

    const inChain = await getChain(deposit.data.chainId);

    const destination = await this._getExecuteAndWithdrawDestination({
      chainId: output.chainId,
      currency: output.currency,
      amount: output.minimumAmount,
      recipient: output.recipient,
      orderAddress,
      nonce: data.nonce,
      additionalData: data.additionalData,
      useGatewaySource: data.useGatewaySource,
    });

    return {
      inChainId: inChain.id,
      inCurrency,
      outChainId: destination.outChainId,
      outCurrency: destination.outCurrency,
      outAmountMinimum: output.minimumAmount,
      depository: destination.depository,
      orderAddress,
      receiver: destination.receiver,
      data: destination.data,
      fees: output.fees,
      nonce: data.nonce,
      // The oracle authorization expires alongside the solver-signed order's
      // output deadline. Derived from the order (rather than local time) so
      // that all peer oracles produce an identical signed request.
      deadline: output.deadline.toString(),
    };
  }

  // Builds an `ExecuteAndWithdrawRequest` that pays out one of the order's
  // signed refund options (rather than filling the order output).
  private async _getExecuteAndWithdrawRefundRequest(data: {
    attested: Awaited<
      ReturnType<AttestationService["_attestExecuteAndWithdrawDeposit"]>
    >;
    refundIndex?: number;
    nonce: string;
    additionalData?: WithdrawRequestAdditionalData;
    useGatewaySource?: string;
  }): Promise<ExecuteAndWithdrawRequest> {
    const { deposit, orderAddress, inCurrency, refunds } = data.attested;

    const inChain = await getChain(deposit.data.chainId);

    // The refund pays out one of the options the solver signed refund terms
    // for, picked by index so the chain and currency are taken verbatim from
    // the order. Independent of what gets pulled from the order address, and
    // not necessarily on the deposit chain.
    const refund = refunds[data.refundIndex ?? 0];
    if (!refund) {
      throw externalError("Order input has no refund option at that index");
    }

    const destination = await this._getExecuteAndWithdrawDestination({
      chainId: refund.chainId,
      currency: refund.currency,
      amount: refund.minimumAmount,
      recipient: refund.recipient,
      orderAddress,
      nonce: data.nonce,
      additionalData: data.additionalData,
      useGatewaySource: data.useGatewaySource,
    });

    return {
      inChainId: inChain.id,
      inCurrency,
      outChainId: destination.outChainId,
      outCurrency: destination.outCurrency,
      outAmountMinimum: refund.minimumAmount,
      depository: destination.depository,
      orderAddress,
      receiver: destination.receiver,
      data: destination.data,
      fees: refund.fees,
      nonce: data.nonce,
      // The oracle authorization expires alongside the solver-signed order's
      // refund deadline. Derived from the order (rather than local time) so
      // that all peer oracles produce an identical signed request.
      deadline: refund.deadline.toString(),
    };
  }

  private async _getExecuteAndWithdrawFeesCharged(
    orderAddress: string,
  ): Promise<boolean> {
    const hubInfo = await getHubInfo();
    const executor = getContract({
      address: hubInfo.executorAddress as Address,
      abi: parseAbi([
        "function feesChargedByOrderAddress(address orderAddress) view returns (bool)",
      ]),
      client: await getHubHttpRpc(),
    });
    return executor.read.feesChargedByOrderAddress([orderAddress as Address]);
  }

  private async _getExecuteAndWithdrawDestination(data: {
    chainId: string;
    currency: string;
    amount: string;
    recipient: string;
    orderAddress: string;
    nonce: string;
    additionalData?: WithdrawRequestAdditionalData;
    useGatewaySource?: string;
  }): Promise<
    Pick<
      ExecuteAndWithdrawRequest,
      "outChainId" | "outCurrency" | "depository" | "receiver" | "data"
    >
  > {
    const destinationChain = await getChain(data.chainId);

    // The standard path withdraws the order's requested currency through the
    // physical destination chain's regular depository
    if (!data.useGatewaySource) {
      const depository = destinationChain.depository!;
      const receiver = encodeAddressToHex(
        data.recipient,
        destinationChain.vmType,
      );
      const outCurrency = encodeAddressToHex(
        data.currency,
        destinationChain.vmType,
      );

      return {
        outChainId: destinationChain.id,
        outCurrency,
        depository: encodeAddressToHex(depository, destinationChain.vmType),
        receiver,
        data: encodeWithdrawRequestAdditionalData({
          vmType: destinationChain.vmType,
          additionalData: data.additionalData,
          depository,
        }),
      };
    }

    const gatewayChain = await getChain(data.useGatewaySource);

    // Gateway can only back native Circle USDC on a configured physical
    // destination. Compare encoded addresses so validation follows that VM's
    // address normalization rules.
    const gatewayDestination = await getGatewayDestination(
      gatewayChain,
      destinationChain.id,
    );
    if (
      encodeAddressToHex(data.currency, destinationChain.vmType) !==
      encodeAddressToHex(gatewayDestination.usdc, destinationChain.vmType)
    ) {
      throw externalError(
        `Gateway withdrawals require configured Circle USDC on ${destinationChain.id}`,
      );
    }

    // The additional data is caller-provided but gets encoded into the
    // oracle-signed withdraw request, and `GatewayVmPayloadBuilder` routes the
    // withdrawal by it. Validate it against the attested order before signing.
    const gatewayAdditionalData = data.additionalData?.["gateway-vm"];
    if (!gatewayAdditionalData) {
      throw externalError("Additional data is required for gateway-vm");
    }
    if (gatewayAdditionalData.destinationChainId !== destinationChain.id) {
      throw externalError(
        `Gateway destination chain ${gatewayAdditionalData.destinationChainId} does not match the order destination chain ${destinationChain.id}`,
      );
    }
    await new GatewayVmAttestor().validateMaxBlockHeight(
      gatewayChain,
      gatewayAdditionalData.maxBlockHeight,
    );

    const depository = await this._getConfiguredDepository(gatewayChain);
    const receiver = encodeAddressToHex(
      data.recipient,
      destinationChain.vmType,
    );

    // The Hub burns the configured source Gateway token, while the depository
    // identifies its source bucket. The receiver remains encoded for the
    // physical destination VM, whose routing metadata is carried in `data`.
    return {
      outChainId: gatewayChain.id,
      outCurrency: zeroAddress,
      depository,
      receiver,
      data: encodeWithdrawRequestAdditionalData({
        vmType: gatewayChain.vmType,
        additionalData: data.additionalData,
      }),
    };
  }

  // Resolves each order fee recipient to its Hub account alias. Fee currencies
  // are validated in `_attestExecuteAndWithdrawDeposit`, which owns the
  // charged/uncharged distinction.
  private async _getExecuteAndWithdrawFees(
    order: Order,
  ): Promise<ExecuteAndWithdrawFee[]> {
    const fees: ExecuteAndWithdrawFee[] = [];
    for (const fee of order.fees) {
      fees.push({
        recipient: generateAddress({
          address: fee.recipient,
          chainId: fee.recipientChainId,
          family: await getChainVmType(fee.recipientChainId),
        }),
        amount: fee.amount,
      });
    }

    return fees;
  }

  private async _getDepositsDetails(data: {
    order: Order;
    orderSignature: string;
    inputs: {
      transactionId: string;
      onchainId: string;
      inputIndex: number;
    }[];
    inputHints?: InputHints;
  }): Promise<{
    totalWeightedInputPaymentBpsDiff: bigint;
    depositoryDeposits: EnhancedDepositoryDepositMessage[];
  }> {
    // Ensure every input specifies a unique onchain id
    if (
      new Set(data.inputs.map((input) => input.onchainId)).size !==
      data.inputs.length
    ) {
      throw externalError("Input information contains non-unique onchain ids");
    }

    // Get the order id
    const orderId = getOrderId(data.order, await getSdkChainsConfig());

    // Verify the order signature
    const isSignatureValid = await verifyMessage({
      address: data.order.solver as Address,
      message: {
        raw: orderId,
      },
      signature: data.orderSignature as Hex,
    }).catch(() => false);
    if (!isSignatureValid) {
      throw externalError("Invalid order signature");
    }

    // Verify the inputs
    let totalWeightedPaidAmount = 0n;
    const depositoryDeposits: EnhancedDepositoryDepositMessage[] = [];
    {
      for (
        let inputPaymentIndex = 0;
        inputPaymentIndex < data.order.inputs.length;
        inputPaymentIndex++
      ) {
        const orderInput = data.order.inputs[inputPaymentIndex];

        // Get the input information corresponding to the current input payment
        const inputInformation = data.inputs.find(
          ({ inputIndex }) => inputIndex === inputPaymentIndex,
        );
        if (!inputInformation) {
          throw externalError(
            `Missing input information for order input payment ${inputPaymentIndex}`,
          );
        }

        // Get the depository deposit corresponding to the current order input payment
        const fetchedDeposits = await getVmAttestor(
          orderInput.payment.chainId,
        ).then((attestor) =>
          attestor.getDepositoryDepositMessages(
            orderInput.payment.chainId,
            inputInformation.transactionId,
            getInputHints(inputInformation.inputIndex, data.inputHints),
          ),
        );
        const depositoryDeposit = fetchedDeposits.find(
          (d) =>
            d.result.depositId === orderId &&
            d.result.onchainId === inputInformation.onchainId,
        );
        if (!depositoryDeposit) {
          throw externalError(
            `Invalid input information for order input payment ${inputPaymentIndex} (orderId=${orderId} onchainId=${
              inputInformation.onchainId
            } depositoryDeposits=${JSON.stringify(fetchedDeposits)})`,
          );
        }

        // The sibling execute-and-withdraw path rejects a deposit whose currency differs from the
        // order input (until the order's fees have been charged). Measure how often that would
        // fire here before enforcing the same rule.
        if (depositoryDeposit.result.currency !== orderInput.payment.currency) {
          const vmType = await getChainVmType(orderInput.payment.chainId);
          const encode = (value: string) => {
            try {
              return encodeAddressToHex(value, vmType);
            } catch {
              return undefined;
            }
          };
          const encodedOrderCurrency = encode(orderInput.payment.currency);
          const encodedDepositCurrency = encode(
            depositoryDeposit.result.currency,
          );

          logger.warn(
            "solver-fill-deposit-currency",
            JSON.stringify({
              msg: "Deposit currency does not match order input currency",
              orderId,
              inputPaymentIndex,
              chainId: orderInput.payment.chainId,
              vmType,
              orderCurrency: orderInput.payment.currency,
              depositCurrency: depositoryDeposit.result.currency,
              // true = same token, different encoding; false = different token;
              // null = not address-encodable for this vm (lighter asset indexes, hyperliquid dex ids)
              encodedMatch:
                encodedOrderCurrency && encodedDepositCurrency
                  ? encodedOrderCurrency === encodedDepositCurrency
                  : null,
              transactionId: inputInformation.transactionId,
              onchainId: inputInformation.onchainId,
            }),
          );
        }

        // Keep track of the total weighted paid amount
        totalWeightedPaidAmount +=
          BigInt(depositoryDeposit.result.amount) *
          BigInt(orderInput.payment.weight);

        // Save the corresponding deposit
        depositoryDeposits.push(depositoryDeposit);
      }
    }
    // Compare the total weighted requested amount to the total weighted paid amount in order to determine any under/over-payment
    const totalWeightedRequestedAmount = data.order.inputs
      .map(
        (input) => BigInt(input.payment.amount) * BigInt(input.payment.weight),
      )
      .reduce((a, b) => a + b, 0n);
    const totalWeightedInputPaymentBpsDiff =
      ((totalWeightedPaidAmount - totalWeightedRequestedAmount) * 10n ** 18n) /
      totalWeightedRequestedAmount;

    return {
      totalWeightedInputPaymentBpsDiff,
      depositoryDeposits,
    };
  }

  private async _getSolverFillOrRefundExecution(data: {
    order: Order;
    totalWeightedInputPaymentBpsDiff: bigint;
    depositoryDeposits: EnhancedDepositoryDepositMessage[];
    type: "fill" | "refund";
  }): Promise<ExecutionMessage> {
    const actions: string[] = [];

    // Solver address on the hub
    const solverAlias = generateAddress({
      address: data.order.solver,
      chainId: data.order.solverChainId,
      family: await getChainVmType(data.order.solverChainId),
    });

    // Transfer from order to solver
    for (const deposit of data.depositoryDeposits) {
      const vmType = await getChainVmType(deposit.data.chainId);
      const hubTokenId = generateTokenId({
        address: deposit.result.currency,
        chainId: deposit.data.chainId,
        family: vmType,
      });

      const hubFromAddress = await this._getOrderAddress({
        chainId: deposit.data.chainId,
        vmType,
        timestamp: deposit.extraData.timestamp,
        depositor: deposit.result.depositor,
        depositId: deposit.result.depositId,
      });

      const amount = deposit.result.amount;

      actions.push(
        encodeAction({
          type: ActionType.TRANSFER,
          data: {
            hubTokenId,
            hubFromAddress,
            hubToAddress: solverAlias,
            amount,
          },
        }),
      );
    }

    // Only when the solver filled, transfer from solver to fee recipients
    if (data.type === "fill") {
      for (const fee of data.order.fees) {
        const hubTokenId = generateTokenId({
          address: fee.currency,
          chainId: fee.currencyChainId,
          family: await getChainVmType(fee.currencyChainId),
        });

        const hubToAddress = generateAddress({
          address: fee.recipient,
          chainId: fee.recipientChainId,
          family: await getChainVmType(fee.recipientChainId),
        });

        const amount = fee.amount;
        actions.push(
          encodeAction({
            type: ActionType.TRANSFER,
            data: {
              hubTokenId,
              hubFromAddress: solverAlias,
              hubToAddress,
              amount,
            },
          }),
        );
      }
    }

    // Ensure we never return empty actions
    if (!actions.length) {
      throw internalError("Missing actions to execute");
    }

    // Sort and generate a unique id for the relevant deposits
    const sortedDepositIds = data.depositoryDeposits
      .map((deposit) => deposit.result.onchainId)
      .sort((a, b) => (BigInt(a) - BigInt(b) <= 0 ? -1 : 1));
    const depositsId = getDeterministicId(...sortedDepositIds);

    return {
      // The idempotency key includes the deposits id in order to support duplicate deposit fills / refunds
      idempotencyKey: getDeterministicId(
        depositsId,
        getOrderId(data.order, await getSdkChainsConfig()),
      ),
      actions,
    };
  }

  private async _getOrderAddress(data: {
    chainId: string;
    vmType: VmType;
    timestamp: string;
    depositor: string;
    depositId: string;
  }): Promise<string> {
    return getOrderAddress({
      vmType: data.vmType,
      chainId: data.chainId,
      depositor: data.depositor,
      timestamp: BigInt(data.timestamp),
      depositId: data.depositId,
    });
  }

  private async _getConfiguredDepository(
    chain: Chain,
    requestedDepository?: string,
  ) {
    if (chain.vmType === "gateway-vm") {
      const source = await getGatewaySource(chain);
      const configured = encodeAddressToHex(
        source.gatewayDepository,
        source.chain.vmType,
      );
      const requested = requestedDepository ?? configured;
      if (requested.toLowerCase() !== configured.toLowerCase()) {
        throw externalError(
          `Depository ${requested} is not configured for chain ${chain.id}`,
        );
      }
      return configured;
    }

    const requested = requestedDepository ?? chain.depository;
    if (!requested) {
      throw externalError("Chain has no depository configured");
    }

    const configured = findEquivalentAddress(
      requested,
      [chain.depository, ...(chain.additionalDepositories ?? [])].filter(
        (depository): depository is string => Boolean(depository),
      ),
      chain.vmType,
    );
    if (!configured) {
      throw externalError(
        `Depository ${requested} is not configured for chain ${chain.id}`,
      );
    }

    return configured;
  }

  private async _getWithdrawalAddress(data: WithdrawalAddressRequest) {
    const chain = await getChain(data.chainId);

    // The token to be withdrawn from depository
    const hubTokenId = generateTokenId({
      address: data.currency,
      chainId: data.chainId,
      family: await getChainVmType(data.chainId),
    });

    // The alias for withdrawer address on origin chain
    const withdrawerAlias = generateAddress({
      address: data.withdrawer,
      chainId: data.withdrawerChainId,
      family: await getChainVmType(data.withdrawerChainId),
    });

    // Compute address
    const depository = await this._getConfiguredDepository(
      chain,
      data.depository,
    );
    const withdrawalAddress = getWithdrawalAddress({
      depository,
      chainId: data.chainId,
      vmType: await getChainVmType(data.chainId),
      recipient: data.recipient,
      currency: data.currency,
      ownerAlias: withdrawerAlias,
      nonce: data.withdrawalNonce,
    });

    return {
      hubTokenId,
      withdrawalAddress,
      withdrawerAlias,
    };
  }

  private async _getEncodedWithdrawalV3(
    withdrawRequest: WithdrawRequest,
  ): Promise<string> {
    const hubInfo = await getHubInfo();

    const allocator = getContract({
      address: hubInfo.allocatorAddress as Address,
      abi: parseAbi([
        "function payloads(bytes32 withdrawRequestHash) view returns (bytes unsignedPayload)",
        "function payloadBuilders(string chainId, bytes depository) view returns (address)",
      ]),
      client: await getHubHttpRpc(),
    });

    const payloadBuilderAddress = await allocator.read.payloadBuilders([
      withdrawRequest.chainId,
      withdrawRequest.depository as Hex,
    ]);
    if (payloadBuilderAddress === zeroAddress) {
      throw externalError(
        `No payload builder configured for chain ${withdrawRequest.chainId}`,
      );
    }

    const payloadBuilder = getContract({
      address: payloadBuilderAddress,
      abi: parseAbi(["function family() view returns (string)"]),
      client: await getHubHttpRpc(),
    });
    const family = await payloadBuilder.read.family();

    const withdrawRequestHash = getWithdrawRequestHash(withdrawRequest);
    const payload = await allocator.read.payloads([withdrawRequestHash as Hex]);
    if (payload === "0x") {
      throw externalError("Withdraw request not yet available");
    }

    switch (family) {
      case "ethereum-vm":
      case "gateway-vm":
      case "hyperliquid-vm":
      case "lighter-vm":
      case "solana-vm":
      case "ton-vm":
      case "tron-vm":
      case "xrp-vm": {
        return payload;
      }

      case "bitcoin-vm": {
        return this._encodeBitcoinPsbtWithdrawal({
          transactionData: this._decodeBitcoinTransactionData(payload as Hex),
        });
      }

      default: {
        throw externalError("Vm type not implemented");
      }
    }
  }

  private _decodeBitcoinTransactionData(encodedData: Hex): {
    inputs: { txid: Hex; index: Hex; script: Hex; value: Hex }[];
    outputs: { value: Hex; script: Hex }[];
  } {
    return decodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            {
              type: "tuple[]",
              name: "inputs",
              components: [
                { type: "bytes", name: "txid" },
                { type: "bytes", name: "index" },
                { type: "bytes", name: "script" },
                { type: "bytes", name: "value" },
              ],
            },
            {
              type: "tuple[]",
              name: "outputs",
              components: [
                { type: "bytes", name: "value" },
                { type: "bytes", name: "script" },
              ],
            },
          ],
        },
      ],
      encodedData,
    )[0] as {
      inputs: { txid: Hex; index: Hex; script: Hex; value: Hex }[];
      outputs: { value: Hex; script: Hex }[];
    };
  }

  private _fromBitcoinLittleEndian(value: Hex): number {
    const bytes = Buffer.from(value.slice(2), "hex");
    const reversed = Buffer.from(bytes).reverse();
    const normalized = reversed.toString("hex").replace(/^0+/, "") || "0";
    return Number(BigInt(`0x${normalized}`));
  }

  private _encodeBitcoinPsbtWithdrawal(data: {
    transactionData: {
      inputs: { txid: Hex; index: Hex; script: Hex; value: Hex }[];
      outputs: { value: Hex; script: Hex }[];
    };
  }): string {
    const psbt = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });
    psbt.setVersion(1);

    for (const input of data.transactionData.inputs) {
      const txid = Buffer.from(input.txid.slice(2), "hex")
        .reverse()
        .toString("hex");

      psbt.addInput({
        hash: txid,
        index: this._fromBitcoinLittleEndian(input.index),
        sequence: 0xfffffffd,
        sighashType: bitcoin.Transaction.SIGHASH_ALL,
        witnessUtxo: {
          script: Buffer.from(input.script.slice(2), "hex"),
          value: this._fromBitcoinLittleEndian(input.value),
        },
      });
    }

    for (const output of data.transactionData.outputs) {
      psbt.addOutput({
        script: Buffer.from(output.script.slice(2), "hex"),
        value: this._fromBitcoinLittleEndian(output.value),
      });
    }

    return encodeWithdrawal({
      vmType: "bitcoin-vm",
      withdrawal: { psbt: psbt.toHex() },
    });
  }
}
