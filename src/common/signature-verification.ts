import crypto from "crypto";
import stringify from "json-stable-stringify";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";
import { Verifier as Bip322Verifier } from "bip322-js";
import { Address as TonAddress } from "@ton/core";
import {
  Address,
  createPublicClient,
  Hex,
  http,
  keccak256,
  recoverAddress,
  SignableMessage,
  verifyMessage,
} from "viem";
import { verifyMessage as verifyMessageOnchain } from "viem/actions";
import {
  decode as decodeXrplTx,
  encodeForSigning as encodeXrplForSigning,
} from "ripple-binary-codec";
import {
  deriveAddress as deriveXrplAddress,
  verify as verifyXrplSignature,
} from "ripple-keypairs";

import { encodeAddressToHex } from "@relay-protocol/settlement-sdk";

import { XrpMemo } from "./vm/xrp-vm/rpc";

import { Chain, getChain } from "./chains";
import { externalError } from "./error";
import { logger } from "./logger";
import { toHexAddress } from "../services/attestation/vm/tron-vm";
import { httpRpc as lighterHttpRpc } from "./vm/lighter-vm/rpc";
import { httpRpc as tonHttpRpc } from "./vm/ton-vm/rpc";

type SignatureMetadata = {
  // ton-vm TonConnect signData envelope params; verified separately from the digest.
  "ton-vm"?: { timestamp: number; domain: string };
};

type BaseSignatureData = {
  chainId: string;
  currency: string;
  amount: string;
  ownerChainId: string;
  owner: string;
  recipient: string;
  nonce: string;
  additionalData?: Record<string, unknown>;
  signatureMetadata?: SignatureMetadata;
};

export type WithdrawalSignatureData = BaseSignatureData;

export type TransferSignatureData = BaseSignatureData;

export type GasPaymentSignatureData = BaseSignatureData & {
  feeCurrency: string;
  feeAmount: string;
};

type SignatureOperation = "withdrawal" | "transfer" | "gas-payment";

const createSignaturePayload = <Operation extends SignatureOperation>(
  operation: Operation,
  data: BaseSignatureData,
) => ({
  operation,
  chainId: data.chainId,
  currency: data.currency,
  amount: data.amount,
  ownerChainId: data.ownerChainId,
  owner: data.owner,
  recipient: data.recipient,
  nonce: data.nonce,
  additionalData: data.additionalData,
});

const createWithdrawalSignaturePayload = (data: WithdrawalSignatureData) =>
  createSignaturePayload("withdrawal", data);

const createTransferSignaturePayload = (data: TransferSignatureData) =>
  createSignaturePayload("transfer", data);

const createGasPaymentSignaturePayload = (data: GasPaymentSignatureData) => ({
  ...createSignaturePayload("gas-payment", data),
  feeCurrency: data.feeCurrency,
  feeAmount: data.feeAmount,
});

type SignaturePayload =
  | ReturnType<typeof createWithdrawalSignaturePayload>
  | ReturnType<typeof createTransferSignaturePayload>
  | ReturnType<typeof createGasPaymentSignaturePayload>;

type SignatureVerification<T> = {
  data: T;
  signature: string;
};

export const verifyWithdrawalSignature = (
  verification: SignatureVerification<WithdrawalSignatureData>,
) =>
  verifySignature({
    data: verification.data,
    payload: createWithdrawalSignaturePayload(verification.data),
    signature: verification.signature,
  });

export const verifyTransferSignature = (
  verification: SignatureVerification<TransferSignatureData>,
) =>
  verifySignature({
    data: verification.data,
    payload: createTransferSignaturePayload(verification.data),
    signature: verification.signature,
  });

export const verifyGasPaymentSignature = (
  verification: SignatureVerification<GasPaymentSignatureData>,
) =>
  verifySignature({
    data: verification.data,
    payload: createGasPaymentSignaturePayload(verification.data),
    signature: verification.signature,
  });

