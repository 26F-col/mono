# IMPLEMENTATION_PLAN.md

Confidential Portfolio Margin Layer for Tokenized Stocks on Solana — hackathon prototype plan.

> Positioning: **Confidential margin infrastructure for tokenized securities on Solana.** Institutions can lock a portfolio of tokenized equities, calculate collateral risk privately, and prove that a requested loan satisfies a lender's margin policy without publicly revealing the underlying portfolio. We are **not** building another lending protocol; we are building the confidential risk layer that lending protocols can consume.

---

## 1. Current repo assessment

- The repository did not exist before this plan; it is being created fresh as `confidential-margin/`.
- No legacy code, no existing programs, no existing tests. Greenfield build.
- Local toolchain (verified installed):
  - `solana-cli 3.0.15` (Agave line; provides `cargo-build-sbf`, `solana-test-validator`)
  - `anchor-cli 0.30.1`, `avm 0.31.1`
  - `cargo 1.93.1` / `rustc 1.93.1`
  - `node v25.8.0`, `yarn 1.22.22`

## 2. Chosen privacy approach

### The three-layer honesty split (per product brief §3)

| Layer | Status in this prototype |
|---|---|
| Production architecture | Confidential vault + off-chain risk computation + signed margin attestations + CreditGate consumer; portable to Kamino-style lenders. Roadmap to MPC/ZK risk computation. |
| Privacy primitive available today | Portfolio **composition is never published by our protocol state**: on-chain we store only a hash commitment to the (encrypted) portfolio snapshot. Risk is computed off-chain by an authorized risk engine that signs the decision. Lender verifies an Ed25519-signed attestation on-chain and learns only: requested amount, eligible true/false, policy id, collateral-locked flag, margin status. |
| Simulated / demo component | (a) **Test Token-2022 mints** for SPYx/AAPLx/NVDAx/USDC (clearly labelled, not production xStocks). (b) **Mock oracle** behind a `PriceOracle` interface (deterministic prices, market-session flag). (c) **Trusted-attester model** stands in for MPC/ZK confidential computation. |

### What is actually private vs not (be precise)

- **Private by construction (protocol never publishes):** exact portfolio quantities are not stored on-chain in plaintext anywhere in our program state — only `sha256(portfolio_blob ‖ nonce)`; risk metrics (NAV, weights, health factor) stay off-chain; the lender-visible decision is a boolean + amount + policy id.
- **Known, documented leak (ingress):** collateral tokens are locked in vault-owned Token-2022 token accounts; **token account balances are publicly readable on Solana**. An observer can infer portfolio size from raw token balances. The product brief explicitly anticipates this: private ingress (privacy pools / Token-2022 Confidential Balances / Arcium) is a roadmap item, not faked here. Our mitigation in this prototype: the vault is designed so protocol-level state and lender-facing surfaces expose zero portfolio data, and the README documents the raw-balance leak explicitly.
- **Trust model:** the risk engine ("attester") is a trusted party in this prototype — it signs eligibility results with an Ed25519 key that `CreditGate` pins. This is an honest, working stand-in for Arcium-MPC / ZK computation, which is the production roadmap. The lender trusts the attester, not the borrower.

### Why a signed attestation instead of on-chain risk math

On-chain risk math over plaintext portfolio state would publish the portfolio (account data is public). Off-chain computation + on-chain signature verification keeps quantities off-chain and gives the lender a machine-verifiable answer ("can this vault support $Y under policy X → true/false"). This directly implements the brief's `MarginAttestation` abstraction (§14) and keeps the interface portable to future proof systems.

## 3. Verified dependencies

Verification performed per brief §20 (read docs → verify package names → verify network support → record limitations). See `docs/DEPENDENCIES.md` for the full table produced during this build. Summary at plan-writing time (updated as verification lands):

