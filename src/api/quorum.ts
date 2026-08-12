import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import axios from "axios";
import stringify from "json-stable-stringify";

import { logger } from "../common/logger";
import { sanitizeError } from "../common/sanitize-error";
import { config } from "../config";

type JsonPath = Array<string | number>;

type OracleSignature = Record<string, unknown> & {
  oracleSigner: string;
  signature: string;
};

type SignaturePath = {
  path: JsonPath;
  signatures: OracleSignature[];
};

type Candidate<T> = {
  key: string;
  response: T;
  signaturePaths: SignaturePath[];
};

type SignatureGroup<T> = {
  response: T;
  signers: Set<string>;
  signaturePathCount: number;
  firstAllowlistedContribution?: number;
};

type QuorumOutcome = "quorum" | "partial" | "unsigned" | "standalone";

type QuorumResolution<T> = {
  response: T;
  outcome: QuorumOutcome;
  matchedSignatures: number;
  groupKey?: string;
};

const SIGNATURE_MARKER = "__oracleSignatureArray";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isOracleSignature = (value: unknown): value is OracleSignature =>
  isRecord(value) &&
  typeof value.oracleSigner === "string" &&
  typeof value.signature === "string";

const normalizeComparableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(normalizeComparableValue);
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        normalizeComparableValue(item),
      ]),
    );
  }

  return typeof value === "string" && /^0x[0-9a-f]*$/i.test(value)
    ? value.toLowerCase()
    : value;
};

const getSignatureMetadata = (signature: OracleSignature): unknown =>
  normalizeComparableValue(
    Object.fromEntries(
      Object.entries(signature).filter(
        ([key]) => key !== "oracleSigner" && key !== "signature",
      ),
    ),
  );

const toWireValue = (value: unknown): unknown => {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map(toWireValue);
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, toWireValue(item)]),
    );
  }

  return value;
};

const canonicalizeUnsignedResponse = (
  value: unknown,
  path: JsonPath,
  signaturePaths: SignaturePath[],
): unknown => {
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(isOracleSignature)) {
      const metadata = value.map(getSignatureMetadata);
      const metadataKey = stringify(metadata[0]);
      if (metadata.some((item) => stringify(item) !== metadataKey)) {
        throw new Error("Oracle signatures used different signing metadata");
      }
      signaturePaths.push({ path, signatures: value });
      return { [SIGNATURE_MARKER]: metadata[0] };
    }

    return value.map((item, index) =>
      canonicalizeUnsignedResponse(item, [...path, index], signaturePaths),
    );
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        canonicalizeUnsignedResponse(item, [...path, key], signaturePaths),
      ]),
    );
  }

  return normalizeComparableValue(value);
};

const createCandidate = <T>(response: T, responseSchema: TSchema): Candidate<T> => {
  const wireResponse = toWireValue(response) as T;
  if (!Value.Check(responseSchema, wireResponse)) {
    throw new Error("Attestation response did not match the HTTP 200 schema");
  }

  const signaturePaths: SignaturePath[] = [];
  const comparableResponse = Value.Clean(
    responseSchema,
    structuredClone(wireResponse),
  );
  const unsignedResponse = canonicalizeUnsignedResponse(
    comparableResponse,
    [],
    signaturePaths,
  );
  const key = stringify(unsignedResponse);
  if (key === undefined) {
    throw new Error("Attestation response could not be canonicalized");
  }

  return { key, response: wireResponse, signaturePaths };
};

const updateSignaturePath = (
  target: unknown,
  path: JsonPath,
  update: (signatures: OracleSignature[]) => OracleSignature[],
): void => {
  if (path.length === 0) {
    throw new Error("Attestation response cannot be a signature array");
  }

  let parent = target;
  for (const segment of path.slice(0, -1)) {
    parent = (parent as Record<string | number, unknown>)[segment];
  }

  const key = path[path.length - 1];
  const record = parent as Record<string | number, unknown>;
  const signatures = record[key];
  if (!Array.isArray(signatures)) {
    throw new Error("Matching attestation responses had different signatures");
  }
  record[key] = update(signatures);
};

const getCandidateSigners = (signaturePaths: SignaturePath[]): Set<string> => {
  if (signaturePaths.length === 0) {
    return new Set();
  }

  const [first, ...rest] = signaturePaths.map(
    ({ signatures }) =>
      new Set(signatures.map(({ oracleSigner }) => oracleSigner.toLowerCase())),
  );
  return new Set(
    [...first].filter((signer) => rest.every((set) => set.has(signer))),
  );
};

const buildGroupResponse = <T>(group: SignatureGroup<T>): T =>
  structuredClone(group.response);

const sortSignatures = (
  signatures: OracleSignature[],
): OracleSignature[] =>
  [...signatures].sort((a, b) => {
    const signerA = a.oracleSigner.toLowerCase();
    const signerB = b.oracleSigner.toLowerCase();
    return signerA < signerB ? -1 : signerA > signerB ? 1 : 0;
  });

