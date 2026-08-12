import { Type } from "@fastify/type-provider-typebox";

import {
  depositModeSchema,
  Endpoint,
  ErrorResponses,
  executeAndWithdrawRequestSchema,
  executionSchema,
  FastifyReplyTypeBox,
  FastifyRequestTypeBox,
  feeCommitmentSchema,
  orderSchema,
  withdrawRequestAdditionalDataSchema,
} from "../../utils";
import { resolveOracleQuorum } from "../../quorum";
import {
  signExecuteAndWithdrawRequestMessage,
  signExecutionMessage,
} from "../../../common/signer";
import { AttestationService } from "../../../services/attestation";

const MessageData = Type.Object({
  chainId: Type.String({
    description: "The chain id of the transaction to attest",
  }),
  transactionId: Type.String({
    description: "The transaction id to attest",
  }),
  mode: Type.Optional(depositModeSchema),
  feeCommitment: Type.Optional(feeCommitmentSchema),
  onchainId: Type.String({
    description: "The onchain id of the deposit",
  }),
  inputCurrency: Type.Optional(
    Type.String({
      description:
        "The currency to pull from the order address (defaults to the deposit currency). Must match the deposit currency until the order's fees are charged, afterwards any currency is allowed.",
    }),
  ),
  refundIndex: Type.Optional(
    Type.Integer({
      minimum: 0,
      description:
        "Index of the order refund option to pay out, which supplies the refund chain and currency (defaults to the first option). Need not be on the deposit chain.",
    }),
  ),
  order: orderSchema,
  orderSignature: Type.String({
    description: "The solver signature of the order",
  }),
  nonce: Type.String({
    description: "Nonce to pass-through to the underlying withdraw request",
  }),
  additionalData: Type.Optional(withdrawRequestAdditionalDataSchema),
  useGatewaySource: Type.Optional(
    Type.String({
      description:
        "Gateway chain id to use as the withdrawal currency source (only relevant for Circle USDC withdrawals)",
    }),
  ),
  hints: Type.Optional(
    Type.Object(
      {
        "ton-vm": Type.Optional(
          Type.Object({
            lt: Type.String({
              description:
                "The logical time of the deposit tx (required for ton-vm — TON has no global tx-hash lookup; high-throughput depositories make scan-fallback unreliable)",
            }),
          }),
        ),
      },
      {
        description:
          "Hints for attesting the deposit transaction and building the withdraw request",
      },
    ),
  ),
  requestPeerSignatures: Type.Optional(
    Type.Boolean({
      description:
        "Whether to request signatures from any configured oracle peers",
    }),
  ),
});

const Schema = {
  body: MessageData,
  response: {
    ...ErrorResponses,
    200: Type.Object({
      execution: executionSchema,
      executeAndWithdrawRequest: executeAndWithdrawRequestSchema,
    }),
  },
};

export default {
  method: "POST",
  url: "/attestations/withdraw-and-refund/v1",
  schema: Schema,
  handler: async (
    req: FastifyRequestTypeBox<typeof Schema>,
    reply: FastifyReplyTypeBox<typeof Schema>,
  ) => {
    return reply.send(
      await resolveOracleQuorum({
        endpointPath: req.originalUrl,
        requestBody: req.body,
        requestApiKey: req.headers["x-api-key"],
        requestPeerSignatures: req.body.requestPeerSignatures ?? false,
        responseSchema: Schema.response[200],
        createLocalResponse: async () => {
          const { execution, executeAndWithdrawRequest } =
            await new AttestationService().attestWithdrawAndRefund(req.body);
          const [executionSignature, withdrawSignature] = await Promise.all([
            signExecutionMessage(execution),
            signExecuteAndWithdrawRequestMessage(executeAndWithdrawRequest),
          ]);

          return {
            execution: {
              ...execution,
              signatures: [executionSignature],
            },
            executeAndWithdrawRequest: {
              ...executeAndWithdrawRequest,
              signatures: [withdrawSignature],
            },
          };
        },
      }),
    );
  },
} as Endpoint;
