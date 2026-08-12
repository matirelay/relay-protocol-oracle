import { describe, expect, it } from "@jest/globals";
import { parseUnits } from "viem";

import { parseDecimalUnits } from "../../../../src/services/attestation/vm/hyperliquid-vm";

const legacyParseDecimalUnits = (
  amount: string | number,
  decimals: number,
): bigint => parseUnits(Number(amount).toFixed(decimals), decimals);

describe("parseDecimalUnits", () => {
  describe("legacy compatibility for exactly representable amounts", () => {
    it.each([
      ["zero with no decimals", "0", 0],
      ["zero with native currency decimals", "0", 8],
      ["integer amount", "42", 8],
      ["fraction shorter than the currency precision", "1.2", 8],
      ["smallest native currency unit", "0.00000001", 8],
      ["largest exact JavaScript safe-integer unit amount", "90071992.54740991", 8],
      ["six-decimal spot token amount", "25.123456", 6],
      ["two-decimal token amount", "999999.99", 2],
      ["leading and fractional zeros", "000001.2300", 6],
      ["surrounding whitespace", " 42.125 ", 3],
      ["number input", 1.25, 8],
    ] as Array<[string, string | number, number]>)(
      "matches the legacy result for %s",
      (_name, amount, decimals) => {
        expect(parseDecimalUnits(amount, decimals)).toBe(
          legacyParseDecimalUnits(amount, decimals),
        );
      },
    );

    it("matches the legacy result across common decimal and fraction-length combinations", () => {
      const integerParts = ["0", "1", "42", "12345"];
      const decimalCounts = [0, 2, 6, 8];
      const fractionalDigits = "12345678";

      for (const decimals of decimalCounts) {
        for (const integerPart of integerParts) {
          for (let fractionLength = 0; fractionLength <= decimals; fractionLength++) {
            const amount =
              fractionLength === 0
                ? integerPart
                : `${integerPart}.${fractionalDigits.slice(0, fractionLength)}`;

            expect(parseDecimalUnits(amount, decimals)).toBe(
              legacyParseDecimalUnits(amount, decimals),
            );
          }
        }
      }
    });

    it.each([
      ["1.000000000", 8],
      ["1.2300000000", 8],
      ["0.0000000100", 8],
      ["42.0", 0],
    ] as Array<[string, number]>)(
      "preserves the legacy result when excess decimal places are only trailing zeros: %s",
      (amount, decimals) => {
        expect(parseDecimalUnits(amount, decimals)).toBe(
          legacyParseDecimalUnits(amount, decimals),
        );
      },
    );
  });

  describe("precision improvements over number-based parsing", () => {
    it.each([
      ["123456789012345678.12345678", 8, 12345678901234567812345678n],
      ["9007199254740993", 0, 9007199254740993n],
      ["100000000000000000.00000001", 8, 10000000000000000000000001n],
      ["0.12345678901234567", 17, 12345678901234567n],
    ] as Array<[string, number, bigint]>)(
      "keeps the exact units for %s instead of the legacy rounded value",
      (amount, decimals, expected) => {
        const legacyResult = legacyParseDecimalUnits(amount, decimals);
        const result = parseDecimalUnits(amount, decimals);

        expect(result).toBe(expected);
        expect(result).not.toBe(legacyResult);
      },
    );
  });

  describe("amounts with more precision than the configured units", () => {
    it.each([
      ["100.123456789", 8, 10012345678n],
      ["25.1234567", 6, 25123456n],
      ["1.999", 2, 199n],
      ["0.0000000010", 8, 0n],
      ["42.9", 0, 42n],
    ] as Array<[string, number, bigint]>)(
      "truncates unsupported decimal places for %s",
      (amount, decimals, expected) => {
        expect(parseDecimalUnits(amount, decimals)).toBe(expected);
      },
    );
  });

  describe("invalid unsigned decimal formats", () => {
    it.each(["-1", "+1", "1e3", ".5", "1.", "", "NaN", "Infinity"])(
      "rejects %s",
      (amount) => {
        expect(() => parseDecimalUnits(amount, 8)).toThrow(
          `Invalid decimal amount: ${amount}`,
        );
      },
    );
  });
});
