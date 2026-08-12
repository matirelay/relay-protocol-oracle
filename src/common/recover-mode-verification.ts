import { Type } from "@fastify/type-provider-typebox";
import { bytesToHex } from "viem";

import { encodeAddress, Order, VmType } from "@relay-protocol/settlement-sdk";

import { getChainVmType } from "./chains";
import { externalError } from "./error";
import { AttestationService } from "../services/attestation";
import { getDeterministicId } from "../services/attestation/utils";
import { orderSchema } from "../api/utils";

const encodeAddressToHex = (address: string, vmType: VmType) =>
  bytesToHex(encodeAddress(address, vmType));

export const recoverModeSchemaFields = {
  ownerSignature: Type.Optional(
    Type.String({
      description:
        "Owner signature authorizing the withdrawal (required when recoverMode is not set)",
    }),
  ),
  recoverMode: Type.Optional(
    Type.Boolean({
      description:
        "When true, skips owner signature verification and validates order against on-chain deposit instead",
    }),
  ),
  depositChainId: Type.Optional(
    Type.String({
      description:
        "Chain id of the deposit transaction (required for recoverMode)",
    }),
  ),
  depositTransactionId: Type.Optional(
    Type.String({
      description: "Transaction id of the deposit (required for recoverMode)",
    }),
  ),
  depositOnchainId: Type.Optional(
    Type.String({
      description: "Onchain id of the deposit (required for recoverMode)",
    }),
  ),
  order: Type.Optional(orderSchema),
  orderSignature: Type.Optional(
    Type.String({
      description:
        "The solver signature of the order (required for recoverMode)",
    }),
  ),
};

export async function validateRecoverMode(params: {
  attestationService: AttestationService;
  depositChainId?: string;
  depositTransactionId?: string;
  depositOnchainId?: string;
  order?: Order;
  orderSignature?: string;
  chainId: string;
  currency: string;
  amount: string;
  recipient: string;
  owner: string;
  ownerChainId: string;
}): Promise<{ nonce: string }> {
  if (
    !params.depositChainId ||
    !params.depositTransactionId ||
    !params.depositOnchainId ||
    !params.order ||
    !params.orderSignature
  ) {
    throw externalError(
      "recoverMode requires depositChainId, depositTransactionId, depositOnchainId, order, and orderSignature",
    );
  }

  // Single-input only
  if (params.order.inputs.length !== 1) {
    throw externalError("recoverMode only supports single-input orders");
  }

  // The withdrawal must move the deposit's own funds, so it settles on the
  // chain the deposit was made on.
  if (params.chainId !== params.depositChainId) {
    throw externalError("Withdrawal chain does not match the deposit chain");
  }

  // A caller-chosen nonce would let one deposit authorize an unbounded number
  // of withdrawals, so the oracle derives it instead. Every replay of the same
  // recovery collapses onto one withdraw request hash for the Hub to reject.
  const nonce = getDeterministicId(
    params.depositOnchainId,
    "recover-withdrawal",
  );

  // Fetch deposit from chain
  const { messages: deposits } =
    await params.attestationService.attestDepositoryDeposits({
      chainId: params.depositChainId,
      transactionId: params.depositTransactionId,
    });
  const deposit = deposits.find(
    (d) => d.result.onchainId === params.depositOnchainId,
  );
  if (!deposit) {
    throw externalError(
      `Deposit with onchainId ${params.depositOnchainId} not found in transaction`,
    );
  }

  // Order ↔ on-chain deposit linkage + signature + no-fill-or-refund check
  await params.attestationService.validateOrderForDeposit({
    deposit,
    order: params.order,
    orderSignature: params.orderSignature,
  });

  // Match the refund entry that authorizes this withdrawal
  const refundVmType = await getChainVmType(params.chainId);
  const encodedCurrency = encodeAddressToHex(params.currency, refundVmType);
  const matches = params.order.inputs[0].refunds.filter(
    (r) =>
      r.chainId === params.chainId &&
      encodeAddressToHex(r.currency, refundVmType) === encodedCurrency,
  );
  if (matches.length !== 1) {
    throw externalError(
      `Expected exactly 1 refund entry for chain ${params.chainId} currency ${params.currency}, got ${matches.length}`,
    );
  }
  const refund = matches[0];

  if (
    encodeAddressToHex(params.recipient, refundVmType) !==
    encodeAddressToHex(refund.recipient, refundVmType)
  ) {
    throw externalError("Recipient does not match the order refund entry");
  }

  // Full-amount only
  if (BigInt(params.amount) !== BigInt(deposit.result.amount)) {
    throw externalError(
      "Amount does not match the deposit amount (slow refund is full-amount only)",
    );
  }

  // The refund entry above is authored by the solver, so matching it alone does
  // not tie the withdrawal to the deposited asset.
  if (
    encodedCurrency !==
    encodeAddressToHex(deposit.result.currency, refundVmType)
  ) {
    throw externalError(
      "Withdrawal currency does not match the deposit currency",
    );
  }

  // Owner / depositor cross-check
  if (params.ownerChainId !== params.depositChainId) {
    throw externalError("Owner chain does not match the deposit chain");
  }
  const ownerVmType = await getChainVmType(params.ownerChainId);
  if (
    encodeAddressToHex(params.owner, ownerVmType) !==
    encodeAddressToHex(deposit.result.depositor, ownerVmType)
  ) {
    throw externalError("Owner does not match the deposit's depositor");
  }

  // A slow refund returns the deposit to the address that made it. The refund
  // entry matched above is authored by the solver, so it cannot be what decides
  // where the funds land — otherwise anyone able to name a depositor could name
  // themselves as the payee.
  if (
    encodeAddressToHex(params.recipient, refundVmType) !==
    encodeAddressToHex(deposit.result.depositor, refundVmType)
  ) {
    throw externalError("Recipient is not the deposit's depositor");
  }

  return { nonce };
}
