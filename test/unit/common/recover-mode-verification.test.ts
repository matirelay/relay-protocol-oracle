import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { Hex, keccak256, verifyMessage } from "viem";

import { Order, getOrderId } from "@relay-protocol/settlement-sdk";

import { validateRecoverMode } from "../../../src/common/recover-mode-verification";
import { AttestationService } from "../../../src/services/attestation";
import { getDeterministicId } from "../../../src/services/attestation/utils";
import { getVmAttestor } from "../../../src/services/attestation/vm";
import { Chain, getSdkChainsConfig } from "../../../src/common/chains";
import { getHubHttpRpc } from "../../../src/common/hub";

jest.mock("../../../src/services/attestation/vm");
jest.mock("../../../src/common/chains");
jest.mock("../../../src/common/hub", () => ({
  getBalanceOnHub: jest.fn().mockImplementation(() => Promise.resolve(10000n)),
  getHubHttpRpc: jest.fn(),
}));

jest.mock("viem", () => {
  const viem = jest.requireActual("viem") as typeof import("viem");
  return {
    ...viem,
    verifyMessage: jest.fn().mockImplementation(() => Promise.resolve(true)),
    verifyTypedData: jest.fn().mockImplementation(() => Promise.resolve(true)),
  };
});

jest.mock("../../../src/common/chains", () => {
  const chains: Record<string, Chain> = {
    ethereum: {
      id: "ethereum",
      vmType: "ethereum-vm",
      httpRpcUrl: "http://127.0.0.1:8545",
      depository: "0x0987654321098765432109876543210987654321",
      additionalData: { evmChainId: "1" },
    },
    solana: {
      id: "solana",
      vmType: "solana-vm",
      httpRpcUrl: "http://127.0.0.1:8899",
      depository: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    },
  };
  return {
    getChains: async () => chains,
    getChain: async (chainId: string) => chains[chainId],
    getChainVmType: jest.fn().mockImplementation(async (chainId) => {
      if (chainId === "ethereum") return "ethereum-vm";
      if (chainId === "solana") return "solana-vm";
      throw new Error(`Unknown chain: ${chainId}`);
    }),
    getHubInfo: jest.fn().mockImplementation(async () => ({
      id: "hub",
      evmChainId: "1",
      httpRpcUrl: "http://localhost:8545",
      hubAddress: "0x0000000000000000000000000000000000000001",
      oracleAddress: "0x0000000000000000000000000000000000000002",
      oracleMultisigAddress: "0x0000000000000000000000000000000000000003",
      genericMappingAddress: "0x0000000000000000000000000000000000000004",
      allocatorAddress: "0x0000000000000000000000000000000000000005",
    })),
    getSdkChainsConfig: jest.fn(() => ({
      ethereum: "ethereum-vm",
      solana: "solana-vm",
    })),
  };
});

const mockGetVmAttestor = jest.mocked(getVmAttestor);

