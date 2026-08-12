import { isAddress, zeroAddress, zeroHash } from "viem";

import { AttestationCache } from "../../../common/attestation-cache";
import { logger } from "../../../common/logger";
import { signWithdrawRequestMessage } from "../../../common/signer";
import {
  WithdrawRequestAttestationContext as AttestationContext,
  WithdrawRequestAttestationMessage as AttestationMessage,
} from "..";
import {
  SIGNER_CONCURRENCY,
  SIGNER_MAX_PENDING,
  SignerLimiter,
} from "./signer-limiter";

type Signature = Awaited<ReturnType<typeof signWithdrawRequestMessage>>;

type SignedAttestation = AttestationMessage & {
  signatures: Signature[];
};

type CacheEntry = {
  attestation: SignedAttestation;
  indexes: number[];
};

type Component = {
  hashToSign: string;
  owners: Set<string>;
  generation: number;
};

type ComponentSnapshot = Omit<Component, "owners"> & {
  index: number;
};

type ComponentGroup = {
  chainId: number;
  allocator: string;
  components: Map<number, Component>;
};

export type WithdrawRequestEventProvenance = {
  transactionHash?: string;
  blockNumber?: string;
  logIndex?: string;
};

declare const observationBrand: unique symbol;

export type WithdrawRequestObservation = {
  readonly [observationBrand]: true;
};

type ActiveObservation = {
  attestation: AttestationMessage;
  indexes: number[];
  generation: number;
  provenance?: WithdrawRequestEventProvenance;
};

type ObservationState = {
  metadata: {
    chainId: number;
    allocator: string;
  };
  indexes: Map<
    number,
    {
      hashToSign: string;
      generation: number;
      provenance?: WithdrawRequestEventProvenance;
    }
  >;
  active: Set<number>;
};

type Options = {
  ttlMs: number;
  maxCount: number;
  maxWeight?: number;
  getWeight?: (entry: CacheEntry) => number;
  cleanupIntervalMs?: number | false;
  sign?: typeof signWithdrawRequestMessage;
  signerLimiter?: SignerLimiter;
};

type ResolveOptions = {
  context: AttestationContext;
  hashIndexes: number[];
  fetchAttestation: () => Promise<AttestationMessage>;
};

type ResolutionSource = "derived" | "exact" | "http-fallback";

const COMPONENT = "withdraw-request-cache";
const CACHE_PREFIX = "withdraw-requests:v1";
const BYTES32_PATTERN = /^0x[0-9a-f]{64}$/i;
export const MAX_HASH_INDEXES = 256;
export const CACHE_TTL_MS = 300_000;
const CACHE_MAX_COUNT = 10_000;
const CACHE_MAX_HASH_COUNT = 100_000;

const normalizeHex = (value: string) => value.toLowerCase();

const isSameProvenance = (
  left: WithdrawRequestEventProvenance | undefined,
  right: WithdrawRequestEventProvenance,
) =>
  left?.transactionHash?.toLowerCase() ===
    right.transactionHash?.toLowerCase() &&
  left?.blockNumber?.toLowerCase() === right.blockNumber?.toLowerCase() &&
  left?.logIndex?.toLowerCase() === right.logIndex?.toLowerCase();

const isDefined = <V>(value: V | undefined): value is V => value !== undefined;

const isSameContext = (
  left: AttestationContext,
  right: AttestationContext,
) =>
  left.chainId === right.chainId &&
  normalizeHex(left.allocator) === normalizeHex(right.allocator) &&
  normalizeHex(left.withdrawRequestHash) ===
    normalizeHex(right.withdrawRequestHash);

const isSameUnsignedAttestation = (
  left: AttestationMessage,
  right: AttestationMessage,
) =>
  isSameContext(left, right) &&
  left.hashesToSign.length === right.hashesToSign.length &&
  left.hashesToSign.every(
    (hash, index) =>
      normalizeHex(hash) === normalizeHex(right.hashesToSign[index]),
  );

