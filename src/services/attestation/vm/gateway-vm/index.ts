import {
  decodeWithdrawal,
  DepositoryWithdrawalMessage,
  DepositoryWithdrawalStatus,
  GatewayBurnIntent,
  GatewayTransferSpec,
  getDecodedWithdrawalId,
  getGatewayDestinationExpiration,
  getGatewayDestinationVmType,
  getVmTypeNativeCurrency,
} from "@relay-protocol/settlement-sdk";
import {
  Address,
  getContract,
  Hex,
  pad,
  parseAbi,
  parseEventLogs,
  TransactionReceipt,
} from "viem";

import type { TxHints } from "../..";
import {
  Chain,
  getChain,
  getGatewayDestination,
  getGatewaySource,
} from "../../../../common/chains";
import { externalError } from "../../../../common/error";
import { getTrackingId, logRpcUsage } from "../../../../common/rpc-usage";
import { httpRpc } from "../../../../common/vm/ethereum-vm/rpc";
import {
  getDeterministicId,
  isNumericFinalityMet,
  resolveAmountTieredFinality,
} from "../../utils";
import {
  DepositFinality,
  DepositMode,
  EnhancedDepositoryDepositMessage,
  VmAttestor,
} from "../types";

export const ABI = parseAbi([
  "event RelayErc20Deposit(address from, address token, uint256 amount, bytes32 id)",
  "function callRequests(bytes32 withdrawalId) view returns (bool)",
]);

const DEFAULT_FINALIZATION_BLOCKS = 10;
const DEFAULT_FINALIZATION_TIME = 60;

const TX_ID_REGEX = /^0x[0-9a-f]{64}$/;

export class GatewayVmAttestor extends VmAttestor {
  public async getDepositoryDepositMessages(
    chainId: string,
    transactionId: string,
    _hints?: TxHints,
    opts?: { mode?: DepositMode },
  ): Promise<EnhancedDepositoryDepositMessage[]> {
    const trackingId = getTrackingId();

    this._requireCanonicalTransactionId(transactionId);

    const {
      chain: sourceChain,
      gatewayDepository,
      usdc,
    } = await this._getSourceChain(chainId);

    switch (sourceChain.vmType) {
      case "ethereum-vm":
        return this._getEthereumVmDepositoryDepositMessages(
          chainId,
          transactionId,
          sourceChain,
          gatewayDepository,
          usdc,
          trackingId,
          opts,
        );
      default:
        throw externalError(
          `Gateway source vm type ${sourceChain.vmType} is not implemented`,
        );
    }
  }

  private async _getEthereumVmDepositoryDepositMessages(
    chainId: string,
    transactionId: string,
    sourceChain: Chain,
    gatewayDepository: string,
    usdc: string,
    trackingId: string,
    opts?: { mode?: DepositMode },
  ): Promise<EnhancedDepositoryDepositMessage[]> {
    const rpc = await httpRpc(sourceChain.id);

    await logRpcUsage(sourceChain.id, "eth_getTransactionReceipt", trackingId);
    const receipt = await rpc
      .getTransactionReceipt({ hash: transactionId as Hex })
      .catch((error) => {
        if ((error as any).name === "TransactionReceiptNotFoundError") {
          throw externalError(
            `Missing transaction ${transactionId} on Gateway source ${sourceChain.id}`,
          );
        }
        throw error;
      });
    if (receipt.status !== "success") {
      throw externalError(
        `Reverted transaction ${transactionId} on Gateway source ${sourceChain.id}`,
      );
    }

    const finality = await this._measureFinality(
      sourceChain,
      receipt,
      trackingId,
    );
    const logs = parseEventLogs({
      abi: ABI,
      logs: receipt.logs,
      eventName: "RelayErc20Deposit",
    })
      .filter(
        (log) => log.address.toLowerCase() === gatewayDepository.toLowerCase(),
      )
      .sort((left, right) => left.logIndex - right.logIndex);

    // The depository only accepts its configured USDC, so a mismatch means the
    // oracle's Gateway configuration disagrees with the deposit contract
    for (const log of logs) {
      const token = log.args.token.toLowerCase();
      if (token !== usdc.toLowerCase()) {
        throw externalError(
          `Gateway deposit token ${token} does not match the configured USDC on ${sourceChain.id}`,
        );
      }
    }

    const messages = logs.map<EnhancedDepositoryDepositMessage>((log) => ({
      data: {
        chainId,
        transactionId,
      },
      result: {
        onchainId: getDeterministicId(
          chainId,
          sourceChain.id,
          transactionId,
          log.logIndex.toString(),
        ),
        depository: gatewayDepository,
        depositId: log.args.id.toLowerCase(),
        depositor: log.args.from.toLowerCase(),
        currency: getVmTypeNativeCurrency("gateway-vm"),
        amount: log.args.amount.toString(),
      },
      extraData: {
        timestamp: finality.timestamp,
      },
    }));

    this._ensureFinality(sourceChain, transactionId, finality, messages, opts);
    return messages;
  }

