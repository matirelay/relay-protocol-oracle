import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { FastifyInstance } from "fastify";

import { config } from "../../src/config";
import {
  buildHttpServer,
  validateLocalOracleSigner,
} from "../../src/http-server";

jest.mock("../../src/api", () => ({
  setupEndpoints: (app: FastifyInstance) => {
    app.get("/test", async () => ({ ok: true }));
  },
}));

jest.mock("../../src/config", () => ({
  config: {
    apiKeys: { "valid-key": "partner" },
    httpPort: 0,
    oracleSigners: undefined,
    allocatorEventAttestation: false,
    relayWsUrl: undefined,
    unauthenticatedRateLimitMax: 1,
    unauthenticatedRateLimitWindowMs: 60000,
  },
}));

const mockedConfig = config as typeof config & {
  oracleSigners?: Set<string>;
};
const localSigner = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

let httpServer: FastifyInstance;

describe("unauthenticated rate limiting", () => {
  beforeEach(async () => {
    httpServer = await buildHttpServer();
  });

  afterEach(async () => {
    await httpServer.close();
  });

  it("does not treat inherited object properties as authenticated API keys", async () => {
    const firstResponse = await httpServer.inject({
      method: "GET",
      url: "/test",
      headers: { "x-api-key": "constructor" },
    });
    const secondResponse = await httpServer.inject({
      method: "GET",
      url: "/test",
      headers: { "x-api-key": "constructor" },
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(firstResponse.headers["x-ratelimit-remaining"]).toBe("0");
    expect(secondResponse.statusCode).toBe(429);
  });

  it("exempts configured API keys from unauthenticated rate limiting", async () => {
    const responses = await Promise.all(
      Array.from({ length: 2 }, () =>
        httpServer.inject({
          method: "GET",
          url: "/test",
          headers: { "x-api-key": "valid-key" },
        }),
      ),
    );

    expect(responses.map(({ statusCode }) => statusCode)).toEqual([200, 200]);
    expect(responses[0].headers["x-ratelimit-limit"]).toBeUndefined();
  });
});

describe("local Oracle signer startup validation", () => {
  beforeEach(() => {
    mockedConfig.oracleSigners = undefined;
  });

  it("allows startup without an Oracle signer allowlist", () => {
    expect(() => validateLocalOracleSigner(localSigner)).not.toThrow();
  });

  it("allows startup when the local signer is allowlisted", () => {
    mockedConfig.oracleSigners = new Set([localSigner]);

    expect(() =>
      validateLocalOracleSigner(localSigner.toUpperCase()),
    ).not.toThrow();
  });

  it("rejects startup when the local signer is not allowlisted", () => {
    mockedConfig.oracleSigners = new Set([
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]);

    expect(() => validateLocalOracleSigner(localSigner)).toThrow(
      `Local oracle signer ${localSigner} is not included in ORACLE_SIGNERS`,
    );
  });
});