const validateContext = (context: AttestationContext) => {
  if (!Number.isSafeInteger(context.chainId) || context.chainId < 1) {
    throw new Error("Withdrawal attestation chain id must be a positive integer");
  }
  if (
    !isAddress(context.allocator) ||
    normalizeHex(context.allocator) === zeroAddress
  ) {
    throw new Error("Withdrawal attestation allocator must be a non-zero address");
  }
  if (
    !BYTES32_PATTERN.test(context.withdrawRequestHash) ||
    normalizeHex(context.withdrawRequestHash) === zeroHash
  ) {
    throw new Error("Withdrawal request hash must be a non-zero bytes32 value");
  }
};

const validateIndexes = (indexes: number[]) => {
  if (
    indexes.length === 0 ||
    indexes.length > MAX_HASH_INDEXES ||
    indexes.some((index) => !Number.isSafeInteger(index) || index < 0)
  ) {
    throw new Error(
      `Withdrawal attestation indexes must contain between 1 and ${MAX_HASH_INDEXES} non-negative integers`,
    );
  }
};

const validateAttestation = (
  attestation: AttestationMessage,
  indexes: number[],
) => {
  validateContext(attestation);
  validateIndexes(indexes);
  if (
    attestation.hashesToSign.length !== indexes.length ||
    attestation.hashesToSign.some(
      (hash) =>
        !BYTES32_PATTERN.test(hash) || normalizeHex(hash) === zeroHash,
    )
  ) {
    throw new Error(
      "Withdrawal attestation must contain one non-zero bytes32 hash per index",
    );
  }

  const hashesByIndex = new Map<number, string>();
  indexes.forEach((index, position) => {
    const hashToSign = normalizeHex(attestation.hashesToSign[position]);
    const existing = hashesByIndex.get(index);
    if (existing && existing !== hashToSign) {
      throw new Error(
        "Duplicate withdrawal attestation indexes must contain the same hash",
      );
    }
    hashesByIndex.set(index, hashToSign);
  });
};

export class WithdrawRequestCache {
  private readonly activeObservations = new Map<
    WithdrawRequestObservation,
    ActiveObservation
  >();
  private readonly components = new Map<string, ComponentGroup>();
  private readonly observations = new Map<string, ObservationState>();
  private readonly inFlightFetches = new Map<
    string,
    Promise<SignedAttestation>
  >();
  private readonly inFlightDerived = new Map<
    string,
    Promise<SignedAttestation | undefined>
  >();
  private readonly cache: AttestationCache<CacheEntry>;
  private readonly sign: typeof signWithdrawRequestMessage;
  private readonly signerLimiter: SignerLimiter;
  private generation = 0;

  public constructor({
    ttlMs,
    maxCount,
    maxWeight,
    getWeight,
    cleanupIntervalMs,
    sign = signWithdrawRequestMessage,
    signerLimiter = new SignerLimiter({
      concurrency: SIGNER_CONCURRENCY,
      maxPending: SIGNER_MAX_PENDING,
    }),
  }: Options) {
    this.sign = sign;
    this.signerLimiter = signerLimiter;
    this.cache = new AttestationCache<CacheEntry>({
      ttlMs,
      maxCount,
      maxWeight,
      getWeight,
      cleanupIntervalMs,
      onEvict: ({ key, value, reason }) => {
        this.removeComponentOwners(key, value);
        if (reason === "capacity") {
          logger.warn(
            COMPONENT,
            JSON.stringify({
              msg: "Evicted withdrawal attestation at cache capacity",
              withdrawRequestHash: value.attestation.withdrawRequestHash,
              hashCount: value.attestation.hashesToSign.length,
              cacheCount: this.cache.size,
              cacheHashCount: this.cache.weight,
            }),
          );
        }
      },
    });
  }