  public async getDepositoryWithdrawalMessage(
    chainId: string,
    withdrawal: string,
    _transactionId?: string,
    _hints?: TxHints,
  ): Promise<DepositoryWithdrawalMessage> {
    const gatewayChain = await getChain(chainId);
    const decodedWithdrawal = decodeWithdrawal(withdrawal, "gateway-vm");

    await this._validateSourceRouting(
      gatewayChain,
      decodedWithdrawal.withdrawal.burnIntent.spec,
    );

    const destination = await getGatewayDestination(
      gatewayChain,
      decodedWithdrawal.withdrawal.destinationChainId,
    );
    const destinationVmType = getGatewayDestinationVmType(
      decodedWithdrawal.withdrawal,
    );

    if (destination.chain.vmType !== destinationVmType) {
      throw externalError(
        `Gateway destination ${destination.chain.id} has vm type ${destination.chain.vmType}, expected ${destinationVmType}`,
      );
    }

    switch (destinationVmType) {
      case "ethereum-vm":
        return this._getEthereumVmDepositoryWithdrawalMessage({
          chainId,
          withdrawal,
          destination,
          withdrawalId: getDecodedWithdrawalId(decodedWithdrawal),
          expiration: getGatewayDestinationExpiration(
            decodedWithdrawal.withdrawal,
          ),
          burnIntent: decodedWithdrawal.withdrawal.burnIntent,
        });
      default:
        throw externalError(
          `Gateway destination vm type ${destinationVmType} is not implemented`,
        );
    }
  }

  // The burn intent debits the Circle balance backing this Gateway chain's Hub
  // token, so its source routing must match the configured Gateway source
  private async _validateSourceRouting(
    gatewayChain: Chain,
    spec: GatewayTransferSpec,
  ): Promise<void> {
    const source = await getGatewaySource(gatewayChain);

    switch (source.chain.vmType) {
      case "ethereum-vm": {
        const configuredToken = pad(source.usdc as Hex, {
          size: 32,
        }).toLowerCase();

        if (
          spec.sourceDomain !== source.circleDomain ||
          spec.sourceToken.toLowerCase() !== configuredToken
        ) {
          throw externalError(
            `Gateway withdrawal routing does not match configured source ${source.chain.id}`,
          );
        }

        return;
      }

      default:
        throw externalError(
          `Gateway source vm type ${source.chain.vmType} is not implemented`,
        );
    }
  }

