import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { Value } from "@sinclair/typebox/value";

import endpoint from "../../../src/api/attestations/withdraw-request-authorization/v1";
import { validateRecoverMode } from "../../../src/common/recover-mode-verification";
import { verifyWithdrawalSignature } from "../../../src/common/signature-verification";
import { signAllocatorWithdrawRequest } from "../../../src/common/signer";
import { getChain } from "../../../src/common/chains";
import { normalizeWithdrawRequest } from "@relay-protocol/settlement-sdk";

const NORMALIZED = {
  chainId: "ethereum",
  depository: "0xDepository",
  currency: "0xCurrency",
  amount: "1000000",
  spenderChainId: "ethereum",
  spender: "0xSpender",
  receiver: "0xReceiver",
  data: "0x",
  nonce: `0x${"00".repeat(31)}07`,
};
const SIGN_RESULT = {
  allocatorChainId: 1,
  allocatorContract: "0xAllocator0000000000000000000000000000abcd",
  oracleSigner: "0xOracleSigner00000000000000000000000000abcd",
  signature: "0x" + "ab".repeat(65),
};

jest.mock("../../../src/common/chains", () => ({
  getChain: jest.fn(async () => ({
    id: "ethereum",
    vmType: "ethereum-vm",
    depository: "0xDep0000000000000000000000000000000000abcd",
  })),
}));

const RECOVER_NONCE = `0x${"5a".repeat(32)}`;

jest.mock("../../../src/common/recover-mode-verification", () => ({
  recoverModeSchemaFields: {},
  validateRecoverMode: jest.fn(async () => ({ nonce: RECOVER_NONCE })),
}));

jest.mock("../../../src/common/signature-verification", () => ({
  verifyWithdrawalSignature: jest.fn(async () => undefined),
}));

jest.mock("../../../src/common/signer", () => ({
  signAllocatorWithdrawRequest: jest.fn(async () => SIGN_RESULT),
}));

jest.mock("../../../src/services/attestation", () => ({
  AttestationService: class {},
}));

jest.mock("../../../src/common/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("@relay-protocol/settlement-sdk", () => {
  const actual = jest.requireActual("@relay-protocol/settlement-sdk") as Record<string, unknown>;
  return { ...actual, normalizeWithdrawRequest: jest.fn(() => NORMALIZED) };
});

// config.peers undefined → the peer-signature fan-out is skipped.
jest.mock("../../../src/config", () => ({ config: { peers: undefined } }));

const recoverBody = () => ({
  chainId: "ethereum",
  currency: "0xCurrency00000000000000000000000000000abcd",
  amount: "1000000",
  spenderChainId: "ethereum",
  spender: "0xOwner000000000000000000000000000000000abcd",
  receiver: "0xRecipient0000000000000000000000000000abcd",
  nonce: "0x" + "00".repeat(31) + "07",
  recoverMode: true,
  depositChainId: "ethereum",
  depositTransactionId: "0x" + "ab".repeat(32),
  depositOnchainId: "0x" + "cd".repeat(32),
  order: { inputs: [] },
  orderSignature: "0x" + "ee".repeat(65),
});

const makeReply = () => {
  const reply: any = {};
  reply.send = jest.fn().mockReturnValue(reply);
  return reply;
};

const call = (body: any) => (endpoint as any).handler({ body, headers: {} } as any, makeReply());

