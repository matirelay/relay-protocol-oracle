import { describe, expect, it, jest, beforeEach } from "@jest/globals";

import type { VmType } from "@relay-protocol/settlement-sdk";

import type { Chain } from "../../../src/common/chains";

// Each call to a fresh underlying client builder triggers exactly one
// `getChain` lookup, so we can use the mock's call count as a proxy for
// "how many real client instances were built".
const mockGetChain = jest.fn(async (chainId: string): Promise<Chain> => ({
  id: chainId,
  vmType: "evm" as VmType,
  httpRpcUrl: `https://rpc.example/${chainId}`,
  depository: undefined,
  additionalData: undefined,
}));

const mockGetHubInfo = jest.fn(async () => ({
  id: "hub",
  evmChainId: "1",
  httpRpcUrl: "https://hub.example",
  hubAddress: "0x0000000000000000000000000000000000000001",
  oracleAddress: "0x0000000000000000000000000000000000000002",
  oracleMultisigAddress: "0x0000000000000000000000000000000000000003",
  genericMappingAddress: "0x0000000000000000000000000000000000000004",
}));

jest.mock("../../../src/common/chains", () => ({
  getChain: (chainId: string) => mockGetChain(chainId),
  getHubInfo: () => mockGetHubInfo(),
}));

import {
  httpRpc,
  __resetCache,
  __getCacheSize,
} from "../../../src/common/vm/ethereum-vm/rpc";
import {
  getHubBatchHttpRpc,
  getHubHttpRpc,
  __resetHubCache,
} from "../../../src/common/hub";

describe("ethereum-vm rpc cache", () => {
  beforeEach(() => {
    __resetCache();
    mockGetChain.mockClear();
    mockGetChain.mockImplementation(async (chainId: string) => ({
      id: chainId,
      vmType: "evm" as VmType,
      httpRpcUrl: `https://rpc.example/${chainId}`,
      depository: undefined,
      additionalData: undefined,
    }));
  });

  it("returns the same client instance on cache hit", async () => {
    const a = await httpRpc("1");
    const b = await httpRpc("1");
    expect(a).toBe(b);
    expect(mockGetChain).toHaveBeenCalledTimes(1);
  });

  it("isolates clients across different chainIds", async () => {
    const a = await httpRpc("1");
    const b = await httpRpc("10");
    expect(a).not.toBe(b);
    expect(mockGetChain).toHaveBeenCalledTimes(2);
    expect(__getCacheSize()).toBe(2);
  });

  it("does not poison cache on builder failure (next call retries)", async () => {
    mockGetChain.mockImplementationOnce(async () => {
      throw new Error("transient config load failure");
    });

    await expect(httpRpc("42161")).rejects.toThrow(
      "transient config load failure",
    );
    // Second call should retry — cache stays empty after a rejected build.
    const client = await httpRpc("42161");
    expect(client).toBeDefined();
    expect(mockGetChain).toHaveBeenCalledTimes(2);
  });

  it("returns the same instance across many sequential calls (regression)", async () => {
    const first = await httpRpc("1");
    for (let i = 0; i < 10_000; i++) {
      const next = await httpRpc("1");
      if (next !== first) {
        throw new Error(`instance changed at iteration ${i}`);
      }
    }
    expect(mockGetChain).toHaveBeenCalledTimes(1);
  });
});

describe("hub.ts rpc cache", () => {
  beforeEach(() => {
    __resetHubCache();
    mockGetHubInfo.mockClear();
  });

  it("returns a stable hub client instance", async () => {
    const hub = await getHubHttpRpc();
    expect(await getHubHttpRpc()).toBe(hub);
    expect(mockGetHubInfo).toHaveBeenCalledTimes(1);
  });

  it("returns a separate stable batched hub client", async () => {
    const regular = await getHubHttpRpc();
    const batched = await getHubBatchHttpRpc();

    expect(await getHubBatchHttpRpc()).toBe(batched);
    expect(batched).not.toBe(regular);
    expect(mockGetHubInfo).toHaveBeenCalledTimes(2);
  });
});
