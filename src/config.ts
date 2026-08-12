import { isAddress, zeroAddress, type Hex } from "viem";

import { logger } from "./common/logger";

type PositiveNumberOptions = {
  defaultValue: number;
  integer?: boolean;
  maximum?: number;
};

const httpPortOptions = {
  defaultValue: 3000,
  integer: true,
  maximum: 65_535,
} as const;

const positiveNumberEnv = {
  HTTP_PORT: httpPortOptions,
  PORT: httpPortOptions,
  PEER_REQUEST_TIMEOUT_MS: { defaultValue: 10_000, integer: true },
  UNAUTHENTICATED_RATE_LIMIT_MAX: { defaultValue: 2, integer: true },
  UNAUTHENTICATED_RATE_LIMIT_WINDOW_MS: {
    defaultValue: 1000,
    integer: true,
  },
} as const satisfies Record<string, PositiveNumberOptions>;

type PositiveNumberEnvName = keyof typeof positiveNumberEnv;

const positiveNumberFromEnv = (name: PositiveNumberEnvName): number => {
  const options: PositiveNumberOptions = positiveNumberEnv[name];
  const value = process.env[name];
  if (value === undefined) {
    return options.defaultValue;
  }

  const parsed = Number(value);
  if (
    Number.isFinite(parsed) &&
    parsed > 0 &&
    parsed <= (options.maximum ?? Number.POSITIVE_INFINITY) &&
    (!options.integer || Number.isInteger(parsed))
  ) {
    return parsed;
  }

  logger.warn(
    "config",
    JSON.stringify({
      msg: "Invalid numeric configuration, using default",
      name,
      value,
      defaultValue: options.defaultValue,
    }),
  );
  return options.defaultValue;
};

type BooleanOptions = {
  defaultValue: boolean;
};

const booleanEnv = {
  ALLOCATOR_EVENT_ATTESTATION: { defaultValue: false },
} as const satisfies Record<string, BooleanOptions>;

type BooleanEnvName = keyof typeof booleanEnv;

const booleanFromEnv = (name: BooleanEnvName): boolean => {
  const options: BooleanOptions = booleanEnv[name];
  const value = process.env[name];
  if (value === undefined) {
    return options.defaultValue;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }

  logger.error(
    "config",
    JSON.stringify({
      msg: "Invalid boolean configuration, using default",
      name,
      value,
      defaultValue: options.defaultValue,
    }),
  );
  return options.defaultValue;
};

const signingModules = ["raw-private-key", "aws-kms"] as const;

export type SigningModule = (typeof signingModules)[number];

const isSigningModule = (value: string): value is SigningModule =>
  signingModules.some((signingModule) => signingModule === value);

const signingModuleFromEnv = (): SigningModule | undefined => {
  const value = process.env.SIGNING_MODULE;
  if (value === undefined) {
    return undefined;
  }
  if (isSigningModule(value)) {
    return value;
  }
  throw new Error(
    `SIGNING_MODULE must be one of: ${signingModules.join(", ")}`,
  );
};

type RecordEnvName = "API_KEYS" | "PEERS";

const recordFromEnv = (
  name: RecordEnvName,
  separator: ":" | "|",
): Record<string, string> | undefined => {
  const value = process.env[name];
  if (!value) {
    return undefined;
  }

  const entries = new Map<string, string>();
  for (const [index, entry] of value.split(";").entries()) {
    const separatorIndex = entry.indexOf(separator);
    const key = entry.slice(0, separatorIndex);
    const entryValue = entry.slice(separatorIndex + separator.length);
    if (separatorIndex <= 0 || !entryValue) {
      throw new Error(`${name} entry ${index + 1} is malformed`);
    }
    if (entries.has(key)) {
      throw new Error(`${name} entry ${index + 1} duplicates an earlier key`);
    }
    entries.set(key, entryValue);
  }
  return Object.fromEntries(entries);
};

