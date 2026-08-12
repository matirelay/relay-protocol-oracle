import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import {
  TransactionStatus,
  TransactionType,
} from "@reservoir0x/lighter-ts-sdk";
import {
  encodeWithdrawal,
  DepositoryWithdrawalStatus,
  getDecodedWithdrawalId,
} from "@relay-protocol/settlement-sdk";
import axios from "axios";

import { Chain } from "../../../../src/common/chains";
import { httpRpc } from "../../../../src/common/vm/lighter-vm/rpc";
import { LighterVmAttestor } from "../../../../src/services/attestation/vm/lighter-vm";

import { randomHex } from "../../../common/utils";

const testDepositoryAddress = "460491";
const testAdditionalDepositoryAddress = "460492";
const testRecipientAddress = "462196";

// Lighter tx ids are 40-byte hashes, hex without the 0x prefix
const randomLighterTxId = () => randomHex(40).slice(2);

jest.mock("../../../../src/common/chains", () => {
  const chains: Record<string, Chain> = {
    lighter: {
      id: "lighter",
      vmType: "lighter-vm",
      httpRpcUrl: "https://api.lighter.xyz",
      depository: "460491",
      additionalDepositories: ["460492"],
      additionalData: {
        explorerApiUrl: "https://explorer.elliot.ai/api",
      },
    },
  };
  return {
    HUB_VM_TYPE: "hub-vm",
    HUB_CHAIN_ID: 0n,
    getChains: async () => chains,
    getHubChains: async () => [],
    getChain: async (chainId: string) => chains[chainId],
    getChainVmType: async (chainId: string) =>
      chainId === "base" ? "ethereum-vm" : chains[chainId].vmType,
    getSdkChainsConfig: () =>
      Object.fromEntries(
        Object.values(chains).map((chain) => [chain.id, chain.vmType]),
      ),
  };
});

jest.mock("../../../../src/common/vm/lighter-vm/rpc", () => {
  return {
    httpRpc: jest.fn(),
  };
});

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

const setupRpcMock = (mockData: any) => {
  (httpRpc as jest.Mock).mockImplementation(() => {
    return Promise.resolve({
      ...mockData,
    });
  });
};

// Helper to create a valid TransferTxInfo for tests
const createTransferTxInfo = (overrides: any = {}) => ({
  FromAccountIndex: Number(testDepositoryAddress),
  ApiKeyIndex: 4,
  ToAccountIndex: Number(testRecipientAddress),
  AssetIndex: 3,
  FromRouteType: 0,
  ToRouteType: 0,
  Amount: 1000000,
  USDCFee: 3000000,
  Memo: Array.from(Buffer.from("abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234", "hex")), // 32 bytes, no trailing zeros
  ExpiredAt: 1763299591909,
  Nonce: 1,
  Sig: "signature",
  L1Sig: "0x1234...",
  ...overrides,
});

// Helper to create matching decoded withdrawal params from a TransferTxInfo
const createMatchingWithdrawal = (
  info: ReturnType<typeof createTransferTxInfo>,
  lighterChainId: string = "304",
) => ({
  vmType: "lighter-vm" as const,
  withdrawal: {
    actionType: 0,
    parameters: {
      type: "Transfer" as const,
      nonce: info.Nonce.toString(),
      fromAccountIndex: info.FromAccountIndex.toString(),
      fromRouteType: info.FromRouteType.toString(),
      apiKeyIndex: info.ApiKeyIndex.toString(),
      toAccountIndex: info.ToAccountIndex.toString(),
      toRouteType: info.ToRouteType.toString(),
      assetIndex: info.AssetIndex.toString(),
      amount: info.Amount.toString(),
      usdcFee: info.USDCFee.toString(),
      lighterChainId,
      memo: Buffer.from(info.Memo).toString("hex").padEnd(64, "0"),
    },
  },
});

