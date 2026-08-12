import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
  decodeWithdrawal,
  DepositoryWithdrawalStatus,
  encodeWithdrawal,
  getDecodedWithdrawalId,
} from "@relay-protocol/settlement-sdk";
import {
  encodeAbiParameters,
  encodeEventTopics,
  Hex,
  Log,
  pad,
  TransactionReceipt,
  zeroAddress,
} from "viem";

import { Chain } from "../../../../src/common/chains";
import { httpRpc } from "../../../../src/common/vm/ethereum-vm/rpc";
import {
  ABI,
  GatewayVmAttestor,
} from "../../../../src/services/attestation/vm/gateway-vm";
import { getDeterministicId } from "../../../../src/services/attestation/utils";
import { randomHex } from "../../../common/utils";

const GATEWAY_DEPOSITORY = randomHex(20);
const DESTINATION_GATEWAY_DEPOSITORY = randomHex(20);
const USDC = randomHex(20);
const TRANSFER_SPEC_HASH = randomHex(32);
const ETHEREUM_VM_GATEWAY_MINTER =
  "0x0000000000000000000000002222222d7164433c4c09b0b0d809a9b52c04c205";
const gatewayChain: Chain = {
  id: "arbitrum-gateway",
  vmType: "gateway-vm",
  httpRpcUrl: "",
  gateway: {
    source: {
      id: "arbitrum",
      gatewayDepository: GATEWAY_DEPOSITORY,
      usdc: USDC,
      circleDomain: 3,
    },
    destinations: [
      {
        id: "arbitrum",
        gatewayDepository: DESTINATION_GATEWAY_DEPOSITORY,
        usdc: USDC,
        circleDomain: 3,
      },
    ],
  },
};
const solanaGatewayChain: Chain = {
  id: "solana-gateway",
  vmType: "gateway-vm",
  httpRpcUrl: "",
  gateway: {
    source: {
      id: "solana",
      gatewayDepository: "GatewayDepository11111111111111111111111111",
      usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      circleDomain: 5,
    },
    destinations: [],
  },
};
const arbitrumChain: Chain = {
  id: "arbitrum",
  vmType: "ethereum-vm",
  httpRpcUrl: "http://127.0.0.1:8545",
  additionalData: {
    evmChainId: "42161",
    finalizationBlocks: 10,
    finalizationTime: 60,
  },
};
const solanaChain: Chain = {
  id: "solana",
  vmType: "solana-vm",
  httpRpcUrl: "http://127.0.0.1:8899",
};

jest.mock("../../../../src/common/chains", () => ({
  getChain: async (chainId: string) => {
    if (chainId === "arbitrum-gateway") return gatewayChain;
    if (chainId === "solana-gateway") return solanaGatewayChain;
    if (chainId === "arbitrum") return arbitrumChain;
    if (chainId === "solana") return solanaChain;
    throw new Error(`Chain ${chainId} is not available`);
  },
  getGatewaySource: async (chain: Chain) => {
    if (chain.vmType !== "gateway-vm") {
      throw new Error(`Chain ${chain.id} is not a Gateway chain`);
    }
    const source = chain.gateway!.source;
    return {
      chain: source.id === "arbitrum" ? arbitrumChain : solanaChain,
      gatewayDepository: source.gatewayDepository,
      usdc: source.usdc,
      circleDomain: source.circleDomain,
    };
  },
  getGatewayDestination: async (
    chain: Chain,
    destinationChainId: string,
  ) => {
    const destination = chain.gateway?.destinations.find(
      (candidate) => candidate.id === destinationChainId,
    );
    if (!destination) {
      throw new Error(
        `Gateway destination ${destinationChainId} is not configured`,
      );
    }
    return {
      chain: destination.id === "arbitrum" ? arbitrumChain : solanaChain,
      gatewayDepository: destination.gatewayDepository,
      usdc: destination.usdc,
      circleDomain: destination.circleDomain,
    };
  },
}));

jest.mock("../../../../src/common/vm/ethereum-vm/rpc", () => ({
  httpRpc: jest.fn(),
}));

jest.mock("../../../../src/common/rpc-usage", () => ({
  getTrackingId: () => "tracking-id",
  logRpcUsage: jest.fn(async () => undefined),
}));