  public async resolve({
    context,
    hashIndexes,
    fetchAttestation,
  }: ResolveOptions): Promise<SignedAttestation> {
    const startedAt = Date.now();
    validateContext(context);
    validateIndexes(hashIndexes);
    const complete = (
      source: ResolutionSource,
      attestation: SignedAttestation,
    ) => this.completeResolution(source, attestation, startedAt);

    const key = this.attestationKey(context.withdrawRequestHash, hashIndexes);
    const cached = this.getExact(context, hashIndexes);
    if (cached) {
      return complete("exact", cached);
    }

    const waiter = this.cache.waitFor(key);
    const exact = waiter.promise.then(({ attestation }) =>
      isSameContext(attestation, context) ? attestation : undefined,
    );
    const derived = this.deriveFromComponents(context, hashIndexes, key).then(
      (attestation) => ({ source: "derived" as const, attestation }),
      (error: unknown) => ({ source: "derived" as const, error }),
    );

    try {
      const first = await Promise.race([
        exact.then((attestation) => ({
          source: "exact" as const,
          attestation,
        })),
        derived,
      ]);
      if (first.source === "exact" && first.attestation) {
        return complete("exact", first.attestation);
      }

      const derivedResult =
        first.source === "derived" ? first : await derived;
      if ("error" in derivedResult) {
        const latest = this.getExact(context, hashIndexes);
        if (latest) {
          return complete("exact", latest);
        }
        throw derivedResult.error;
      }
      if (derivedResult.attestation) {
        return complete("derived", derivedResult.attestation);
      }

      const latest = this.getExact(context, hashIndexes);
      if (latest) {
        return complete("exact", latest);
      }
      logger.debug(
        COMPONENT,
        JSON.stringify({
          msg: "Using HTTP withdrawal attestation fallback",
          withdrawRequestHash: context.withdrawRequestHash,
          hashCount: hashIndexes.length,
        }),
      );
      const fallback = this.fetchAndStore(
        key,
        context,
        hashIndexes,
        fetchAttestation,
      );
      const fallbackResult = fallback.then(
        (attestation) => ({ source: "fallback" as const, attestation }),
        (error: unknown) => ({ source: "fallback" as const, error }),
      );
      const result = await Promise.race([
        exact.then((attestation) => ({
          source: "exact" as const,
          attestation,
        })),
        fallbackResult,
      ]);
      if (result.source === "exact" && result.attestation) {
        return complete("exact", result.attestation);
      }

      const completedFallback =
        result.source === "fallback" ? result : await fallbackResult;
      if ("error" in completedFallback) {
        const cachedAfterError = this.getExact(context, hashIndexes);
        if (cachedAfterError) {
          return complete("exact", cachedAfterError);
        }
        throw completedFallback.error;
      }
      return complete("http-fallback", completedFallback.attestation);
    } finally {
      waiter.cancel();
    }
  }

  public async signAndStore(
    attestation: AttestationMessage,
    indexes: number[],
  ): Promise<SignedAttestation | undefined> {
    validateAttestation(attestation, indexes);
    const existing = this.getExact(attestation, indexes);
    if (existing && isSameUnsignedAttestation(existing, attestation)) {
      this.cache.refresh(
        this.attestationKey(attestation.withdrawRequestHash, indexes),
      );
      return existing;
    }

    return this.signObservation(this.beginObservation(attestation, indexes));
  }

  public beginObservation(
    attestation: AttestationMessage,
    indexes: number[],
    provenance?: WithdrawRequestEventProvenance,
  ): WithdrawRequestObservation {
    validateAttestation(attestation, indexes);
    const token = Object.freeze({}) as WithdrawRequestObservation;
    const observation = {
      attestation,
      indexes: [...indexes],
      generation: ++this.generation,
      provenance,
    };
    this.registerObservation(observation);
    this.activeObservations.set(token, observation);
    return token;
  }

  public async signObservation(
    token: WithdrawRequestObservation,
  ): Promise<SignedAttestation | undefined> {
    const observation = this.activeObservations.get(token);
    if (!observation) {
      throw new Error("Withdrawal attestation observation is no longer active");
    }

    const { attestation, indexes, generation } = observation;
    const hash = normalizeHex(attestation.withdrawRequestHash);

    try {
      const existing = this.getExact(attestation, indexes);
      if (existing && isSameUnsignedAttestation(existing, attestation)) {
        this.cache.refresh(
          this.attestationKey(attestation.withdrawRequestHash, indexes),
        );
        return existing;
      }

      const signature = await this.signerLimiter.run(() =>
        this.sign(attestation),
      );
      if (!this.isCurrentObservation(attestation, indexes, generation)) {
        logger.warn(
          COMPONENT,
          JSON.stringify({
            msg: "Discarding stale withdrawal attestation observation",
            withdrawRequestHash: hash,
          }),
        );
        return this.getExact(attestation, indexes);
      }

      const signed = this.insertAttestation(
        attestation,
        indexes,
        signature,
        generation,
      );
      return signed;
    } finally {
      this.finishObservation(token);
    }
  }