describe("POST /attestations/withdraw-request-authorization/v1 — recoverMode", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uses the shared withdrawal nonce schema", () => {
    expect(
      Value.Check((endpoint as any).schema.body, {
        ...recoverBody(),
        nonce: "123",
      }),
    ).toBe(true);
  });

  it("authorizes recoverMode without a user signature and signs the normalized request", async () => {
    const reply = makeReply();
    await (endpoint as any).handler({ body: recoverBody(), headers: {} } as any, reply);

    // recoverMode path: validateRecoverMode runs, the user-signature check does not.
    expect(validateRecoverMode).toHaveBeenCalledTimes(1);
    expect(verifyWithdrawalSignature).not.toHaveBeenCalled();

    // validateRecoverMode receives the request fields it needs to authorize.
    const args = (validateRecoverMode as jest.Mock).mock.calls[0][0] as any;
    expect(args).toMatchObject({
      depositChainId: "ethereum",
      depositOnchainId: "0x" + "cd".repeat(32),
      owner: "0xOwner000000000000000000000000000000000abcd",
      recipient: "0xRecipient0000000000000000000000000000abcd",
      orderSignature: "0x" + "ee".repeat(65),
    });
    expect(args.attestationService).toBeDefined();

    // The exact normalized request returned to the caller is the one that was signed.
    expect(signAllocatorWithdrawRequest).toHaveBeenCalledWith(NORMALIZED);
    expect(reply.send).toHaveBeenCalledWith({
      withdrawRequest: NORMALIZED,
      allocatorChainId: SIGN_RESULT.allocatorChainId,
      allocatorContract: SIGN_RESULT.allocatorContract,
      signatures: [{ oracleSigner: SIGN_RESULT.oracleSigner, signature: SIGN_RESULT.signature }],
    });
  });

  it("signs the oracle-derived nonce, not the one the caller sent", async () => {
    // recoverMode binds the withdrawal to a single use of the cited deposit, so
    // the nonce is the oracle's to compute (DEC-1660).
    await call({ ...recoverBody(), nonce: "0x" + "99".repeat(32) });

    expect(normalizeWithdrawRequest).toHaveBeenCalledWith(
      expect.objectContaining({ nonce: RECOVER_NONCE }),
    );
  });

  it("keeps the caller's nonce on the non-recover path", async () => {
    const callerNonce = "0x" + "88".repeat(32);
    await call({
      ...recoverBody(),
      recoverMode: false,
      nonce: callerNonce,
      ownerSignature: "0x" + "cc".repeat(65),
    });

    expect(normalizeWithdrawRequest).toHaveBeenCalledWith(
      expect.objectContaining({ nonce: callerNonce }),
    );
  });

  it("propagates a recoverMode rejection and does not sign", async () => {
    (validateRecoverMode as jest.Mock).mockImplementationOnce(async () => {
      throw new Error("recoverMode requires depositChainId, ...");
    });

    await expect(call(recoverBody())).rejects.toThrow(/recoverMode requires/);
    expect(signAllocatorWithdrawRequest).not.toHaveBeenCalled();
  });

  it("still requires ownerSignature on the non-recover path (regression)", async () => {
    const { recoverMode, ...rest } = recoverBody();
    await expect(call(rest)).rejects.toThrow(/ownerSignature is required/);
    expect(validateRecoverMode).not.toHaveBeenCalled();
    expect(signAllocatorWithdrawRequest).not.toHaveBeenCalled();
  });

  it("supports xrp-vm recoverMode authorization (slow refund)", async () => {
    (getChain as jest.Mock)
      .mockResolvedValueOnce({
        id: "xrp",
        vmType: "xrp-vm",
        depository: "rEgPcf61jqzyxHMqStaX7GsC9Swb1srgur",
      } as never)
      .mockResolvedValueOnce({
        id: "ethereum",
        vmType: "ethereum-vm",
        depository: "0xDep0000000000000000000000000000000000abcd",
      } as never);

    const xrpAdditionalData = {
      "xrp-vm": {
        sequence: 105458838,
        fee: "10",
        lastLedgerSequence: 105565650,
        flags: 2147483648,
      },
    };
    const body = {
      ...recoverBody(),
      chainId: "xrp",
      currency: "rrrrrrrrrrrrrrrrrrrrrhoLvTp",
      receiver: "rMeb13qr92ScuX8eCADmVNuBk4G6z1tHJL",
      additionalData: xrpAdditionalData,
    };

    const reply = makeReply();
    await (endpoint as any).handler({ body, headers: {} } as any, reply);

    expect(validateRecoverMode).toHaveBeenCalledTimes(1);
    expect(verifyWithdrawalSignature).not.toHaveBeenCalled();
    expect(normalizeWithdrawRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        vmType: "xrp-vm",
        chainId: "xrp",
        depository: "rEgPcf61jqzyxHMqStaX7GsC9Swb1srgur",
        additionalData: xrpAdditionalData,
      }),
    );
    expect(signAllocatorWithdrawRequest).toHaveBeenCalledWith(NORMALIZED);
  });

  it("supports lighter-vm withdraw request authorization", async () => {
    (getChain as jest.Mock)
      .mockResolvedValueOnce({
        id: "lighter",
        vmType: "lighter-vm",
        depository: "460491",
        additionalDepositories: ["460492"],
      } as never)
      .mockResolvedValueOnce({
        id: "ethereum",
        vmType: "ethereum-vm",
        depository: "0xDep0000000000000000000000000000000000abcd",
      } as never);

    const lighterAdditionalData = {
      "lighter-vm": {
        nonce: "123",
        apiKeyIndex: "5",
        usdcFee: "10",
      },
    };
    const body = {
      chainId: "lighter",
      depository: "460492",
      currency: "3",
      amount: "1000",
      spenderChainId: "ethereum",
      spender: "0xOwner000000000000000000000000000000000abcd",
      receiver: "99",
      nonce: "0x" + "00".repeat(31) + "08",
      ownerSignature: "0x" + "ef".repeat(65),
      additionalData: lighterAdditionalData,
    };

    const reply = makeReply();
    await (endpoint as any).handler({ body, headers: {} } as any, reply);

    expect(verifyWithdrawalSignature).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chainId: "lighter",
        additionalData: lighterAdditionalData,
      }),
      signature: body.ownerSignature,
    });
    expect(normalizeWithdrawRequest).toHaveBeenCalledWith({
      vmType: "lighter-vm",
      spenderVmType: "ethereum-vm",
      chainId: "lighter",
      depository: "460492",
      currency: "3",
      amount: "1000",
      spenderChainId: "ethereum",
      spender: body.spender,
      receiver: "99",
      nonce: body.nonce,
      additionalData: lighterAdditionalData,
    });
    expect(signAllocatorWithdrawRequest).toHaveBeenCalledWith(NORMALIZED);
  });
});