const generateDepositLog = (params: {
  transactionHash: Hex;
  logIndex: number;
  depository: Hex;
  token: Hex;
  depositor: Hex;
  amount: bigint;
  depositId: Hex;
}): Log<bigint, number, false> => ({
  address: params.depository,
  blockHash: randomHex(32) as Hex,
  blockNumber: 100n,
  data: encodeAbiParameters(
    [
      { name: "from", type: "address" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "id", type: "bytes32" },
    ],
    [params.depositor, params.token, params.amount, params.depositId],
  ),
  logIndex: params.logIndex,
  removed: false,
  topics: encodeEventTopics({
    abi: ABI,
    eventName: "RelayErc20Deposit",
  }) as [Hex],
  transactionHash: params.transactionHash,
  transactionIndex: 0,
});

const generateReceipt = (
  transactionHash: Hex,
  logs: Log<bigint, number, false>[],
): TransactionReceipt => ({
  blockHash: randomHex(32) as Hex,
  blockNumber: 100n,
  contractAddress: null,
  cumulativeGasUsed: 0n,
  effectiveGasPrice: 0n,
  from: randomHex(20) as Hex,
  gasUsed: 0n,
  logs,
  logsBloom: randomHex(256) as Hex,
  status: "success",
  to: GATEWAY_DEPOSITORY as Hex,
  transactionHash,
  transactionIndex: 0,
  type: "eip1559",
});

const mockRpc = (receipt: TransactionReceipt) => {
  (httpRpc as jest.Mock).mockReturnValue({
    getTransactionReceipt: jest.fn(async () => receipt),
    getBlock: jest.fn().mockImplementation((params?: { blockNumber: bigint }) =>
      params?.blockNumber
        ? Promise.resolve({ number: 100n, timestamp: 1_000n })
        : Promise.resolve({ number: 120n, timestamp: 1_100n }),
    ),
  });
};

const encodeGatewayWithdrawal = (
  expiration: number,
  overrides?: {
    destinationChainId?: string;
    destinationDomain?: number;
    sourceDomain?: number;
    sourceToken?: Hex;
  },
) => {
  const executionPayload = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "transferSpecHash", type: "bytes32" },
          {
            name: "calls",
            type: "tuple[]",
            components: [
              { name: "to", type: "address" },
              { name: "data", type: "bytes" },
              { name: "value", type: "uint256" },
              { name: "allowFailure", type: "bool" },
            ],
          },
          { name: "nonce", type: "uint256" },
          { name: "expiration", type: "uint256" },
        ],
      },
    ],
    [
      {
        transferSpecHash: TRANSFER_SPEC_HASH as Hex,
        calls: [],
        nonce: 1n,
        expiration: BigInt(expiration),
      },
    ],
  );

  return encodeWithdrawal({
    vmType: "gateway-vm",
    withdrawal: {
      destinationChainId: overrides?.destinationChainId ?? "arbitrum",
      executionPayload,
      burnIntent: {
        maxBlockHeight: "1000000",
        maxFee: "1000",
        spec: {
          version: 1,
          sourceDomain: overrides?.sourceDomain ?? 3,
          destinationDomain: overrides?.destinationDomain ?? 3,
          sourceContract: randomHex(32),
          destinationContract: ETHEREUM_VM_GATEWAY_MINTER,
          sourceToken:
            overrides?.sourceToken ?? pad(USDC as Hex, { size: 32 }),
          destinationToken: pad(USDC as Hex, { size: 32 }),
          sourceDepositor: randomHex(32),
          destinationRecipient: pad(
            DESTINATION_GATEWAY_DEPOSITORY as Hex,
            { size: 32 },
          ),
          sourceSigner: randomHex(32),
          destinationCaller: pad(
            DESTINATION_GATEWAY_DEPOSITORY as Hex,
            { size: 32 },
          ),
          value: "1000000",
          salt: randomHex(32),
          hookData: "0x",
        },
      },
    },
  });
};

const mockWithdrawalRpc = (params: {
  executed: boolean;
  latestTimestamp: bigint;
  finalizedTimestamp: bigint;
}) => {
  const readContract = jest.fn(async () => params.executed);
  const getBlock = jest
    .fn()
    .mockImplementation((request?: { blockNumber: bigint }) =>
      request?.blockNumber
        ? Promise.resolve({
            number: request.blockNumber,
            timestamp: params.finalizedTimestamp,
          })
        : Promise.resolve({
            number: 120n,
            timestamp: params.latestTimestamp,
          }),
    );
  (httpRpc as jest.Mock).mockReturnValue({ getBlock, readContract });
  return { getBlock, readContract };
};

