import { Type } from "@fastify/type-provider-typebox";
import { generateAddress } from "@relay-protocol/settlement-sdk";

import {
  Endpoint,
  ErrorResponses,
  executionSchema,
  FastifyReplyTypeBox,
  FastifyRequestTypeBox,
} from "../../utils";
import { resolveOracleQuorum } from "../../quorum";
import { getChain } from "../../../common/chains";
import { signExecutionMessage } from "../../../common/signer";
import { verifyTransferSignature } from "../../../common/signature-verification";
import { AttestationService } from "../../../services/attestation";

const Schema = {
  body: Type.Object({
    chainId: Type.String({
      description: "The chain id of the currency being transferred",
    }),
    currency: Type.String({
      description: "The currency to transfer",
    }),
    amount: Type.String({
      description: "The amount to transfer",
    }),
    recipient: Type.String({
      description: "The hub address to transfer the funds to",
    }),
    nonce: Type.String({
      description: "Nonce for replay protection",
    }),
    ownerChainId: Type.String({
      description: "The chain id of the funds owner (whose alias holds them)",
    }),
    owner: Type.String({
      description: "The owner of the funds (origin-chain address)",
    }),
    ownerSignature: Type.String({
      description:
        "The owner's signature over the transfer request, proving alias ownership",
    }),
    requestPeerSignatures: Type.Optional(
      Type.Boolean({
        description:
          "Whether to request signatures from any configured oracle peers",
      }),
    ),
  }),
  response: {
    ...ErrorResponses,
    200: Type.Object({
      execution: executionSchema,
    }),
  },
};

export default {
  method: "POST",
  url: "/attestations/transfer/v1",
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
          await verifyTransferSignature({
            data: req.body,
            signature: req.body.ownerSignature,
          });

          const from = generateAddress({
            family: await getChain(req.body.ownerChainId).then(
              (chain) => chain.vmType,
            ),
            chainId: req.body.ownerChainId,
            address: req.body.owner,
          });
          const { execution } =
            await new AttestationService().attestTransfer({
              chainId: req.body.chainId,
              currency: req.body.currency,
              amount: req.body.amount,
              from,
              to: req.body.recipient,
              nonce: req.body.nonce,
            });

          return {
            execution: {
              ...execution,
              signatures: [await signExecutionMessage(execution)],
            },
          };
        },
      }),
    );
  },
} as Endpoint;