// Verifies an operation-bound signature using the owner's chain-native signing
// scheme. Public operation-specific methods above provide domain separation
// without exposing the operation discriminator to callers.
const verifySignature = async ({
  data,
  payload,
  signature,
}: {
  data: BaseSignatureData;
  payload: SignaturePayload;
  signature: string;
}) => {
  const ownerChain = await getChain(data.ownerChainId);
  const digest = computeDigest(payload);

  switch (ownerChain.vmType) {
    case "ethereum-vm":
    case "hyperliquid-vm":
      return verifyEvmPersonalSign(data, digest, signature);

    case "tron-vm":
      return verifyTronMessage(data, digest, signature);

    case "solana-vm":
      return verifySolanaEd25519(data, digest, signature);

    case "bitcoin-vm":
      return verifyBitcoinMessage(data, digest, signature);

    case "lighter-vm":
      return verifyLighterPersonalSign(data, digest, signature);

    case "ton-vm":
      return verifyTonSignData(data, digest, signature, ownerChain);

    case "xrp-vm":
      return verifyXrpSignedTxBlob(data, digest, signature);

    default:
      throw externalError(
        "Signature verification not supported for owner chain",
      );
  }
};

// All VMs use the same digest: SHA256(json-stable-stringify(params)).
// `operation` provides domain separation between owner-authorized actions.
// Each VM signs this digest using its native signing method.
const computeDigest = (payload: SignaturePayload): string =>
  crypto
    .createHash("sha256")
    .update(stringify(payload)!)
    .digest()
    .toString("hex");

// EVM/Hyperliquid: personal_sign over raw SHA256 bytes.
// `address` defaults to `data.owner`; pass an override when owner is not the
// signing EVM address (e.g. lighter-vm, where owner is the L2 account index).
// Smart-contract wallets (e.g. Safe multisigs) are also supported: if offline
// ECDSA recovery fails, the signature is verified via EIP-1271
// `isValidSignature` on the owner chain (viem's RPC-based verifyMessage,
// which also covers ERC-6492 counterfactual wallets). Only EVM owner chains
// qualify — lighter-vm delegates here, but its configured httpRpcUrl is the
// Lighter API rather than an EVM node.
const verifyEvmPersonalSign = async (
  data: BaseSignatureData,
  digest: string,
  signature: string,
  address: string = data.owner,
) => {
  // Wallets differ in how they EIP-191-encode the digest for personal_sign:
  // most sign the raw 32 bytes, but some (e.g. Safe{Wallet}) treat the hex
  // string as UTF-8 text. Both encodings bind the exact same payload, so
  // accept either.
  const messages: SignableMessage[] = [
    { raw: `0x${digest}` as Hex },
    `0x${digest}`,
  ];

  // Offline ECDSA fast path — covers EOA owners without any RPC dependency.
  let isSignatureValid = false;
  for (const message of messages) {
    try {
      isSignatureValid = await verifyMessage({
        address: address as Address,
        message,
        signature: signature as Hex,
      });
    } catch {
      // Not a recoverable ECDSA signature (e.g. an EIP-1271 contract-wallet
      // blob) — fall through to on-chain verification below.
    }
    if (isSignatureValid) {
      break;
    }
  }

  if (!isSignatureValid) {
    const ownerChain = await getChain(data.ownerChainId);
    const isEvmOwnerChain =
      ownerChain.vmType === "ethereum-vm" ||
      ownerChain.vmType === "hyperliquid-vm";
    if (isEvmOwnerChain && ownerChain.httpRpcUrl) {
      const client = createPublicClient({
        transport: http(ownerChain.httpRpcUrl),
      });
      for (const message of messages) {
        try {
          isSignatureValid = await verifyMessageOnchain(client, {
            address: address as Address,
            message,
            signature: signature as Hex,
          });
        } catch (error) {
          logger.warn(
            "signature-verification",
            `EIP-1271 signature verification error for ${address}: ${error}`,
          );
        }
        if (isSignatureValid) {
          break;
        }
      }
    }
  }

  if (!isSignatureValid) {
    throw externalError("Invalid signature");
  }
};