const privateKeyFromEnv = (
  signingModule: SigningModule,
): Hex | undefined => {
  if (signingModule !== "raw-private-key") {
    return undefined;
  }

  const value = process.env.ECDSA_PRIVATE_KEY;
  if (value === undefined) {
    return undefined;
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(
      "ECDSA_PRIVATE_KEY must be a 32-byte hexadecimal value prefixed with 0x",
    );
  }
  return value as Hex;
};

const parseOracleSigners = (value: string | undefined) => {
  if (!value) {
    return undefined;
  }

  const signers = value.split(";").map((signer) => signer.trim());
  for (const signer of signers) {
    if (
      !isAddress(signer, { strict: false }) ||
      signer.toLowerCase() === zeroAddress
    ) {
      throw new Error(
        `ORACLE_SIGNERS contains an invalid or zero address: ${signer}`,
      );
    }
  }

  return new Set(signers.map((signer) => signer.toLowerCase()));
};

const oracleSigners = parseOracleSigners(process.env.ORACLE_SIGNERS);
const oracleSignersThreshold = Number(
  process.env.ORACLE_SIGNERS_THRESHOLD ?? 1,
);

if (!Number.isInteger(oracleSignersThreshold) || oracleSignersThreshold < 1) {
  throw new Error("ORACLE_SIGNERS_THRESHOLD must be an integer of at least 1");
}

if (oracleSigners && oracleSignersThreshold > oracleSigners.size) {
  throw new Error(
    "ORACLE_SIGNERS_THRESHOLD cannot exceed the number of unique ORACLE_SIGNERS",
  );
}

const httpPort = positiveNumberFromEnv(
  process.env.HTTP_PORT === undefined ? "PORT" : "HTTP_PORT",
);
const signingModule = signingModuleFromEnv();
const ecdsaPrivateKey = privateKeyFromEnv(
  signingModule ?? "raw-private-key",
);
const peers = recordFromEnv("PEERS", "|");

if (process.env.ORACLE_SIGNERS_THRESHOLD !== undefined && !oracleSigners) {
  logger.warn(
    "config",
    JSON.stringify({
      msg: "ORACLE_SIGNERS_THRESHOLD is ignored without ORACLE_SIGNERS",
      requiredSignatures: oracleSignersThreshold,
    }),
  );
}

if (oracleSigners) {
  const configuredPeers = peers ? Object.keys(peers).length : 0;
  const maximumAvailableSignatures = configuredPeers + 1;
  if (oracleSignersThreshold > maximumAvailableSignatures) {
    logger.warn(
      "config",
      JSON.stringify({
        msg: "Configured oracle quorum cannot reach threshold",
        configuredPeers,
        requiredSignatures: oracleSignersThreshold,
        maximumAvailableSignatures,
      }),
    );
  }
}

export const config = {
  httpPort,
  environment: process.env.ENVIRONMENT!,
  peerRequestTimeoutMs: positiveNumberFromEnv("PEER_REQUEST_TIMEOUT_MS"),
  // Semicolon-separated multisig signer addresses, unset means wait for all peers.
  oracleSigners,
  // Total number of unique allowlisted oracle signatures required for a quorum.
  oracleSignersThreshold,
  unauthenticatedRateLimitMax: positiveNumberFromEnv(
    "UNAUTHENTICATED_RATE_LIMIT_MAX",
  ),
  unauthenticatedRateLimitWindowMs: positiveNumberFromEnv(
    "UNAUTHENTICATED_RATE_LIMIT_WINDOW_MS",
  ),
  allocatorEventAttestation: booleanFromEnv(
    "ALLOCATOR_EVENT_ATTESTATION",
  ),
  relayWsUrl: process.env.RELAY_WS_URL,

  apiKeys: recordFromEnv("API_KEYS", ":"),

  peers,

  signingModule,

  // For "raw-private-key" signing module, production deployments should use
  // SIGNING_MODULE=aws-kms instead of providing a raw key here.
  // nosemgrep: raw-private-key-from-env
  ecdsaPrivateKey,

  // For "aws-kms" signing module
  awsKmsSignerKeyId: process.env.AWS_KMS_SIGNER_KEY_ID,
  awsKmsSignerKeyRegion: process.env.AWS_KMS_SIGNER_KEY_REGION,
};