describe("LighterVmAttestor", () => {
  describe("getSolverPaidAmount", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("should reject a non-canonical transaction id", async () => {
      const attestor = new LighterVmAttestor();
      await expect(
        attestor.getSolverPaidAmount("lighter", `${randomLighterTxId()} `, {
          currency: "0",
          recipient: testRecipientAddress,
          orderId: `0x${"ab".repeat(32)}`,
          extraData: "0x",
          deadline: 9999999999,
        }),
      ).rejects.toThrow(/Invalid Lighter transaction id/);
    });

    it("should correctly verify USDC payment amount for EXECUTED and COMMITTED transactions", async () => {
      const transactionId = randomLighterTxId();
      const paymentAmount = 1000000; // 1 USDC (6 decimals)

      const mockTransaction = {
        code: 200,
        hash: transactionId,
        type: TransactionType.TRANSFER,
        info: JSON.stringify({
          FromAccountIndex: Number(testDepositoryAddress),
          ApiKeyIndex: 3,
          ToAccountIndex: Number(testRecipientAddress),
          AssetIndex: 3,
          FromRouteType: 0,
          ToRouteType: 0,
          Amount: paymentAmount,
          USDCFee: 3000000,
          Memo: [116, 114, 97, 110, 115, 102, 101, 114, 45, 105, 100],
          ExpiredAt: 1763299591909,
          Nonce: 1,
          Sig: "signature",
          L1Sig: "0x1234...",
        }),
        status: TransactionStatus.EXECUTED,
        transaction_index: 443,
        l1_address: "0x8B5E4dB198FfC7f69f8F11F6592f682717dF1D92",
        account_index: Number(testDepositoryAddress),
        nonce: 1,
        expire_at: 1763299591909,
        block_height: 97526892,
        queued_at: 1763298993375,
        sequence_index: 27657305907,
        committed_at: 0,
        verified_at: 0,
        executed_at: 1763298993242,
      };

      setupRpcMock({
        transactionApi: {
          getTransaction: jest.fn(() => Promise.resolve(mockTransaction)),
        },
      });

      const payment = {
        currency: "0", // LVM native currency (USDC)
        recipient: testRecipientAddress,
        orderId: "0x7472616e736665722d6964",
        extraData: "",
        deadline: Math.floor(mockTransaction.queued_at / 1000) + 3600, // 1 hour after transaction
      };

      const attestor = new LighterVmAttestor();
      const paidAmount = await attestor.getSolverPaidAmount(
        "lighter",
        transactionId,
        payment,
      );

      expect(paidAmount).toBe(BigInt(paymentAmount));

      // Also test COMMITTED status
      mockTransaction.status = TransactionStatus.COMMITTED;
      const paidAmount2 = await attestor.getSolverPaidAmount(
        "lighter",
        transactionId,
        payment,
      );
      expect(paidAmount2).toBe(BigInt(paymentAmount));
    });

    it("should throw error when transaction is not found", async () => {
      const transactionId = randomLighterTxId();

      setupRpcMock({
        transactionApi: {
          getTransaction: jest.fn(() => Promise.resolve(null)),
        },
      });

      const payment = {
        currency: "0",
        recipient: testRecipientAddress,
        orderId: "test-order-id",
        extraData: "",
        deadline: Math.floor(Date.now() / 1000) + 3600,
      };

      const attestor = new LighterVmAttestor();

      try {
        await attestor.getSolverPaidAmount("lighter", transactionId, payment);
        expect(false).toBe(true); // Should not reach here
      } catch (error: any) {
        expect(error.message).toContain(`Missing transaction ${transactionId}`);
      }
    });

    it("should throw error when transaction is not committed or executed", async () => {
      const transactionId = randomLighterTxId();

      const mockTransaction = {
        hash: transactionId,
        type: TransactionType.TRANSFER,
        status: TransactionStatus.QUEUED, // Not committed or executed
        queued_at: 1763298993375,
        info: "{}",
      };

      setupRpcMock({
        transactionApi: {
          getTransaction: jest.fn(() => Promise.resolve(mockTransaction)),
        },
      });

      const payment = {
        currency: "0",
        recipient: testRecipientAddress,
        orderId: "test-order-id",
        extraData: "",
        deadline: Math.floor(Date.now() / 1000) + 3600,
      };

      const attestor = new LighterVmAttestor();

      try {
        await attestor.getSolverPaidAmount("lighter", transactionId, payment);
        expect(false).toBe(true); // Should not reach here
      } catch (error: any) {
        expect(error.message).toContain("Missing or reverted transaction");
      }
    });

    it("should throw error when transaction exceeds deadline", async () => {
      const transactionId = randomLighterTxId();
      const queuedAt = 1763298993375;

      const mockTransaction = {
        hash: transactionId,
        type: TransactionType.TRANSFER,
        status: TransactionStatus.EXECUTED,
        queued_at: queuedAt,
        info: JSON.stringify({
          FromAccountIndex: Number(testDepositoryAddress),
          ToAccountIndex: Number(testRecipientAddress),
          AssetIndex: 3,
          FromRouteType: 0,
          ToRouteType: 0,
          Amount: 1000,
        }),
      };

      setupRpcMock({
        transactionApi: {
          getTransaction: jest.fn(() => Promise.resolve(mockTransaction)),
        },
      });

      const payment = {
        currency: "0",
        recipient: testRecipientAddress,
        orderId: "test-order-id",
        extraData: "",
        deadline: Math.floor(queuedAt / 1000) - 3600, // 1 hour before transaction
      };

      const attestor = new LighterVmAttestor();

      try {
        await attestor.getSolverPaidAmount("lighter", transactionId, payment);
        expect(false).toBe(true); // Should not reach here
      } catch (error: any) {
        expect(error.message).toContain("executed after deadline");
      }
    });

    it("should throw error when payment cannot be detected", async () => {
      const transactionId = randomLighterTxId();
      const attestor = new LighterVmAttestor();

      // Test case 1: Wrong recipient
      const mockTransaction1 = {
        hash: transactionId,
        type: TransactionType.TRANSFER,
        status: TransactionStatus.EXECUTED,
        queued_at: 1763298993375,
        info: JSON.stringify({
          FromAccountIndex: Number(testDepositoryAddress),
          ToAccountIndex: Number(testRecipientAddress),
          AssetIndex: 3,
          FromRouteType: 0,
          ToRouteType: 0,
          Amount: 1000000,
          USDCFee: 3000000,
          Memo: [116, 101, 115, 116],
        }),
      };

      setupRpcMock({
        transactionApi: {
          getTransaction: jest.fn(() => Promise.resolve(mockTransaction1)),
        },
      });

      try {
        await attestor.getSolverPaidAmount("lighter", transactionId, {
          currency: "0",
          recipient: "999999", // Wrong recipient
          orderId: "0x74657374",
          extraData: "",
          deadline: Math.floor(Date.now() / 1000) + 3600,
        });
        expect(false).toBe(true);
      } catch (error: any) {
        expect(error.message).toContain("Could not detect payment");
      }

      // Test case 2: Wrong transaction type
      const mockTransaction2 = {
        ...mockTransaction1,
        type: TransactionType.WITHDRAW,
      };

      setupRpcMock({
        transactionApi: {
          getTransaction: jest.fn(() => Promise.resolve(mockTransaction2)),
        },
      });

      try {
        await attestor.getSolverPaidAmount("lighter", transactionId, {
          currency: "0",
          recipient: testRecipientAddress,
          orderId: "test-order-id",
          extraData: "",
          deadline: Math.floor(Date.now() / 1000) + 3600,
        });
        expect(false).toBe(true);
      } catch (error: any) {
        expect(error.message).toContain("Could not detect payment");
      }
    });
  });

  describe("getDepositoryDepositMessages", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("should reject transaction ids which alias to the same transaction", async () => {
      const transactionId = randomLighterTxId();
      const transferInfo = createTransferTxInfo({
        FromAccountIndex: 123456,
        ToAccountIndex: Number(testDepositoryAddress),
      });

      // Mock a valid deposit so only the id check can reject these
      setupRpcMock({
        transactionApi: {
          getTransaction: jest.fn(() =>
            Promise.resolve({
              hash: transactionId,
              type: TransactionType.TRANSFER,
              status: TransactionStatus.EXECUTED,
              queued_at: 1763298993375,
              info: JSON.stringify(transferInfo),
            }),
          ),
        },
      });

      const attestor = new LighterVmAttestor();
      for (const aliased of [
        `${transactionId} `,
        `${transactionId}\n`,
        `${transactionId}\t`,
        `${transactionId}%00`,
        `${transactionId}deadbeef`,
        `0x${transactionId}`,
      ]) {
        await expect(
          attestor.getDepositoryDepositMessages("lighter", aliased),
        ).rejects.toThrow(/Invalid Lighter transaction id/);
      }

      await expect(
        attestor.getDepositoryDepositMessages("lighter", transactionId),
      ).resolves.toHaveLength(1);
    });

    it("should return deposit message for Transfer TO depository (USDC perps)", async () => {
      const transactionId = randomLighterTxId();
      const depositorAccount = "123456";

      const transferInfo = createTransferTxInfo({
        FromAccountIndex: Number(depositorAccount),
        ToAccountIndex: Number(testDepositoryAddress),
        AssetIndex: 3,
        ToRouteType: 0, // Perps
        Amount: 5000000,
        Memo: Array.from(Buffer.from("deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "hex")),
      });

      setupRpcMock({
        transactionApi: {
          getTransaction: jest.fn(() =>
            Promise.resolve({
              hash: transactionId,
              type: TransactionType.TRANSFER,
              status: TransactionStatus.EXECUTED,
              queued_at: 1763298993375,
              info: JSON.stringify(transferInfo),
            }),
          ),
        },
      });

      const attestor = new LighterVmAttestor();
      const messages = await attestor.getDepositoryDepositMessages(
        "lighter",
        transactionId,
      );

      expect(messages).toHaveLength(1);
      expect(messages[0].result.depositor).toBe(depositorAccount);
      expect(messages[0].result.depository).toBe(testDepositoryAddress);
      expect(messages[0].result.currency).toBe("0"); // native = perps USDC
      expect(messages[0].result.amount).toBe("5000000");
      expect(messages[0].result.depositId).toBe(
        "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      );
    });

    it("should return deposit message for Transfer TO an additional depository", async () => {
      const transactionId = randomLighterTxId();
      const depositorAccount = "123456";

      const transferInfo = createTransferTxInfo({
        FromAccountIndex: Number(depositorAccount),
        ToAccountIndex: Number(testAdditionalDepositoryAddress),
        Amount: 5000000,
      });

      setupRpcMock({
        transactionApi: {
          getTransaction: jest.fn(() =>
            Promise.resolve({
              hash: transactionId,
              type: TransactionType.TRANSFER,
              status: TransactionStatus.EXECUTED,
              queued_at: 1763298993375,
              info: JSON.stringify(transferInfo),
            }),
          ),
        },
      });

      const attestor = new LighterVmAttestor();
      const messages = await attestor.getDepositoryDepositMessages(
        "lighter",
        transactionId,
      );

      expect(messages).toHaveLength(1);
      expect(messages[0].result.depository).toBe(
        testAdditionalDepositoryAddress,
      );
      expect(messages[0].result.depositor).toBe(depositorAccount);
    });

    it("should return deposit message for Transfer TO depository (USDC spot)", async () => {
      const transactionId = randomLighterTxId();

      const transferInfo = createTransferTxInfo({
        FromAccountIndex: 123456,
        ToAccountIndex: Number(testDepositoryAddress),
        AssetIndex: 3,
        ToRouteType: 1, // Spot
        Amount: 2000000,
        Memo: Array.from(Buffer.from("cafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafe", "hex")),
      });

      setupRpcMock({
        transactionApi: {
          getTransaction: jest.fn(() =>
            Promise.resolve({
              hash: transactionId,
              type: TransactionType.TRANSFER,
              status: TransactionStatus.COMMITTED,
              queued_at: 1763298993375,
              info: JSON.stringify(transferInfo),
            }),
          ),
        },
      });

      const attestor = new LighterVmAttestor();
      const messages = await attestor.getDepositoryDepositMessages(
        "lighter",
        transactionId,
      );

      expect(messages).toHaveLength(1);
      expect(messages[0].result.currency).toBe("3"); // Spot USDC = assetIndex
    });

    it("should return deposit message for Transfer TO depository (ETH spot)", async () => {
      const transactionId = randomLighterTxId();

      const transferInfo = createTransferTxInfo({
        FromAccountIndex: 123456,
        ToAccountIndex: Number(testDepositoryAddress),
        AssetIndex: 1,
        ToRouteType: 1, // Spot
        Amount: 100000,
        Memo: Array.from(Buffer.from("0102010201020102010201020102010201020102010201020102010201020102", "hex")),
      });

      setupRpcMock({
        transactionApi: {
          getTransaction: jest.fn(() =>
            Promise.resolve({
              hash: transactionId,
              type: TransactionType.TRANSFER,
              status: TransactionStatus.EXECUTED,
              queued_at: 1763298993375,
              info: JSON.stringify(transferInfo),
            }),
          ),
        },
      });

      const attestor = new LighterVmAttestor();
      const messages = await attestor.getDepositoryDepositMessages(
        "lighter",
        transactionId,
      );

      expect(messages).toHaveLength(1);
      expect(messages[0].result.currency).toBe("1"); // ETH spot = assetIndex
    });

    it("should still attest deposit with unknown asset/route combo", async () => {
      const transactionId = randomLighterTxId();

      const transferInfo = createTransferTxInfo({
        FromAccountIndex: 123456,
        ToAccountIndex: Number(testDepositoryAddress),
        AssetIndex: 99, // Unknown asset
        ToRouteType: 5, // Unknown route
        Amount: 500,
        Memo: Array.from(Buffer.from("0101010101010101010101010101010101010101010101010101010101010101", "hex")),
      });

      setupRpcMock({
        transactionApi: {
          getTransaction: jest.fn(() =>
            Promise.resolve({
              hash: transactionId,
              type: TransactionType.TRANSFER,
              status: TransactionStatus.EXECUTED,
              queued_at: 1763298993375,
              info: JSON.stringify(transferInfo),
            }),
          ),
        },
      });

      const attestor = new LighterVmAttestor();
      const messages = await attestor.getDepositoryDepositMessages(
        "lighter",
        transactionId,
      );

      // Unknown combos should still be attested (recovery flows need it)
      expect(messages).toHaveLength(1);
      expect(messages[0].result.currency).toBe("99"); // raw assetIndex
      expect(messages[0].result.amount).toBe("500");
    });

    it("should use zeroHash for depositId when Memo is not 32 bytes (non-solver deposit)", async () => {
      const transactionId = randomLighterTxId();

      const transferInfo = createTransferTxInfo({
        FromAccountIndex: 123456,
        ToAccountIndex: Number(testDepositoryAddress),
        AssetIndex: 3,
        ToRouteType: 0,
        Amount: 1000000,
        Memo: [0xde, 0xad], // only 2 bytes — not a valid orderId
      });

      setupRpcMock({
        transactionApi: {
          getTransaction: jest.fn(() =>
            Promise.resolve({
              hash: transactionId,
              type: TransactionType.TRANSFER,
              status: TransactionStatus.EXECUTED,
              queued_at: 1763298993375,
              info: JSON.stringify(transferInfo),
            }),
          ),
        },
      });

      const attestor = new LighterVmAttestor();
      const messages = await attestor.getDepositoryDepositMessages(
        "lighter",
        transactionId,
      );

      expect(messages).toHaveLength(1);
      expect(messages[0].result.depositId).toBe(
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      );
    });

    it("should use zeroHash for depositId when Memo has last 12 bytes as zero (non-Relay memo)", async () => {
      const transactionId = randomLighterTxId();

      // 20-byte address + 12 zero bytes (e.g. fast withdrawal memo)
      const memo = [
        0xab, 0xcd, 0xef, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde,
        0xf0, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      ];

      const transferInfo = createTransferTxInfo({
        FromAccountIndex: 123456,
        ToAccountIndex: Number(testDepositoryAddress),
        Memo: memo,
      });

      setupRpcMock({
        transactionApi: {
          getTransaction: jest.fn(() =>
            Promise.resolve({
              hash: transactionId,
              type: TransactionType.TRANSFER,
              status: TransactionStatus.EXECUTED,
              queued_at: 1763298993375,
              info: JSON.stringify(transferInfo),
            }),
          ),
        },
      });

      const attestor = new LighterVmAttestor();
      const messages = await attestor.getDepositoryDepositMessages(
        "lighter",
        transactionId,
      );

      expect(messages).toHaveLength(1);
      expect(messages[0].result.depositId).toBe(
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      );
    });

    it("should throw when transaction has no queued_at", async () => {
      const transactionId = randomLighterTxId();

      const transferInfo = createTransferTxInfo({
        FromAccountIndex: 123456,
        ToAccountIndex: Number(testDepositoryAddress),
      });

      setupRpcMock({
        transactionApi: {
          getTransaction: jest.fn(() =>
            Promise.resolve({
              hash: transactionId,
              type: TransactionType.TRANSFER,
              status: TransactionStatus.EXECUTED,
              info: JSON.stringify(transferInfo),
              // no queued_at
            }),
          ),
        },
      });

      const attestor = new LighterVmAttestor();
      await expect(
        attestor.getDepositoryDepositMessages("lighter", transactionId),
      ).rejects.toThrow("Missing queued_at");
    });

    it("should return empty array for Transfer NOT to depository", async () => {
      const transactionId = randomLighterTxId();

      const transferInfo = createTransferTxInfo({
        FromAccountIndex: 123456,
        ToAccountIndex: 999999, // Not the depository
      });

      setupRpcMock({
        transactionApi: {
          getTransaction: jest.fn(() =>
            Promise.resolve({
              hash: transactionId,
              type: TransactionType.TRANSFER,
              status: TransactionStatus.EXECUTED,
              queued_at: 1763298993375,
              info: JSON.stringify(transferInfo),
            }),
          ),
        },
      });

      const attestor = new LighterVmAttestor();
      const messages = await attestor.getDepositoryDepositMessages(
        "lighter",
        transactionId,
      );

      expect(messages).toHaveLength(0);
    });

    it("should return empty array for non-Transfer tx type", async () => {
      const transactionId = randomLighterTxId();

      setupRpcMock({
        transactionApi: {
          getTransaction: jest.fn(() =>
            Promise.resolve({
              hash: transactionId,
              type: TransactionType.WITHDRAW, // Not a Transfer
              status: TransactionStatus.EXECUTED,
              queued_at: 1763298993375,
              info: "{}",
            }),
          ),
        },
      });

      const attestor = new LighterVmAttestor();
      const messages = await attestor.getDepositoryDepositMessages(
        "lighter",
        transactionId,
      );

      expect(messages).toHaveLength(0);
    });

    it("should throw for missing transaction", async () => {
      const transactionId = randomLighterTxId();

      setupRpcMock({
        transactionApi: {
          getTransaction: jest.fn(() => Promise.resolve(null)),
        },
      });

      const attestor = new LighterVmAttestor();
      await expect(
        attestor.getDepositoryDepositMessages("lighter", transactionId),
      ).rejects.toThrow("Missing transaction");
    });

    it("should throw for reverted transaction", async () => {
      const transactionId = randomLighterTxId();

      setupRpcMock({
        transactionApi: {
          getTransaction: jest.fn(() =>
            Promise.resolve({
              hash: transactionId,
              type: TransactionType.TRANSFER,
              status: TransactionStatus.REJECTED,
              queued_at: 1763298993375,
              info: "{}",
            }),
          ),
        },
      });

      const attestor = new LighterVmAttestor();
      await expect(
        attestor.getDepositoryDepositMessages("lighter", transactionId),
      ).rejects.toThrow("Missing or reverted");
    });
  });

  describe("getDepositoryWithdrawalMessage", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("should reject a non-canonical fallback transaction id", async () => {
      const encodedWithdrawal = encodeWithdrawal(
        createMatchingWithdrawal(createTransferTxInfo()),
      );

      const attestor = new LighterVmAttestor();
      await expect(
        attestor.getDepositoryWithdrawalMessage(
          "lighter",
          encodedWithdrawal,
          `${randomLighterTxId()}\n`,
        ),
      ).rejects.toThrow(/Invalid Lighter transaction id/);
    });

    it("should return EXECUTED when matching tx found via Explorer API scan", async () => {
      const transferInfo = createTransferTxInfo();
      const decoded = createMatchingWithdrawal(transferInfo);
      const encodedWithdrawal = encodeWithdrawal(decoded);
      const withdrawalId = getDecodedWithdrawalId(decoded);

      // Mock Explorer API returning a matching tx with status "executed"
      mockedAxios.get.mockResolvedValueOnce({
        data: [
          {
            hash: "matching-tx-hash",
            status: "executed",
            pubdata: {
              l2_transfer_pubdata_v2: {
                from_account_index: testDepositoryAddress,
                to_account_index: testRecipientAddress,
              },
            },
          },
        ],
      });

      setupRpcMock({
        transactionApi: {
          getTransaction: jest.fn(() =>
            Promise.resolve({
              type: TransactionType.TRANSFER,
              status: TransactionStatus.EXECUTED,
              info: JSON.stringify(transferInfo),
            }),
          ),
        },
      });

      const attestor = new LighterVmAttestor();
      const result = await attestor.getDepositoryWithdrawalMessage(
        "lighter",
        encodedWithdrawal,
      );

      expect(result.result.withdrawalId).toBe(withdrawalId);
      expect(result.result.status).toBe(DepositoryWithdrawalStatus.EXECUTED);
      expect(result.result.depository).toBe(testDepositoryAddress);
    });

    it("should scan and return the additional depository encoded in the withdrawal", async () => {
      const transferInfo = createTransferTxInfo({
        FromAccountIndex: Number(testAdditionalDepositoryAddress),
      });
      const decoded = createMatchingWithdrawal(transferInfo);
      const encodedWithdrawal = encodeWithdrawal(decoded);

      mockedAxios.get.mockResolvedValueOnce({
        data: [
          {
            hash: "matching-tx-hash",
            status: "executed",
            pubdata: {
              l2_transfer_pubdata_v2: {
                from_account_index: testAdditionalDepositoryAddress,
                to_account_index: testRecipientAddress,
              },
            },
          },
        ],
      });

      setupRpcMock({
        transactionApi: {
          getTransaction: jest.fn(() =>
            Promise.resolve({
              type: TransactionType.TRANSFER,
              status: TransactionStatus.EXECUTED,
              info: JSON.stringify(transferInfo),
            }),
          ),
        },
      });

      const attestor = new LighterVmAttestor();
      const result = await attestor.getDepositoryWithdrawalMessage(
        "lighter",
        encodedWithdrawal,
      );

      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.stringContaining(
          `/accounts/${testAdditionalDepositoryAddress}/logs`,
        ),
        expect.anything(),
      );
      expect(result.result.status).toBe(DepositoryWithdrawalStatus.EXECUTED);
      expect(result.result.depository).toBe(testAdditionalDepositoryAddress);
    });

    it("should reject withdrawals from an unconfigured depository", async () => {
      const transferInfo = createTransferTxInfo({
        FromAccountIndex: 999999,
      });
      const decoded = createMatchingWithdrawal(transferInfo);
      const encodedWithdrawal = encodeWithdrawal(decoded);

      const attestor = new LighterVmAttestor();
      await expect(
        attestor.getDepositoryWithdrawalMessage("lighter", encodedWithdrawal),
      ).rejects.toThrow("Depository 999999 is not configured for chain lighter");
    });

    it("should return EXPIRED when matching tx has non-executed status", async () => {
      const transferInfo = createTransferTxInfo();
      const decoded = createMatchingWithdrawal(transferInfo);
      const encodedWithdrawal = encodeWithdrawal(decoded);

      mockedAxios.get.mockResolvedValueOnce({
        data: [
          {
            hash: "failed-tx-hash",
            status: "failed",
            pubdata: {
              l2_transfer_pubdata_v2: {
                from_account_index: testDepositoryAddress,
                to_account_index: testRecipientAddress,
              },
            },
          },
        ],
      });

      setupRpcMock({
        transactionApi: {
          getTransaction: jest.fn(() =>
            Promise.resolve({
              type: TransactionType.TRANSFER,
              info: JSON.stringify(transferInfo),
            }),
          ),
        },
      });

      const attestor = new LighterVmAttestor();
      const result = await attestor.getDepositoryWithdrawalMessage(
        "lighter",
        encodedWithdrawal,
      );

      expect(result.result.status).toBe(DepositoryWithdrawalStatus.EXPIRED);
    });

    it("should return EXPIRED when an Explorer tx consumed the nonce with a different hash", async () => {
      const transferInfo = createTransferTxInfo();
      const decoded = createMatchingWithdrawal(transferInfo);
      const encodedWithdrawal = encodeWithdrawal(decoded);
      const consumingTransferInfo = {
        ...transferInfo,
        AssetIndex: transferInfo.AssetIndex + 1,
      };

      mockedAxios.get.mockResolvedValueOnce({
        data: [
          {
            hash: "different-tx-hash",
            status: "executed",
            pubdata: {
              l2_transfer_pubdata_v2: {
                from_account_index: testDepositoryAddress,
                to_account_index: testRecipientAddress,
              },
            },
          },
        ],
      });

      setupRpcMock({
        transactionApi: {
          getTransaction: jest.fn(() =>
            Promise.resolve({
              type: TransactionType.TRANSFER,
              status: TransactionStatus.EXECUTED,
              info: JSON.stringify(consumingTransferInfo),
            }),
          ),
        },
      });

      const attestor = new LighterVmAttestor();
      const result = await attestor.getDepositoryWithdrawalMessage(
        "lighter",
        encodedWithdrawal,
      );

      expect(result.result.status).toBe(DepositoryWithdrawalStatus.EXPIRED);
    });

    it("should return EXECUTED via transactionId fallback when Explorer scan finds no match", async () => {
      const transferInfo = createTransferTxInfo();
      const decoded = createMatchingWithdrawal(transferInfo);
      const encodedWithdrawal = encodeWithdrawal(decoded);

      // Explorer scan: no matching txs (different from_account_index), then empty page
      mockedAxios.get
        .mockResolvedValueOnce({
          data: [
            {
              hash: "other-tx",
              status: "executed",
              pubdata: {
                l2_transfer_pubdata_v2: {
                  from_account_index: "999999", // Not the depository
                  to_account_index: testRecipientAddress,
                },
              },
            },
          ],
        })
        .mockResolvedValueOnce({ data: [] });

      setupRpcMock({
        transactionApi: {
          getTransaction: jest.fn(() =>
            Promise.resolve({
              type: TransactionType.TRANSFER,
              status: TransactionStatus.EXECUTED,
              info: JSON.stringify(transferInfo),
            }),
          ),
        },
      });

      const attestor = new LighterVmAttestor();
      const result = await attestor.getDepositoryWithdrawalMessage(
        "lighter",
        encodedWithdrawal,
        randomLighterTxId(),
      );

      expect(result.result.status).toBe(DepositoryWithdrawalStatus.EXECUTED);
    });

    it("should return EXPIRED via transactionId fallback when tx is pending but past ExpiredAt", async () => {
      const transferInfo = createTransferTxInfo({
        ExpiredAt: Date.now() - 120001, // expired well past the 60s buffer
      });
      const decoded = createMatchingWithdrawal(transferInfo);
      const encodedWithdrawal = encodeWithdrawal(decoded);

      // Explorer returns empty
      mockedAxios.get.mockResolvedValueOnce({ data: [] });

      setupRpcMock({
        transactionApi: {
          getTransaction: jest.fn(() =>
            Promise.resolve({
              type: TransactionType.TRANSFER,
              status: TransactionStatus.PENDING,
              info: JSON.stringify(transferInfo),
            }),
          ),
        },
      });

      const attestor = new LighterVmAttestor();
      const result = await attestor.getDepositoryWithdrawalMessage(
        "lighter",
        encodedWithdrawal,
        randomLighterTxId(),
      );

      expect(result.result.status).toBe(DepositoryWithdrawalStatus.EXPIRED);
    });

    it.each([
      TransactionStatus.EXECUTED,
      TransactionStatus.COMMITTED,
      TransactionStatus.FAILED,
      TransactionStatus.REJECTED,
    ])(
      "should return EXPIRED via transactionId fallback when a tx with status %s consumed the nonce with a different hash",
      async (txStatus) => {
        const transferInfo = createTransferTxInfo();
        const decoded = createMatchingWithdrawal(transferInfo);
        const encodedWithdrawal = encodeWithdrawal(decoded);
        const consumingTransferInfo = {
          ...transferInfo,
          Amount: transferInfo.Amount + 1,
        };

        mockedAxios.get.mockResolvedValueOnce({ data: [] });

        setupRpcMock({
          transactionApi: {
            getTransaction: jest.fn(() =>
              Promise.resolve({
                type: TransactionType.TRANSFER,
                status: txStatus,
                info: JSON.stringify(consumingTransferInfo),
              }),
            ),
          },
        });

        const attestor = new LighterVmAttestor();
        const result = await attestor.getDepositoryWithdrawalMessage(
          "lighter",
          encodedWithdrawal,
          randomLighterTxId(),
        );

        expect(result.result.status).toBe(DepositoryWithdrawalStatus.EXPIRED);
      },
    );

    it("should keep a different hash PENDING when its API key, status, currency, and amount do not consume the nonce", async () => {
      const transferInfo = createTransferTxInfo();
      const decoded = createMatchingWithdrawal(transferInfo);
      const encodedWithdrawal = encodeWithdrawal(decoded);
      const getTransaction = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValueOnce({
          type: TransactionType.TRANSFER,
          status: TransactionStatus.EXECUTED,
          info: JSON.stringify({
            ...transferInfo,
            ApiKeyIndex: transferInfo.ApiKeyIndex + 1,
          }),
        })
        .mockResolvedValueOnce({
          type: TransactionType.TRANSFER,
          status: TransactionStatus.PENDING,
          info: JSON.stringify({
            ...transferInfo,
            Amount: transferInfo.Amount + 1,
          }),
        })
        .mockResolvedValueOnce({
          type: TransactionType.TRANSFER,
          status: TransactionStatus.EXECUTED,
          info: JSON.stringify({
            ...transferInfo,
            ToAccountIndex: transferInfo.ToAccountIndex + 1,
          }),
        });

      mockedAxios.get.mockResolvedValue({ data: [] });
      setupRpcMock({ transactionApi: { getTransaction } });

      const attestor = new LighterVmAttestor();
      const differentApiKeyResult = await attestor.getDepositoryWithdrawalMessage(
        "lighter",
        encodedWithdrawal,
        randomLighterTxId(),
      );
      const pendingResult = await attestor.getDepositoryWithdrawalMessage(
        "lighter",
        encodedWithdrawal,
        randomLighterTxId(),
      );
      const sameValueResult = await attestor.getDepositoryWithdrawalMessage(
        "lighter",
        encodedWithdrawal,
        randomLighterTxId(),
      );

      expect(differentApiKeyResult.result.status).toBe(
        DepositoryWithdrawalStatus.PENDING,
      );
      expect(pendingResult.result.status).toBe(
        DepositoryWithdrawalStatus.PENDING,
      );
      expect(sameValueResult.result.status).toBe(
        DepositoryWithdrawalStatus.PENDING,
      );
    });

    it("should return PENDING when no match found", async () => {
      const transferInfo = createTransferTxInfo({ Nonce: 10 });
      const decoded = createMatchingWithdrawal(transferInfo);
      const encodedWithdrawal = encodeWithdrawal(decoded);

      // Explorer returns empty
      mockedAxios.get.mockResolvedValueOnce({ data: [] });

      setupRpcMock({
        transactionApi: {
          getTransaction: jest.fn(),
        },
      });

      const attestor = new LighterVmAttestor();
      const result = await attestor.getDepositoryWithdrawalMessage(
        "lighter",
        encodedWithdrawal,
      );

      expect(result.result.status).toBe(DepositoryWithdrawalStatus.PENDING);
    });
  });
});
