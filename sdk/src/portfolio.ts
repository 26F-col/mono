import type { Holding } from "./risk";
import { Buffer } from "buffer";

/**
 * Client-side portfolio storage (brief §3: the portfolio is encrypted
 * client-side; on-chain we store only sha256 of the ciphertext).
 *
 * Uses WebCrypto (AES-256-GCM) so it works in Node AND the browser. The
 * ciphertext never needs to leave the institution unless it chooses to
 * disclose to an authorized auditor — but committing to its hash binds every
 * margin attestation to one specific, immutable portfolio snapshot.
 */

export interface PortfolioSnapshot {
  institution: string;
  holdings: Holding[];
  /** Cents. Computed client-side; kept private. */
  navCents?: number;
  committedAt: number;
}

const PORTFOLIO_DOMAIN = "cml-portfolio-v1";

const subtle = (): any => (globalThis as any).crypto.subtle;

export async function sha256Hex(data: Buffer): Promise<string> {
  const d = await subtle().digest("SHA-256", new Uint8Array(data));
  return Buffer.from(d).toString("hex");
}

/** sha256(domain ‖ ciphertext) — the value registered on the vault. */
export async function commitmentHash(ciphertext: Buffer): Promise<Buffer> {
  const d = await subtle().digest(
    "SHA-256",
    new Uint8Array(Buffer.concat([Buffer.from(PORTFOLIO_DOMAIN, "ascii"), ciphertext])),
  );
  return Buffer.from(d);
}

async function importAesKey(key: Buffer): Promise<any> {
  return subtle().importKey("raw", new Uint8Array(key), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** AES-256-GCM. Output layout: [12B nonce][16B tag][ciphertext]. */
export async function encryptPortfolio(
  snapshot: PortfolioSnapshot,
  key?: Buffer,
): Promise<{ key: Buffer; ciphertext: Buffer }> {
  const k = key ?? Buffer.from((globalThis as any).crypto.getRandomValues(new Uint8Array(32)));
  const nonce = (globalThis as any).crypto.getRandomValues(new Uint8Array(12));
  const sk = await importAesKey(k);
  const ct = new Uint8Array(
    await subtle().encrypt(
      { name: "AES-GCM", iv: nonce },
      sk,
      new Uint8Array(Buffer.from(JSON.stringify(snapshot), "utf8")),
    ),
  );
  return { key: k, ciphertext: Buffer.concat([Buffer.from(nonce), Buffer.from(ct)]) };
}

export async function decryptPortfolio(
  ciphertext: Buffer,
  key: Buffer,
): Promise<PortfolioSnapshot> {
  const nonce = ciphertext.subarray(0, 12);
  const ct = ciphertext.subarray(12);
  const sk = await importAesKey(key);
  const pt = await subtle().decrypt({ name: "AES-GCM", iv: new Uint8Array(nonce) }, sk, new Uint8Array(ct));
  return JSON.parse(Buffer.from(pt).toString("utf8"));
}
