import { afterAll, beforeEach, describe, expect, it } from "@jest/globals";

import { isValidApiKey } from "../../../src/common/api-key";
import { config } from "../../../src/config";

const originalApiKeys = config.apiKeys;

describe("isValidApiKey", () => {
  beforeEach(() => {
    config.apiKeys = { "valid-key": "partner" };
  });

  afterAll(() => {
    config.apiKeys = originalApiKeys;
  });

  it("accepts configured API keys", () => {
    expect(isValidApiKey("valid-key")).toBe(true);
  });

  it.each(["constructor", "toString", "hasOwnProperty", "__proto__"])(
    "rejects inherited object property %s",
    (apiKey) => {
      expect(isValidApiKey(apiKey)).toBe(false);
    },
  );

  it("rejects non-string header values", () => {
    expect(isValidApiKey(["valid-key"])).toBe(false);
  });
});
