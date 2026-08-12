import { describe, expect, it, jest } from "@jest/globals";
import { verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  generateAddress,
  generateTokenId,
} from "@relay-protocol/settlement-sdk";

import {
  FAST_FEE_COMMITMENT_TYPES,
  FeeCommitment,
  getFastFeeCommitmentDomain,
  verifyFeeCommitment,
} from "../../../../src/services/attestation/fee-commitment";

const mockHubInfo = {
  evmChainId: "537724",
  oracleAddress: "0x4411881acda74849c1811d0b19c8e045c8f4c280",
  oracleVersion: "2",
};

jest.mock("../../../../src/common/chains", () => ({
  getHubInfo: jest.fn().mockImplementation(async () => mockHubInfo),
  getChainVmType: jest.fn().mockImplementation(async (chainId: unknown) => {
    if (chainId === "base" || chainId === "ethereum") return "ethereum-vm";
    if (chainId === "solana") return "solana-vm";
    throw new Error(`Chain ${chainId} is not available`);
  }),
}));

// Delegate to viem's pure implementation so the EOA path exercises real ECDSA
// recovery (production verifies via the payer's source chain RPC for 1271)
jest.mock("../../../../src/common/vm/ethereum-vm/rpc", () => ({
  httpRpc: jest.fn().mockImplementation(async () => ({
    verifyTypedData: (args: any) => verifyTypedData(args),
  })),
}));

