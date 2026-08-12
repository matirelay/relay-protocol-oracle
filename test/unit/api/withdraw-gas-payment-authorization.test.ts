import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { Value } from "@sinclair/typebox/value";

import endpoint from "../../../src/api/attestations/withdraw-gas-payment-authorization/v1";
import { getChain } from "../../../src/common/chains";
import { signWithdrawGasPayment } from "../../../src/common/signer";
import { verifyGasPaymentSignature } from "../../../src/common/signature-verification";
import {
  encodeAddressToHex,
  normalizeWithdrawRequest,
} from "@relay-protocol/settlement-sdk";
import axios from "axios";

const WITHDRAW_CURRENCY = "0x1111111111111111111111111111111111111111";
const FEE_CURRENCY = "0x2222222222222222222222222222222222222222";
const ENCODED_WITHDRAW_CURRENCY = `0x${"11".repeat(32)}`;
const ENCODED_FEE_CURRENCY = `0x${"22".repeat(32)}`;
const GAS_PAYER_CONTRACT = "0x3333333333333333333333333333333333333333";

const NORMALIZED_WITHDRAW_REQUEST = {
  chainId: "ton-mainnet",
  depository: "0x01",
  currency: ENCODED_WITHDRAW_CURRENCY,
  amount: "1000000",
  spenderChainId: "ethereum",
  spender: `0x${"44".repeat(20)}`,
  receiver: `0x${"55".repeat(32)}`,
  data: "0x",
  nonce: `0x${"66".repeat(32)}`,
};

const SIGN_RESULT = {
  gasPayerChainId: 537724,
  gasPayerContract: GAS_PAYER_CONTRACT,
  oracleSigner: "0x7777777777777777777777777777777777777777",
  signature: `0x${"88".repeat(65)}`,
};

jest.mock("../../../src/common/chains", () => ({
  getChain: jest.fn(async (chainId: string) =>
    chainId === "ton-mainnet"
      ? {
          id: "ton-mainnet",
          vmType: "ton-vm",
          depository: "EQDepository",
        }
      : {
          id: "ethereum",
          vmType: "ethereum-vm",
          depository: "0x9999999999999999999999999999999999999999",
        },
  ),
}));

jest.mock("../../../src/common/signature-verification", () => ({
  verifyGasPaymentSignature: jest.fn(async () => undefined),
}));

jest.mock("../../../src/common/signer", () => ({
  signWithdrawGasPayment: jest.fn(async () => SIGN_RESULT),
}));

jest.mock("@relay-protocol/settlement-sdk", () => {
  const actual = jest.requireActual(
    "@relay-protocol/settlement-sdk",
  ) as Record<string, unknown>;
  return {
    ...actual,
    encodeAddressToHex: jest.fn(() => ENCODED_FEE_CURRENCY),
    normalizeWithdrawRequest: jest.fn(() => NORMALIZED_WITHDRAW_REQUEST),
  };
});

jest.mock("../../../src/config", () => ({
  config: {
    peers: { "https://peer.example": "peer-api-key" },
  },
}));

jest.mock("axios", () => ({
  __esModule: true,
  default: {
    post: jest.fn(),
  },
}));

const body = () => ({
  chainId: "ton-mainnet",
  currency: WITHDRAW_CURRENCY,
  amount: "1000000",
  spenderChainId: "ethereum",
  spender: NORMALIZED_WITHDRAW_REQUEST.spender,
  receiver: "EQReceiver",
  nonce: NORMALIZED_WITHDRAW_REQUEST.nonce,
  feeCurrency: FEE_CURRENCY,
  feeAmount: "000250000",
  ownerSignature: `0x${"99".repeat(65)}`,
  requestPeerSignatures: false,
});

const makeReply = () => {
  const reply: any = {};
  reply.send = jest.fn().mockReturnValue(reply);
  return reply;
};

const call = async (requestBody: Record<string, unknown>) => {
  const reply = makeReply();
  await (endpoint as any).handler(
    {
      body: requestBody,
      headers: {},
      originalUrl: "/attestations/withdraw-gas-payment-authorization/v1",
    },
    reply,
  );
  return reply;
};