const createGroup = <T>(candidate: Candidate<T>): SignatureGroup<T> => {
  const response = structuredClone(candidate.response);
  for (const { path } of candidate.signaturePaths) {
    updateSignaturePath(response, path, () => []);
  }

  return {
    response,
    signers: new Set(),
    signaturePathCount: candidate.signaturePaths.length,
  };
};

const addCandidateToGroup = <T>(
  group: SignatureGroup<T>,
  candidate: Candidate<T>,
  oracleSigners?: Set<string>,
): void => {
  const newSigners = [...getCandidateSigners(candidate.signaturePaths)].filter(
    (signer) =>
      !group.signers.has(signer) &&
      (!oracleSigners || oracleSigners.has(signer)),
  );

  for (const { path, signatures } of candidate.signaturePaths) {
    const signaturesBySigner = new Map(
      signatures.map((signature) => [
        signature.oracleSigner.toLowerCase(),
        signature,
      ]),
    );
    updateSignaturePath(group.response, path, (current) =>
      sortSignatures([
        ...current,
        ...newSigners.map((signer) => signaturesBySigner.get(signer)!),
      ]),
    );
  }

  for (const signer of newSigners) {
    group.signers.add(signer);
  }
};

const loggableError = (error: unknown): string => {
  const sanitized = sanitizeError(error);
  if (sanitized instanceof Error) {
    return sanitized.message;
  }
  if (isRecord(sanitized) && typeof sanitized.message === "string") {
    return sanitized.message;
  }
  return String(sanitized);
};

const logPeerFailure = ({
  endpointPath,
  url,
  start,
  error,
}: {
  endpointPath: string;
  url: string;
  start: number;
  error: unknown;
}) => {
  const status = (error as { response?: { status?: unknown } }).response
    ?.status;
  logger.warn(
    "oracle-peer",
    JSON.stringify({
      msg: "Skipping peer attestation",
      endpointPath,
      url,
      durationMs: Date.now() - start,
      timeoutMs: config.peerRequestTimeoutMs,
      status: typeof status === "number" ? status : undefined,
      error: loggableError(error),
    }),
  );
};

