import { Type, type TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { TUnsafe } from "@sinclair/typebox";
import type {
  ContextConfigDefault,
  FastifyReply,
  FastifyRequest,
  HTTPMethods,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import type { RouteGenericInterface } from "fastify/types/route";
import type { FastifySchema } from "fastify/types/schema";

import { isExternalError } from "../common/error";
import { logger } from "../common/logger";
import { sanitizeError } from "../common/sanitize-error";

export type FastifyRequestTypeBox<TSchema extends FastifySchema> =
  FastifyRequest<
    RouteGenericInterface,
    RawServerDefault,
    RawRequestDefaultExpression,
    TSchema,
    TypeBoxTypeProvider
  >;

export type FastifyReplyTypeBox<TSchema extends FastifySchema> = FastifyReply<
  RouteGenericInterface,
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  ContextConfigDefault,
  TSchema,
  TypeBoxTypeProvider
>;

export type Endpoint = {
  url: string;
  method: HTTPMethods;
  schema: FastifySchema;
  handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
};

export const ErrorResponses = {
  400: Type.Object({
    message: Type.String({ description: "Error message" }),
  }),
};

// Generic wrapper for standard error handling across all endpoints
export const errorWrapper = (
  url: string,
  handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>,
): ((req: FastifyRequest, reply: FastifyReply) => Promise<void>) => {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await handler(req, reply);
    } catch (error: any) {
      // External errors can be passed-through externally
      if (isExternalError(error)) {
        return reply.status(400).send({ message: error.message });
      }

      logger.error(
        url,
        JSON.stringify({
          msg: "Request failed",
          requestUrl: req.url,
          error: sanitizeError(error),
          errorMsg: error.msg,
          errorResponse: error.response?.data ?? error.response?.body,
          errorStack: error.stack,
        }),
      );

      throw new Error("Something went wrong");
    }
  };
};

// Shared schemas

// BigInt is serialized as string in JSON, but TypeBox doesn't have a native BigInt type
// This creates a custom type that tells TypeScript to expect bigint while serializing as string
export const BigIntString = Type.String() as unknown as TUnsafe<bigint>;

export const depositModeSchema = Type.Union(
  [Type.Literal("fast"), Type.Literal("slow")],
  {
    description:
      "Attestation mode (default slow): 'slow' waits for full finalization, 'fast' might not wait for full finalization (depending on the oracle's configuration)",
  },
);

export const feeCommitmentSchema = Type.Object(
  {
    payer: Type.Object(
      {
        chainId: Type.String({
          description: "The chain of the payer wallet",
        }),
        address: Type.String({
          description:
            "The payer wallet address on that chain — the fee is charged from its hub alias",
        }),
      },
      {
        description: "The wallet paying the fast attestation fee",
      },
    ),
    fee: Type.Object(
      {
        chainId: Type.String({
          description: "The chain of the fee currency",
        }),
        currency: Type.String({
          description: "The fee currency address on that chain",
        }),
        maxAmount: Type.String({
          description:
            "Payer-signed cap on the fee per deposit, enforced on-chain by the fee calculator",
        }),
      },
      {
        description: "The fee terms the payer signed",
      },
    ),
    deadline: Type.String({
      description: "Commitment expiry (epoch seconds)",
    }),
    signature: Type.String({
      description: "The payer's EIP-712 signature over the commitment",
    }),
  },
  {
    description:
      "Signed commitment authorizing the fast attestation fee to be charged to the payer (required when the resolved fast tier carries a non-zero fee)",
  },
);