describe("POST /attestations/withdraw-gas-payment-authorization/v1", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getChain as jest.Mock).mockImplementation(async (chainId) =>
      chainId === "ton-mainnet"
        ? {
            id: "ton-mainnet",
            vmType: "ton-vm",
            depository: "EQDepository",
          }
        : {
            id: "ethereum",
            vmType: "ethereum-vm",
            depository: "0x9999999999999999999999999999999999999999",
          },
    );
  });

  it("authorizes and signs the canonical PayGas request", async () => {
    const requestBody = body();
    const reply = await call(requestBody);

    expect(verifyGasPaymentSignature).toHaveBeenCalledWith({
      data: {
        chainId: requestBody.chainId,
        currency: requestBody.currency,
        amount: requestBody.amount,
        ownerChainId: requestBody.spenderChainId,
        owner: requestBody.spender,
        recipient: requestBody.receiver,
        nonce: requestBody.nonce,
        additionalData: undefined,
        signatureMetadata: undefined,
        feeCurrency: requestBody.feeCurrency,
        feeAmount: "250000",
      },
      signature: requestBody.ownerSignature,
    });
    expect(normalizeWithdrawRequest).toHaveBeenCalledTimes(1);
    expect(encodeAddressToHex).toHaveBeenCalledWith(FEE_CURRENCY, "ton-vm");
    expect(signWithdrawGasPayment).toHaveBeenCalledWith(
      NORMALIZED_WITHDRAW_REQUEST,
      ENCODED_FEE_CURRENCY,
      "250000",
    );
    expect(reply.send).toHaveBeenCalledWith({
      withdrawRequest: NORMALIZED_WITHDRAW_REQUEST,
      feeCurrency: ENCODED_FEE_CURRENCY,
      feeAmount: "250000",
      gasPayerChainId: SIGN_RESULT.gasPayerChainId,
      gasPayerContract: SIGN_RESULT.gasPayerContract,
      signatures: [
        {
          oracleSigner: SIGN_RESULT.oracleSigner,
          signature: SIGN_RESULT.signature,
        },
      ],
    });
  });

  it("keeps Gateway fee currency unchanged", async () => {
    (getChain as jest.Mock).mockResolvedValueOnce({
      id: "gateway",
      vmType: "gateway-vm",
      depository: "0x9999999999999999999999999999999999999999",
    } as never);

    await call({ ...body(), chainId: "gateway" });

    expect(encodeAddressToHex).not.toHaveBeenCalled();
    expect(signWithdrawGasPayment).toHaveBeenCalledWith(
      NORMALIZED_WITHDRAW_REQUEST,
      FEE_CURRENCY,
      "250000",
    );
  });

  it.each(["0", "-1", "1.5", "not-a-number"])(
    "rejects invalid fee amount %s before signing",
    async (feeAmount) => {
      await expect(call({ ...body(), feeAmount })).rejects.toThrow(
        "feeAmount must be a positive integer",
      );
      expect(verifyGasPaymentSignature).not.toHaveBeenCalled();
      expect(signWithdrawGasPayment).not.toHaveBeenCalled();
    },
  );

  it("rejects chains whose payload builders do not use WithdrawGasPayer", async () => {
    (getChain as jest.Mock).mockResolvedValueOnce({
      id: "ethereum",
      vmType: "ethereum-vm",
      depository: "0x9999999999999999999999999999999999999999",
    } as never);

    await expect(
      call({ ...body(), chainId: "ethereum" }),
    ).rejects.toThrow("Gas payments on ethereum-vm are not supported");
    expect(verifyGasPaymentSignature).not.toHaveBeenCalled();
    expect(signWithdrawGasPayment).not.toHaveBeenCalled();
  });

  it("accepts Gateway-specific normalization data in the API schema", () => {
    expect(
      Value.Check((endpoint as any).schema.body, {
        ...body(),
        chainId: "gateway",
        depository: `0x${"aa".repeat(20)}`,
        currency: `0x${"bb".repeat(20)}`,
        receiver: `0x${"cc".repeat(20)}`,
        nonce: "123",
        feeCurrency: `0x${"dd".repeat(20)}`,
        additionalData: {
          "gateway-vm": {
            allocator: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            destinationChainId: "8453",
            maxBlockHeight: "22000000",
          },
        },
      }),
    ).toBe(true);
  });

  it("keeps only peer signatures for the same PayGas digest", async () => {
    const peerSignature = {
      oracleSigner: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      signature: `0x${"bb".repeat(65)}`,
    };
    (axios.post as jest.Mock).mockResolvedValueOnce({
      data: {
        withdrawRequest: NORMALIZED_WITHDRAW_REQUEST,
        feeCurrency: ENCODED_FEE_CURRENCY,
        feeAmount: "250000",
        gasPayerChainId: SIGN_RESULT.gasPayerChainId,
        gasPayerContract: SIGN_RESULT.gasPayerContract,
        signatures: [peerSignature],
      },
    } as never);

    const reply = await call({ ...body(), requestPeerSignatures: true });
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        signatures: expect.arrayContaining([
          {
            oracleSigner: SIGN_RESULT.oracleSigner,
            signature: SIGN_RESULT.signature,
          },
          peerSignature,
        ]),
      }),
    );
  });

  it("rejects a peer signature for a different fee", async () => {
    (axios.post as jest.Mock).mockResolvedValueOnce({
      data: {
        withdrawRequest: NORMALIZED_WITHDRAW_REQUEST,
        feeCurrency: ENCODED_FEE_CURRENCY,
        feeAmount: "250001",
        gasPayerChainId: SIGN_RESULT.gasPayerChainId,
        gasPayerContract: SIGN_RESULT.gasPayerContract,
        signatures: [
          {
            oracleSigner: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            signature: `0x${"bb".repeat(65)}`,
          },
        ],
      },
    } as never);

    const reply = await call({ ...body(), requestPeerSignatures: true });
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        signatures: [
          {
            oracleSigner: SIGN_RESULT.oracleSigner,
            signature: SIGN_RESULT.signature,
          },
        ],
      }),
    );
  });
});
