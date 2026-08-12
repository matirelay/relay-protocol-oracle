import { describe, expect, it } from "@jest/globals";
import { Value } from "@sinclair/typebox/value";

import { withdrawRequestAdditionalDataSchema } from "../../../src/api/utils";

describe("withdrawRequestAdditionalDataSchema", () => {
  const routedGatewayData = {
    "gateway-vm": {
      allocator: "0x0000000000000000000000000000000000000005",
      destinationChainId: "polygon",
      maxBlockHeight: "735450",
      destinationData: {
        vmType: "ethereum-vm",
        router: "0x0000000000000000000000000000000000000006",
        calls: [
          {
            to: "0x0000000000000000000000000000000000000007",
            data: "0x1234",
            value: "0",
            allowFailure: false,
          },
        ],
      },
    },
  };

  it("accepts routed Gateway destination calls", () => {
    expect(
      Value.Check(withdrawRequestAdditionalDataSchema, routedGatewayData),
    ).toBe(true);
  });

  it("rejects an empty routed Gateway call bundle", () => {
    expect(
      Value.Check(withdrawRequestAdditionalDataSchema, {
        "gateway-vm": {
          ...routedGatewayData["gateway-vm"],
          destinationData: {
            ...routedGatewayData["gateway-vm"].destinationData,
            calls: [],
          },
        },
      }),
    ).toBe(false);
  });
});
