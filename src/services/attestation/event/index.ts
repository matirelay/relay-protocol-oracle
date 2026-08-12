import { isAddress, zeroAddress } from "viem";

import { getHubInfo } from "../../../common/chains";
import { logger } from "../../../common/logger";
import { config } from "../../../config";
import {
  CACHE_TTL_MS,
  withdrawRequestCache,
} from "../cache/withdraw-request";
import { subscribeAllocatorPayloadBuilt } from "./allocator";
import { createEventConnection, EventConnection } from "./connection";
import { EventAttestationQueue } from "./queue";

type MonitorConfig = {
  allocatorAddress: `0x${string}`;
  chainId: number;
  wsUrl: string;
};

type Options = {
  createConnection?: (url: string) => EventConnection;
  allocatorEnabled?: boolean;
  heartbeatIntervalMs?: number;
  backoffResetMs?: number;
  resolveConfig?: () => Promise<MonitorConfig | undefined>;
  random?: () => number;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

const COMPONENT = "event-attestation";
const HEARTBEAT_INTERVAL_MS = 30_000;
const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
const EVENT_CONCURRENCY = 16;
const EVENT_MAX_PENDING = 10_000;

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const delay = (durationMs: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, durationMs);
    timer.unref();
  });

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isWebSocketUrl = (value: string | undefined): value is string => {
  if (!value) {
    return false;
  }
  try {
    const protocol = new URL(value).protocol;
    return protocol === "ws:" || protocol === "wss:";
  } catch {
    return false;
  }
};

const resolveMonitorConfig = async (): Promise<MonitorConfig | undefined> => {
  let hub: Awaited<ReturnType<typeof getHubInfo>>;
  try {
    hub = await getHubInfo();
  } catch (error) {
    logger.error(
      COMPONENT,
      JSON.stringify({
        msg: "Failed to load allocator event attestation configuration",
        error: errorMessage(error),
      }),
    );
    return undefined;
  }
  const chainId = Number(hub.evmChainId);
  const allocatorAddress = hub.allocatorAddress;
  const wsUrl = config.relayWsUrl;

  if (
    !isWebSocketUrl(wsUrl) ||
    !Number.isSafeInteger(chainId) ||
    chainId < 1 ||
    !isAddress(allocatorAddress) ||
    allocatorAddress.toLowerCase() === zeroAddress
  ) {
    logger.error(
      COMPONENT,
      JSON.stringify({
        msg: "Allocator event attestation configuration is invalid",
        hasValidWsUrl: isWebSocketUrl(wsUrl),
        chainId: hub.evmChainId,
        allocatorAddress,
      }),
    );
    return undefined;
  }

  return {
    allocatorAddress,
    chainId,
    wsUrl,
  };
};

export class EventAttestationMonitor {
  private readonly createConnection: (url: string) => EventConnection;
  private readonly allocatorEnabled: boolean;
  private readonly heartbeatIntervalMs: number;
  private readonly backoffResetMs: number;
  private readonly resolveConfig: () => Promise<MonitorConfig | undefined>;
  private readonly random: () => number;
  private stopped?: Deferred<void>;
  private running = false;
  private runPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private connection?: EventConnection;

  public constructor({
    createConnection = createEventConnection,
    allocatorEnabled = config.allocatorEventAttestation,
    heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
    backoffResetMs = MAX_RETRY_MS,
    resolveConfig = resolveMonitorConfig,
    random = Math.random,
  }: Options = {}) {
    this.createConnection = createConnection;
    this.allocatorEnabled = allocatorEnabled;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.backoffResetMs = backoffResetMs;
    this.resolveConfig = resolveConfig;
    this.random = random;
  }

  public start(): void {
    if (this.runPromise || this.stopPromise || !this.allocatorEnabled) {
      return;
    }

    const stopped = createDeferred<void>();
    this.stopped = stopped;
    this.running = true;
    const runPromise = this.run(stopped)
      .catch((error) => {
        logger.error(
          COMPONENT,
          JSON.stringify({
            msg: "Event attestation supervisor stopped unexpectedly",
            error: errorMessage(error),
          }),
        );
      })
      .finally(() => {
        this.running = false;
        if (this.runPromise === runPromise) {
          this.runPromise = undefined;
        }
        if (this.stopped === stopped) {
          this.stopped = undefined;
        }
      });
    this.runPromise = runPromise;
  }

  public stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    const runPromise = this.runPromise;
    const stopped = this.stopped;
    if (!runPromise || !stopped) {
      return Promise.resolve();
    }

