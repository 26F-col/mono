# RISK_ENGINE_PLAN.md — staged plan for the risk engine

Current implementation: `sdk/src/risk.ts` (the ONLY risk engine), policy
parameters on-chain (`RiskPolicy` account), decision flow described in
`risk/RISK_MODEL.md`. Worked example with the demo numbers lives there too.

## Where the risk engine stands today (v2)

| Aspect | State |
|---|---|
| Where it runs | Off-chain, inside the institution's own process (SDK) |
| Model | Linear haircuts: advance rates × session factor × concentration penalty; stale oracle ⇒ ineligible; HF bands (≥2.0 eligible / 1.5–2.0 margin call / <1.5 ineligible) |
| Parameters | Public, on-chain (`RiskPolicy`), changeable by policy authority |
| Decision | Ed25519-signed attestation, 2-of-3 committee, verified by `credit_gate` |
| Honesty guard | Attester cross-checks committed holdings vs public custody balances |
| Known limits | Committee keys live in the same demo process (no separation); linear haircuts; no volatility/correlation; no confidence-interval pricing; Pyth live prices need a licensed endpoint |

## Phase 1 — harden the model (off-chain, no protocol changes)

**STATUS: IMPLEMENTED** in `sdk/src/risk-advanced.ts` (2026-09-13), with
formal spec in `risk/ADVANCED_MODEL.md`, golden-vector regression tests and a
deterministic report demo (`scripts/advanced-risk-demo.ts`). Client surface:
`ConfidentialMarginClient.evaluateRiskAdvancedPrivately`.

1. ✅ **Confidence-aware pricing** — collateral priced at `price − k·conf`.
2. ✅ **Volatility-scaled advance rates** — `AR = max(floor, static − z·σ_liq)`,
   σ from EWMA(λ=0.94), liquidation horizon scaled by session multiplier.
3. ✅ **Correlation-aware concentration** — Meucci effective number of bets
   (eigen-projection + entropy), haircut factor vs N_min = 2; hard 40%
   single-name cap retained as an overlay.
4. ✅ **Deterministic stress scenarios** — market + idiosyncratic shock
   ladder; worst scenario reported with per-scenario HF.
5. ✅ **Golden decision vectors** — `tests/fixtures/advanced-golden.json`
   (seeded history, seed 42) pins inputs → outputs; any behavior change fails
   the suite.
6. 🟡 **Live price path** — Pyth feed IDs + market session resolved from
   public metadata (verified live); price *updates* require a licensed Hermes
   endpoint (public updates return "unauthorized" — verified 2026-09-13).
   `PYTH_HERMES_URL` accepts a licensed base URL.

## Phase 2 — separate the risk engine (operational trust)

Today the "committee" is a stand-in inside the same demo process. The plan:

1. **Risk engine as an independent service**: institution submits the
   encrypted snapshot + public inputs; the engine reads prices itself,
   re-derives the decision, checks custody balances (the existing honesty
   guard), and signs. Keys move out of the institution's process.
2. **Auditable behavior**: `AttestationLogged` events (already on-chain) become
   the public record; a monitoring service flags decisions that contradict
   public oracle state (e.g., ELIGIBLE while feeds were stale).
3. **Slashing-style accountability (social)**: a mis-signing attester is
   rotated out via `set_attesters` and publicly attributable forever.

## Phase 3 — trust minimization (MPC / ZK)

**STATUS: Phase 3 STARTED** — `sdk/src/zk.ts` implements the Poseidon
commitment + Fiat-Shamir threshold proof (6/6 tests passing). The full
Groth16 circuit is the next build phase.

1. **Arcium MXE (preferred)**: institutions submit *encrypted* holdings; the
   margin computation (the same haircut math) runs inside MPC; output is a
   signed decision no single party could fake or inspect.
   Constraints (verified): Arcis forbids Vec/HashMap/loops — the haircut model
   is fixed-size arithmetic, which fits; decision output fits one callback.
2. **ZK alternative**: commitments over holdings (Poseidon), prove
   `Σ haircut(value) ≥ k·debt` in a ZK circuit; `credit_gate` verifies the
   proof instead of Ed25519 signatures. Bigger lift; removes the committee.
3. **Liquidation math moves on-chain/MPC** with the same privacy envelope.

The `MarginAttestation` interface (v2) is the stability contract — phases 2/3
replace *who computes and signs*, not what lenders consume.

## Phase 4 — production pricing plumbing

1. On-chain Pyth price updates via `pyth-solana-receiver` so any party can
   re-verify prices on-chain (TODO_VERIFY against current docs).
2. TWAP windows (e.g., 30-min) instead of spot to blunt short-window
   manipulation of the signed decisions.
3. Confidence intervals enforced on-chain for anything value-based.

## What does NOT change

- `credit_gate`'s consumption surface: attestation in → release/status/liquidation.
- The public data model: no portfolio data on chain, decisions and amounts public.
- The honesty posture: every limitation above is documented, never faked.
