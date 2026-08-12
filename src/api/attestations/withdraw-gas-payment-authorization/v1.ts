import { Type } from "@fastify/type-provider-typebox";
import {
  encodeAddressToHex,
  normalizeWithdrawRequest,
  VmType,
} from "@relay-protocol/settlement-sdk";

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
import { signWithdrawGasPayment } from "../../../common/signer";
import { verifyGasPaymentSignature } from "../../../common/signature-verification";

// Only payload builders that pay gas through WithdrawGasPayer should request
// this authorization.
const SUPPORTED_WITHDRAW_VM_TYPES = ["gateway-vm", "ton-vm", "xrp-vm"];

const normalizeCurrency = (currency: string, vmType: VmType) =>
  vmType === "gateway-vm" ? currency : encodeAddressToHex(currency, vmType);

const Schema = {
  body: Type.Object({
    ...withdrawRequestSchema.properties,
    signatureMetadata: signatureMetadataSchema,
    feeCurrency: Type.String({
      description: "The currency used to pay the withdrawal gas fee",
    }),
    feeAmount: Type.String({
      description: "The gas fee amount as a positive integer",
      pattern: "^[0-9]+$",
    }),
    ownerSignature: Type.String({
      description:
        "The spender's signature authorizing this gas payment, including its fee currency and amount",
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
      withdrawRequest: normalizedWithdrawRequestSchema,
      feeCurrency: Type.String({
        description: "The encoded gas fee currency",
      }),
      feeAmount: Type.String({
        description: "The canonical gas fee amount",
      }),
      gasPayerChainId: Type.Number({
        description: "The Hub EVM chain id of WithdrawGasPayer",
      }),
      gasPayerContract: Type.String({
        description: "The WithdrawGasPayer contract being authorized",
      }),
      signatures: Type.Array(
        Type.Object({
          oracleSigner: Type.String({
            description: "The address of the oracle signer",
          }),
          signature: Type.String({
            description: "The signature over the PayGas digest",
          }),
        }),
        { minItems: 1 },
      ),
    }),
  },
};

export default {
  method: "POST",
  url: "/attestations/withdraw-gas-payment-authorization/v1",
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
          if (!SUPPORTED_WITHDRAW_VM_TYPES.includes(chain.vmType)) {
            throw externalError(
              `Gas payments on ${chain.vmType} are not supported by this endpoint`,
            );
          }

          let feeAmount: string;
          try {
            const parsedFeeAmount = BigInt(req.body.feeAmount);
            if (parsedFeeAmount <= 0n) {
              throw new Error("Non-positive fee");
            }
            feeAmount = parsedFeeAmount.toString();
          } catch {
            throw externalError("feeAmount must be a positive integer");
          }

          await verifyGasPaymentSignature({
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
              feeCurrency: req.body.feeCurrency,
              feeAmount,
            },
            signature: req.body.ownerSignature,
          });

          const spenderChain = await getChain(req.body.spenderChainId);
          const withdrawRequest = normalizeWithdrawRequest({
            vmType: chain.vmType,
            spenderVmType: spenderChain.vmType,
            chainId: req.body.chainId,
            depository: req.body.depository ?? chain.depository!,
            currency: req.body.currency,
            amount: req.body.amount,
            spenderChainId: req.body.spenderChainId,
            spender: req.body.spender,
            receiver: req.body.receiver,
            nonce: req.body.nonce,
            additionalData: req.body.additionalData,
          });
          const feeCurrency = normalizeCurrency(
            req.body.feeCurrency,
            chain.vmType,
          );
          const {
            gasPayerChainId,
            gasPayerContract,
            oracleSigner,
            signature,
          } = await signWithdrawGasPayment(
            withdrawRequest,
            feeCurrency,
            feeAmount,
          );

          return {
            withdrawRequest,
            feeCurrency,
            feeAmount,
            gasPayerChainId,
            gasPayerContract,
            signatures: [{ oracleSigner, signature }],
          };
        },
      }),
    );
  },
} as Endpoint;
