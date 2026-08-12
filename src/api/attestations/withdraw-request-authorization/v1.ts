import { Type } from "@fastify/type-provider-typebox";
import { normalizeWithdrawRequest } from "@relay-protocol/settlement-sdk";

import {
  Endpoint,
  ErrorResponses,
  FastifyReplyTypeBox,
  FastifyRequestTypeBox,
  normalizedWithdrawRequestSchema,
  signatureMetadataSchema,
  withdrawRequestSchema,
} from "../../utils";
import { resolveOracleQuorum } from "../../quorum";
import { getChain } from "../../../common/chains";
import { externalError } from "../../../common/error";
import { logger } from "../../../common/logger";
import {
  recoverModeSchemaFields,
  validateRecoverMode,
} from "../../../common/recover-mode-verification";
import { signAllocatorWithdrawRequest } from "../../../common/signer";
import { verifyWithdrawalSignature } from "../../../common/signature-verification";
import { AttestationService } from "../../../services/attestation";

// Withdraw-chain vm types supported by this endpoint; reject anything else
// up front with a clean 4xx before owner-signature verification.
const SUPPORTED_WITHDRAW_VM_TYPES = [
  "bitcoin-vm",
  "ethereum-vm",
  "lighter-vm",
  "solana-vm",
  "ton-vm",
  "tron-vm",
  "xrp-vm",
];

const Schema = {
  body: Type.Object({
    ...withdrawRequestSchema.properties,
    // ton-vm owners sign via TonConnect signData; echo back the wallet's
    // timestamp + domain so the oracle can reconstruct the signature.
    signatureMetadata: signatureMetadataSchema,
    ...recoverModeSchemaFields,
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
      withdrawRequest: normalizedWithdrawRequestSchema,
      allocatorChainId: Type.Number({
        description: "The Hub EVM chain id of the allocator",
      }),
      allocatorContract: Type.String({
        description: "The allocator contract the signatures authorize",
      }),
      // Oracle signature(s) over the allocator WithdrawRequest digest. The
      // allocator's ORACLE is a threshold multisig, so the caller must sort
      // these by oracleSigner ascending and concatenate into one blob before
      // submitting on-chain.
      signatures: Type.Array(
        Type.Object({
          oracleSigner: Type.String({
            description: "The address of the oracle signer",
          }),
          signature: Type.String({
            description: "The signature over the WithdrawRequest digest",
          }),
        }),
        { minItems: 1 },
      ),
    }),
  },
};

export default {
  method: "POST",
  url: "/attestations/withdraw-request-authorization/v1",
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
          const isRecoverMode = req.body.recoverMode === true;

          // Reject unsupported chains before verifying, clean 4xx, not a sig error.
          const chain = await getChain(req.body.chainId);
          if (!SUPPORTED_WITHDRAW_VM_TYPES.includes(chain.vmType)) {
            throw externalError(
              `Withdrawals on ${chain.vmType} are not supported by this endpoint`,
            );
          }

          // AUTHORIZE: the only per-branch difference. The shared tail below
          // stays identical apart from the nonce, which recoverMode derives
          // from the deposit rather than taking from the caller.
          let nonce = req.body.nonce;
          if (isRecoverMode) {
            // Slow refund: skip user signature, validate the order against the
            // on-chain deposit + solver's no-fill-or-refund declaration instead.
            const attestationService = new AttestationService();
            ({ nonce } = await validateRecoverMode({
              attestationService,
              chainId: req.body.chainId,
              currency: req.body.currency,
              amount: req.body.amount,
              owner: req.body.spender,
              recipient: req.body.receiver,
              ownerChainId: req.body.spenderChainId,
              depositChainId: req.body.depositChainId,
              depositTransactionId: req.body.depositTransactionId,
              depositOnchainId: req.body.depositOnchainId,
              order: req.body.order,
              orderSignature: req.body.orderSignature,
            }));
            // Audit log: recoverMode bypasses user signature. Every accepted
            // invocation must be observable.
            logger.info(
              "recover-mode-verification",
              JSON.stringify({
                msg: "recoverMode attestation accepted",
                endpoint: "withdraw-request-authorization/v1",
                depositChainId: req.body.depositChainId,
                depositTransactionId: req.body.depositTransactionId,
                depositOnchainId: req.body.depositOnchainId,
                spender: req.body.spender,
                receiver: req.body.receiver,
                chainId: req.body.chainId,
                nonce,
              }),
            );
          } else {
            if (!req.body.ownerSignature) {
              throw externalError("ownerSignature is required");
            }
            // The user-signed digest keys on owner/recipient/ownerChainId. Map
            // the request fields onto it to keep the digest identical across endpoints.
            await verifyWithdrawalSignature({
              data: {
                chainId: req.body.chainId,
                currency: req.body.currency,
                amount: req.body.amount,
                ownerChainId: req.body.spenderChainId,
                owner: req.body.spender,
                recipient: req.body.receiver,
                nonce: req.body.nonce,
                additionalData: req.body.additionalData,
                signatureMetadata: req.body.signatureMetadata,
              },
              signature: req.body.ownerSignature,
            });
          }

          const spenderChain = await getChain(req.body.spenderChainId);
          const normalizedWithdrawRequest = normalizeWithdrawRequest({
            vmType: chain.vmType,
            spenderVmType: spenderChain.vmType,
            chainId: req.body.chainId,
            depository: req.body.depository ?? chain.depository!,
            currency: req.body.currency,
            amount: req.body.amount,
            spenderChainId: req.body.spenderChainId,
            spender: req.body.spender,
            receiver: req.body.receiver,
            nonce,
            additionalData: req.body.additionalData,
          });
          const {
            allocatorChainId,
            allocatorContract,
            oracleSigner,
            signature,
          } = await signAllocatorWithdrawRequest(normalizedWithdrawRequest);

          return {
            withdrawRequest: normalizedWithdrawRequest,
            allocatorChainId,
            allocatorContract,
            signatures: [{ oracleSigner, signature }],
          };
        },
      }),
    );
  },
} as Endpoint;