  public discardObservation(token: WithdrawRequestObservation): void {
    this.finishObservation(token);
  }

  public invalidateEvent(
    attestation: AttestationMessage,
    indexes: number[],
    provenance: WithdrawRequestEventProvenance,
  ): number {
    validateAttestation(attestation, indexes);
    const hash = normalizeHex(attestation.withdrawRequestHash);
    const state = this.observations.get(hash);
    if (
      !state ||
      state.metadata.chainId !== attestation.chainId ||
      state.metadata.allocator !== normalizeHex(attestation.allocator) ||
      !indexes.some((index) =>
        isSameProvenance(state.indexes.get(index)?.provenance, provenance),
      )
    ) {
      return 0;
    }

    const deleted = this.evictCachedWithdrawal(hash);
    this.observations.delete(hash);
    return deleted;
  }

  public evictWithdrawal(withdrawRequestHash: string): number {
    const hash = normalizeHex(withdrawRequestHash);
    const deleted = this.evictCachedWithdrawal(hash);
    this.observations.delete(hash);
    return deleted;
  }

  public stopCleanup(): void {
    this.cache.stopCleanup();
  }

  private evictCachedWithdrawal(withdrawRequestHash: string): number {
    const hash = normalizeHex(withdrawRequestHash);
    const prefix = `${CACHE_PREFIX}:${hash}:attestation:`;
    const deleted = this.cache.deleteWhere((key) => key.startsWith(prefix));
    this.components.delete(this.componentKey(hash));
    this.cleanupObservationState(hash);
    return deleted;
  }

  private fetchAndStore(
    key: string,
    context: AttestationContext,
    indexes: number[],
    fetchAttestation: () => Promise<AttestationMessage>,
  ): Promise<SignedAttestation> {
    const existing = this.inFlightFetches.get(key);
    if (existing) {
      return existing;
    }

    const request = (async () => {
      try {
        const attestation = await fetchAttestation();
        if (!isSameContext(attestation, context)) {
          throw new Error(
            "HTTP withdrawal attestation did not match the requested context",
          );
        }
        const stored = await this.signAndStore(attestation, indexes);
        if (stored) {
          return stored;
        }

        const latest = this.getExact(context, indexes);
        if (latest) {
          return latest;
        }
        throw new Error("Withdrawal attestation was superseded before caching");
      } catch (error) {
        const cached = this.getExact(context, indexes);
        if (cached) {
          return cached;
        }
        throw error;
      }
    })();

    return this.trackInFlight(this.inFlightFetches, key, request);
  }

  private deriveFromComponents(
    context: AttestationContext,
    indexes: number[],
    key: string,
  ): Promise<SignedAttestation | undefined> {
    const existing = this.inFlightDerived.get(key);
    if (existing) {
      return existing;
    }

    const group = this.components.get(
      this.componentKey(context.withdrawRequestHash),
    );
    if (
      !group ||
      group.chainId !== context.chainId ||
      group.allocator !== normalizeHex(context.allocator)
    ) {
      return Promise.resolve(undefined);
    }

    const snapshot: Array<ComponentSnapshot | undefined> = indexes.map((index) => {
      const component = group.components.get(index);
      return component
        ? {
            index,
            hashToSign: component.hashToSign,
            generation: component.generation,
          }
        : undefined;
    });
    if (!snapshot.every(isDefined)) {
      return Promise.resolve(undefined);
    }

    const request = (async () => {
      const attestation: AttestationMessage = {
        ...context,
        hashesToSign: snapshot.map(({ hashToSign }) => hashToSign),
      };
      const signature = await this.signerLimiter.run(() =>
        this.sign(attestation),
      );

      const currentGroup = this.components.get(
        this.componentKey(context.withdrawRequestHash),
      );
      const isCurrent =
        currentGroup === group &&
        snapshot.every((component) => {
          const current = currentGroup.components.get(component.index);
          return (
            current?.generation === component.generation &&
            normalizeHex(current.hashToSign) ===
              normalizeHex(component.hashToSign)
          );
        });
      if (!isCurrent) {
        return undefined;
      }

      const exact = this.getExact(context, indexes);
      if (exact) {
        return exact;
      }
      return this.insertAttestation(attestation, indexes, signature);
    })();

    return this.trackInFlight(this.inFlightDerived, key, request);
  }