describe("GatewayVmAttestor", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rejects a Gateway source VM without a deposit implementation", async () => {
    await expect(
      new GatewayVmAttestor().getDepositoryDepositMessages(
        "solana-gateway",
        randomHex(32),
      ),
    ).rejects.toThrow("Gateway source vm type solana-vm is not implemented");
  });

  it("rejects transaction ids which alias to the same transaction", async () => {
    const transactionHash = randomHex(32) as Hex;
    const depositor = randomHex(20) as Hex;
    const depositId = randomHex(32) as Hex;

    // Mock a valid deposit so only the id check can reject the aliases
    const validLog = generateDepositLog({
      transactionHash,
      logIndex: 0,
      depository: GATEWAY_DEPOSITORY as Hex,
      token: USDC as Hex,
      depositor,
      amount: 1_000_000n,
      depositId,
    });
    mockRpc(generateReceipt(transactionHash, [validLog]));

    const attestor = new GatewayVmAttestor();
    for (const aliased of [
      transactionHash.slice(2),
      `${transactionHash} `,
      `${transactionHash}\n`,
      `${transactionHash}deadbeef`,
      `0x${transactionHash}`,
      `0x${transactionHash.slice(2).toUpperCase()}`,
    ]) {
      await expect(
        attestor.getDepositoryDepositMessages("arbitrum-gateway", aliased),
      ).rejects.toThrow(/Invalid gateway-vm transaction id/);
    }

    await expect(
      attestor.getDepositoryDepositMessages(
        "arbitrum-gateway",
        transactionHash,
      ),
    ).resolves.toHaveLength(1);
  });

  it("attests deposits emitted by the Gateway depository", async () => {
    const transactionHash = randomHex(32) as Hex;
    const depositor = randomHex(20) as Hex;
    const depositId = randomHex(32) as Hex;
    const amount = 1_000_000n;
    const validLog = generateDepositLog({
      transactionHash,
      logIndex: 2,
      depository: GATEWAY_DEPOSITORY as Hex,
      token: USDC as Hex,
      depositor,
      amount,
      depositId,
    });
    const wrongDepositoryLog = generateDepositLog({
      transactionHash,
      logIndex: 0,
      depository: randomHex(20) as Hex,
      token: USDC as Hex,
      depositor,
      amount,
      depositId: randomHex(32) as Hex,
    });
    mockRpc(
      generateReceipt(transactionHash, [validLog, wrongDepositoryLog]),
    );

    const messages =
      await new GatewayVmAttestor().getDepositoryDepositMessages(
        "arbitrum-gateway",
        transactionHash,
      );

    expect(messages).toEqual([
      {
        data: {
          chainId: "arbitrum-gateway",
          transactionId: transactionHash,
        },
        result: {
          onchainId: getDeterministicId(
            "arbitrum-gateway",
            "arbitrum",
            transactionHash,
            "2",
          ),
          depository: GATEWAY_DEPOSITORY,
          depositId: depositId.toLowerCase(),
          depositor: depositor.toLowerCase(),
          currency: zeroAddress,
          amount: amount.toString(),
        },
        extraData: {
          timestamp: "1000",
        },
      },
    ]);
    expect(httpRpc).toHaveBeenCalledWith("arbitrum");
  });

  it("rejects a deposit for a token other than the configured USDC", async () => {
    const transactionHash = randomHex(32) as Hex;
    const otherToken = randomHex(20) as Hex;
    mockRpc(
      generateReceipt(transactionHash, [
        generateDepositLog({
          transactionHash,
          logIndex: 0,
          depository: GATEWAY_DEPOSITORY as Hex,
          token: otherToken,
          depositor: randomHex(20) as Hex,
          amount: 1_000_000n,
          depositId: randomHex(32) as Hex,
        }),
      ]),
    );

    await expect(
      new GatewayVmAttestor().getDepositoryDepositMessages(
        "arbitrum-gateway",
        transactionHash,
      ),
    ).rejects.toThrow(
      `Gateway deposit token ${otherToken} does not match the configured USDC on arbitrum`,
    );
  });

  it("rejects a deposit before subchain finality", async () => {
    const transactionHash = randomHex(32) as Hex;
    const receipt = generateReceipt(transactionHash, [
      generateDepositLog({
        transactionHash,
        logIndex: 0,
        depository: GATEWAY_DEPOSITORY as Hex,
        token: USDC as Hex,
        depositor: randomHex(20) as Hex,
        amount: 1_000_000n,
        depositId: randomHex(32) as Hex,
      }),
    ]);
    (httpRpc as jest.Mock).mockReturnValue({
      getTransactionReceipt: jest.fn(async () => receipt),
      getBlock: jest
        .fn()
        .mockImplementation((params?: { blockNumber: bigint }) =>
          params?.blockNumber
            ? Promise.resolve({ number: 100n, timestamp: 1_000n })
            : Promise.resolve({ number: 105n, timestamp: 1_030n }),
        ),
    });

    await expect(
      new GatewayVmAttestor().getDepositoryDepositMessages(
        "arbitrum-gateway",
        transactionHash,
      ),
    ).rejects.toThrow(`Transaction ${transactionHash} is not finalized`);
  });

  it("attests a finalized Gateway destination call request as executed", async () => {
    const withdrawal = encodeGatewayWithdrawal(1_000);
    const withdrawalId = getDecodedWithdrawalId(
      decodeWithdrawal(withdrawal, "gateway-vm"),
    );
    const { readContract } = mockWithdrawalRpc({
      executed: true,
      latestTimestamp: 1_100n,
      finalizedTimestamp: 1_050n,
    });

    const message =
      await new GatewayVmAttestor().getDepositoryWithdrawalMessage(
        "arbitrum-gateway",
        withdrawal,
      );

    expect(message).toEqual({
      data: {
        chainId: "arbitrum-gateway",
        withdrawal,
      },
      result: {
        withdrawalId,
        depository: DESTINATION_GATEWAY_DEPOSITORY,
        status: DepositoryWithdrawalStatus.EXECUTED,
      },
    });
    expect(httpRpc).toHaveBeenCalledWith("arbitrum");
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: DESTINATION_GATEWAY_DEPOSITORY,
        functionName: "callRequests",
        args: [withdrawalId],
        blockNumber: 110n,
      }),
    );
  });

  it("keeps an unexecuted Gateway request pending inside the finality window", async () => {
    const withdrawal = encodeGatewayWithdrawal(1_000);
    mockWithdrawalRpc({
      executed: false,
      latestTimestamp: 1_040n,
      finalizedTimestamp: 1_001n,
    });

    const message =
      await new GatewayVmAttestor().getDepositoryWithdrawalMessage(
        "arbitrum-gateway",
        withdrawal,
      );

    expect(message.result.status).toBe(DepositoryWithdrawalStatus.PENDING);
  });

  it("attests an unexecuted finalized Gateway request as expired", async () => {
    const withdrawal = encodeGatewayWithdrawal(1_000);
    mockWithdrawalRpc({
      executed: false,
      latestTimestamp: 1_100n,
      finalizedTimestamp: 1_050n,
    });

    const message =
      await new GatewayVmAttestor().getDepositoryWithdrawalMessage(
        "arbitrum-gateway",
        withdrawal,
      );

    expect(message.result.status).toBe(DepositoryWithdrawalStatus.EXPIRED);
  });

  it("rejects a withdrawal whose burn intent disagrees with destination config", async () => {
    const withdrawal = encodeGatewayWithdrawal(1_000, {
      destinationDomain: 6,
    });

    await expect(
      new GatewayVmAttestor().getDepositoryWithdrawalMessage(
        "arbitrum-gateway",
        withdrawal,
      ),
    ).rejects.toThrow(
      "Gateway withdrawal routing does not match configured destination arbitrum",
    );
    expect(httpRpc).not.toHaveBeenCalled();
  });

  it("rejects a withdrawal whose burn intent has the wrong source domain", async () => {
    const withdrawal = encodeGatewayWithdrawal(1_000, { sourceDomain: 6 });

    await expect(
      new GatewayVmAttestor().getDepositoryWithdrawalMessage(
        "arbitrum-gateway",
        withdrawal,
      ),
    ).rejects.toThrow(
      "Gateway withdrawal routing does not match configured source arbitrum",
    );
    expect(httpRpc).not.toHaveBeenCalled();
  });

  it("rejects a withdrawal whose burn intent has the wrong source token", async () => {
    const withdrawal = encodeGatewayWithdrawal(1_000, {
      sourceToken: pad(randomHex(20) as Hex, { size: 32 }),
    });

    await expect(
      new GatewayVmAttestor().getDepositoryWithdrawalMessage(
        "arbitrum-gateway",
        withdrawal,
      ),
    ).rejects.toThrow(
      "Gateway withdrawal routing does not match configured source arbitrum",
    );
    expect(httpRpc).not.toHaveBeenCalled();
  });
});
