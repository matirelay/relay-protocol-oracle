import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { Type, type TSchema } from "@sinclair/typebox";
import axios from "axios";

import { logger } from "../../../src/common/logger";
import { resolveOracleQuorum } from "../../../src/api/quorum";

jest.mock("axios");

jest.mock("../../../src/common/logger", () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const SIGNER_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SIGNER_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SIGNER_C = "0xcccccccccccccccccccccccccccccccccccccccc";
const SIGNER_OUTSIDE = "0x9999999999999999999999999999999999999999";

const mockConfig: {
  peers?: Record<string, string>;
  peerRequestTimeoutMs: number;
  oracleSigners?: Set<string>;
  oracleSignersThreshold: number;
} = {
  peers: undefined,
  peerRequestTimeoutMs: 10000,
  oracleSigners: undefined,
  oracleSignersThreshold: 1,
};

jest.mock("../../../src/config", () => ({
  get config() {
    return mockConfig;
  },
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

const loggedMessage = (
  log: jest.MockedFunction<typeof logger.debug>,
  component: string,
  msg: string,
) =>
  log.mock.calls
    .filter(([loggedComponent]) => loggedComponent === component)
    .map(([, message]) => JSON.parse(message))
    .find((message) => message.msg === msg);

const signatureSchema = Type.Object({
  oracleChainId: Type.Optional(Type.String()),
  oracleContract: Type.Optional(Type.String()),
  oracleSigner: Type.String(),
  signature: Type.String(),
});

const responseSchema = Type.Object({
  value: Type.String(),
  amount: Type.String(),
  signatures: Type.Array(signatureSchema),
});

const multiResponseSchema = Type.Object({
  value: Type.String(),
  execution: Type.Object({
    signatures: Type.Array(signatureSchema),
  }),
  withdrawal: Type.Object({
    signatures: Type.Array(signatureSchema),
  }),
});

const sig = (oracleSigner: string) => ({
  oracleSigner,
  signature: `sig-${oracleSigner}`,
});

const domainSig = (oracleSigner: string, oracleContract: string) => ({
  oracleChainId: "1",
  oracleContract,
  ...sig(oracleSigner),
});

const response = (
  oracleSigner: string,
  value = "0xAABB",
  amount: string | bigint = "1",
) => ({
  value,
  amount,
  signatures: [sig(oracleSigner)],
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const startResolution = ({
  createLocalResponse,
  requestPeerSignatures = true,
  requestApiKey = "incoming-key",
  schema = responseSchema,
}: {
  createLocalResponse: () => Promise<any>;
  requestPeerSignatures?: boolean;
  requestApiKey?: string | string[];
  schema?: TSchema;
}) =>
  resolveOracleQuorum({
    endpointPath: "/attestations/test/v1",
    requestBody: { requestId: "request" },
    requestApiKey,
    requestPeerSignatures,
    responseSchema: schema,
    createLocalResponse,
  });

describe("resolveOracleQuorum", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConfig.peers = undefined;
    mockConfig.oracleSigners = undefined;
    mockConfig.oracleSignersThreshold = 1;
  });

  it("uses the local response when peer signatures are disabled", async () => {
    mockConfig.peers = { "http://peer": "peer-key" };

    const result = await startResolution({
      createLocalResponse: async () => response(SIGNER_A, "0xAABB", 1n),
      requestPeerSignatures: false,
    });

    expect(result).toEqual(response(SIGNER_A, "0xAABB", "1"));
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it("returns a matching all-remote quorum without waiting for local work", async () => {
    mockConfig.peers = {
      "http://peer-a": "key-a",
      "http://peer-b": "key-b",
    };
    mockConfig.oracleSigners = new Set([SIGNER_A, SIGNER_B, SIGNER_C]);
    mockConfig.oracleSignersThreshold = 2;
    const local = deferred<ReturnType<typeof response>>();
    mockedAxios.post
      .mockResolvedValueOnce({ data: response(SIGNER_A) })
      .mockResolvedValueOnce({ data: response(SIGNER_B, "0xaabb") });

    const result = await startResolution({
      createLocalResponse: () => local.promise,
    });

    expect(result.signatures).toHaveLength(2);
    expect(result.signatures).toEqual(
      expect.arrayContaining([sig(SIGNER_A), sig(SIGNER_B)]),
    );
    expect(
      loggedMessage(
        jest.mocked(logger.debug),
        "oracle-quorum",
        "Oracle quorum resolved",
      ),
    ).toMatchObject({
      endpointPath: "/attestations/test/v1",
      outcome: "quorum",
      durationMs: expect.any(Number),
      matchedSignatures: 2,
      requiredSignatures: 2,
      candidateGroupCount: 1,
      localCompleted: false,
      localContributed: false,
    });
  });

  it("does not combine mismatched payloads or duplicate signers", async () => {
    mockConfig.peers = {
      "http://peer-a": "key-a",
      "http://peer-a-duplicate": "key-a-duplicate",
      "http://peer-b": "key-b",
      "http://peer-c": "key-c",
    };
    mockConfig.oracleSigners = new Set([SIGNER_A, SIGNER_B, SIGNER_C]);
    mockConfig.oracleSignersThreshold = 2;
    mockedAxios.post
      .mockResolvedValueOnce({ data: response(SIGNER_A, "0x01") })
      .mockResolvedValueOnce({ data: response(SIGNER_A, "0x01") })
      .mockResolvedValueOnce({ data: response(SIGNER_B, "0x02") })
      .mockResolvedValueOnce({ data: response(SIGNER_C, "0x01") });

    const result = await startResolution({
      createLocalResponse: async () => {
        throw new Error("local unavailable");
      },
    });

    expect(result.value).toBe("0x01");
    expect(result.signatures).toEqual([sig(SIGNER_A), sig(SIGNER_C)]);
  });

  it("ignores schema-unknown fields when matching peer responses", async () => {
    mockConfig.peers = {
      "http://peer-a": "key-a",
      "http://peer-b": "key-b",
    };
    mockConfig.oracleSigners = new Set([SIGNER_A, SIGNER_B]);
    mockConfig.oracleSignersThreshold = 2;
    mockedAxios.post
      .mockResolvedValueOnce({
        data: { ...response(SIGNER_A), legacyPeerField: "old" },
      })
      .mockResolvedValueOnce({
        data: { ...response(SIGNER_B), newPeerField: "new" },
      });

    const result = await startResolution({
      createLocalResponse: async () => {
        throw new Error("local unavailable");
      },
    });

    expect(result.signatures).toEqual([sig(SIGNER_A), sig(SIGNER_B)]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      loggedMessage(
        jest.mocked(logger.warn),
        "oracle-quorum",
        "Local attestation failed",
      ),
    ).toMatchObject({
      endpointPath: "/attestations/test/v1",
      error: "local unavailable",
    });
  });

  it("does not combine signatures from different signing domains", async () => {
    const oldOracle = "0x1111111111111111111111111111111111111111";
    const newOracle = "0x2222222222222222222222222222222222222222";
    mockConfig.peers = {
      "http://old": "old-key",
      "http://new-a": "new-a-key",
      "http://new-b": "new-b-key",
    };
    mockConfig.oracleSigners = new Set([SIGNER_A, SIGNER_B, SIGNER_C]);
    mockConfig.oracleSignersThreshold = 2;
    mockedAxios.post
      .mockResolvedValueOnce({
        data: {
          ...response(SIGNER_A),
          signatures: [domainSig(SIGNER_A, oldOracle)],
        },
      })
      .mockResolvedValueOnce({
        data: {
          ...response(SIGNER_B),
          signatures: [domainSig(SIGNER_B, newOracle)],
        },
      })
      .mockResolvedValueOnce({
        data: {
          ...response(SIGNER_C),
          signatures: [domainSig(SIGNER_C, newOracle.toUpperCase())],
        },
      });

    const result = await startResolution({
      createLocalResponse: async () => {
        throw new Error("local unavailable");
      },
    });

    expect(result.signatures).toEqual([
      domainSig(SIGNER_B, newOracle),
      domainSig(SIGNER_C, newOracle.toUpperCase()),
    ]);
  });

  it("requires and consistently sorts each signer in every signature array", async () => {
    mockConfig.peers = {
      "http://mismatched": "mismatched-key",
      "http://peer-b": "key-b",
      "http://peer-c": "key-c",
    };
    mockConfig.oracleSigners = new Set([SIGNER_A, SIGNER_B, SIGNER_C]);
    mockConfig.oracleSignersThreshold = 2;
    mockedAxios.post
      .mockResolvedValueOnce({
        data: {
          value: "same",
          execution: { signatures: [sig(SIGNER_A)] },
          withdrawal: { signatures: [sig(SIGNER_B)] },
        },
      })
      .mockResolvedValueOnce({
        data: {
          value: "same",
          execution: { signatures: [sig(SIGNER_C)] },
          withdrawal: { signatures: [sig(SIGNER_C)] },
        },
      })
      .mockResolvedValueOnce({
        data: {
          value: "same",
          execution: { signatures: [sig(SIGNER_B)] },
          withdrawal: { signatures: [sig(SIGNER_B)] },
        },
      });

    const result = await startResolution({
      schema: multiResponseSchema,
      createLocalResponse: async () => {
        throw new Error("local unavailable");
      },
    });
    const expectedSigners = [SIGNER_B, SIGNER_C];

    expect(
      result.execution.signatures.map(
        ({ oracleSigner }: { oracleSigner: string }) => oracleSigner,
      ),
    ).toEqual(expectedSigners);
    expect(
      result.withdrawal.signatures.map(
        ({ oracleSigner }: { oracleSigner: string }) => oracleSigner,
      ),
    ).toEqual(expectedSigners);
  });

  it.each([
    {
      name: "dedicated",
      peerApiKey: "dedicated-key",
      requestApiKey: "incoming-key",
      headers: { "x-api-key": "dedicated-key" },
    },
    {
      name: "pass-through",
      peerApiKey: "pass-through",
      requestApiKey: "incoming-key",
      headers: { "x-api-key": "incoming-key" },
    },
    {
      name: "ambiguous pass-through",
      peerApiKey: "pass-through",
      requestApiKey: ["first-key", "second-key"],
      headers: undefined,
    },
  ])(
    "sends a non-recursive $name peer request",
    async ({ peerApiKey, requestApiKey, headers }) => {
      mockConfig.peers = { "http://peer": peerApiKey };
      mockedAxios.post.mockResolvedValue({
        data: response(SIGNER_B),
        status: 200,
      });

      await startResolution({
        createLocalResponse: async () => response(SIGNER_A),
        requestApiKey,
      });

      expect(mockedAxios.post).toHaveBeenCalledWith(
        "http://peer/attestations/test/v1",
        { requestId: "request", requestPeerSignatures: false },
        { headers, timeout: 10000 },
      );
      const peerLog = loggedMessage(
        jest.mocked(logger.debug),
        "oracle-peer",
        "Peer request completed",
      );
      expect(peerLog).toMatchObject({
        endpointPath: "/attestations/test/v1",
        url: "http://peer",
        durationMs: expect.any(Number),
        status: 200,
      });
      expect(peerLog).not.toHaveProperty("data");
    },
  );

  it("sanitizes peer failures without logging their response body", async () => {
    mockConfig.peers = { "http://peer": "peer-key" };
    mockedAxios.post.mockRejectedValue({
      message: "peer unavailable",
      response: { status: 503, data: { secret: "response-secret" } },
    });

    await startResolution({
      createLocalResponse: async () => response(SIGNER_A),
    });

    const peerLog = loggedMessage(
      jest.mocked(logger.warn),
      "oracle-peer",
      "Skipping peer attestation",
    );
    expect(peerLog).toMatchObject({
      status: 503,
      error: "peer unavailable",
    });
    expect(JSON.stringify(peerLog)).not.toContain("response-secret");
  });

  it("strips non-allowlisted signatures from a partial group", async () => {
    mockConfig.peers = {
      "http://outside": "outside-key",
      "http://eligible": "eligible-key",
    };
    mockConfig.oracleSigners = new Set([SIGNER_A, SIGNER_B, SIGNER_C]);
    mockConfig.oracleSignersThreshold = 3;
    mockedAxios.post
      .mockResolvedValueOnce({ data: response(SIGNER_OUTSIDE) })
      .mockResolvedValueOnce({ data: response(SIGNER_A) });

    const result = await startResolution({
      createLocalResponse: async () => {
        throw new Error("local unavailable");
      },
    });

    expect(result.signatures).toEqual([sig(SIGNER_A)]);
    expect(logger.warn).toHaveBeenCalledWith(
      "oracle-quorum",
      JSON.stringify({
        msg: "Returning partial oracle quorum",
        endpointPath: "/attestations/test/v1",
        matchedSignatures: 1,
        requiredSignatures: 3,
        candidateGroupCount: 1,
      }),
    );
  });

  it("rejects a signed response without an allowlisted signer", async () => {
    mockConfig.oracleSigners = new Set([SIGNER_A]);

    await expect(
      startResolution({
        requestPeerSignatures: false,
        createLocalResponse: async () => response(SIGNER_OUTSIDE),
      }),
    ).rejects.toThrow("No allowlisted oracle attestation was returned");
  });

  it("keeps a pending local result unless a signed quorum completes", async () => {
    const statusSchema = Type.Union([
      Type.Object({ status: Type.Literal("PENDING") }),
      Type.Object({
        status: Type.Literal("EXECUTED"),
        signatures: Type.Array(signatureSchema),
      }),
    ]);
    mockConfig.peers = { "http://peer": "peer-key" };
    mockConfig.oracleSigners = new Set([SIGNER_A, SIGNER_B]);
    mockConfig.oracleSignersThreshold = 2;
    mockedAxios.post.mockResolvedValue({
      data: { status: "EXECUTED", signatures: [sig(SIGNER_A)] },
    });

    const result = await startResolution({
      schema: statusSchema,
      createLocalResponse: async () => ({ status: "PENDING" }),
    });

    expect(result).toEqual({ status: "PENDING" });
  });

  it("waits for all peers and returns the local group without an allowlist", async () => {
    mockConfig.peers = {
      "http://matching": "matching-key",
      "http://different": "different-key",
    };
    mockedAxios.post
      .mockResolvedValueOnce({ data: response(SIGNER_B) })
      .mockResolvedValueOnce({ data: response(SIGNER_C, "0x02") });

    const result = await startResolution({
      createLocalResponse: async () => response(SIGNER_A),
    });

    expect(result.value).toBe("0xAABB");
    expect(result.signatures).toHaveLength(2);
    expect(result.signatures).toEqual(
      expect.arrayContaining([sig(SIGNER_A), sig(SIGNER_B)]),
    );
  });

  it("rejects malformed local and peer responses", async () => {
    mockConfig.peers = { "http://peer": "peer-key" };
    mockConfig.oracleSigners = new Set([SIGNER_A]);
    mockConfig.oracleSignersThreshold = 1;
    mockedAxios.post.mockResolvedValue({ data: { value: "incomplete" } });

    await expect(
      startResolution({
        createLocalResponse: async () => ({ value: "also-incomplete" }),
      }),
    ).rejects.toThrow("Attestation response did not match the HTTP 200 schema");
  });
});