export const resolveOracleQuorum = async <T>({
  endpointPath,
  requestBody,
  requestApiKey,
  requestPeerSignatures,
  responseSchema,
  createLocalResponse,
}: {
  endpointPath: string;
  requestBody: Record<string, unknown>;
  requestApiKey?: string | string[];
  requestPeerSignatures: boolean;
  responseSchema: TSchema;
  createLocalResponse: () => Promise<T>;
}): Promise<T> => {
  const resolutionStart = Date.now();
  const { oracleSigners, oracleSignersThreshold, peers } = config;
  const peerEntries =
    requestPeerSignatures && peers ? Object.entries(peers) : [];
  const logResolution = ({
    outcome,
    matchedSignatures,
    candidateGroupCount,
    localCompleted,
    localContributed,
  }: {
    outcome: QuorumOutcome;
    matchedSignatures: number;
    candidateGroupCount: number;
    localCompleted: boolean;
    localContributed: boolean;
  }) => {
    logger.debug(
      "oracle-quorum",
      JSON.stringify({
        msg: "Oracle quorum resolved",
        endpointPath,
        outcome,
        durationMs: Date.now() - resolutionStart,
        matchedSignatures,
        requiredSignatures: oracleSigners ? oracleSignersThreshold : null,
        candidateGroupCount,
        localCompleted,
        localContributed,
      }),
    );
  };

  if (peerEntries.length === 0) {
    const candidate = createCandidate(
      await createLocalResponse(),
      responseSchema,
    );
    let response = candidate.response;
    let matchedSignatures = getCandidateSigners(candidate.signaturePaths).size;
    if (oracleSigners && candidate.signaturePaths.length > 0) {
      const group = createGroup(candidate);
      addCandidateToGroup(group, candidate, oracleSigners);
      if (group.signers.size === 0) {
        throw new Error("No allowlisted oracle attestation was returned");
      }
      response = buildGroupResponse(group);
      matchedSignatures = group.signers.size;
    }

    if (requestPeerSignatures) {
      logResolution({
        outcome: "standalone",
        matchedSignatures,
        candidateGroupCount: 1,
        localCompleted: true,
        localContributed: true,
      });
    }
    return response;
  }

  const groups = new Map<string, SignatureGroup<T>>();
  let contributionSequence = 0;
  let localCandidateKey: string | undefined;
  let localCompleted = false;
  let localContributed = false;
  let localError: unknown;
  let earlyResolved = false;
  let resolveEarly!: (resolution: QuorumResolution<T>) => void;
  const earlyResponse = new Promise<QuorumResolution<T>>((resolve) => {
    resolveEarly = resolve;
  });

  const recordCandidate = (candidate: Candidate<T>, isLocal: boolean) => {
    let group = groups.get(candidate.key);
    if (!group) {
      group = createGroup(candidate);
      groups.set(candidate.key, group);
    }

    const signerCount = group.signers.size;
    addCandidateToGroup(group, candidate, oracleSigners);

    if (isLocal) {
      localCandidateKey = candidate.key;
      localContributed =
        candidate.signaturePaths.length === 0 ||
        group.signers.size > signerCount;
    }

    contributionSequence++;
    if (!oracleSigners) {
      return;
    }

    const matched = group.signers.size;
    if (matched > 0 && group.firstAllowlistedContribution === undefined) {
      group.firstAllowlistedContribution = contributionSequence;
    }

    if (!earlyResolved && matched >= oracleSignersThreshold) {
      earlyResolved = true;
      resolveEarly({
        response: buildGroupResponse(group),
        outcome: "quorum",
        matchedSignatures: matched,
        groupKey: candidate.key,
      });
    }
  };

  const localStart = Date.now();
  const localTask = Promise.resolve()
    .then(createLocalResponse)
    .then((response) => {
      localCompleted = true;
      recordCandidate(createCandidate(response, responseSchema), true);
    })
    .catch((error: unknown) => {
      localCompleted = true;
      localError = error;
      logger.warn(
        "oracle-quorum",
        JSON.stringify({
          msg: "Local attestation failed",
          endpointPath,
          durationMs: Date.now() - localStart,
          error: loggableError(error),
        }),
      );
    });

  const peerTasks = peerEntries.map(async ([url, apiKey]) => {
    const start = Date.now();
    try {
      const peerApiKey =
        apiKey === "pass-through" ? requestApiKey : apiKey;
      const response = await axios.post(
        `${url}${endpointPath}`,
        { ...requestBody, requestPeerSignatures: false },
        {
          headers:
            typeof peerApiKey === "string"
              ? { "x-api-key": peerApiKey }
              : undefined,
          timeout: config.peerRequestTimeoutMs,
        },
      );
      const durationMs = Date.now() - start;
      logger.debug(
        "oracle-peer",
        JSON.stringify({
          msg: "Peer request completed",
          endpointPath,
          url,
          durationMs,
          status: response.status,
        }),
      );
      recordCandidate(createCandidate(response.data as T, responseSchema), false);
    } catch (error: unknown) {
      logPeerFailure({ endpointPath, url, start, error });
    }
  });

  const allSourcesSettled = Promise.all([localTask, ...peerTasks]).then(() => {
    if (!oracleSigners) {
      if (localCandidateKey) {
        const group = groups.get(localCandidateKey)!;
        return {
          response: buildGroupResponse(group),
          outcome:
            group.signaturePathCount === 0 ? "unsigned" : "quorum",
          matchedSignatures: group.signers.size,
          groupKey: localCandidateKey,
        } satisfies QuorumResolution<T>;
      }
      throw localError ?? new Error("Local attestation did not return a response");
    }

    const localGroup = localCandidateKey
      ? groups.get(localCandidateKey)
      : undefined;
    if (localGroup?.signaturePathCount === 0) {
      return {
        response: buildGroupResponse(localGroup),
        outcome: "unsigned",
        matchedSignatures: 0,
        groupKey: localCandidateKey,
      } satisfies QuorumResolution<T>;
    }

    const bestGroup = [...groups.entries()]
      .map(([key, group]) => ({
        key,
        group,
        matched: group.signers.size,
      }))
      .filter(({ matched }) => matched > 0)
      .sort(
        (a, b) =>
          b.matched - a.matched ||
          a.group.firstAllowlistedContribution! -
            b.group.firstAllowlistedContribution!,
      )[0];

    if (bestGroup) {
      if (bestGroup.matched < oracleSignersThreshold) {
        logger.warn(
          "oracle-quorum",
          JSON.stringify({
            msg: "Returning partial oracle quorum",
            endpointPath,
            matchedSignatures: bestGroup.matched,
            requiredSignatures: oracleSignersThreshold,
            candidateGroupCount: groups.size,
          }),
        );
      }
      return {
        response: buildGroupResponse(bestGroup.group),
        outcome:
          bestGroup.matched < oracleSignersThreshold ? "partial" : "quorum",
        matchedSignatures: bestGroup.matched,
        groupKey: bestGroup.key,
      } satisfies QuorumResolution<T>;
    }

    throw localError ?? new Error("No allowlisted oracle attestation was returned");
  });

  const resolution = await (oracleSigners
    ? Promise.race([earlyResponse, allSourcesSettled])
    : allSourcesSettled);
  logResolution({
    outcome: resolution.outcome,
    matchedSignatures: resolution.matchedSignatures,
    candidateGroupCount: groups.size,
    localCompleted,
    localContributed:
      localContributed && localCandidateKey === resolution.groupKey,
  });
  return resolution.response;
};