// Lighter: owner is the L2 account index (e.g. "476952"), but the signature
// is produced by the L1 EVM owner of that account. Resolve index → l1_address
// via Lighter API, then delegate to the EVM personal_sign verifier.
// EOA owners only: the lighter-vm chain config's httpRpcUrl is the Lighter
// API, not an EVM node, so EIP-1271 wallets (e.g. Safe multisigs) as L1
// owners are not supported here.
const verifyLighterPersonalSign = async (
  data: BaseSignatureData,
  digest: string,
  signature: string,
) => {
  // Lighter's `GET /api/v1/account` returns `{ code, total, accounts: [...] }`
  // even when looked up by index. The SDK's return type `Promise<Account>` is
  // misleading — the real body is the wrapper, so cast and read `accounts[0]`.
  let l1Address: string | undefined;
  try {
    const { accountApi } = await lighterHttpRpc(data.ownerChainId);
    const response = (await accountApi.getAccount({
      by: "index",
      value: data.owner,
    })) as unknown as { accounts?: Array<{ l1_address?: string }> };
    l1Address = response.accounts?.[0]?.l1_address;
  } catch (error) {
    logger.warn(
      "signature-verification",
      `Lighter account lookup failed for ${data.owner}: ${error}`,
    );
    throw externalError(`Lighter account ${data.owner} not found`);
  }

  if (!l1Address) {
    throw externalError(`Lighter account ${data.owner} has no l1_address`);
  }

  return verifyEvmPersonalSign(data, digest, signature, l1Address);
};

// Tron: signMessageV2 over SHA256 hex string.
// TronWeb's signMessageV2 uses "\x19TRON Signed Message:\n" prefix.
const TRON_MESSAGE_PREFIX = "\x19TRON Signed Message:\n";

const hashTronMessage = (message: string): Hex => {
  const msgBytes = Buffer.from(message, "utf-8");
  const prefix = Buffer.from(
    `${TRON_MESSAGE_PREFIX}${msgBytes.length}`,
    "utf-8",
  );
  return keccak256(Buffer.concat([prefix, msgBytes]));
};

const verifyTronMessage = async (
  data: BaseSignatureData,
  digest: string,
  signature: string,
) => {
  try {
    const recoveredAddress = await recoverAddress({
      hash: hashTronMessage(digest),
      signature: signature as Hex,
    });

    const expectedHex = toHexAddress(data.owner).toLowerCase();
    const recoveredHex = recoveredAddress.toLowerCase();

    if (recoveredHex !== expectedHex) {
      throw externalError("Invalid signature");
    }
  } catch (error: any) {
    if (error?.message === "Invalid signature") {
      throw error;
    }
    throw externalError("Invalid signature");
  }
};

// Solana: Ed25519 sign over SHA256 hex string (as UTF-8 bytes).
// Raw 32-byte digest triggers Phantom's anti-transaction-signing check,
// so wallets sign the 64-char hex string instead.
const verifySolanaEd25519 = async (
  data: BaseSignatureData,
  digest: string,
  signature: string,
) => {
  const digestBytes = Buffer.from(digest, "utf-8");

  let pubkeyBytes: Uint8Array;
  try {
    pubkeyBytes = bs58.decode(data.owner);
  } catch {
    throw externalError("Invalid Solana owner address");
  }
  if (pubkeyBytes.length !== 32) {
    throw externalError("Invalid Solana owner address");
  }

  const sigHex = signature.startsWith("0x") ? signature.slice(2) : signature;
  const sigBytes = Buffer.from(sigHex, "hex");
  if (sigBytes.length !== 64) {
    throw externalError("Invalid signature length");
  }

  const isValid = ed25519.verify(sigBytes, digestBytes, pubkeyBytes);
  if (!isValid) {
    throw externalError("Invalid signature");
  }
};

