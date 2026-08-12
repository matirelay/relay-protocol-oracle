import { VmType } from "@relay-protocol/settlement-sdk";

import { externalError } from "./error";
import { logger } from "./logger";
import {
  getSettlementChainDefaultsForChain,
  SettlementChainDefaults,
} from "./settlement-networks";
import { readConfigValue } from "./utils";
import { config } from "../config";

export type Chain = {
  // The user-friendly id of the chain
  id: string;
  vmType: VmType;
  httpRpcUrl: string;
  depository?: string;
  // During migration periods, chains can have extra depositories (currently supported for "bitcoin-vm", "hyperliquid-vm", and "lighter-vm")
  additionalDepositories?: string[];
  additionalData?: {
    // For "ethereum-vm"
    evmChainId?: string;
    // For "bitcoin-vm" / "ethereum-vm" / "tron-vm";
    // for "ton-vm" — masterchain blocks past the tx's mc anchor
    finalizationBlocks?: number;
    // For "ethereum-vm" / "tron-vm" - minimum wall-clock time (in seconds) for finalization
    finalizationTime?: number;
    // For "bitcoin-vm"
    esploraCompatibleApiUrl?: string;
    blockstreamClientSecret?: string;
    blockstreamClientId?: string;
    maestroApiKey?: string;
    // For "hyperliquid-vm"
    proxyApiUrl?: string;
    proxyApiKey?: string;
    // For "ethereum-vm"
    isZksyncStack?: boolean;
    // For "lighter-vm"
    rpcApiKey?: string;
    explorerApiUrl?: string;
    // For "ton-vm" — TonConnect signData origin domain (e.g. "app.relay.link").
    signDataDomain?: string;
    // Fast-mode configurations
    fastMode?: {
      feeRecipient?: string;
      // Chain + currency address fees are charged in, resolved to its hub
      // token id at attest time (required when any tier has a non-zero feeBps)
      feeCurrency?: { chainId: string; currency: string };
      // Finality tiers per currency
      finalityTiers?: {
        [currency: string]: Array<{
          maxAmount: string;
          finalizationBlocks?: number;
          finalizationTime?: number;
          // 1e18-scaled fee to charge for fast attestations
          feeBps?: string;
        }>;
      };
    };
  };
  // For "gateway-vm": physical source and destinations for this Gateway-backed Hub token
  gateway?: {
    source: {
      id: string;
      gatewayDepository: string;
      usdc: string;
      circleDomain: number;
      blockTimeSeconds?: number;
      withdrawalDelaySeconds?: number;
      executionExpirationSeconds?: number;
      maxBlockHeightTolerance?: number;
    };
    destinations: Array<{
      id: string;
      gatewayDepository: string;
      usdc: string;
      circleDomain: number;
    }>;
  };
};

const DEPOSITORY_REQUIRED_VM_TYPES = new Set<VmType>([
  "ethereum-vm",
  "solana-vm",
  "bitcoin-vm",
  "tron-vm",
  "hyperliquid-vm",
  "lighter-vm",
] as VmType[]);

const readAdditionalData = (rawChain: Record<string, any>) => {
  const additionalData: Record<string, any> = {};
  if (!rawChain.additionalData) {
    return additionalData;
  }

  for (const [key, value] of Object.entries(
    (rawChain.additionalData ?? {}) as Record<string, any>,
  )) {
    additionalData[key] = readConfigValue(value);
  }

  return additionalData;
};

const resolveHttpRpcUrl = (
  rawChain: Record<string, any>,
  settlementDefaults: SettlementChainDefaults | undefined,
) => {
  const settlementRpcFallback = settlementDefaults?.httpRpcUrl;
  const localRpcRawValue = rawChain.httpRpcUrl;
  const localRpcValue = readConfigValue(rawChain.httpRpcUrl);

  // Keep literal local values authoritative.
  // Only use settlement fallback when the local value is an unresolved env placeholder.
  if (
    typeof localRpcRawValue === "string" &&
    localRpcRawValue.startsWith("$")
  ) {
    return localRpcValue ?? settlementRpcFallback;
  }

  return localRpcValue ?? settlementRpcFallback;
};

