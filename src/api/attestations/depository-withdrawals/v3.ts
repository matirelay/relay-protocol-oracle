import { Type } from "@fastify/type-provider-typebox";

import {
  Endpoint,
  ErrorResponses,
  executionSchema,
  FastifyReplyTypeBox,
  FastifyRequestTypeBox,
  withdrawRequestSchema,
} from "../../utils";
import { resolveOracleQuorum } from "../../quorum";
import { getChain } from "../../../common/chains";
import { signExecutionMessage } from "../../../common/signer";
import { AttestationService } from "../../../services/attestation";

const MessageData = Type.Object({
  ...withdrawRequestSchema.properties,
  requestPeerSignatures: Type.Optional(
    Type.Boolean({
      description:
        "Whether to request signatures from any configured oracle peers",
    }),
  ),
  transactionId: Type.Optional(
    Type.String({
      description:
        "The transaction id that executed the withdrawal (required for Hyperliquid VM; for XRP once the withdrawal's sequence has been consumed)",
    }),
  ),
  hints: Type.Optional(
    Type.Object(
      {
        "ton-vm": Type.Optional(
          Type.Object({
            lt: Type.String({
              description:
                "The logical time of the executing tx on the depository wallet (required for ton-vm — TON has no global tx-hash lookup; depository tx history fans out faster than scan windows can reliably cover)",
            }),
          }),
        ),
      },
      { description: "Hints for verifying the executing tx" },
    ),
  ),
});

const Schema = {
  body: MessageData,
  response: {
    ...ErrorResponses,
    200: Type.Object({
      status: Type.Number({
        description:
          "The status of the withdrawal (0 = pending, 1 = executed, 2 = expired)",
      }),
      execution: executionSchema,
    }),
  },
};

export default {
  method: "POST",
  url: "/attestations/depository-withdrawals/v3",
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
          const chain = await getChain(req.body.chainId);
          const depository = req.body.depository ?? chain.depository!;
          const { status, execution } =
            await new AttestationService().attestDepositoryWithdrawalV3({
              chainId: req.body.chainId,
              depository,
              currency: req.body.currency,
              amount: req.body.amount,
              spenderChainId: req.body.spenderChainId,
              spender: req.body.spender,
              receiver: req.body.receiver,
              nonce: req.body.nonce,
              additionalData: req.body.additionalData,
              transactionId: req.body.transactionId,
              hints: req.body.hints,
            });
          const localSignature = execution
            ? await signExecutionMessage(execution)
            : undefined;

          return {
            status,
            execution:
              execution && localSignature
                ? { ...execution, signatures: [localSignature] }
                : undefined,
          };
        },
      }),
    );
  },
} as Endpoint;
