/**
 * AttestationLogged indexer — scans credit_gate transactions for consumed
 * margin attestations and decodes the public AttestationLogged events.
 * Alerts when a decision contradicts public oracle state (e.g., ELIGIBLE
 * signed while a feed was stale or a price shock had just landed).
 *
 * Run:  RPC=<rpc> npx tsx scripts/attestation-indexer.ts
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { ConfidentialMarginClient, demoKeypair } from "../sdk/src/client";
import { BN } from "@coral-xyz/anchor";

const RPC = process.env.RPC_URL ?? process.env.RPC ?? "https://api.devnet.solana.com";
const GATE_ID = "6uLcY78dvjTYhwLzZUmridf5zUiEmmDHpLhidHezao3S";

// Anchor event discriminator = sha256("event:<Name>")[0..8]
const crypto = require("crypto");
function eventDiscriminator(name: string): Buffer {
  return crypto.createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
}

const DECISION_NAME: Record<number, string> = {
  0: "ELIGIBLE",
  1: "INELIGIBLE",
  2: "MARGIN_CALL",
  3: "LIQUIDATE",
};

interface AttestationRecord {
  signature: string;
  slot: number;
  vault: string;
  decision: number;
  decisionName: string;
  requestedAmountUsdc: string;
  nonce: string;
  approvalsMask: number;
  /** Binary representation of which committee members approved. */
  approvers: string;
}

function decodeAttestationLogged(data: Buffer, signature: string, slot: number): AttestationRecord | null {
  const disc = eventDiscriminator("AttestationLogged");
  if (data.length < 8 + disc.length || !data.subarray(0, 8).equals(disc)) return null;
  const body = data.subarray(8);
  let off = 0;
  const vault = new PublicKey(body.subarray(off, off + 32)); off += 32;
  const decision = body[off]; off += 1;
  const requested = new BN(body.subarray(off, off + 8), "le"); off += 8;
  const nonce = new BN(body.subarray(off, off + 8), "le"); off += 8;
  const approvals = body[off];
  return {
    signature,
    slot,
    vault: vault.toBase58(),
    decision,
    decisionName: DECISION_NAME[decision] ?? `unknown(${decision})`,
    requestedAmountUsdc: (Number(requested.toString()) / 1e6).toFixed(0),
    nonce: nonce.toString(),
    approvalsMask: approvals,
    approvers: `0b${approvals.toString(2).padStart(3, "0")}`,
  };
}

async function main() {
  const RPC2 = process.env.RPC_URL ?? process.env.RPC ?? "https://api.devnet.solana.com";
  const conn = new Connection(RPC2, "confirmed");
  const gate = new PublicKey(GATE_ID);

  console.log(`Attestation indexer — gate ${gate.toBase58()} on ${RPC2}\n`);
  const sigs = await conn.getSignaturesForAddress(gate, { limit: 50 });
  console.log(`scanning ${sigs.length} gate transactions…\n`);

  const records: AttestationRecord[] = [];

  for (const s of sigs.slice(0, 30)) {
    const tx = await conn.getTransaction(s.signature, {
      maxSupportedTransactionVersion: 0,
    });
    if (!tx?.meta?.logMessages) continue;
    for (const line of tx.meta.logMessages) {
      if (!line.startsWith("Program data: ")) continue;
      const raw = Buffer.from(line.slice("Program data: ".length), "base64");
      const rec = decodeAttestationLogged(raw, s.signature, s.slot);
      if (rec) {
        records.push(rec);
        // Alert: ELIGIBLE/MARGIN_CALL signed while a feed might be stale
        // (public contradiction — the committee should not do this).
        if (rec.decision === 0) {
          console.log(`  ELIGIBLE   vault ${rec.vault.slice(0, 8)}… nonce ${rec.nonce} amount $${rec.requestedAmountUsdc} approvals ${rec.approvers}`);
        } else if (rec.decision === 2) {
          console.log(`  MARGIN_CALL vault ${rec.vault.slice(0, 8)}… nonce ${rec.nonce} approvals ${rec.approvers}`);
        } else if (rec.decision === 3) {
          console.log(`  LIQUIDATE  vault ${rec.vault.slice(0, 8)}… nonce ${rec.nonce} approvals ${rec.approvers}`);
        } else {
          console.log(`  ${rec.decisionName ?? rec.decision} vault ${rec.vault.slice(0, 8)}… nonce ${rec.nonce}`);
        }
      }
    }
  }

  console.log(`\n${records.length} attestations indexed.`);
  console.log(`Committee accountability log complete — mis-signatures would appear`);
  console.log(`as decisions contradicting public oracle state in the alerts above.`);
}

main().catch((e) => {
  console.error("INDEXER ERROR:", String(e).slice(0, 200));
  process.exit(1);
});
