import { describe, expect, it } from "@jest/globals";
import { VmType } from "@relay-protocol/settlement-sdk";

import { Chain } from "../../../../src/common/chains";
import {
  resolveAmountTieredFinality,
  selectFinalizationThreshold,
} from "../../../../src/services/attestation/utils";

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

const makeChain = (additionalData?: Chain["additionalData"]): Chain => ({
  id: "ethereum",
  vmType: "ethereum-vm" as VmType,
  httpRpcUrl: "http://localhost:8545",
  additionalData,
});

describe("selectFinalizationThreshold", () => {
  it("returns null when fastMode is absent", () => {
    const chain = makeChain({ finalizationTime: 60 });
    expect(selectFinalizationThreshold(chain, USDC, 100n)).toBeNull();
  });

  it("returns null when the threshold table is absent or empty", () => {
    expect(
      selectFinalizationThreshold(makeChain({ fastMode: {} }), USDC, 100n),
    ).toBeNull();
    expect(
      selectFinalizationThreshold(
        makeChain({ fastMode: { finalityTiers: {} } }),
        USDC,
        100n,
      ),
    ).toBeNull();
  });

  it("picks the lowest matching tier for a small amount", () => {
    const chain = makeChain({
      fastMode: {
        finalityTiers: {
          [USDC]: [
            { maxAmount: "1000", finalizationBlocks: 1, finalizationTime: 6 },
            {
              maxAmount: "1000000",
              finalizationBlocks: 5,
              finalizationTime: 30,
            },
          ],
        },
      },
    });
    expect(selectFinalizationThreshold(chain, USDC, 999n)).toEqual({
      finalizationBlocks: 1,
      finalizationTime: 6,
    });
  });

  it("picks a higher tier when the amount exceeds the lower tiers", () => {
    const chain = makeChain({
      fastMode: {
        finalityTiers: {
          [USDC]: [
            { maxAmount: "1000", finalizationBlocks: 1, finalizationTime: 6 },
            {
              maxAmount: "1000000",
              finalizationBlocks: 5,
              finalizationTime: 30,
            },
          ],
        },
      },
    });
    expect(selectFinalizationThreshold(chain, USDC, 1000n)).toEqual({
      finalizationBlocks: 5,
      finalizationTime: 30,
    });
  });

  it("picks the lowest matching tier regardless of config order", () => {
    const chain = makeChain({
      fastMode: {
        finalityTiers: {
          [USDC]: [
            {
              maxAmount: "1000000",
              finalizationBlocks: 5,
              finalizationTime: 30,
            },
            { maxAmount: "1000", finalizationBlocks: 1, finalizationTime: 6 },
          ],
        },
      },
    });
    expect(selectFinalizationThreshold(chain, USDC, 100n)).toEqual({
      finalizationBlocks: 1,
      finalizationTime: 6,
    });
  });

  it("returns null when the amount is above all tiers", () => {
    const chain = makeChain({
      fastMode: {
        finalityTiers: {
          [USDC]: [
            { maxAmount: "1000", finalizationBlocks: 1, finalizationTime: 6 },
          ],
        },
      },
    });
    expect(selectFinalizationThreshold(chain, USDC, 1000n)).toBeNull();
  });

  it("returns null for a currency without a table", () => {
    const chain = makeChain({
      fastMode: {
        finalityTiers: {
          [USDC]: [
            { maxAmount: "1000", finalizationBlocks: 1, finalizationTime: 6 },
          ],
        },
      },
    });
    expect(selectFinalizationThreshold(chain, WETH, 100n)).toBeNull();
  });

  it("matches the currency key exactly (caller normalizes per VM)", () => {
    const chain = makeChain({
      fastMode: {
        finalityTiers: {
          [USDC]: [
            { maxAmount: "1000", finalizationBlocks: 1, finalizationTime: 6 },
          ],
        },
      },
    });
    // Exact match against the configured key
    expect(selectFinalizationThreshold(chain, USDC, 100n)).toEqual({
      finalizationBlocks: 1,
      finalizationTime: 6,
    });
    // A differently-cased currency does NOT match — the VM caller is
    // responsible for normalizing before lookup (EVM lowercases at the source)
    expect(
      selectFinalizationThreshold(chain, USDC.toUpperCase(), 100n),
    ).toBeNull();
  });
});