const readGatewayConfig = (rawChain: Record<string, any>): Chain["gateway"] => {
  if (!rawChain.gateway) {
    return undefined;
  }

  const source = rawChain.gateway.source;

  return {
    source: {
      id: readConfigValue(source?.id) as string,
      gatewayDepository: readConfigValue(source?.gatewayDepository) as string,
      usdc: readConfigValue(source?.usdc) as string,
      circleDomain: readConfigValue(source?.circleDomain) as number,
      blockTimeSeconds: readConfigValue(source?.blockTimeSeconds) as
        | number
        | undefined,
      withdrawalDelaySeconds: readConfigValue(
        source?.withdrawalDelaySeconds,
      ) as number | undefined,
      executionExpirationSeconds: readConfigValue(
        source?.executionExpirationSeconds,
      ) as number | undefined,
      maxBlockHeightTolerance: readConfigValue(
        source?.maxBlockHeightTolerance,
      ) as number | undefined,
    },
    destinations: (rawChain.gateway.destinations ?? []).map(
      (rawDestination: Record<string, any>) => ({
        id: readConfigValue(rawDestination.id) as string,
        gatewayDepository: readConfigValue(
          rawDestination.gatewayDepository,
        ) as string,
        usdc: readConfigValue(rawDestination.usdc) as string,
        circleDomain: readConfigValue(rawDestination.circleDomain) as number,
      }),
    ),
  };
};

const warnInvalidChainConfiguration = (chain: Chain) => {
  const chainName = chain.id ?? "<missing-id>";

  if (!chain.id) {
    logger.warn("chains", "Configured chain is missing id");
  }
  if (!chain.vmType) {
    logger.warn("chains", `Chain ${chainName} is missing vmType`);
  }
  if (!chain.httpRpcUrl) {
    if (chain.vmType !== "gateway-vm") {
      logger.warn("chains", `Chain ${chainName} is missing httpRpcUrl`);
    }
  }
  if (
    chain.vmType &&
    DEPOSITORY_REQUIRED_VM_TYPES.has(chain.vmType) &&
    !chain.depository
  ) {
    logger.warn(
      "chains",
      `Chain ${chainName} (${chain.vmType}) is missing depository`,
    );
  }
  if (chain.vmType === "gateway-vm") {
    if (!chain.gateway?.source?.id) {
      logger.warn("chains", `Gateway chain ${chainName} is missing source`);
    }
    if (!chain.gateway?.destinations.length) {
      logger.warn("chains", `Gateway chain ${chainName} has no destinations`);
    }
  }
  const source = chain.gateway?.source;
  if (source) {
    if (!source.gatewayDepository) {
      logger.warn(
        "chains",
        `Gateway source ${source.id} is missing gatewayDepository`,
      );
    }
    if (!source.usdc) {
      logger.warn("chains", `Gateway source ${source.id} is missing USDC`);
    }
    if (!Number.isInteger(source.circleDomain)) {
      logger.warn(
        "chains",
        `Gateway source ${source.id} is missing circleDomain`,
      );
    }
    if (!Number.isInteger(source.blockTimeSeconds)) {
      logger.warn(
        "chains",
        `Gateway source ${source.id} is missing blockTimeSeconds`,
      );
    }
    if (!Number.isInteger(source.withdrawalDelaySeconds)) {
      logger.warn(
        "chains",
        `Gateway source ${source.id} is missing withdrawalDelaySeconds`,
      );
    }
    if (!Number.isInteger(source.executionExpirationSeconds)) {
      logger.warn(
        "chains",
        `Gateway source ${source.id} is missing executionExpirationSeconds`,
      );
    }
    if (!Number.isInteger(source.maxBlockHeightTolerance)) {
      logger.warn(
        "chains",
        `Gateway source ${source.id} is missing maxBlockHeightTolerance`,
      );
    }
  }
  for (const destination of chain.gateway?.destinations ?? []) {
    if (!destination.gatewayDepository) {
      logger.warn(
        "chains",
        `Gateway destination ${destination.id} is missing gatewayDepository`,
      );
    }
    if (!destination.usdc) {
      logger.warn(
        "chains",
        `Gateway destination ${destination.id} is missing USDC`,
      );
    }
    if (!Number.isInteger(destination.circleDomain)) {
      logger.warn(
        "chains",
        `Gateway destination ${destination.id} is missing circleDomain`,
      );
    }
  }
};

let _chains: { [id: string]: Chain } | undefined;
export const getChains = async () => {
  if (!_chains) {
    const __chains: { [id: string]: Chain } = {};

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const chains = require(
      `../../configs/chains.${config.environment}.json`,
    ) as Record<string, any>[];
    for (const chain of chains) {
      const chainId = readConfigValue(chain.id);
      const configuredVmType = readConfigValue(chain.vmType) as
        | VmType
        | undefined;
      const settlementDefaults = chainId
        ? getSettlementChainDefaultsForChain(chainId as string)
        : undefined;
      const additionalData = readAdditionalData(chain);

      const resolvedChain: Chain = {
        id: (chainId ?? settlementDefaults?.id) as string,
        vmType: (configuredVmType ?? settlementDefaults?.vmType) as VmType,
        httpRpcUrl: resolveHttpRpcUrl(chain, settlementDefaults) as string,
        depository: (readConfigValue(chain.depository) ??
          settlementDefaults?.depository) as string | undefined,
        additionalDepositories: readConfigValue(
          chain.additionalDepositories,
        ) as string[] | undefined,
        additionalData,
        gateway: readGatewayConfig(chain),
      };

      warnInvalidChainConfiguration(resolvedChain);
      if (!resolvedChain.id) {
        continue;
      }
      __chains[resolvedChain.id] = resolvedChain;
    }

    _chains = __chains;
  }

  return _chains;
};