export const orderSchema = Type.Object(
  {
    version: Type.Literal("v1", {
      description: "The order schema version",
    }),
    solverChainId: Type.String({
      description: "The chain id of the solver address",
    }),
    solver: Type.String({
      description: "The solver address that signed the order",
    }),
    salt: Type.String({
      description: "Order salt used to make the order id unique",
    }),
    inputs: Type.Array(
      Type.Object({
        payment: Type.Object({
          chainId: Type.String({
            description: "The chain id where the input payment is deposited",
          }),
          currency: Type.String({
            description: "The input payment currency",
          }),
          amount: Type.String({
            description: "The expected input payment amount",
          }),
          weight: Type.String({
            description: "The input payment weight used for amount accounting",
          }),
        }),
        refunds: Type.Array(
          Type.Object({
            chainId: Type.String({
              description: "The chain id where this refund may be paid",
            }),
            recipient: Type.String({
              description: "The refund recipient",
            }),
            currency: Type.String({
              description: "The refund currency",
            }),
            minimumAmount: Type.String({
              description: "The minimum acceptable refund amount",
            }),
            deadline: Type.Number({
              description: "The refund payment deadline as a Unix timestamp",
            }),
            extraData: Type.String({
              description: "VM-specific extra data for the refund payment",
            }),
          }),
          { description: "Possible refunds for this input payment" },
        ),
      }),
      { description: "Input payments required by the order" },
    ),
    output: Type.Object({
      chainId: Type.String({
        description: "The chain id where the solver output is paid",
      }),
      payments: Type.Array(
        Type.Object({
          recipient: Type.String({
            description: "The output payment recipient",
          }),
          currency: Type.String({
            description: "The output payment currency",
          }),
          minimumAmount: Type.String({
            description: "The minimum acceptable output payment amount",
          }),
          expectedAmount: Type.String({
            description: "The expected output payment amount",
          }),
        }),
        { description: "Output payments the solver must make" },
      ),
      calls: Type.Array(Type.String({ description: "Encoded call data" }), {
        description: "Calls the solver must execute on the output chain",
      }),
      deadline: Type.Number({
        description: "The output payment deadline as a Unix timestamp",
      }),
      extraData: Type.String({
        description: "VM-specific extra data for the output payment",
      }),
    }),
    fees: Type.Array(
      Type.Object({
        recipientChainId: Type.String({
          description: "The chain id of the fee recipient",
        }),
        recipient: Type.String({
          description: "The fee recipient",
        }),
        currencyChainId: Type.String({
          description: "The chain id of the fee currency",
        }),
        currency: Type.String({
          description: "The fee currency",
        }),
        amount: Type.String({
          description: "The fee amount",
        }),
      }),
      { description: "Fees associated with the order" },
    ),
  },
  {
    description: "The order data",
  },
);

export const executionMessageSignatureSchema = Type.Object({
  oracleChainId: BigIntString,
  oracleContract: Type.String({
    description: "The address of the oracle contract on the hub chain",
  }),
  oracleSigner: Type.String({
    description: "The address of the oracle signer",
  }),
  signature: Type.String({
    description: "The message signature",
  }),
});

export const withdrawRequestAdditionalDataSchema = Type.Object(
  {
    "bitcoin-vm": Type.Optional(
      Type.Object({
        allocatorUtxos: Type.Array(
          Type.Object({
            txid: Type.String(),
            vout: Type.Number(),
            value: Type.String(),
          }),
        ),
        feeUtxos: Type.Array(
          Type.Object({
            txid: Type.String(),
            vout: Type.Number(),
            value: Type.String(),
            address: Type.String(),
          }),
        ),
        feeRate: Type.Number(),
        feeChangeAddress: Type.String(),
      }),
    ),
    "hyperliquid-vm": Type.Optional(
      Type.Object({
        nonce: Type.String({
          description: "The nonce of the withdrawal transaction on Hyperliquid",
        }),
      }),
    ),
    "lighter-vm": Type.Optional(
      Type.Object({
        nonce: Type.Union([Type.String(), Type.Number()], {
          description: "The nonce of the transfer transaction on Lighter",
        }),
        apiKeyIndex: Type.Union([Type.String(), Type.Number()], {
          description: "The Lighter API key index used for signing",
        }),
        usdcFee: Type.Union([Type.String(), Type.Number()], {
          description: "The USDC fee for the Lighter transfer",
        }),
      }),
    ),
    "xrp-vm": Type.Optional(
      Type.Object({
        sequence: Type.Number({
          description:
            "The depository account sequence consumed by the withdrawal",
        }),
        fee: Type.Union([Type.String(), Type.Number()], {
          description: "The transaction fee in drops",
        }),
        lastLedgerSequence: Type.Number({
          description: "The last ledger index the transaction is valid for",
        }),
        flags: Type.Optional(Type.Number()),
        destinationTag: Type.Optional(Type.Number()),
      }),
    ),
    "gateway-vm": Type.Optional(
      Type.Object({
        allocator: Type.String({
          description: "Gateway allocator / Circle delegate address",
        }),
        destinationChainId: Type.String({
          description:
            "Relay destination chain id for the Gateway withdrawal (must match the order's destination chain)",
        }),
        maxBlockHeight: Type.String({
          description: "Circle Gateway BurnIntent max block height",
        }),
        destinationData: Type.Optional(
          Type.Object({
            vmType: Type.Literal("ethereum-vm"),
            router: Type.String({
              description:
                "Allowlisted destination router that executes the committed calls",
            }),
            calls: Type.Array(
              Type.Object({
                to: Type.String({
                  description: "Destination call target",
                }),
                data: Type.String({
                  description: "Destination call calldata",
                }),
                value: Type.String({
                  description: "Native currency value sent with the call",
                }),
                allowFailure: Type.Boolean({
                  description:
                    "Whether the routed withdrawal may continue if the call fails",
                }),
              }),
              { minItems: 1 },
            ),
          }),
        ),
      }),
    ),
  },
  { description: "Additional data for normalizing a withdraw request" },
);