  private async _getEthereumVmDepositoryWithdrawalMessage(params: {
    chainId: string;
    withdrawal: string;
    destination: Awaited<ReturnType<typeof getGatewayDestination>>;
    withdrawalId: string;
    expiration: number;
    burnIntent: GatewayBurnIntent;
  }): Promise<DepositoryWithdrawalMessage> {
    const { destination, withdrawalId } = params;
    const configuredDepository = pad(
      destination.gatewayDepository as Hex,
      { size: 32 },
    ).toLowerCase();
    const configuredToken = pad(destination.usdc as Hex, {
      size: 32,
    }).toLowerCase();
    const spec = params.burnIntent.spec;

    if (
      spec.destinationDomain !== destination.circleDomain ||
      spec.destinationToken.toLowerCase() !== configuredToken ||
      spec.destinationRecipient.toLowerCase() !== configuredDepository ||
      spec.destinationCaller.toLowerCase() !== configuredDepository
    ) {
      throw externalError(
        `Gateway withdrawal routing does not match configured destination ${destination.chain.id}`,
      );
    }

    const trackingId = getTrackingId();
    const rpc = await httpRpc(destination.chain.id);
    const depositoryContract = getContract({
      address: destination.gatewayDepository as Address,
      abi: ABI,
      client: rpc,
    });
    const finalizationBlocks =
      destination.chain.additionalData?.finalizationBlocks ??
      DEFAULT_FINALIZATION_BLOCKS;
    const finalizationTime =
      destination.chain.additionalData?.finalizationTime ??
      DEFAULT_FINALIZATION_TIME;

    await logRpcUsage(destination.chain.id, "eth_getBlock", trackingId);
    const latestBlock = await rpc.getBlock();
    const finalizedBlockNumber =
      BigInt(latestBlock.number!) - BigInt(finalizationBlocks);

    await logRpcUsage(destination.chain.id, "eth_call", trackingId);
    const isExecuted = await depositoryContract.read.callRequests(
      [withdrawalId as Hex],
      { blockNumber: finalizedBlockNumber },
    );

    let status: DepositoryWithdrawalStatus;
    if (isExecuted) {
      status = DepositoryWithdrawalStatus.EXECUTED;
    } else {
      await logRpcUsage(destination.chain.id, "eth_getBlock", trackingId);
      const finalizedTimestamp = await rpc
        .getBlock({ blockNumber: finalizedBlockNumber })
        .then((block) => block.timestamp);

      const expiration = BigInt(params.expiration);
      if (
        BigInt(finalizedTimestamp) > expiration &&
        BigInt(latestBlock.timestamp) - BigInt(finalizationTime) > expiration
      ) {
        status = DepositoryWithdrawalStatus.EXPIRED;
      } else {
        status = DepositoryWithdrawalStatus.PENDING;
      }
    }

    return {
      data: {
        chainId: params.chainId,
        withdrawal: params.withdrawal,
      },
      result: {
        withdrawalId,
        depository: destination.gatewayDepository,
        status,
      },
    };
  }

  // Circle only accepts a Gateway transfer request while the BurnIntent's max
  // block height is at least the Gateway withdrawal delay past the source
  // chain's current block, and the transfer can be requested at any point
  // until the destination execution payload expires. The caller-provided value
  // must therefore cover the execution expiration plus the withdrawal delay
  // from the current block, without extending meaningfully beyond that.
  public async validateMaxBlockHeight(
    gatewayChain: Chain,
    maxBlockHeight: number | bigint | string,
  ): Promise<void> {
    let proposedMaxBlockHeight: bigint;
    try {
      proposedMaxBlockHeight = BigInt(maxBlockHeight);
    } catch {
      throw externalError("Invalid Gateway maxBlockHeight");
    }

    const source = await getGatewaySource(gatewayChain);
    if (source.chain.vmType !== "ethereum-vm") {
      throw externalError(
        `Gateway source vm type ${source.chain.vmType} is not implemented`,
      );
    }

    const rpc = await httpRpc(source.chain.id);
    const latestBlockNumber = await rpc.getBlockNumber();

    const blockTimeSeconds = BigInt(source.blockTimeSeconds!);
    const secondsUntilTarget =
      BigInt(source.executionExpirationSeconds!) +
      BigInt(source.withdrawalDelaySeconds!);
    const blocksUntilTarget =
      (secondsUntilTarget + blockTimeSeconds - 1n) / blockTimeSeconds;
    const expectedMaxBlockHeight = latestBlockNumber + blocksUntilTarget;

    if (
      proposedMaxBlockHeight < expectedMaxBlockHeight ||
      proposedMaxBlockHeight >
        expectedMaxBlockHeight + BigInt(source.maxBlockHeightTolerance!)
    ) {
      throw externalError(
        `Gateway maxBlockHeight ${proposedMaxBlockHeight.toString()} is outside the allowed range for ${source.chain.id}`,
      );
    }
  }

