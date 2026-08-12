import { describe, expect, it, jest } from "@jest/globals";
import { Hex } from "viem";

import { AttestationService } from "../../../../src/services/attestation";
import { getHubHttpRpc } from "../../../../src/common/hub";

jest.mock("../../../../src/services/attestation/vm");
jest.mock("../../../../src/common/hub", () => ({
  getBalanceOnHub: jest.fn(),
  getHubHttpRpc: jest.fn(),
}));
jest.mock("../../../../src/common/chains", () => ({
  getHubInfo: jest.fn().mockImplementation(async () => ({
    allocatorAddress: "0x6666666666666666666666666666666666666666",
  })),
}));

describe("_getEncodedWithdrawalV3 - xrp-vm routing", () => {
  const XRP_PAYLOAD = ("0x" + "ab".repeat(96)) as Hex;
  const withdrawRequest = {
    chainId: "xrp",
    depository: ("0x" + "12".repeat(20)) as Hex,
    currency: ("0x" + "00".repeat(20)) as Hex,
    amount: "1000000",
    spenderChainId: "ethereum",
    spender: ("0x" + "34".repeat(20)) as Hex,
    receiver: ("0x" + "56".repeat(20)) as Hex,
    nonce: ("0x" + "00".repeat(31) + "01") as Hex,
    data: "0x" as Hex,
  };

  it("returns the realtime allocator payload as-is for xrp-vm", async () => {
    (getHubHttpRpc as any).mockResolvedValue({
      readContract: jest.fn(async (params: any) => {
        switch (params.functionName) {
          case "payloadBuilders":
            return "0x1111111111111111111111111111111111111111";
          case "family":
            return "xrp-vm";
          case "payloads":
            return XRP_PAYLOAD;
          default:
            throw new Error(`Unexpected read: ${params.functionName}`);
        }
      }),
    } as any);

    const encoded = await (new AttestationService() as any)
      ._getEncodedWithdrawalV3(withdrawRequest);
    expect(encoded).toEqual(XRP_PAYLOAD);
  });
});