  private registerObservation(observation: ActiveObservation): void {
    const { attestation, indexes, generation, provenance } = observation;
    const hash = normalizeHex(attestation.withdrawRequestHash);
    const allocator = normalizeHex(attestation.allocator);
    let state = this.observations.get(hash);
    if (!state) {
      state = {
        metadata: { chainId: attestation.chainId, allocator },
        indexes: new Map(),
        active: new Set(),
      };
      this.observations.set(hash, state);
    } else {
      const metadataConflict =
        state.metadata.chainId !== attestation.chainId ||
        state.metadata.allocator !== allocator;
      const conflictingIndex = indexes.find((index, position) => {
        const previous = state?.indexes.get(index);
        return (
          previous &&
          previous.hashToSign !==
            normalizeHex(attestation.hashesToSign[position])
        );
      });
      if (metadataConflict || conflictingIndex !== undefined) {
        this.logConflict(hash, conflictingIndex);
        this.evictCachedWithdrawal(hash);
        state = this.observations.get(hash) ?? state;
        state.indexes.clear();
      }
      state.metadata = { chainId: attestation.chainId, allocator };
      this.observations.set(hash, state);
    }

    state.active.add(generation);
    for (const [position, index] of indexes.entries()) {
      const hashToSign = normalizeHex(attestation.hashesToSign[position]);
      state.indexes.set(index, { hashToSign, generation, provenance });
    }
  }

  private isCurrentObservation(
    attestation: AttestationMessage,
    indexes: number[],
    generation: number,
  ): boolean {
    const state = this.observations.get(
      normalizeHex(attestation.withdrawRequestHash),
    );
    if (
      !state ||
      state.metadata.chainId !== attestation.chainId ||
      state.metadata.allocator !== normalizeHex(attestation.allocator)
    ) {
      return false;
    }

    return indexes.every((index, position) => {
      const latest = state.indexes.get(index);
      return (
        latest !== undefined &&
        latest.generation >= generation &&
        latest.hashToSign === normalizeHex(attestation.hashesToSign[position])
      );
    });
  }

  private insertAttestation(
    attestation: AttestationMessage,
    indexes: number[],
    signature: Signature,
    generation?: number,
  ): SignedAttestation {
    const key = this.attestationKey(attestation.withdrawRequestHash, indexes);
    const existing = this.cache.get(key);
    if (
      existing &&
      isSameUnsignedAttestation(existing.attestation, attestation)
    ) {
      this.cache.refresh(key);
      this.attachComponents(attestation, indexes, key, generation);
      return existing.attestation;
    }
    if (existing) {
      this.logConflict(normalizeHex(attestation.withdrawRequestHash));
      this.evictCachedWithdrawal(attestation.withdrawRequestHash);
    }

    const signed = { ...attestation, signatures: [signature] };
    this.attachComponents(attestation, indexes, key, generation);
    this.cache.set(key, { attestation: signed, indexes: [...indexes] });
    return signed;
  }

  private attachComponents(
    attestation: AttestationMessage,
    indexes: number[],
    owner: string,
    generation?: number,
  ): void {
    const hash = normalizeHex(attestation.withdrawRequestHash);
    const componentKey = this.componentKey(hash);
    let group = this.components.get(componentKey);
    if (!group) {
      group = {
        chainId: attestation.chainId,
        allocator: normalizeHex(attestation.allocator),
        components: new Map(),
      };
      this.components.set(componentKey, group);
    }

    for (const [position, index] of indexes.entries()) {
      const existing = group.components.get(index);
      const componentGeneration = generation ?? existing?.generation ?? 0;
      if (existing) {
        existing.hashToSign = attestation.hashesToSign[position];
        existing.generation = Math.max(
          existing.generation,
          componentGeneration,
        );
        existing.owners.add(owner);
      } else {
        group.components.set(index, {
          hashToSign: attestation.hashesToSign[position],
          owners: new Set([owner]),
          generation: componentGeneration,
        });
      }
    }
  }