  public async getSolverPaidAmount(
    _chainId: string,
    _transactionId: string,
    _payment: {
      currency: string;
      recipient: string;
      orderId: string;
      extraData: string;
      deadline: number;
    },
    _hints?: TxHints,
  ): Promise<bigint> {
    throw externalError("Gateway solver payments are not implemented");
  }

  public async verifySolverCalls(
    _chainId: string,
    _transactionId: string,
    _calls: string[],
    _extraData: string,
  ): Promise<boolean> {
    throw externalError("Gateway solver calls are not implemented");
  }

  private async _getSourceChain(
    chainId: string,
  ): Promise<{ chain: Chain; gatewayDepository: string; usdc: string }> {
    const chain = await getChain(chainId);
    return getGatewaySource(chain);
  }

  private async _measureFinality(
    subchain: Chain,
    receipt: TransactionReceipt,
    trackingId: string,
  ): Promise<DepositFinality> {
    switch (subchain.vmType) {
      case "ethereum-vm":
        return this._measureEthereumVmFinality(subchain, receipt, trackingId);
      default:
        throw externalError(
          `Gateway subchain vm type ${subchain.vmType} is not implemented`,
        );
    }
  }

  private async _measureEthereumVmFinality(
    subchain: Chain,
    receipt: TransactionReceipt,
    trackingId: string,
  ): Promise<DepositFinality> {
    const rpc = await httpRpc(subchain.id);

    await logRpcUsage(subchain.id, "eth_getBlock", trackingId);
    await logRpcUsage(subchain.id, "eth_getBlock", trackingId);
    const [latestBlock, transactionTimestamp] = await Promise.all([
      rpc.getBlock(),
      rpc
        .getBlock({ blockNumber: receipt.blockNumber })
        .then((block) => block.timestamp),
    ]);

    return {
      confirmations: Number(latestBlock.number! - receipt.blockNumber),
      elapsedSeconds: Number(latestBlock.timestamp - transactionTimestamp),
      timestamp: transactionTimestamp.toString(),
    };
  }

  private _ensureFinality(
    subchain: Chain,
    transactionId: string,
    finality: DepositFinality,
    messages: EnhancedDepositoryDepositMessage[],
    opts?: { mode?: DepositMode },
  ) {
    switch (subchain.vmType) {
      case "ethereum-vm":
        return this._ensureEthereumVmFinality(
          subchain,
          transactionId,
          finality,
          messages,
          opts,
        );
      default:
        throw externalError(
          `Gateway subchain vm type ${subchain.vmType} is not implemented`,
        );
    }
  }

  // Validate the transaction id against the canonical EVM transaction hash format.
  private _requireCanonicalTransactionId(transactionId: string) {
    if (!TX_ID_REGEX.test(transactionId)) {
      throw externalError(
        `Invalid gateway-vm transaction id ${transactionId}: expected 0x + 64 lowercase hex chars`,
      );
    }
  }

  private _ensureEthereumVmFinality(
    subchain: Chain,
    transactionId: string,
    finality: DepositFinality,
    messages: EnhancedDepositoryDepositMessage[],
    opts?: { mode?: DepositMode },
  ) {
    const defaults = {
      finalizationBlocks:
        subchain.additionalData?.finalizationBlocks ??
        DEFAULT_FINALIZATION_BLOCKS,
      finalizationTime:
        subchain.additionalData?.finalizationTime ?? DEFAULT_FINALIZATION_TIME,
    };

    if (opts?.mode === "fast" && subchain.additionalData?.fastMode) {
      const { required, mode, tiers } = resolveAmountTieredFinality(
        subchain,
        messages,
        defaults,
      );
      if (!isNumericFinalityMet(finality, required)) {
        throw externalError(`Transaction ${transactionId} is not finalized`);
      }

      messages.forEach((message, index) => {
        message.extraData.mode = mode;
        if (message.extraData.mode === "fast") {
          message.extraData.fastFeeBps = tiers[index]?.feeBps;
        }
      });
    } else if (!isNumericFinalityMet(finality, defaults)) {
      throw externalError(`Transaction ${transactionId} is not finalized`);
    }
  }
}
