import {
  Address,
  encodeAbiParameters,
  Hex,
  isAddress,
  isHex,
  parseAbiParameters,
  zeroAddress,
} from "viem";

import {
  generateAddress,
  generateTokenId,
} from "@relay-protocol/settlement-sdk";

import { getChainVmType, getHubInfo } from "../../common/chains";
import { externalError, internalError } from "../../common/error";
import { logger } from "../../common/logger";
import { httpRpc as getEvmHttpRpc } from "../../common/vm/ethereum-vm/rpc";

// Fee commitment on a fast attestation request: the payer's signed consent to
// the fast fee — signed by the raw wallet, charged from its hub alias.
export type FeeCommitment = {
  payer: { chainId: string; address: string };
  fee: { chainId: string; currency: string; maxAmount: string };
  deadline: string;
  signature: string;
};

export const FAST_FEE_COMMITMENT_TYPES = {
  FastFeeCommitment: [
    { name: "payerChainId", type: "string" },
    { name: "payer", type: "string" },
    { name: "chainId", type: "string" },
    { name: "transactionId", type: "string" },
    { name: "feeCurrencyChainId", type: "string" },
    { name: "feeCurrency", type: "string" },
    { name: "feeBps", type: "uint256" },
    { name: "maxFeeAmount", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

// The oracle's signing domain (same shape as signExecutionMessage) — scopes
// commitments per environment and oracle generation, no cross-env replay.
export const getFastFeeCommitmentDomain = (hubInfo: {
  evmChainId: string;
  oracleAddress: string;
  oracleVersion: string;
}) => ({
  name: "RelayOracle",
  version: hubInfo.oracleVersion,
  chainId: BigInt(hubInfo.evmChainId),
  verifyingContract: hubInfo.oracleAddress as Address,
});

// Guarded parse of externally-provided uint256 strings
const toBigInt = (value: string, field: string) => {
  try {
    return BigInt(value);
  } catch {
    throw externalError(`Invalid fee commitment ${field}`);
  }
};

// Hub token id of a (chainId, currency address) pair
const resolveFeeTokenId = async (fee: { chainId: string; currency: string }) =>
  generateTokenId({
    address: fee.currency,
    chainId: fee.chainId,
    family: await getChainVmType(fee.chainId),
  });

// Verify the payer's signed consent — the contract trusts the attested
// feePayer, so this fails closed; returns the payer alias + fee token id.
export const verifyFeeCommitment = async (params: {
  commitment: FeeCommitment;
  chainId: string;
  transactionId: string;
  // Tier-resolved 1e18-scaled fee the payer must have signed
  feeBps: string;
  // Configured fee currency the payer must have signed
  feeCurrency: { chainId: string; currency: string };
}): Promise<{ feePayer: Address; feeTokenId: bigint }> => {
  const { commitment, chainId, transactionId, feeBps, feeCurrency } = params;

  // Only EVM payer wallets can sign the EIP-712 commitment for now; other VMs
  // need their own signing scheme (verifyOwnerSignature-style dispatch) first
  const payerVmType = await getChainVmType(commitment.payer.chainId);
  if (payerVmType !== "ethereum-vm") {
    throw externalError("Unsupported fee commitment payer chain");
  }

  if (
    !isAddress(commitment.payer.address) ||
    commitment.payer.address === zeroAddress
  ) {
    throw externalError("Invalid fee commitment payer");
  }

  // Non-hex signatures make viem throw locally before reaching the RPC —
  // reject them at the boundary so they surface as the client's 400, not a 500
  if (!isHex(commitment.signature) || commitment.signature.length % 2 !== 0) {
    throw externalError("Invalid fee commitment signature");
  }

  const maxFeeAmount = toBigInt(commitment.fee.maxAmount, "fee maxAmount");
  const deadline = toBigInt(commitment.deadline, "deadline");

  // Compare as hub token ids so formatting differences cannot fail the match;
  // a configured-side failure is an oracle misconfiguration, not a client error
  const feeTokenId = await resolveFeeTokenId(feeCurrency).catch((error) => {
    throw internalError(
      `Failed to resolve the configured fee currency: ${error.message}`,
    );
  });
  const commitmentFeeTokenId = await resolveFeeTokenId(commitment.fee).catch(
    () => {
      throw externalError("Invalid fee commitment fee currency");
    },
  );
  if (commitmentFeeTokenId !== feeTokenId) {
    throw externalError(
      "Fee commitment currency does not match the configured fee currency",
    );
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  if (deadline <= now) {
    throw externalError("Fee commitment expired");
  }

  const hubInfo = await getHubInfo();
  // Verified on the payer's source chain (where its EOA/1271 wallet lives);
  // with the inputs validated above, a throw here is an RPC failure
  const payerRpc = await getEvmHttpRpc(commitment.payer.chainId);
  const isValidSignature = await payerRpc
    .verifyTypedData({
      address: commitment.payer.address as Address,
      domain: getFastFeeCommitmentDomain(hubInfo),
      types: FAST_FEE_COMMITMENT_TYPES,
      primaryType: "FastFeeCommitment",
      message: {
        payerChainId: commitment.payer.chainId,
        payer: commitment.payer.address,
        chainId,
        transactionId,
        feeCurrencyChainId: commitment.fee.chainId,
        feeCurrency: commitment.fee.currency,
        feeBps: BigInt(feeBps),
        maxFeeAmount,
        deadline,
      },
      signature: commitment.signature as Hex,
    })
    .catch((error) => {
      throw internalError(
        `Failed to verify fee commitment signature: ${error.message}`,
      );
    });
  if (!isValidSignature) {
    throw externalError("Invalid fee commitment signature");
  }

  return {
    feePayer: generateAddress({
      address: commitment.payer.address,
      chainId: commitment.payer.chainId,
      family: payerVmType,
    }),
    feeTokenId,
  };
};

// Resolve the calculator pair for a tx's fast messages: a non-zero fee tier
// requires the payer's verified consent; fee-free txs get the zero pair.
export const resolveFastMintFee = async (params: {
  fastMessages: { tokenId: bigint; amount: bigint; feeBps: string }[];
  fastMode?: {
    feeRecipient?: string;
    feeCurrency?: { chainId: string; currency: string };
  };
  feeCalculator?: { address: string; type: string };
  chainId: string;
  transactionId: string;
  commitment?: FeeCommitment;
}): Promise<{ feeCalculator: string; feeCalculatorData: string }> => {
  const { fastMessages, fastMode, chainId, transactionId, commitment } = params;

  const feeMessages = fastMessages.filter((m) => BigInt(m.feeBps) > 0n);
  if (!feeMessages.length) {
    return { feeCalculator: zeroAddress, feeCalculatorData: "0x" };
  }

  // One commitment signs one feeBps — mixed non-zero tiers cannot be covered
  // by a single signature
  const feeBpsValues = [...new Set(feeMessages.map((m) => m.feeBps))];
  if (feeBpsValues.length > 1) {
    throw externalError(
      "Fast mode fee tiers differ within the transaction; retry with mode=slow",
    );
  }
  const feeBps = feeBpsValues[0];

  const feeRecipient = fastMode?.feeRecipient;
  if (!feeRecipient || feeRecipient === zeroAddress) {
    throw internalError("Missing fast mode feeRecipient configuration");
  }
  if (!params.feeCalculator) {
    throw internalError("Missing fast mode feeCalculator configuration");
  }
  // Fail closed on unknown calculator types — the data layout below is
  // specific to the bps calculator (mirrors resolveRateLimiter dispatch)
  if (params.feeCalculator.type !== "bps") {
    throw internalError(
      `Unsupported fee calculator type "${params.feeCalculator.type}"`,
    );
  }
  const feeCurrency = fastMode?.feeCurrency;
  if (!feeCurrency?.chainId || !feeCurrency?.currency) {
    throw internalError("Missing fast mode feeCurrency configuration");
  }

  // The contract charges the attested feePayer without any signature check,
  // so a non-zero fee strictly requires the payer's signed consent
  if (!commitment) {
    throw externalError(
      "Fast mode requires a fee commitment; retry with mode=slow",
    );
  }
  const { feePayer, feeTokenId } = await verifyFeeCommitment({
    commitment,
    chainId,
    transactionId,
    feeBps,
    feeCurrency,
  });

  // RelayBpsFeeCalculator data layout — the payer-signed maxFeeAmount is
  // enforced on-chain (FeeExceedsMax reverts without consuming the key)
  const feeCalculatorData = encodeAbiParameters(
    parseAbiParameters(
      "uint256 feeCurrency, uint256 feeBps, uint256 maxFeeAmount, address feeRecipient, address feePayer",
    ),
    [
      feeTokenId,
      BigInt(feeBps),
      BigInt(commitment.fee.maxAmount),
      feeRecipient as Address,
      feePayer,
    ],
  );

  // The commitment + signature is the only consent evidence (on-chain has
  // just the FastMint event) — keep it in the logs
  logger.info(
    "attestation-service",
    JSON.stringify({
      msg: "Fast fee commitment accepted",
      chainId,
      transactionId,
      feeBps,
      commitment,
    }),
  );

  return {
    feeCalculator: params.feeCalculator.address,
    feeCalculatorData,
  };
};