// TON: TonConnect signData (type="text"), spec: ton-connect/docs spec/rpc.md.
// sha256(0xffff || "ton-connect/sign-data/" || addr(BE) || domainLen(BE32) || domain ||
//        timestamp(BE64) || "txt" || payloadLen(BE32) || payload)
// Ed25519 pubkey from get_public_key() on-chain getter.
// signatureMetadata["ton-vm"].timestamp = Unix seconds from TonConnect signData response.
// signatureMetadata["ton-vm"].domain = domain from TonConnect signData response.
export const verifyTonSignData = async (
  data: BaseSignatureData,
  digest: string,
  signature: string,
  ownerChain: Chain,
) => {
  const tonData = data.signatureMetadata?.["ton-vm"];

  const timestamp = tonData?.timestamp;
  if (typeof timestamp !== "number") {
    throw externalError("Missing ton-vm timestamp in signatureMetadata");
  }

  const domain = tonData?.domain;
  if (typeof domain !== "string") {
    throw externalError("Missing ton-vm domain in signatureMetadata");
  }

  const signDataDomain = ownerChain.additionalData?.signDataDomain;
  if (!signDataDomain) {
    throw externalError("ton-vm chain missing signDataDomain config");
  }
  if (domain !== signDataDomain && !domain.endsWith("." + signDataDomain)) {
    throw externalError("Invalid signData domain");
  }

  const { client } = await tonHttpRpc(data.ownerChainId);
  const result = await client.runMethodWithError(
    TonAddress.parse(data.owner),
    "get_public_key",
  );
  if (result.exit_code !== 0) {
    throw externalError(
      `get_public_key failed for owner ${data.owner} (exit ${result.exit_code})`,
    );
  }
  const pubkeyBigInt = result.stack.readBigNumber();
  const pubkeyBytes = Buffer.from(
    pubkeyBigInt.toString(16).padStart(64, "0"),
    "hex",
  );

  // Payload = the canonical operation-bound digest the user signed.
  const payloadBytes = Buffer.from(digest, "utf-8");

  const [wcStr, addrHashHex] = data.owner.split(":");
  const wcBuf = Buffer.alloc(4);
  wcBuf.writeInt32BE(parseInt(wcStr));
  const addrHashBuf = Buffer.from(addrHashHex, "hex");

  const domainUtf8 = Buffer.from(domain, "utf-8");
  const domainLenBuf = Buffer.alloc(4);
  domainLenBuf.writeUInt32BE(domainUtf8.length);

  const timestampBuf = Buffer.alloc(8);
  timestampBuf.writeBigInt64BE(BigInt(timestamp));

  const payloadLenBuf = Buffer.alloc(4);
  payloadLenBuf.writeUInt32BE(payloadBytes.length);

  const message = Buffer.concat([
    Buffer.from([0xff, 0xff]),
    Buffer.from("ton-connect/sign-data/"),
    wcBuf,
    addrHashBuf,
    domainLenBuf,
    domainUtf8,
    timestampBuf,
    Buffer.from("txt"),
    payloadLenBuf,
    payloadBytes,
  ]);
  const messageHash = crypto.createHash("sha256").update(message).digest();

  const sigHex = signature.startsWith("0x") ? signature.slice(2) : signature;
  const sigBytes = Buffer.from(sigHex, "hex");
  if (sigBytes.length !== 64) {
    throw externalError("Invalid signature length");
  }

  const isValid = ed25519.verify(sigBytes, messageHash, pubkeyBytes);
  if (!isValid) {
    throw externalError("Invalid signature");
  }
};