- **Anchor 0.31.1** (upgraded from 0.30.1 during the build — 0.30's IDL extraction is broken on 2026 toolchains because `anchor-syn` calls the removed `proc-macro2::Span::source_file`; 0.31.1 removed that dependency). Building against agave `cargo-build-sbf`. `@coral-xyz/anchor` npm package pinned to ^0.31.1.
- **Token-2022 (`spl-token-2022`)** via `anchor-spl::token_interface` — used for all test mints and vault custody. Core transfers: verified mainstream; extension usage kept to standard token accounts in v1.
- **Token-2022 Confidential Balances** — **not coded against in v1**; documented as the production private-ingress path with crate/SDK names recorded in `docs/DEPENDENCIES.md` (verification by research task).
- **Ed25519 native program + instructions sysvar** — used for on-chain attestation verification. Pattern: transaction includes an `Ed25519Program` instruction; `credit_gate` reads it back via `solana_program::sysvar::instructions`, checks the embedded pubkey/message offsets. Canonical example referenced in `docs/DEPENDENCIES.md`.
- **Pyth** — not integrated in v1; `PriceOracle` interface isolates it. `TODO_VERIFY` recorded.
- **Arcium / Helius** — researched for the roadmap section only; nothing coded against them.

`TODO_VERIFY` markers in code/docs flag anything not personally verified at implementation time.

## 4. Architecture

```text
/repo
  programs/
    confidential_vault/   # Vault PDA, collateral custody (Token-2022), portfolio
                          # commitment (hash only), RiskPolicy account
    credit_gate/          # demo credit consumer: verify MarginAttestation
                          # (Ed25519, native program + instructions sysvar),
                          # release test-USDC, publish margin status
    mock_oracle/          # deterministic PriceFeed accounts behind the
                          # PriceOracle interface (prices + market session)
  risk/                   # policy definition + valuation reference notes/tests
  sdk/                    # TS: risk engine (TS impl), attestation builder/signer,
                          # PriceOracle interface, deploy/seed helpers
  app/                    # dual dashboard UI: Institution vs Public/Lender
  tests/                  # end-to-end tests = the 8 success criteria
  scripts/                # demo driver (the scripted demo of brief §9)
```

### On-chain accounts

```text
RiskPolicy (confidential_vault)
  policy_id: [u8;8]                  // e.g. b"INSTEQV1"
  advance_rate_bps per asset mint    // SPYx 8000, AAPLx 7000, NVDAx 6000
  session_factor_bps                 // open 10000, extended 9000, closed 8000
  concentration_threshold_bps 4000   // single-asset weight cap
  concentration_penalty_bps 7500     // applied to assets over the cap
  max_oracle_staleness_slots
  policy_authority                   // can update parameters (prototype)

Vault (confidential_vault, PDA seeds ["vault", institution])
  institution, bump
  policy: Pubkey
  collateral_locked: bool
  commitment: [u8;32]                // sha256(encrypted portfolio blob ‖ nonce)
  commitment_nonce: u64
  deposited_mints + custody ATAs     // token balances (leak documented above)
  opened facilities count / last attestation slot (public metadata only)

PriceFeed (mock_oracle, PDA seeds ["price", symbol])
  symbol, price (u64, cents), publish_slot, market_session enum,
  staleness window; set by oracle authority

CreditGate (credit_gate, PDA seeds ["gate"])
  attester: Pubkey                   // Ed25519 risk-engine key (trusted in prototype)
  usdc_mint, treasury ATA, policy allow-list ref
CreditFacility (PDA seeds ["facility", gate, vault])
  outstanding, opened_at, margin_status, last_nonce (replay protection)
```

### MarginAttestation (signed message, off-chain data)

```text
magic | vault pubkey | commitment[32] | policy_id[8] |
requested_amount_usdc (u64) | decision: Eligible | Ineligible | MarginCall |
valid_until (unix ts) | nonce (u64)
```

No private portfolio data is included (brief §14). `credit_gate::request_credit` verifies: Ed25519 sig from pinned attester, vault exists + `collateral_locked`, `commitment` matches vault's current commitment (binds attestation to the locked state, prevents cross-vault replay), `policy_id` matches, `clock < valid_until`, `nonce` unused (monotonic per facility), `decision == Eligible`, then transfers test-USDC and emits `CreditReleased { vault, amount }` — amount public, portfolio not.

`report_margin_status` accepts `Ineligible`/`MarginCall` attestations to flip public facility status and emit `MarginStatusChanged { vault, status }` — the public learns "additional collateral required", not why.

### Risk engine (TS in `/sdk`, policy params on-chain)

```text
eligible_value_usd_cents =
    qty * price_cents / 100
      × advance_rate_bps/1e4
      × session_factor_bps/1e4
      × concentration_penalty_bps/1e4   // only for assets whose weight > threshold
eligible = Σ eligible_value ≥ requested_credit × margin_requirement_bps
stale oracle (now - publish_slot > window) ⇒ asset ineligible
health factor = Σ eligible_value / requested_value   (private)
```

These are prototype assumptions, not production risk parameters; all live in the `RiskPolicy` account.

## 5. Unresolved technical risks

1. **Ingress leak** (vault token balances readable). Mitigation: documented; roadmap = Token-2022 Confidential Balances / privacy pool / Arcium. We will not claim private ingress.
2. **Trusted attester** — the lender must trust the risk-engine signer in v1. Roadmap: MPC (Arcium) or ZK. Documented, not hidden.
3. **anchor-lang ↔ agave 3.0.x toolchain** — resolved: anchor 0.31.1 + a pinned Cargo.lock (fresh crates.io resolution in 2026 pulls edition2024 crates that platform-tools' cargo 1.84 cannot parse; see `docs/DEPENDENCIES.md` for the exact pin list).
4. **Ed25519 instructions-sysvar parsing** — byte-offset parsing is fiddly; covered by a dedicated on-chain test with a forged-signature case.
5. **Commitment is self-reported** — the on-chain program cannot verify the committed blob matches deposited tokens. The attester cross-checks portfolio totals against public custody balances in the demo; fraud-resistant binding is a known limitation (documented).

## 6. Exact implementation order (brief §19 priority)

1. Scaffold workspace; **fail-fast `anchor build`** on minimal programs.
2. `mock_oracle`: PriceFeed init / set_price / set_session.
3. `confidential_vault`: RiskPolicy init, Vault init, `deposit_collateral` (Token-2022 CPI + commitment registration), `update_commitment`.
4. TS SDK: seed mints (SPYx/AAPLx/NVDAx/test-USDC, clearly labelled TEST), risk engine, attestation signer.
5. `credit_gate`: gate init, `request_credit` (Ed25519 verify + release), `report_margin_status`.
6. Integration tests = the 8 success criteria (brief §22), including the forged-attestation negative test.
7. Stress scenario driver: NVDA −30% and OPEN→CLOSED; assert public margin warning without portfolio exposure.
8. App: two dashboards side by side (Institution sees everything; Public/Lender sees only the §9 fields), explicit TEST-ASSET badges.
9. README (positioning §21, confidentiality table §15, prototype limitations §16) + `docs/DEPENDENCIES.md`.
10. Polish (stretch goals only after the core demo works).

## 7. Definition of done

The scripted demo (brief §9) passes end-to-end on localnet:
seed $1M portfolio → request $300k → `APPROVED` publicly with holdings/NAV CONFIDENTIAL → NVDA −30% or market closes → `MARGIN STATUS CHANGED / additional collateral required` publicly → portfolio details still never appear in public/lender-facing state, per the confidentiality table.