  private removeComponentOwners(key: string, cached: CacheEntry): void {
    const hash = normalizeHex(cached.attestation.withdrawRequestHash);
    const componentKey = this.componentKey(hash);
    const group = this.components.get(componentKey);
    if (!group) {
      return;
    }

    for (const index of new Set(cached.indexes)) {
      const component = group.components.get(index);
      component?.owners.delete(key);
      if (component?.owners.size === 0) {
        group.components.delete(index);
        const observed = this.observations.get(hash)?.indexes.get(index);
        if (observed && observed.generation <= component.generation) {
          this.observations.get(hash)?.indexes.delete(index);
        }
      }
    }
    if (group.components.size === 0) {
      this.components.delete(componentKey);
      this.cleanupObservationState(hash);
    }
  }

  private finishObservation(token: WithdrawRequestObservation): void {
    const observation = this.activeObservations.get(token);
    if (!observation) {
      return;
    }
    this.activeObservations.delete(token);
    const hash = normalizeHex(observation.attestation.withdrawRequestHash);
    const state = this.observations.get(hash);
    if (state) {
      state.active.delete(observation.generation);
    }
    this.cleanupObservationState(hash);
  }

  private cleanupObservationState(hash: string): void {
    const state = this.observations.get(hash);
    if (
      state &&
      state.active.size === 0 &&
      !this.components.has(this.componentKey(hash))
    ) {
      this.observations.delete(hash);
    }
  }

  private getExact(
    context: AttestationContext,
    indexes: number[],
  ): SignedAttestation | undefined {
    const entry = this.cache.get(
      this.attestationKey(context.withdrawRequestHash, indexes),
    );
    return entry && isSameContext(entry.attestation, context)
      ? entry.attestation
      : undefined;
  }

  private attestationKey(
    withdrawRequestHash: string,
    indexes: number[],
  ): string {
    return `${CACHE_PREFIX}:${normalizeHex(withdrawRequestHash)}:attestation:indexes:${indexes.join(",")}`;
  }

  private componentKey(withdrawRequestHash: string): string {
    return `${CACHE_PREFIX}:${normalizeHex(withdrawRequestHash)}`;
  }

  private trackInFlight<V>(
    requests: Map<string, Promise<V>>,
    key: string,
    request: Promise<V>,
  ): Promise<V> {
    requests.set(key, request);
    void request.then(
      () => this.deleteTrackedRequest(requests, key, request),
      () => this.deleteTrackedRequest(requests, key, request),
    );
    return request;
  }

  private deleteTrackedRequest<V>(
    requests: Map<string, Promise<V>>,
    key: string,
    request: Promise<V>,
  ): void {
    if (requests.get(key) === request) {
      requests.delete(key);
    }
  }

  private logConflict(withdrawRequestHash: string, index?: number): void {
    logger.error(
      COMPONENT,
      JSON.stringify({
        msg: "Conflicting withdrawal attestation data, replacing cached state",
        withdrawRequestHash,
        index,
      }),
    );
  }

  private completeResolution(
    source: ResolutionSource,
    attestation: SignedAttestation,
    startedAt: number,
  ): SignedAttestation {
    logger.debug(
      COMPONENT,
      JSON.stringify({
        msg: "Resolved withdrawal attestation",
        source,
        durationMs: Date.now() - startedAt,
        withdrawRequestHash: attestation.withdrawRequestHash,
        hashCount: attestation.hashesToSign.length,
        cacheCount: this.cache.size,
        cacheHashCount: this.cache.weight,
      }),
    );
    return attestation;
  }
}

export const withdrawRequestCache = new WithdrawRequestCache({
  ttlMs: CACHE_TTL_MS,
  maxCount: CACHE_MAX_COUNT,
  maxWeight: CACHE_MAX_HASH_COUNT,
  getWeight: ({ attestation }) => attestation.hashesToSign.length,
});