describe("validateRecoverMode", () => {
  const service = new AttestationService();

  // A slow refund returns a deposit to the address that made it, so depositor,
  // owner and refund recipient are necessarily the same address.
  // Use lowercase canonical form for the order; tests will check that
  // checksum-cased params still match.
  const depositor = "0xaaaabbbbccccddddeeeeffff0011223344556677";
  // Order data sent to the oracle is the raw form built by the solver
  // (chain-native addresses — `normalizeOrder` only runs inside `getOrderId`
  // for hashing, never mutates the stored Order). For ethereum-vm this means
  // refund addresses can be checksum or lowercase; the encode-based compare
  // must tolerate either side appearing in either form.
  const refundRecipientLower = depositor;
  const refundRecipientChecksum = "0xaaAAbbBBccCCddDDeeEEffff0011223344556677";
  // A recipient that is not the depositor — never valid for a slow refund.
  const strangerRecipient = "0x1234567890123456789012345678901234567890";
  const solver = "0x0987654321098765432109876543210987654321";
  const currencyLower = "0xdac17f958d2ee523a2206206994597c13d831ec7"; // USDT lowercase
  const currencyChecksum = "0xdAC17F958D2ee523a2206206994597C13D831ec7"; // USDT checksum

  // Solana fixtures — base58 mints / pubkeys. Encoding is bs58 → bytes → hex,
  // so a clean round-trip is the real test of `encodeAddress` for non-EVM VMs.
  const solRecipient = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const solUsdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const solUsdtMint = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
  const amount = "1000";
  const chainId = "ethereum";
  const depositChainId = "ethereum";
  const transactionId =
    "0x552985b36c59902b24fde1437a11a2698347aa5ca2bf82697d0f8e8e1e35cc6e";
  const onchainId =
    "0x0000000000000000000000000000000000000000000000000000000000000999";

  const buildOrder = (overrides?: {
    refundChainId?: string;
    refundRecipient?: string;
    refundCurrency?: string;
    inputCount?: number;
  }): Order => {
    const refundChainId = overrides?.refundChainId ?? chainId;
    const refundRecipient = overrides?.refundRecipient ?? refundRecipientLower;
    const refundCurrency = overrides?.refundCurrency ?? currencyLower;
    const inputCount = overrides?.inputCount ?? 1;
    const input = {
      payment: { chainId, currency: currencyLower, amount, weight: "1" },
      refunds: [
        {
          chainId: refundChainId,
          recipient: refundRecipient,
          currency: refundCurrency,
          minimumAmount: amount,
          deadline: Math.floor(Date.now() / 1000) + 3600,
          extraData: "0x",
        },
      ],
    };
    return {
      version: "v1",
      salt: "0x1",
      solverChainId: chainId,
      solver,
      inputs: Array.from({ length: inputCount }, () => input),
      output: {
        chainId,
        payments: [
          {
            recipient: "0x3333333333333333333333333333333333333333",
            currency: currencyLower,
            minimumAmount: amount,
            expectedAmount: amount,
          },
        ],
        calls: [],
        extraData: "0x",
        deadline: Math.floor(Date.now() / 1000) + 3600,
      },
      fees: [],
    };
  };

  const buildDeposit = (overrides?: {
    depositId?: Hex;
    amount?: string;
    chainId?: string;
    currency?: string;
    depositor?: string;
  }) => ({
    data: { chainId: overrides?.chainId ?? depositChainId, transactionId },
    result: {
      depositor: overrides?.depositor ?? depositor,
      depository: "0x0987654321098765432109876543210987654321",
      currency: overrides?.currency ?? currencyLower,
      amount: overrides?.amount ?? amount,
      onchainId,
      depositId: overrides?.depositId ?? keccak256("0xdead" as Hex),
    },
    extraData: { timestamp: String(Math.floor(Date.now() / 1000)) },
  });

  // recoverMode nonces are derived from the deposit rather than caller-chosen,
  // so one deposit authorizes exactly one withdrawal (see DEC-1660).
  const depositNonce = getDeterministicId(onchainId, "recover-withdrawal");

  const setupMockAttestor = (messages: ReturnType<typeof buildDeposit>[]) => {
    const mockAttestor: any = {
      getDepositoryDepositMessages: jest
        .fn<() => Promise<ReturnType<typeof buildDeposit>[]>>()
        .mockResolvedValue(messages),
    };
    mockGetVmAttestor.mockResolvedValue(mockAttestor);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: getEntry returns a non-zero createdAt so no-fill-or-refund
    // passes; tests can override.
    jest.mocked(getHubHttpRpc).mockResolvedValue({
      readContract: jest.fn<any>().mockResolvedValue(["0x01", 1000n]),
    } as any);
    jest.mocked(verifyMessage).mockResolvedValue(true);
  });

  const baseParams = {
    chainId,
    currency: currencyLower,
    amount,
    recipient: refundRecipientLower,
    owner: depositor,
    ownerChainId: depositChainId,
    depositChainId,
    depositTransactionId: transactionId,
    depositOnchainId: onchainId,
    orderSignature: "0x" + "00".repeat(65),
  };

  it("happy path — all invariants pass", async () => {
    const order = buildOrder();
    const orderId = getOrderId(order, await getSdkChainsConfig());
    setupMockAttestor([buildDeposit({ depositId: orderId })]);

    await expect(
      validateRecoverMode({
        attestationService: service,
        order,
        ...baseParams,
      }),
    ).resolves.toBeDefined();
  });

  it("rejects when amount does not equal deposit amount (F-001)", async () => {
    const order = buildOrder();
    const orderId = getOrderId(order, await getSdkChainsConfig());
    setupMockAttestor([buildDeposit({ depositId: orderId, amount: "1000" })]);

    await expect(
      validateRecoverMode({
        attestationService: service,
        order,
        ...baseParams,
        amount: "999", // 1 wei short of deposit
      }),
    ).rejects.toThrow(/Amount does not match the deposit amount/);
  });

  it("accepts EVM checksum-cased recipient (F-005)", async () => {
    // Order has refund.recipient in lowercase canonical form.
    const order = buildOrder({ refundRecipient: refundRecipientLower });
    const orderId = getOrderId(order, await getSdkChainsConfig());
    setupMockAttestor([buildDeposit({ depositId: orderId })]);

    // Caller passes the same address in checksum (mixed-case) form.
    await expect(
      validateRecoverMode({
        attestationService: service,
        order,
        ...baseParams,
        recipient: refundRecipientChecksum,
      }),
    ).resolves.toBeDefined();
  });

  it("matches currency when order is lowercase and caller passes checksum", async () => {
    const order = buildOrder({ refundCurrency: currencyLower });
    const orderId = getOrderId(order, await getSdkChainsConfig());
    setupMockAttestor([buildDeposit({ depositId: orderId })]);

    await expect(
      validateRecoverMode({
        attestationService: service,
        order,
        ...baseParams,
        currency: currencyChecksum,
      }),
    ).resolves.toBeDefined();
  });

  it("matches currency when order is checksum and caller passes lowercase", async () => {
    const order = buildOrder({ refundCurrency: currencyChecksum });
    const orderId = getOrderId(order, await getSdkChainsConfig());
    setupMockAttestor([buildDeposit({ depositId: orderId })]);

    await expect(
      validateRecoverMode({
        attestationService: service,
        order,
        ...baseParams,
        currency: currencyLower,
      }),
    ).resolves.toBeDefined();
  });

  it("rejects when currency does not match any refund entry", async () => {
    const order = buildOrder();
    const orderId = getOrderId(order, await getSdkChainsConfig());
    setupMockAttestor([buildDeposit({ depositId: orderId })]);

    await expect(
      validateRecoverMode({
        attestationService: service,
        order,
        ...baseParams,
        currency: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      }),
    ).rejects.toThrow(/Expected exactly 1 refund entry/);
  });

  // Cross-VM coverage: exercises the bs58 → bytes → hex path inside
  // `encodeAddress` to confirm the comparison works for non-EVM VMs.
  // A Solana deposit recovered back to the depositing address — the withdrawal
  // chain, currency and owner all track the deposit.
  const solanaParams = {
    ...baseParams,
    chainId: "solana",
    depositChainId: "solana",
    ownerChainId: "solana",
    owner: solRecipient,
    recipient: solRecipient,
    currency: solUsdcMint,
  };

  const buildSolanaDeposit = (depositId: Hex) =>
    buildDeposit({
      depositId,
      chainId: "solana",
      currency: solUsdcMint,
      depositor: solRecipient,
    });

  it("matches Solana base58 currency end-to-end (happy path)", async () => {
    const order = buildOrder({
      refundChainId: "solana",
      refundRecipient: solRecipient,
      refundCurrency: solUsdcMint,
    });
    const orderId = getOrderId(order, await getSdkChainsConfig());
    setupMockAttestor([buildSolanaDeposit(orderId)]);

    await expect(
      validateRecoverMode({
        attestationService: service,
        order,
        ...solanaParams,
      }),
    ).resolves.toBeDefined();
  });

  it("rejects when Solana currency is a different mint", async () => {
    const order = buildOrder({
      refundChainId: "solana",
      refundRecipient: solRecipient,
      refundCurrency: solUsdcMint,
    });
    const orderId = getOrderId(order, await getSdkChainsConfig());
    setupMockAttestor([buildSolanaDeposit(orderId)]);

    await expect(
      validateRecoverMode({
        attestationService: service,
        order,
        ...solanaParams,
        currency: solUsdtMint, // valid base58, but wrong mint
      }),
    ).rejects.toThrow(/Expected exactly 1 refund entry/);
  });

  it("rejects multi-input orders", async () => {
    const order = buildOrder({ inputCount: 2 });
    setupMockAttestor([buildDeposit()]);

    await expect(
      validateRecoverMode({
        attestationService: service,
        order,
        ...baseParams,
      }),
    ).rejects.toThrow(/single-input/);
  });

  // DEC-1660: recoverMode must move the funds of the deposit it cites, exactly
  // once. Without these bindings a single deposit authorizes repeated
  // withdrawals of an arbitrary currency out of the owner's pooled alias.

  it("rejects when the withdrawal chain differs from the deposit chain", async () => {
    // Refund entry is on solana so the refund lookup succeeds; only the
    // withdrawal chain diverges from the ethereum deposit.
    const order = buildOrder({
      refundChainId: "solana",
      refundRecipient: solRecipient,
      refundCurrency: solUsdcMint,
    });
    const orderId = getOrderId(order, await getSdkChainsConfig());
    setupMockAttestor([buildDeposit({ depositId: orderId })]);

    await expect(
      validateRecoverMode({
        attestationService: service,
        order,
        ...baseParams,
        chainId: "solana",
        recipient: solRecipient,
        currency: solUsdcMint,
      }),
    ).rejects.toThrow(/Withdrawal chain does not match the deposit chain/);
  });

  it("rejects when the withdrawal currency differs from the deposit currency", async () => {
    // The refund entry names the requested currency, so the only mismatch left
    // is against the currency actually deposited.
    const order = buildOrder({ refundCurrency: currencyLower });
    const orderId = getOrderId(order, await getSdkChainsConfig());
    setupMockAttestor([
      buildDeposit({
        depositId: orderId,
        currency: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      }),
    ]);

    await expect(
      validateRecoverMode({
        attestationService: service,
        order,
        ...baseParams,
      }),
    ).rejects.toThrow(
      /Withdrawal currency does not match the deposit currency/,
    );
  });

  it("returns the nonce derived from the deposit", async () => {
    // The caller does not choose it: one deposit maps to one withdraw request
    // hash, so the Hub rejects replays of the same recovery.
    const order = buildOrder();
    const orderId = getOrderId(order, await getSdkChainsConfig());
    setupMockAttestor([buildDeposit({ depositId: orderId })]);

    await expect(
      validateRecoverMode({
        attestationService: service,
        order,
        ...baseParams,
      }),
    ).resolves.toEqual({ nonce: depositNonce });
  });

  it("rejects when the recipient is not the depositor", async () => {
    // Both the order refund entry and the request name the same recipient, so
    // the only failure left is that it is not the address that deposited.
    const order = buildOrder({ refundRecipient: strangerRecipient });
    const orderId = getOrderId(order, await getSdkChainsConfig());
    setupMockAttestor([buildDeposit({ depositId: orderId })]);

    await expect(
      validateRecoverMode({
        attestationService: service,
        order,
        ...baseParams,
        recipient: strangerRecipient,
      }),
    ).rejects.toThrow(/Recipient is not the deposit's depositor/);
  });

  it("rejects when any recoverMode field is missing", async () => {
    const order = buildOrder();
    setupMockAttestor([buildDeposit()]);

    const { depositTransactionId: _omit, ...partialParams } = baseParams;

    await expect(
      validateRecoverMode({
        attestationService: service,
        order,
        ...partialParams,
      } as any),
    ).rejects.toThrow(
      /recoverMode requires depositChainId, depositTransactionId/,
    );
  });
});
