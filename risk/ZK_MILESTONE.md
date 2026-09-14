# ZK MILESTONE — Poseidon commitment + threshold proof (design + first code)

Status: **prototype designed, off-chain proof library scoped** — the full
in-circuit proof is the next build phase.

## Goal

Replace the trusted-attester committee with a ZK proof that the institution's
(encrypted) portfolio satisfies the margin policy — without revealing the
portfolio:

```
proves: Σᵢ qtyᵢ · Pᵢ · ARᵢ · factorᵢ ≥ k · debt        (in ZK over committed holdings)
public: policy_id, debt_usdc, HF threshold k, holdings commitment
private: individual quantities, prices, confidence intervals
```

## Architecture

```
1. Institution computes holdings → Poseidon commitment C = H(poseidon, [qty, salt])
2. Institution registers C on-chain (existing commit_portfolio)
3. Institution generates a ZK proof π: "I know {qty, salt} s.t. C = commit(qty, salt)
   AND Σ haircut(qty, public_prices, policy) ≥ k · public_debt"
4. credit_gate verifies π on-chain (instead of the Ed25519 committee signature)
```

## Design decisions (verified against current ecosystems)

| decision | choice | why |
|---|---|---|
| Commitment hash | Poseidon (BN254) | ZK-friendly; proven in production (Light Protocol, AZTEC) |
| Proof system | Groth16 (ark-bn254) | Smallest proof + cheapest on-chain verify; mature Rust tooling (ark-groth16) |
| Circuit language | Arkworks (Rust) | Same language as the programs; no circom/TS toolchain split |
| On-chain verifier | Deploy a Groth16 verifier for the margin circuit | ~200k CU per verify (fixed); acceptable at current devnet CU limits |
| Confidence intervals | Public inputs (verified Pyth conf fields) | Conservative pricing at the policy level |

## Why not Arcium MPC (the other Phase-3 option)

Arcium MXE is a strong fit but the async callback model + Arcis constraints
(no Vec/loops) means the haircut computation needs a fixed-size unrolled
circuit — the same math as the ZK approach, with added network latency and a
dependency on Arcium's devnet MXE deployment. The ZK path is simpler to
prototype (single prover, no committee coordination).

## ZK-lite first milestone (implemented this session)

The **Poseidon commitment** and **threshold-comparison check** are built as a
Rust + TS pair — the commit/prove/verify lifecycle works end-to-end with the
hash preimage as the "witness". The full Groth16 circuit (proving the haircut
computation inside the proof) is the next build phase, documented below.

Files: `risk/zk/` — Poseidon-3 hash, commitment scheme, threshold check.
Tests: `tests/zk-milestone.ts` — commitment binding, threshold pass/fail.

## Full Groth16 circuit (next build phase)

The circuit encodes:
1. Poseidon preimage check: commitment = Poseidon([qty_i..., salt])
2. Haircut lookup: advance_rate_i = policy_table[asset_i] (fixed-size LUT)
3. Threshold comparison: Σ qty_i·Pᵢ·ARᵢ ≥ k·debt (range-constrained)

Constraint count estimate: ~5k–15k constraints for 3 assets (Poseidon = ~300
per hash × 4 hashes + lookup + comparison). Groth16 proving time: ~1–3s on
laptop hardware. Verification: ~350k CU on Solana (bn254 pairings via
precompile or a deployed verifier).

## Honest status

This is a **prototype-grade ZK integration** — the Poseidon hash and
commitment are implemented but the full Groth16 circuit is not yet wired.
The Ed25519 committee remains the production trust root until the circuit is
complete and audited. Documented as P0-ZK in BACKLOG.md.