export const getChain = async (chainId: string) => {
  const chains = await getChains();
  if (!chains[chainId]) {
    throw externalError(`Chain ${chainId} is not available`);
  }

  return chains[chainId];
};

export const getGatewaySource = async (
  gatewayChain: Chain,
): Promise<{
  chain: Chain;
  gatewayDepository: string;
  usdc: string;
  circleDomain: number;
  blockTimeSeconds?: number;
  withdrawalDelaySeconds?: number;
  executionExpirationSeconds?: number;
  maxBlockHeightTolerance?: number;
}> => {
  if (gatewayChain.vmType !== "gateway-vm") {
    throw externalError(`Chain ${gatewayChain.id} is not a Gateway chain`);
  }
  const source = gatewayChain.gateway?.source;
  if (!source) {
    throw externalError(`Gateway chain ${gatewayChain.id} has no source`);
  }

  const chain = await getChain(source.id);
  return {
    chain,
    gatewayDepository: source.gatewayDepository,
    usdc: source.usdc,
    circleDomain: source.circleDomain,
    blockTimeSeconds: source.blockTimeSeconds,
    withdrawalDelaySeconds: source.withdrawalDelaySeconds,
    executionExpirationSeconds: source.executionExpirationSeconds,
    maxBlockHeightTolerance: source.maxBlockHeightTolerance,
  };
};

export const getGatewayDestination = async (
  gatewayChain: Chain,
  destinationChainId: string,
): Promise<{
  chain: Chain;
  gatewayDepository: string;
  usdc: string;
  circleDomain: number;
}> => {
  if (gatewayChain.vmType !== "gateway-vm") {
    throw externalError(`Chain ${gatewayChain.id} is not a Gateway chain`);
  }

  const destination = gatewayChain.gateway?.destinations.find(
    (candidate) => candidate.id === destinationChainId,
  );
  if (!destination) {
    throw externalError(
      `Gateway destination ${destinationChainId} is not configured for ${gatewayChain.id}`,
    );
  }

  const chain = await getChain(destination.id);
  return {
    chain,
    gatewayDepository: destination.gatewayDepository,
    usdc: destination.usdc,
    circleDomain: destination.circleDomain,
  };
};

export const RELAY_CHAIN_ID = "relay";
export const getChainVmType = async (chainId: string) => {
  // Custom rule for "Relay" chain
  if (chainId === RELAY_CHAIN_ID) {
    return "ethereum-vm";
  }

  return getChain(chainId).then((c) => c.vmType);
};

export const getSdkChainsConfig = async () => {
  return Object.fromEntries(
    Object.values(await getChains()).map((c) => [c.id, c.vmType]),
  );
};

// Hub info

let __hubInfo:
  | {
      id: string;
      evmChainId: string;
      httpRpcUrl: string;
      hubAddress: string;
      oracleAddress: string;
      oracleVersion: string;
      rateLimiter?: {
        address: string;
        type: "amount" | "usd";
      };
      feeCalculator?: {
        address: string;
        type: "bps";
      };
      oracleMultisigAddress: string;
      genericMappingAddress: string;
      withdrawGasPayerAddress?: string;
      allocatorAddress: string;
      executorAddress: string;
      depositAddressManagerAddress: string;
    }
  | undefined;

export const getHubInfo = async () => {
  if (__hubInfo) {
    return __hubInfo;
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const chain = require(`../../configs/hub.${config.environment}.json`);
  __hubInfo = {
    id: readConfigValue(chain.id),
    evmChainId: readConfigValue(chain.evmChainId),
    httpRpcUrl: readConfigValue(chain.httpRpcUrl),
    hubAddress: readConfigValue(chain.hubAddress),
    oracleAddress: readConfigValue(chain.oracleAddress),
    oracleVersion: readConfigValue(chain.oracleVersion),
    rateLimiter: readConfigValue(chain.rateLimiter),
    feeCalculator: readConfigValue(chain.feeCalculator),
    oracleMultisigAddress: readConfigValue(chain.oracleMultisigAddress),
    genericMappingAddress: readConfigValue(chain.genericMappingAddress),
    withdrawGasPayerAddress: readConfigValue(chain.withdrawGasPayerAddress),
    allocatorAddress: readConfigValue(chain.allocatorAddress),
    executorAddress: readConfigValue(chain.executorAddress),
    depositAddressManagerAddress: readConfigValue(
      chain.depositAddressManagerAddress,
    ),
  };

  return __hubInfo;
};
