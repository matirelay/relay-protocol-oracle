import crypto from "crypto";
import {
  Address,
  encodeAbiParameters,
  getContract,
  Hex,
  parseAbi,
  parseAbiParameters,
} from "viem";

import { Chain } from "../../common/chains";
import { internalError } from "../../common/error";
import { getHubHttpRpc } from "../../common/hub";
import { logger } from "../../common/logger";

export const getDeterministicId = (...values: string[]) =>
  "0x" +
  crypto
    .createHash("sha256")
    .update(values.join(":").toLowerCase())
    .digest("hex");

// Select the matching finalization threshold based on the oracle's configuration
export const selectFinalizationThreshold = (
  chain: Chain,
  currency: string,
  amount: bigint,
): {
  finalizationBlocks?: number;
  finalizationTime?: number;
  feeBps?: string;
} | null => {
  if (!chain.additionalData?.fastMode) {
    return null;
  }

  const table = chain.additionalData.fastMode.finalityTiers ?? {};
  const tiers = table[currency] ?? [];

  // Choose the most restrictive tier which matches the amount
  const matchedTier = [...tiers]
    .sort((a, b) => {
      const aMaxAmount = BigInt(a.maxAmount);
      const bMaxAmount = BigInt(b.maxAmount);
      return aMaxAmount < bMaxAmount ? -1 : aMaxAmount > bMaxAmount ? 1 : 0;
    })
    .find((tier) => amount < BigInt(tier.maxAmount));
  if (!matchedTier) {
    return null;
  }

  return {
    finalizationBlocks: matchedTier.finalizationBlocks,
    finalizationTime: matchedTier.finalizationTime,
    feeBps: matchedTier.feeBps,
  };
};

export const isNumericFinalityMet = (
  measured: { confirmations: number; elapsedSeconds: number },
  threshold: { finalizationBlocks?: number; finalizationTime?: number },
): boolean =>
  measured.confirmations >= (threshold.finalizationBlocks ?? 0) &&
  measured.elapsedSeconds >= (threshold.finalizationTime ?? 0);

// Select the strictest finalization threshold for a list of deposits within a single transaction
export const resolveAmountTieredFinality = (
  chain: Chain,
  deposits: { result: { currency: string; amount: string } }[],
  defaults: { finalizationBlocks: number; finalizationTime: number },
): {
  required: { finalizationBlocks: number; finalizationTime: number };
  mode: "fast" | "slow";
  tiers: ReturnType<typeof selectFinalizationThreshold>[];
} => {
  const tiers = deposits.map((d) =>
    selectFinalizationThreshold(
      chain,
      d.result.currency,
      BigInt(d.result.amount),
    ),
  );

  let finalizationBlocks = 0;
  let finalizationTime = 0;
  for (const tier of tiers) {
    finalizationBlocks = Math.max(
      finalizationBlocks,
      tier?.finalizationBlocks ?? defaults.finalizationBlocks,
    );
    finalizationTime = Math.max(
      finalizationTime,
      tier?.finalizationTime ?? defaults.finalizationTime,
    );
  }

  // Fast only when the resolved thresholds are within the defaults and strictly
  // below in at least one dimension — a tier slower in either dimension is slow.
  const isFaster =
    finalizationBlocks <= defaults.finalizationBlocks &&
    finalizationTime <= defaults.finalizationTime &&
    (finalizationBlocks < defaults.finalizationBlocks ||
      finalizationTime < defaults.finalizationTime);

  return {
    // A slow resolution must meet the chain-default finality — a misconfigured
    // tier (e.g. fewer blocks but longer time) must not weaken the block gate.
    required: isFaster
      ? { finalizationBlocks, finalizationTime }
      : { ...defaults },
    mode: isFaster ? "fast" : "slow",
    tiers,
  };
};

// Pre-check the rate-limiter's budget off-chain for a tx's fast deposits (by
// limiter type) and resolve the data each FAST_MINT passes to consume()
export const resolveRateLimiter = async (params: {
  type: string;
  address: string;
  chainId: string;
  entries: { tokenId: bigint; amount: bigint }[];
}): Promise<{ withinBudget: boolean; rateLimiterData: Hex }> => {
  const { type, address, chainId, entries } = params;
  switch (type) {
    case "amount": {
      // Buckets are keyed by hub token id — sum amounts per token id so a tx
      // that fits the budget per-message but not collectively is rejected
      const amounts = new Map<bigint, bigint>();
      for (const { tokenId, amount } of entries) {
        amounts.set(tokenId, (amounts.get(tokenId) ?? 0n) + amount);
      }

      const checks = await Promise.all(
        [...amounts].map(async ([tokenId, amount]) => {
          let withinBudget = true;
          try {
            const limiter = getContract({
              address: address as Address,
              abi: parseAbi([
                "function canConsume(uint256 tokenId, uint256 amount) view returns (bool)",
              ]),
              client: await getHubHttpRpc(),
            });

            withinBudget = await limiter.read.canConsume([tokenId, amount]);
          } catch {
            // Skip errors
          }

          return withinBudget;
        }),
      );

      // The amount limiter's consume() ignores the data argument
      return { withinBudget: checks.every(Boolean), rateLimiterData: "0x" };
    }

    case "usd": {
      // The USD bucket is per-chain and shared by every token in the tx — one
      // batched call prices and sums all entries like the per-action consume()s
      const rateLimiterData = encodeAbiParameters(
        parseAbiParameters("string chainId"),
        [chainId],
      );

      try {
        const limiter = getContract({
          address: address as Address,
          abi: parseAbi([
            // Declared view locally (on-chain it is nonpayable, for stateful
            // pricing) so the pre-check stays a plain eth_call read
            "function resolveCanConsumeBatch(uint256[] tokenIds, uint256[] amounts, bytes data) view returns (bool)",
          ]),
          client: await getHubHttpRpc(),
        });

        const withinBudget = await limiter.read.resolveCanConsumeBatch([
          entries.map((e) => e.tokenId),
          entries.map((e) => e.amount),
          rateLimiterData,
        ]);

        return { withinBudget, rateLimiterData };
      } catch (error) {
        // Fail closed — the limiter cannot price the token or be read at
        // all, so the deposit must not go fast
        logger.warn(
          "attestation-service",
          JSON.stringify({
            msg: "Fast mode rate-limiter pre-check failed",
            chainId,
            rateLimiter: address,
            error: String(error),
          }),
        );

        return { withinBudget: false, rateLimiterData };
      }
    }

    default: {
      throw internalError(`Unsupported rate limiter type "${type}"`);
    }
  }
};
