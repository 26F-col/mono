import { Keypair, PublicKey, TransactionInstruction, Ed25519Program } from "@solana/web3.js";
import nacl from "tweetnacl";
import { BN } from "@coral-xyz/anchor";
import { Buffer } from "buffer";

/**
 * MarginAttestation (brief §14).
 *
 * A signed answer to "can vault X safely support requested debt Y under
 * policy Z?". Fields intentionally exclude ALL private portfolio data.
 */

export const ATTESTATION_MAGIC = Buffer.from("CML2", "ascii");
/** Padded attestation lifetime for the demo (1 hour). */
export const ATTESTATION_TTL_SECONDS = 3600;

export const DECISION = { ELIGIBLE: 0, INELIGIBLE: 1, MARGIN_CALL: 2 } as const;

export interface AttestationPayload {
  vault: PublicKey;
  /** sha256 commitment; must equal the vault's current on-chain commitment. */
  commitment: Buffer;
  policyId: Buffer;
  /** Test-USDC micros. */
  requestedAmountUsdc: number;
  decision: number;
  /** Unix seconds. */
  validUntil: number;
  /** Vault commitment_nonce this attestation was computed against. */
  nonce: number;
  /** LIQUIDATE only: custody asset to seize and how much. */
  seizeMint: PublicKey;
  seizeAmount: number;
}

export function encodeAttestationMessage(p: AttestationPayload): Buffer {
  const parts = [
    ATTESTATION_MAGIC,
    p.vault.toBuffer(),
    p.commitment,
    p.policyId,
    new BN(p.requestedAmountUsdc).toArrayLike(Buffer, "le", 8),
    Buffer.from([p.decision]),
    new BN(p.validUntil).toArrayLike(Buffer, "le", 8),
    new BN(p.nonce).toArrayLike(Buffer, "le", 8),
  ];
  // Liquidation target is only encoded for LIQUIDATE decisions (keeps the
  // signed message — and therefore each pre-instruction — small).
  if (p.decision === 3) {
    parts.push(p.seizeMint.toBuffer());
    parts.push(new BN(p.seizeAmount).toArrayLike(Buffer, "le", 8));
  }
  return Buffer.concat(parts);
}

export interface SignedAttestation {
  payload: AttestationPayload;
  message: Buffer;
  signature: Buffer;
}

export function buildAttestation(
  p: Omit<AttestationPayload, "validUntil"> & {
    ttlSeconds?: number;
    /** Negative-path test hook: pin an exact validity timestamp. */
    validUntil?: number;
  },
  attester: Keypair,
): SignedAttestation {
  const payload: AttestationPayload = {
    ...p,
    validUntil:
      p.validUntil ?? Math.floor(Date.now() / 1000) + (p.ttlSeconds ?? ATTESTATION_TTL_SECONDS),
  };
  const message = encodeAttestationMessage(payload);
  const signature = Buffer.from(nacl.sign.detached(message, attester.secretKey));
  return { payload, message, signature };
}

/**
 * The Ed25519Program pre-instruction carrying one committee signature.
 * Multiple pre-instructions (one per signing attester) are placed before the
 * credit-gate instruction to satisfy the K-of-N quorum.
 *
 * Data layout (anza-xyz/agave ed25519_instruction.rs):
 *   [num_signatures=1][pad] [14-byte offsets block] [sig 64][pubkey 32][msg]
 */
export function ed25519VerifyInstruction(
  pubkey: Buffer | Uint8Array,
  message: Buffer | Uint8Array,
  signature: Buffer | Uint8Array,
): TransactionInstruction {
  const pk = Buffer.from(pubkey);
  const msg = Buffer.from(message);
  const sig = Buffer.from(signature);
  if (pk.length !== 32) throw new Error("ed25519 pubkey must be 32 bytes");
  if (sig.length !== 64) throw new Error("ed25519 signature must be 64 bytes");
  if (msg.length > 0xffff) throw new Error("message too large for ed25519 pre-instruction");

  const signatureOffset = 16;
  const publicKeyOffset = signatureOffset + 64;
  const messageDataOffset = publicKeyOffset + 32;

  const offsets = Buffer.alloc(14);
  offsets.writeUInt16LE(signatureOffset, 0);
  offsets.writeUInt16LE(0xffff, 2); // signature_instruction_index: this instruction
  offsets.writeUInt16LE(publicKeyOffset, 4);
  offsets.writeUInt16LE(0xffff, 6); // public_key_instruction_index
  offsets.writeUInt16LE(messageDataOffset, 8);
  offsets.writeUInt16LE(msg.length, 10);
  offsets.writeUInt16LE(0xffff, 12); // message_instruction_index

  const data = Buffer.concat([Buffer.from([1, 0]), offsets, sig, pk, msg]);
  return new TransactionInstruction({
    programId: Ed25519Program.programId,
    keys: [],
    data,
  });
}