// Bitcoin: signMessage over SHA256 hex string.
// Uses bip322-js which handles both BIP-137 (legacy) and BIP-322 (witness-based)
// signatures for all address types: P2PKH, P2SH-P2WPKH, P2WPKH, P2TR.
// This covers wallets returning BIP-137 (Unisat, Xverse) and BIP-322 (OKX, Leather).
const verifyBitcoinMessage = (
  data: BaseSignatureData,
  digest: string,
  signature: string,
) => {
  const sigHex = signature.startsWith("0x") ? signature.slice(2) : signature;
  const sigBase64 = Buffer.from(sigHex, "hex").toString("base64");

  let isValid = false;
  try {
    isValid = Bip322Verifier.verifySignature(data.owner, digest, sigBase64);
  } catch (error) {
    logger.warn(
      "signature-verification",
      `Bitcoin signature verification error for ${data.owner}: ${error}`,
    );
  }
  if (!isValid) {
    throw externalError("Invalid signature");
  }
};

// xrp-vm: no personal_sign equivalent exists across XRPL wallets, so the owner
// signs a canonical never-submittable AccountSet whose single Memo is the
// digest as UTF-8 "0x<hex>" — the same memo convention as xrp-vm deposits.
// Never-submittable: Fee "0" is below the network fee floor, and Sequence 0 is
// invalid without a ticket — TicketSequence is rejected so the ticket path
// cannot re-validate it. The envelope is the signed tx
// blob itself; SigningPubKey travels inside it (XRPL account roots don't store
// the master pubkey). Master-key signatures only: a RegularKey signer derives a
// different address and is rejected.
const verifyXrpSignedTxBlob = (
  data: BaseSignatureData,
  digest: string,
  signature: string,
) => {
  let tx: Record<string, unknown>;
  try {
    tx = decodeXrplTx(
      signature.startsWith("0x") ? signature.slice(2) : signature,
    );
  } catch {
    throw externalError("Invalid xrp-vm signed transaction blob");
  }

  if (
    tx.TransactionType !== "AccountSet" ||
    tx.Fee !== "0" ||
    tx.Sequence !== 0
  ) {
    throw externalError(
      "xrp-vm authorization must be an AccountSet with Fee 0 and Sequence 0",
    );
  }
  if (
    tx.SetFlag !== undefined ||
    tx.ClearFlag !== undefined ||
    tx.TicketSequence !== undefined
  ) {
    throw externalError(
      "xrp-vm authorization must not carry account flags or a TicketSequence",
    );
  }

  const signingPubKey = tx.SigningPubKey as string | undefined;
  const txnSignature = tx.TxnSignature as string | undefined;
  if (!signingPubKey || !txnSignature) {
    throw externalError("Missing SigningPubKey or TxnSignature");
  }

  // Signer identity before the costlier curve verify. deriveAddress and the
  // decoded Account are both canonical classic form; only data.owner needs
  // X-address normalization.
  let matches = false;
  try {
    matches =
      deriveXrplAddress(signingPubKey) === tx.Account &&
      encodeAddressToHex(data.owner, "xrp-vm") ===
        encodeAddressToHex(tx.Account as string, "xrp-vm");
  } catch {
    // encodeAddress throws on malformed addresses — treat as mismatch
  }
  if (!matches) {
    throw externalError("Signer does not match owner");
  }

  const memos = (tx.Memos ?? []) as XrpMemo[];
  if (memos.length !== 1) {
    throw externalError("xrp-vm authorization must carry exactly one memo");
  }
  const memoText = Buffer.from(memos[0].Memo?.MemoData ?? "", "hex")
    .toString("utf-8")
    .toLowerCase();
  if (memoText !== `0x${digest}`) {
    throw externalError("xrp-vm authorization memo must equal the digest");
  }

  // encodeForSigning re-serializes only the signing fields with the STX prefix,
  // so the verified bytes are exactly what the wallet signed.
  let isValid = false;
  try {
    isValid = verifyXrplSignature(
      encodeXrplForSigning(tx),
      txnSignature,
      signingPubKey,
    );
  } catch (error) {
    logger.warn(
      "signature-verification",
      `xrp-vm signature verification error for ${data.owner}: ${error}`,
    );
  }
  if (!isValid) {
    throw externalError("Invalid signature");
  }
};
