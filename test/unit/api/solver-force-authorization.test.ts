import { beforeEach, describe, expect, it, jest } from "@jest/globals";

import solverFillEndpoint from "../../../src/api/attestations/solver-fills/v1";
import solverRefundEndpoint from "../../../src/api/attestations/solver-refunds/v1";

const mockAttestSolverFill = jest.fn();
const mockAttestSolverRefund = jest.fn();

jest.mock("../../../src/config", () => ({
  config: {
    apiKeys: { "valid-key": "partner" },
    peers: undefined,
  },
}));

jest.mock("../../../src/common/signer", () => ({
  signExecutionMessage: jest.fn(),
}));

jest.mock("../../../src/services/attestation", () => ({
  AttestationService: jest.fn(() => ({
    attestSolverFill: mockAttestSolverFill,
    attestSolverRefund: mockAttestSolverRefund,
  })),
}));

const makeReply = () => {
  const reply: any = {};
  reply.status = jest.fn().mockReturnValue(reply);
  reply.send = jest.fn().mockReturnValue(reply);
  return reply;
};

describe.each([
  ["solver fill", solverFillEndpoint, mockAttestSolverFill],
  ["solver refund", solverRefundEndpoint, mockAttestSolverRefund],
])("forced %s authorization", (_name, endpoint, attest) => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each(["constructor", "toString", "hasOwnProperty", "__proto__"])(
    "rejects inherited object property %s as an API key",
    async (apiKey) => {
      const reply = makeReply();

      await (endpoint as any).handler(
        {
          body: { force: true },
          headers: { "x-api-key": apiKey },
        } as any,
        reply,
      );

      expect(reply.status).toHaveBeenCalledWith(400);
      expect(reply.send).toHaveBeenCalledWith({
        message: "Unauthorized to use the `force` option",
      });
      expect(attest).not.toHaveBeenCalled();
    },
  );
});
