import { Type } from "@fastify/type-provider-typebox";

import {
  BigIntString,
  Endpoint,
  ErrorResponses,
  FastifyReplyTypeBox,
  FastifyRequestTypeBox,
} from "../../../utils";
import { resolveOracleQuorum } from "../../../quorum";
import { signGenericMappingMessage } from "../../../../common/signer";
import { AttestationService } from "../../../../services/attestation";

const Schema = {
  body: Type.Object({
    walletChainId: Type.String({
      description: "The chain id of the wallet",
    }),
    wallet: Type.String({
      description: "The wallet address",
    }),
    nonce: Type.String({
      description: "The nonce to associate the id to",
    }),
    id: Type.String({
      description: "The id to associate the nonce to",
    }),
    depositor: Type.String({
      description: "The depositor address to associate the nonce to",
    }),
    signatureChainId: Type.String({
      description: "The chain id of the signature",
    }),
    signature: Type.String({
      description: "The signature for the mapping",
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
      genericMapping: Type.Object(
        {
          user: Type.String(),
          id: Type.String(),
          data: Type.String(),
          nonce: Type.String(),
          signatures: Type.Array(
            Type.Object({
              genericMappingChainId: BigIntString,
              genericMappingContract: Type.String({
                description:
                  "The address of the generic mapping contract on the Hub chain",
              }),
              oracleSigner: Type.String({
                description: "The address of the oracle signer",
              }),
              signature: Type.String({
                description: "The signature",
              }),
            }),
            {
              minItems: 1,
            },
          ),
        },
        { description: "Generic mapping message to be sent to the Hub" },
      ),
    }),
  },
};

export default {
  method: "POST",
  url: "/attestations/signatures/nonce-mapping/v2",
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
          const { genericMapping } =
            await new AttestationService().attestNonceMappingSignature(
              req.body,
            );

          return {
            genericMapping: {
              ...genericMapping,
              signatures: [await signGenericMappingMessage(genericMapping)],
            },
          };
        },
      }),
    );
  },
} as Endpoint;
