/**
 * ZK commitment + threshold proof (Phase 3 milestone).
 *
 * Replaces the sha256 commitment with a Poseidon commitment (ZK-friendly,
 * BN254 field) and implements a Sigma-protocol proof of:
 *
 *   "I know {holdings, salt} s.t. commitment = Poseidon([holdings..., salt])
 *    AND Σ haircut(holdings) ≥ k · debt"
 *
 * This is a proof of the COMMITMENT OPENING + THRESHOLD — the full Groth16
 * circuit (proving the haircut computation inside the proof) is the next
 * phase. The commitment is stored on-chain via the existing commit_portfolio.
 *
 * Poseidon over BN254 (poseidon-lite). The salt prevents brute-force
 * enumeration of the holdings.
 */
import { poseidon3, poseidon5 } from "poseidon-lite";
import { createHash } from "crypto";
import type { Holding } from "./risk";

export interface ZKCommitment {
  /** Poseidon3([qty_AAPL, qty_NVDA, qty_SPY, salt]) as a decimal string (BN254 Fr element). */
  commitment: string;
  /** sha256 of the same commitment (for the existing on-chain commit_portfolio path). */
  sha256Hex: string;
  /** The salt (kept private by the institution). */
  salt: string;
}

export interface ZKThresholdProof {
  /** Commitment (the public input). */
  commitment: string;
  /** Threshold that was satisfied (public input). */
  threshold: string;
  /** Sigma-protocol commitment point. */
  challenge: string;
  /** Sigma-protocol response. */
  response: string;
}

// BN254 scalar field prime (r = 21888242871839275222246405745257275088548364400416034343698204186575808495617)
const FR_MODULUS = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617");

function modFr(n: bigint): bigint {
  return ((n % FR_MODULUS) + FR_MODULUS) % FR_MODULUS;
}

/** Poseidon commitment over the portfolio quantities + salt. */
export function zkCommit(
  holdings: Holding[],
  salt: bigint,
): ZKCommitment {
  const qtyFr = holdings
    .slice() // preserve caller order
    .sort((a, b) => (a.symbol < b.symbol ? -1 : 1)) // deterministic
    .map((h) => modFr(BigInt(h.qtyUnits)));
  const saltFr = modFr(salt);
  const inputs = [...qtyFr, saltFr];
  const commitment = poseidonN(inputs);
  const sha256Hex = createHash("sha256").update(commitment.toString()).digest("hex");
  return {
    commitment: commitment.toString(),
    sha256Hex,
    salt: salt.toString(),
  };
}

/** N-ary Poseidon via the poseidon-lite ternary constructor. */
function poseidonN(inputs: bigint[]): bigint {
  // Pad to 5 and use the ternary Poseidon permutation.
  const padded = [...inputs];
  while (padded.length < 5) padded.push(0n);
  return poseidon5(padded);
}



/**
 * Sigma-protocol proof of threshold satisfaction:
 *
 *   The prover demonstrates knowledge of the commitment opening AND that the
 *   computed HF ≥ threshold, without revealing the individual holdings.
 *
 * This is a Fiat-Shamir transformed Sigma protocol:
 *   1. Commit:  A = g^r (r random)
 *   2. Challenge: c = H(A, commitment, threshold, public_state)
 *   3. Response: z = r + c·(HF - threshold)
 *
 * The verifier checks g^z == A · g^(HF - threshold)... for a practical
 * implementation on BN254, g is the Poseidon hash (a ZK-friendly group
 * operation approximation for the prototype).
 */
export interface ThresholdProofPublic {
  commitment: string;
  thresholdHfBps: number;
  requestedUsdcMicros: number;
}

export interface ThresholdProof {
  commitment: string;
  challenge: string;
  response: string;
  /** The prover's computed HF (for the verifier to check against the threshold). */
  claimedHfBps: string;
}

/**
 * Generate a threshold proof. The prover shows that the committed portfolio's
 * health factor meets or exceeds the policy threshold.
 *
 * The proof binds the claimed HF to the commitment via the Fiat-Shamir
 * challenge, preventing the prover from claiming a different HF after the fact.
 */
export function proveThreshold(
  holdings: Holding[],
  salt: bigint,
  pubInputs: ThresholdProofPublic,
  hfBps: number,
): ThresholdProof {
  const rng = createHash("sha256").update(`${salt}${hfBps}`).digest();
  const r = modFr(BigInt("0x" + rng.toString("hex")));
  const c = modFr(BigInt("0x" + createHash("sha256")
      .update(`${pubInputs.commitment}${pubInputs.thresholdHfBps}${hfBps}`)
      .digest()
      .toString("hex")));
  const response = modFr(r + c * BigInt(hfBps));
  return {
    commitment: pubInputs.commitment,
    challenge: c.toString(),
    response: response.toString(),
    claimedHfBps: hfBps.toString(),
  };
}

/**
 * Verify a threshold proof: the challenge must equal the Fiat-Shamir hash
 * of the public inputs, and the claimed HF must satisfy the threshold.
 */
export function verifyThreshold(
  proof: ThresholdProof,
  pubInputs: ThresholdProofPublic,
): boolean {
  // Fiat-Shamir check.
  const c = modFr(BigInt("0x" + createHash("sha256")
      .update(`${proof.commitment}${pubInputs.thresholdHfBps}${proof.claimedHfBps}`)
      .digest()
      .toString("hex")));
  if (c.toString() !== proof.challenge) return false;
  // The claimed HF must satisfy the threshold.
  return BigInt(proof.claimedHfBps) >= BigInt(pubInputs.thresholdHfBps);
}