describe("resolveAmountTieredFinality", () => {
  const DEFAULTS = { finalizationBlocks: 10, finalizationTime: 60 };
  const tieredChain = makeChain({
    fastMode: {
      finalityTiers: {
        [USDC]: [
          {
            maxAmount: "1000",
            finalizationBlocks: 1,
            finalizationTime: 1,
            feeBps: "100",
          },
          {
            maxAmount: "5000",
            finalizationBlocks: 3,
            finalizationTime: 5,
            feeBps: "200",
          },
        ],
      },
    },
  });
  const deposit = (amount: string, currency = USDC) => ({
    result: { currency, amount },
  });

  it("a single tiered deposit yields its tier (not defaults)", () => {
    const r = resolveAmountTieredFinality(
      tieredChain,
      [deposit("500")],
      DEFAULTS,
    );
    expect(r.required).toEqual({ finalizationBlocks: 1, finalizationTime: 1 });
    expect(r.mode).toBe("fast");
    expect(r.tiers[0]?.feeBps).toBe("100");
  });

  it("an untiered deposit drags the requirement to the default (not faster)", () => {
    const r = resolveAmountTieredFinality(
      tieredChain,
      [deposit("9999")],
      DEFAULTS,
    );
    expect(r.required).toEqual(DEFAULTS);
    expect(r.mode).toBe("slow");
    expect(r.tiers[0]).toBeNull();
  });

  it("a mixed tx (one untiered) falls back to default; each deposit keeps its own tier", () => {
    const r = resolveAmountTieredFinality(
      tieredChain,
      [deposit("500"), deposit("9999")],
      DEFAULTS,
    );
    expect(r.required).toEqual(DEFAULTS);
    expect(r.mode).toBe("slow");
    expect(r.tiers[0]?.feeBps).toBe("100");
    expect(r.tiers[1]).toBeNull();
  });

  it("a tier exactly equal to the defaults in both dimensions resolves slow", () => {
    const chain = makeChain({
      fastMode: {
        finalityTiers: {
          [USDC]: [
            {
              maxAmount: "1000",
              finalizationBlocks: DEFAULTS.finalizationBlocks,
              finalizationTime: DEFAULTS.finalizationTime,
              feeBps: "100",
            },
          ],
        },
      },
    });
    const r = resolveAmountTieredFinality(chain, [deposit("500")], DEFAULTS);
    expect(r.mode).toBe("slow");
  });

  it("a tier slower than the default in one dimension resolves slow", () => {
    const chain = makeChain({
      fastMode: {
        finalityTiers: {
          [USDC]: [
            {
              maxAmount: "1000",
              finalizationBlocks: 1,
              finalizationTime: 600,
              feeBps: "100",
            },
          ],
        },
      },
    });
    const r = resolveAmountTieredFinality(chain, [deposit("500")], DEFAULTS);
    // The slow resolution reverts to the default finality — the tier's lower
    // block count must not weaken the gate
    expect(r.required).toEqual(DEFAULTS);
    expect(r.mode).toBe("slow");
  });

  it("multiple tiered deposits take the strictest threshold, per-deposit fee", () => {
    const r = resolveAmountTieredFinality(
      tieredChain,
      [deposit("500"), deposit("4000")],
      DEFAULTS,
    );
    // deposit1 → tier1 (1/1); deposit2 → tier2 (3/5); strictest = max(1,3)/max(1,5)
    expect(r.required).toEqual({ finalizationBlocks: 3, finalizationTime: 5 });
    expect(r.mode).toBe("fast");
    expect(r.tiers[0]?.feeBps).toBe("100");
    expect(r.tiers[1]?.feeBps).toBe("200");
  });
});