    this.running = false;
    stopped.resolve();
    const stopPromise = (async () => {
      await this.closeConnection();
      await runPromise;
      logger.info(
        COMPONENT,
        JSON.stringify({ msg: "Event attestation stopped" }),
      );
    })();
    this.stopPromise = stopPromise;
    const clearStopPromise = () => {
      if (this.stopPromise === stopPromise) {
        this.stopPromise = undefined;
      }
    };
    void stopPromise.then(clearStopPromise, clearStopPromise);
    return stopPromise;
  }

  private async run(stopped: Deferred<void>): Promise<void> {
    const monitorConfig = await this.resolveConfig();
    if (!monitorConfig || !this.running) {
      this.running = false;
      return;
    }

    const queue = new EventAttestationQueue({
      concurrency: EVENT_CONCURRENCY,
      maxPending: EVENT_MAX_PENDING,
      maxAgeMs: CACHE_TTL_MS,
      onError: (error) => {
        logger.error(
          COMPONENT,
          JSON.stringify({
            msg: "Unhandled event attestation task failure",
            error: errorMessage(error),
          }),
        );
      },
      onDrop: (reason, { activeCount, pendingCount }) => {
        logger.warn(
          COMPONENT,
          JSON.stringify({
            msg: "Dropped event attestation task",
            reason,
            activeCount,
            pendingCount,
          }),
        );
      },
    });

    let retryAttempt = 0;
    let failureLogged = false;
    logger.info(
      COMPONENT,
      JSON.stringify({
        msg: "Starting allocator event attestation",
        allocatorAddress: monitorConfig.allocatorAddress,
        chainId: monitorConfig.chainId,
      }),
    );

    try {
      while (this.running) {
        let unsubscribe: (() => void) | undefined;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        let backoffReset: ReturnType<typeof setTimeout> | undefined;
        const failed = createDeferred<unknown>();

        try {
          const connection = this.createConnection(monitorConfig.wsUrl);
          this.connection = connection;
          const actualChainId = await connection.getChainId();
          if (actualChainId !== monitorConfig.chainId) {
            throw new Error(
              `Relay WebSocket chain id ${actualChainId} does not match configured chain id ${monitorConfig.chainId}`,
            );
          }

          unsubscribe = await subscribeAllocatorPayloadBuilt({
            allocatorAddress: monitorConfig.allocatorAddress,
            chainId: monitorConfig.chainId,
            connection,
            queue,
            cache: withdrawRequestCache,
            onConnectionError: failed.resolve,
          });
          logger.info(
            COMPONENT,
            JSON.stringify({
              msg: "Allocator event attestation connected",
              allocatorAddress: monitorConfig.allocatorAddress,
              chainId: monitorConfig.chainId,
              reconnectAttempt: retryAttempt,
            }),
          );
          backoffReset = setTimeout(() => {
            retryAttempt = 0;
            failureLogged = false;
          }, this.backoffResetMs);
          backoffReset.unref();

          let heartbeatRunning = false;
          heartbeat = setInterval(() => {
            if (heartbeatRunning) {
              return;
            }
            heartbeatRunning = true;
            const startedAt = Date.now();
            void connection
              .getChainId()
              .then((chainId) => {
                if (chainId !== monitorConfig.chainId) {
                  failed.resolve(
                    new Error(
                      `Relay WebSocket heartbeat returned chain id ${chainId}`,
                    ),
                  );
                  return;
                }
                logger.debug(
                  COMPONENT,
                  JSON.stringify({
                    msg: "Allocator event attestation heartbeat succeeded",
                    allocatorAddress: monitorConfig.allocatorAddress,
                    chainId,
                    latencyMs: Date.now() - startedAt,
                  }),
                );
              })
              .catch(failed.resolve)
              .finally(() => {
                heartbeatRunning = false;
              });
          }, this.heartbeatIntervalMs);
          heartbeat.unref();

          const failure = await Promise.race([
            failed.promise,
            stopped.promise.then(() => undefined),
          ]);
          if (this.running) {
            throw failure;
          }
        } catch (error) {
          if (!this.running) {
            break;
          }

          const retryLimit = Math.min(
            INITIAL_RETRY_MS * 2 ** retryAttempt,
            MAX_RETRY_MS,
          );
          const retryDelayMs = Math.floor(this.random() * retryLimit);
          const log = failureLogged ? logger.warn : logger.error;
          log(
            COMPONENT,
            JSON.stringify({
              msg: "Allocator event attestation connection failed",
              error: errorMessage(error),
              retryAttempt: retryAttempt + 1,
              retryDelayMs,
            }),
          );
          failureLogged = true;
          retryAttempt += 1;

          await Promise.race([
            delay(retryDelayMs),
            stopped.promise,
          ]);
        } finally {
          if (heartbeat) {
            clearInterval(heartbeat);
          }
          if (backoffReset) {
            clearTimeout(backoffReset);
          }
          unsubscribe?.();
          await this.closeConnection();
        }
      }
    } finally {
      queue.stop();
    }
  }

  private async closeConnection(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    if (connection) {
      await connection.close().catch(() => undefined);
    }
  }
}

export const createEventAttestationMonitor = (): EventAttestationMonitor =>
  new EventAttestationMonitor();
