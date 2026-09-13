import nacl from "tweetnacl";
import type { PortfolioSnapshot } from "./portfolio";

/**
 * Per-auditor view keys (gap-6 fix, SDK level).
 *
 * Instead of one shared AES key handed to every auditor, the institution
 * seals a per-auditor envelope: X25519 ECDH(institution secret, auditor
 * public) via nacl.box. Each auditor can open ONLY their own envelope with
 * their X25519 secret key; envelopes are bound to one auditor and cannot be
 * re-shared as-is. The on-chain commitment still verifies integrity for any
 * envelope: sha256(envelope.ciphertext) is published alongside it.
 *
 * (A production system would use Confidential Balances auditor keys or
 * per-auditor decryption shares via MPC — documented as roadmap.)
 */

export interface AuditorKeyPair {
  publicKey: Uint8Array; // X25519 public (32B)
  secretKey: Uint8Array; // X25519 secret (32B)
}

export function auditorKeyPair(seed?: Uint8Array): AuditorKeyPair {
  if (seed) {
    if (seed.length !== 32) throw new Error("auditor seed must be 32 bytes");
    // tweetnacl has no box.fromSeed: derive the X25519 secret deterministically
    // by using the seed directly as the secret key.
    return nacl.box.keyPair.fromSecretKey(seed);
  }
  return nacl.box.keyPair();
}

export interface AuditorEnvelope {
  version: "cml-auditor-v1";
  /** Institution's X25519 public key (envelope sender). */
  institutionPublicKey: Uint8Array;
  /** Intended auditor's X25519 public key. */
  auditorPublicKey: Uint8Array;
  /** 24B nacl.box nonce. */
  nonce: Uint8Array;
  /** JSON-encoded snapshot, boxed to the auditor. */
  sealed: Uint8Array;
}

/** Institution: seal the snapshot for ONE auditor. */
export function sealForAuditor(
  snapshot: PortfolioSnapshot,
  auditorPublicKey: Uint8Array,
  institutionKeyPair: AuditorKeyPair,
): AuditorEnvelope {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const sealed = nacl.box(
    new Uint8Array(Buffer.from(JSON.stringify(snapshot), "utf8")),
    nonce,
    auditorPublicKey,
    institutionKeyPair.secretKey,
  );
  return {
    version: "cml-auditor-v1",
    institutionPublicKey: institutionKeyPair.publicKey,
    auditorPublicKey,
    nonce,
    sealed,
  };
}

/** Auditor: open an envelope addressed to you. */
export function openAuditorView(
  envelope: AuditorEnvelope,
  auditorSecretKey: Uint8Array,
): PortfolioSnapshot {
  const opened = nacl.box.open(
    envelope.sealed,
    envelope.nonce,
    envelope.institutionPublicKey,
    auditorSecretKey,
  );
  if (!opened) throw new Error("auditor envelope failed to open (wrong key or tampered)");
  return JSON.parse(Buffer.from(opened).toString("utf8"));
}

/** Institution: derive the auditor's verification id for records. */
export function auditorViewId(envelope: AuditorEnvelope): string {
  return Buffer.from(envelope.auditorPublicKey).toString("hex").slice(0, 16);
}