describe("verifyFeeCommitment", () => {
  const payerAccount = privateKeyToAccount(
    "0x0000000000000000000000000000000000000000000000000000000000000001",
  );
  const otherAccount = privateKeyToAccount(
    "0x0000000000000000000000000000000000000000000000000000000000000002",
  );
  const chainId = "base";
  const transactionId =
    "0x552985b36c59902b24fde1437a11a2698347aa5ca2bf82697d0f8e8e1e35cc6e";
  const feeBps = "10000000000000000"; // 1%
  const payerChainId = "base";
  const feeCurrencyChainId = "ethereum";
  const feeCurrencyAddress = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const maxAmount = "50";
  const futureDeadline = () => String(Math.floor(Date.now() / 1000) + 3600);

  const signCommitment = async (params: {
    deadline: string;
    signedFeeBps?: string;
    account?: typeof payerAccount;
    domainOverride?: Partial<ReturnType<typeof getFastFeeCommitmentDomain>>;
  }) =>
    (params.account ?? payerAccount).signTypedData({
      domain: {
        ...getFastFeeCommitmentDomain(mockHubInfo),
        ...params.domainOverride,
      },
      types: FAST_FEE_COMMITMENT_TYPES,
      primaryType: "FastFeeCommitment",
      message: {
        payerChainId,
        payer: payerAccount.address,
        chainId,
        transactionId,
        feeCurrencyChainId,
        feeCurrency: feeCurrencyAddress,
        feeBps: BigInt(params.signedFeeBps ?? feeBps),
        maxFeeAmount: BigInt(maxAmount),
        deadline: BigInt(params.deadline),
      },
    });

  const verify = (
    commitment: Partial<FeeCommitment> & Pick<FeeCommitment, "signature">,
    expected?: {
      feeBps?: string;
      feeCurrency?: { chainId: string; currency: string };
    },
  ) =>
    verifyFeeCommitment({
      commitment: {
        payer: { chainId: payerChainId, address: payerAccount.address },
        fee: {
          chainId: feeCurrencyChainId,
          currency: feeCurrencyAddress,
          maxAmount,
        },
        deadline: futureDeadline(),
        ...commitment,
      },
      chainId,
      transactionId,
      feeBps: expected?.feeBps ?? feeBps,
      feeCurrency: expected?.feeCurrency ?? {
        chainId: feeCurrencyChainId,
        currency: feeCurrencyAddress,
      },
    });

  it("accepts a valid EOA signature and returns the payer alias + fee token id", async () => {
    const deadline = futureDeadline();
    const signature = await signCommitment({ deadline });

    await expect(verify({ deadline, signature })).resolves.toEqual({
      feePayer: generateAddress({
        address: payerAccount.address,
        chainId: payerChainId,
        family: "ethereum-vm",
      }),
      feeTokenId: generateTokenId({
        address: feeCurrencyAddress,
        chainId: feeCurrencyChainId,
        family: "ethereum-vm",
      }),
    });
  });

  it("rejects a payer on a non-EVM chain", async () => {
    const deadline = futureDeadline();
    const signature = await signCommitment({ deadline });

    await expect(
      verify({
        deadline,
        signature,
        payer: { chainId: "solana", address: payerAccount.address },
      }),
    ).rejects.toThrow(/unsupported fee commitment payer chain/i);
  });

  it("rejects when the submitted payer chain differs from the signed one", async () => {
    const deadline = futureDeadline();
    // Signed payerChainId "base"; submitting "ethereum" (also EVM) would
    // derive a different alias, so the signature must not verify
    const signature = await signCommitment({ deadline });

    await expect(
      verify({
        deadline,
        signature,
        payer: { chainId: "ethereum", address: payerAccount.address },
      }),
    ).rejects.toThrow(/invalid fee commitment signature/i);
  });

  it("rejects an unknown fee chain or malformed fee currency as a client error", async () => {
    const deadline = futureDeadline();
    const signature = await signCommitment({ deadline });

    for (const fee of [
      { chainId: "unknown-chain", currency: feeCurrencyAddress, maxAmount },
      { chainId: feeCurrencyChainId, currency: "not-hex", maxAmount },
    ]) {
      await expect(verify({ deadline, signature, fee })).rejects.toThrow(
        /invalid fee commitment fee currency/i,
      );
    }
  });

  it("rejects a signature from a different signer", async () => {
    const deadline = futureDeadline();
    const signature = await signCommitment({ deadline, account: otherAccount });

    await expect(verify({ deadline, signature })).rejects.toThrow(
      /invalid fee commitment signature/i,
    );
  });

  it("rejects when a signed field was tampered with", async () => {
    const deadline = futureDeadline();
    const signature = await signCommitment({ deadline });

    await expect(
      verify({
        deadline,
        signature,
        fee: {
          chainId: feeCurrencyChainId,
          currency: feeCurrencyAddress,
          maxAmount: "999999", // signed 50
        },
      }),
    ).rejects.toThrow(/invalid fee commitment signature/i);
  });

  it("rejects when the signed feeBps differs from the tier's feeBps", async () => {
    const deadline = futureDeadline();
    const signature = await signCommitment({
      deadline,
      signedFeeBps: "20000000000000000", // payer agreed to 2%, tier says 1%
    });

    await expect(verify({ deadline, signature })).rejects.toThrow(
      /invalid fee commitment signature/i,
    );
  });

  it("rejects an expired deadline", async () => {
    const deadline = String(Math.floor(Date.now() / 1000) - 1);
    const signature = await signCommitment({ deadline });

    await expect(verify({ deadline, signature })).rejects.toThrow(
      /fee commitment expired/i,
    );
  });

  it("rejects a signature over a different oracle domain", async () => {
    const deadline = futureDeadline();
    const signature = await signCommitment({
      deadline,
      domainOverride: {
        verifyingContract: "0xcba1cb9d0198dd237619430eae6fe710cb91258d",
      },
    });

    await expect(verify({ deadline, signature })).rejects.toThrow(
      /invalid fee commitment signature/i,
    );
  });

  it("rejects a zero or malformed payer address", async () => {
    const deadline = futureDeadline();
    const signature = await signCommitment({ deadline });

    for (const address of [
      "0x0000000000000000000000000000000000000000",
      "not-an-address",
    ]) {
      await expect(
        verify({
          deadline,
          signature,
          payer: { chainId: payerChainId, address },
        }),
      ).rejects.toThrow(/invalid fee commitment payer/i);
    }
  });

  it("rejects a commitment over a different fee currency", async () => {
    const deadline = futureDeadline();
    const signature = await signCommitment({ deadline });

    await expect(
      // configured currency differs from the signed one
      verify(
        { deadline, signature },
        {
          feeCurrency: {
            chainId: feeCurrencyChainId,
            currency: "0x2222222222222222222222222222222222222222",
          },
        },
      ),
    ).rejects.toThrow(/does not match the configured fee currency/i);
  });

  it("matches the configured fee currency across address casing", async () => {
    const deadline = futureDeadline();
    const signature = await signCommitment({ deadline });

    // Token ids are derived from the raw bytes, so casing differences between
    // the config and the commitment cannot fail the match
    await expect(
      verify(
        { deadline, signature },
        {
          feeCurrency: {
            chainId: feeCurrencyChainId,
            currency: `0x${feeCurrencyAddress.slice(2).toUpperCase()}`,
          },
        },
      ),
    ).resolves.toBeDefined();
  });

  it("rejects a non-hex or odd-length signature as a client error", async () => {
    for (const signature of ["garbage", "0xabc"]) {
      await expect(verify({ signature })).rejects.toThrow(
        /invalid fee commitment signature/i,
      );
    }
  });

  it("rejects malformed numeric fields without leaking an internal error", async () => {
    const deadline = futureDeadline();
    const signature = await signCommitment({ deadline });

    await expect(
      verify({
        deadline,
        signature,
        fee: {
          chainId: feeCurrencyChainId,
          currency: feeCurrencyAddress,
          maxAmount: "not-a-number",
        },
      }),
    ).rejects.toThrow(/invalid fee commitment fee maxAmount/i);
  });
});
