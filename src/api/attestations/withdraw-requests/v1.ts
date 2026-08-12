import { Type } from "@fastify/type-provider-typebox";

import {
  Endpoint,
  ErrorResponses,
  FastifyReplyTypeBox,
  FastifyRequestTypeBox,
  withdrawRequestSchema,
} from "../../utils";
import { resolveOracleQuorum } from "../../quorum";
import { getChain } from "../../../common/chains";
import { AttestationService } from "../../../services/attestation";
import {
  MAX_HASH_INDEXES,
  withdrawRequestCache,
} from "../../../services/attestation/cache/withdraw-request";
import { SignerCapacityError } from "../../../services/attestation/cache/signer-limiter";

const Schema = {
  body: Type.Object({
    ...withdrawRequestSchema.properties,
    hashIndexes: Type.Array(
      Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      {
        minItems: 1,
        maxItems: MAX_HASH_INDEXES,
        description:
          "The hashesToSign indexes to load from the allocator for this withdrawal request",
      },
    ),
    requestPeerSignatures: Type.Optional(
      Type.Boolean({
        description:
          "Whether to request signatures from any configured oracle peers",
      }),
    ),
  }),
  response: {
    ...ErrorResponses,
    503: Type.Object({
      message: Type.String({ description: "Error message" }),
    }),
    200: Type.Object({
      withdrawRequest: Type.Object(
        {
          chainId: Type.Number({
            description: "The Hub EVM chain id",
          }),
          allocator: Type.String({
            description: "The allocator smart contract address on the Hub",
          }),
          withdrawRequestHash: Type.String({
            description: "The withdrawal request hash checked in the allocator",
          }),
          hashesToSign: Type.Array(Type.String(), {
            minItems: 1,
            description:
              "The non-zero hashesToSign values loaded from the allocator for the requested indexes",
          }),
          signatures: Type.Array(
            Type.Object({
              oracleSigner: Type.String({
                description: "The address of the oracle signer",
              }),
              signature: Type.String({
                description: "The message signature",
              }),
            }),
            { minItems: 1 },
          ),
        },
        {
          description: "The withdrawal request inclusion attestation",
        },
      ),
    }),
  },
};

export default {
  method: "POST",
  url: "/attestations/withdraw-requests/v1",
  schema: Schema,
  handler: async (
    req: FastifyRequestTypeBox<typeof Schema>,
    reply: FastifyReplyTypeBox<typeof Schema>,
  ) => {
    try {
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
            const attestationService = new AttestationService();
            const request = {
              chainId: req.body.chainId,
              depository,
              currency: req.body.currency,
              amount: req.body.amount,
              spenderChainId: req.body.spenderChainId,
              spender: req.body.spender,
              receiver: req.body.receiver,
              nonce: req.body.nonce,
              additionalData: req.body.additionalData,
              hashIndexes: req.body.hashIndexes,
            };
            const context =
              await attestationService.getWithdrawRequestAttestationContext(
                request,
              );
            const withdrawRequest = await withdrawRequestCache.resolve({
              context,
              hashIndexes: req.body.hashIndexes,
              fetchAttestation: async () => ({
                ...context,
                hashesToSign:
                  await attestationService.getWithdrawRequestHashesToSign(
                    context,
                    req.body.hashIndexes,
                  ),
              }),
            });

            return {
              withdrawRequest,
            };
          },
        }),
      );
    } catch (error) {
      if (error instanceof SignerCapacityError) {
        return reply.status(503).send({ message: error.message });
      }
      throw error;
    }
  },
} as Endpoint;
