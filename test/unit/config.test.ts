import { afterAll, beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();

jest.mock("../../src/common/logger", () => ({
  logger: { error: mockLoggerError, warn: mockLoggerWarn },
}));

const originalEnv = process.env;
const signerA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const signerB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const signerC = "0xcccccccccccccccccccccccccccccccccccccccc";
const uppercaseSignerA = `0x${signerA.slice(2).toUpperCase()}`;

const loadConfig = async () => {
  jest.resetModules();
  return (await import("../../src/config")).config;
};

describe("Configuration", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.HTTP_PORT;
    delete process.env.PORT;
    delete process.env.PEER_REQUEST_TIMEOUT_MS;
    delete process.env.ORACLE_SIGNERS;
    delete process.env.ORACLE_SIGNERS_THRESHOLD;
    delete process.env.UNAUTHENTICATED_RATE_LIMIT_MAX;
    delete process.env.UNAUTHENTICATED_RATE_LIMIT_WINDOW_MS;
    delete process.env.ALLOCATOR_EVENT_ATTESTATION;
    delete process.env.RELAY_WS_URL;
    delete process.env.API_KEYS;
    delete process.env.PEERS;
    delete process.env.SIGNING_MODULE;
    delete process.env.ECDSA_PRIVATE_KEY;
    mockLoggerWarn.mockClear();
    mockLoggerError.mockClear();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("validates ports and peer request timeouts", async () => {
    process.env.PORT = "3001";
    process.env.HTTP_PORT = "3002";
    process.env.PEER_REQUEST_TIMEOUT_MS = "2500";
    process.env.UNAUTHENTICATED_RATE_LIMIT_MAX = "5";
    process.env.UNAUTHENTICATED_RATE_LIMIT_WINDOW_MS = "2500";

    const config = await loadConfig();

    expect(config.httpPort).toBe(3002);
    expect(config.peerRequestTimeoutMs).toBe(2500);
    expect(config.unauthenticatedRateLimitMax).toBe(5);
    expect(config.unauthenticatedRateLimitWindowMs).toBe(2500);
  });

  it("uses PORT when HTTP_PORT is not configured", async () => {
    process.env.PORT = "3001";

    const config = await loadConfig();

    expect(config.httpPort).toBe(3001);
  });

  it("defaults invalid ports and peer request timeouts", async () => {
    process.env.HTTP_PORT = "65536";
    process.env.PEER_REQUEST_TIMEOUT_MS = "1.5";
    process.env.UNAUTHENTICATED_RATE_LIMIT_MAX = "1.5";
    process.env.UNAUTHENTICATED_RATE_LIMIT_WINDOW_MS = "0";

    const config = await loadConfig();

    expect(config.httpPort).toBe(3000);
    expect(config.peerRequestTimeoutMs).toBe(10_000);
    expect(config.unauthenticatedRateLimitMax).toBe(2);
    expect(config.unauthenticatedRateLimitWindowMs).toBe(1000);
  });

  it("defaults the total signature threshold to one", async () => {
    const config = await loadConfig();

    expect(config.oracleSigners).toBeUndefined();
    expect(config.oracleSignersThreshold).toBe(1);
  });

  it("normalizes and deduplicates configured Oracle signers", async () => {
    process.env.ORACLE_SIGNERS = ` ${uppercaseSignerA} ;${signerA};${signerB}`;
    process.env.ORACLE_SIGNERS_THRESHOLD = "2";

    const config = await loadConfig();

    expect(config.oracleSigners).toEqual(new Set([signerA, signerB]));
    expect(config.oracleSignersThreshold).toBe(2);
  });

  it.each([
    "0x1234",
    "0x0000000000000000000000000000000000000000",
  ])("rejects an invalid Oracle signer address of %p", async (signer) => {
    process.env.ORACLE_SIGNERS = signer;

    await expect(loadConfig()).rejects.toThrow(
      `ORACLE_SIGNERS contains an invalid or zero address: ${signer}`,
    );
  });

  it.each(["0", "-1", "1.5", "invalid", ""])(
    "rejects an invalid total signature threshold of %p",
    async (threshold) => {
      process.env.ORACLE_SIGNERS_THRESHOLD = threshold;

      await expect(loadConfig()).rejects.toThrow(
        "ORACLE_SIGNERS_THRESHOLD must be an integer of at least 1",
      );
    },
  );

  it("rejects a threshold above the unique allowlisted signer count", async () => {
    process.env.ORACLE_SIGNERS = `${signerA};${uppercaseSignerA};${signerB}`;
    process.env.ORACLE_SIGNERS_THRESHOLD = "3";

    await expect(loadConfig()).rejects.toThrow(
      "ORACLE_SIGNERS_THRESHOLD cannot exceed the number of unique ORACLE_SIGNERS",
    );
  });

  it("allows a threshold without an Oracle signer allowlist", async () => {
    process.env.ORACLE_SIGNERS_THRESHOLD = "3";

    const config = await loadConfig();

    expect(config.oracleSigners).toBeUndefined();
    expect(config.oracleSignersThreshold).toBe(3);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "config",
      JSON.stringify({
        msg: "ORACLE_SIGNERS_THRESHOLD is ignored without ORACLE_SIGNERS",
        requiredSignatures: 3,
      }),
    );
  });

  it("warns when the configured peers cannot reach the threshold", async () => {
    process.env.ORACLE_SIGNERS = `${signerA};${signerB};${signerC}`;
    process.env.ORACLE_SIGNERS_THRESHOLD = "3";
    process.env.PEERS = "https://peer.example|peer-key";

    await loadConfig();

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "config",
      JSON.stringify({
        msg: "Configured oracle quorum cannot reach threshold",
        configuredPeers: 1,
        requiredSignatures: 3,
        maximumAvailableSignatures: 2,
      }),
    );
  });

  it("disables event attestation by default", async () => {
    const config = await loadConfig();

    expect(config.allocatorEventAttestation).toBe(false);
    expect(config.relayWsUrl).toBeUndefined();
  });

  it("accepts event attestation settings", async () => {
    process.env.ALLOCATOR_EVENT_ATTESTATION = "true";
    process.env.RELAY_WS_URL = "wss://relay.example";

    const config = await loadConfig();

    expect(config.allocatorEventAttestation).toBe(true);
    expect(config.relayWsUrl).toBe("wss://relay.example");
  });

  it("disables an invalid event attestation flag", async () => {
    process.env.ALLOCATOR_EVENT_ATTESTATION = "1";

    const config = await loadConfig();

    expect(config.allocatorEventAttestation).toBe(false);
  });

  it.each(["raw-private-key", "aws-kms"])(
    "accepts the %s signing module",
    async (signingModule) => {
      process.env.SIGNING_MODULE = signingModule;

      const config = await loadConfig();

      expect(config.signingModule).toBe(signingModule);
    },
  );

  it("rejects an unsupported signing module", async () => {
    process.env.SIGNING_MODULE = "unsupported";

    await expect(loadConfig()).rejects.toThrow(
      "SIGNING_MODULE must be one of: raw-private-key, aws-kms",
    );
  });

  it("parses API keys and peers without truncating values", async () => {
    process.env.API_KEYS = "key-one:partner:one;key-two:partner-two";
    process.env.PEERS =
      "https://peer-one.example|secret-one;https://peer-two.example|secret-two";

    const config = await loadConfig();

    expect(config.apiKeys).toEqual({
      "key-one": "partner:one",
      "key-two": "partner-two",
    });
    expect(config.peers).toEqual({
      "https://peer-one.example": "secret-one",
      "https://peer-two.example": "secret-two",
    });
  });

  it.each([
    ["API_KEYS", "missing-separator"],
    ["PEERS", "https://peer.example|one;https://peer.example|two"],
  ])("rejects malformed %s configuration", async (name, value) => {
    process.env[name] = value;

    await expect(loadConfig()).rejects.toThrow(name);
  });

  it("validates raw private key formatting", async () => {
    const privateKey = `0x${"ab".repeat(32)}`;
    process.env.ECDSA_PRIVATE_KEY = privateKey;

    const config = await loadConfig();

    expect(config.ecdsaPrivateKey).toBe(privateKey);

    process.env.ECDSA_PRIVATE_KEY = "0xinvalid";
    await expect(loadConfig()).rejects.toThrow(
      "ECDSA_PRIVATE_KEY must be a 32-byte hexadecimal value prefixed with 0x",
    );
  });

  it("ignores the raw private key for other signing modules", async () => {
    process.env.SIGNING_MODULE = "aws-kms";
    process.env.ECDSA_PRIVATE_KEY = "0xinvalid";

    const config = await loadConfig();

    expect(config.ecdsaPrivateKey).toBeUndefined();
  });
});