export const withdrawRequestSchema = Type.Object({
  chainId: Type.String({
    description: "The chain id to withdraw on",
  }),
  depository: Type.Optional(
    Type.String({
      description:
        "The depository to withdraw from (defaults to the chain's primary depository)",
    }),
  ),
  currency: Type.String({
    description: "The currency to withdraw",
  }),
  amount: Type.String({
    description: "The amount to withdraw",
  }),
  spenderChainId: Type.String({
    description: "The chain id of the spender",
  }),
  spender: Type.String({
    description: "The spender address",
  }),
  receiver: Type.String({
    description: "The withdrawal recipient",
  }),
  nonce: Type.String({
    description: "Nonce for replay protection",
  }),
  additionalData: Type.Optional(withdrawRequestAdditionalDataSchema),
});

export const normalizedWithdrawRequestSchema = Type.Object({
  chainId: Type.String({ description: "The withdraw chain id" }),
  depository: Type.String({ description: "The encoded depository address" }),
  currency: Type.String({ description: "The encoded currency address" }),
  amount: Type.String({ description: "The withdrawal amount" }),
  spenderChainId: Type.String({ description: "The spender (owner) chain id" }),
  spender: Type.String({ description: "The encoded spender (owner) address" }),
  receiver: Type.String({ description: "The encoded recipient address" }),
  data: Type.String({ description: "The encoded withdrawal data" }),
  nonce: Type.String({ description: "Nonce for replay protection" }),
});

export const signatureMetadataSchema = Type.Optional(
  Type.Object({
    "ton-vm": Type.Optional(
      Type.Object({
        timestamp: Type.Number({
          description: "Unix seconds from the TonConnect signData response",
        }),
        domain: Type.String({
          description: "Domain from the TonConnect signData response",
        }),
      }),
    ),
  }),
);

export const executionSchema = Type.Optional(
  Type.Object(
    {
      idempotencyKey: Type.String(),
      actions: Type.Array(Type.String(), { minItems: 1 }),
      metadata: Type.Optional(
        Type.Array(
          Type.Object({
            hubTokenId: BigIntString,
            origin: Type.Object({
              address: Type.String(),
              chainId: Type.String(),
              family: Type.String(),
            }),
            oracleChainId: Type.String(),
            oracleContract: Type.String({
              description:
                "The address of the oracle contract on the hub chain",
            }),
          }),
        ),
      ),
      signatures: Type.Array(executionMessageSignatureSchema, { minItems: 1 }),
    },
    {
      description: "The 'execution' message to be relayed on the Hub",
    },
  ),
);

export const executeAndWithdrawRequestSchema = Type.Object({
  inChainId: Type.String(),
  inCurrency: Type.String(),
  outChainId: Type.String(),
  outCurrency: Type.String(),
  outAmountMinimum: Type.String(),
  depository: Type.String(),
  orderAddress: Type.String(),
  receiver: Type.String(),
  data: Type.String(),
  fees: Type.Array(
    Type.Object({
      recipient: Type.String(),
      amount: Type.String(),
    }),
  ),
  nonce: Type.String(),
  deadline: Type.String(),
  signatures: Type.Array(
    Type.Object({
      executorChainId: BigIntString,
      executorContract: Type.String(),
      oracleSigner: Type.String(),
      signature: Type.String(),
    }),
    { minItems: 1 },
  ),
});
