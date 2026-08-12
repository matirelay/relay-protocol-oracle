import { RelayHub, RelayOracle } from "@relay-protocol/settlement-abis";
import {
  Address,
  createPublicClient,
  getContract,
  GetContractReturnType,
  http,
  PublicClient,
} from "viem";

import { getHubInfo } from "./chains";

let __cachedHubHttpRpc: PublicClient | undefined;
let __cachedHubBatchHttpRpc: PublicClient | undefined;
let __cachedOracleContract:
  | GetContractReturnType<typeof RelayOracle, PublicClient>
  | undefined;
let __cachedHubContract:
  | GetContractReturnType<typeof RelayHub, PublicClient>
  | undefined;

const createHubHttpRpc = async (batch: boolean): Promise<PublicClient> => {
  const hubInfo = await getHubInfo();
  return createPublicClient({
    chain: {
      id: Number(hubInfo.evmChainId),
      name: "Hub",
      nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
      rpcUrls: {
        default: { http: [hubInfo.httpRpcUrl] },
      },
    },
    transport: batch
      ? http(undefined, { batch: { batchSize: 256, wait: 0 } })
      : http(),
  });
};

export const getHubHttpRpc = async (): Promise<PublicClient> => {
  if (!__cachedHubHttpRpc) {
    __cachedHubHttpRpc = await createHubHttpRpc(false);
  }
  return __cachedHubHttpRpc;
};

export const getHubBatchHttpRpc = async (): Promise<PublicClient> => {
  if (!__cachedHubBatchHttpRpc) {
    __cachedHubBatchHttpRpc = await createHubHttpRpc(true);
  }
  return __cachedHubBatchHttpRpc;
};

const getOracleContract = async () => {
  if (!__cachedOracleContract) {
    const hubInfo = await getHubInfo();
    __cachedOracleContract = getContract({
      address: hubInfo.oracleAddress as Address,
      abi: RelayOracle,
      client: await getHubHttpRpc(),
    });
  }
  return __cachedOracleContract;
};

const getHubContract = async () => {
  if (!__cachedHubContract) {
    const oracleContract = await getOracleContract();
    const hubAddress = await oracleContract.read.HUB();
    __cachedHubContract = getContract({
      address: hubAddress as Address,
      abi: RelayHub,
      client: await getHubHttpRpc(),
    });
  }
  return __cachedHubContract;
};

export const getBalanceOnHub = async (address: string, hubTokenId: bigint) => {
  const hubContract = await getHubContract();
  return (await hubContract.read.balanceOf([
    address as Address,
    hubTokenId,
  ])) as bigint;
};

// Test-only — reset all caches together. Partial resets are unsafe:
// __cachedOracleContract / __cachedHubContract hold a getHubHttpRpc reference,
// so resetting only the http rpc would leave them with the released client.
export const __resetHubCache = () => {
  __cachedHubHttpRpc = undefined;
  __cachedHubBatchHttpRpc = undefined;
  __cachedOracleContract = undefined;
  __cachedHubContract = undefined;
};
