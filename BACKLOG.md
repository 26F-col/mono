# BACKLOG

What we have built, what is in flight, and what is next — so anyone on the team
can pick up work without archaeology. Companion docs:
[README](README.md) · [IMPLEMENTATION_PLAN](IMPLEMENTATION_PLAN.md) ·
[docs/DEPENDENCIES.md](docs/DEPENDENCIES.md) ·
[docs/INGRESS_PRIVACY.md](docs/INGRESS_PRIVACY.md) ·
[risk/RISK_MODEL.md](risk/RISK_MODEL.md) ·
[risk/ADVANCED_MODEL.md](risk/ADVANCED_MODEL.md) ·
[risk/RISK_ENGINE_PLAN.md](risk/RISK_ENGINE_PLAN.md)

Legend: priority **P0** (blocks demo/launch) · **P1** (product-critical next) ·
**P2** (polish/hardening). Effort: S < 1d · M ≈ 1–3d · L ≈ 1–2w · XL > 2w.
Status: ✅ done · 🚧 in flight · 📋 ready to pick up · 🧊 blocked/deferred.

---

## ✅ SHIPPED (v2 — all tested, localnet verified, devnet v1 live)

### Programs (Anchor 0.31.1, Token-2022)
- [x] `confidential_vault` — deposit/withdraw custody (ATA per mint), hash-commitment
      portfolio snapshots with program-counted nonce, controller + recovery-authority
      keys, credit-layer withdrawal lock, `liquidate_custody` (gate-PDA authorized)
- [x] `credit_gate` — 2-of-3 attester quorum (Ed25519 via instructions sysvar),
      credit release, margin-status reporting, liquidation execution, repayment
      with auto-unlock, `AttestationLogged` transparency events
- [x] `mock_oracle` — per-symbol price feeds, market-session state, outage
      simulation control
- [x] Upgrade path proven on devnet (write-buffer resume + in-place upgrade)

### SDK (`sdk/`)
- [x] Simple risk engine (static haircuts) — demo narrative, kept for clarity
- [x] **Advanced risk engine** — confidence-interval pricing, EWMA vol (λ=0.94),
      shrinkage + PSD-repaired covariance, liquidation-horizon quantile advance
      rates, Meucci effective-bets concentration, deterministic scenario ladder
- [x] Attestation v2 (141B LIQUIDATE / 101B standard) + committee signature
      composition (digest-form for 2nd+ signers to fit tx size)
- [x] Per-auditor view keys (X25519/nacl.box envelopes)
- [x] Pyth Hermes oracle — real feed IDs + market-session from metadata;
      live prices gated behind licensed endpoint (public = "unauthorized", verified)
- [x] Resumable devnet smoke + privacy audit scripts; golden-vector generator

### App (`app/`)
- [x] Dual dashboards: Institution (private) vs Public/Lender (on-chain only)
- [x] Localnet + devnet modes (`?cluster=devnet`), live state polling with
      rate-limit-aware retries

### Quality
- [x] 30/30 tests: 8 brief success criteria, negative security paths (forged /
      impostor / replay / expired / quorum / withdrawal-lock), v2 enforcement
      (liquidation, unlock, recovery), advanced math incl. golden-vector
      regression (seed 42, `tests/fixtures/advanced-golden.json`)
- [x] Privacy audit script — 12/12 on localnet and devnet
- [x] CI workflow (`.github/workflows/ci.yml`) — build + test on GH runners
      (🚧 not yet verified on a real runner — see backlog)

### Docs
- [x] README (positioning, architecture, devnet IDs, limitations)
- [x] IMPLEMENTATION_PLAN.md, docs/DEPENDENCIES.md (verified, with sources)
- [x] docs/INGRESS_PRIVACY.md (why deposit privacy is open + real fix design)
- [x] risk/RISK_MODEL.md (demo model worked example),
      risk/ADVANCED_MODEL.md (v2 math spec),
      risk/RISK_ENGINE_PLAN.md (phased roadmap)

---

## 🚧 IN FLIGHT

- [ ] **P0 · M · Upgrade devnet to v2** 🧊 temporarily blocked: api.devnet is
      rate-limiting this IP on a long window. Run
      `./scripts/upgrade-devnet-resume.sh mock_oracle && … confidential_vault && … credit_gate`
      (resumable, safe to re-run), then `npx tsx scripts/devnet-smoke.ts` and
      `npx tsx scripts/privacy-audit.ts devnet` to refresh `devnet-state.json`.
      *DoD: all three programs at v2 (Data Size matches new binaries), smoke
      passes on devnet, dashboard devnet mode consistent.*

---

## 📋 BACKLOG — pick up from here

### P0 — before any external demo or judge review

- [ ] **Verify CI on a real GitHub runner** · M
      Workflow exists but was authored blind. DoD: green run on a push; fix
      toolchain versions (agave/avm) as needed. Consider caching
      `~/.cache/solana` + cargo registry.
- [ ] **Independent risk-engine service** · L
      Split the attester out of the institution process (today the demo
      committee signs in-process — honest but weak). Engine reads prices
      itself, re-derives decisions, enforces the custody cross-check, signs
      with keys the institution never holds. DoD: institution and engine run
      as separate processes/services end-to-end; existing tests adapted.
      See risk/RISK_ENGINE_PLAN.md phase 2.
- [ ] **Security review of v2** · M
      Fresh eyes on: quorum verification (instructions-sysvar parsing),
      liquidation authorization path, withdrawal-lock lifecycle, controller
      recovery. DoD: written review; any Critical/High fixed or documented.

### P1 — product-critical

- [ ] **Live Pyth prices into the advanced engine** · M
      `sdk/src/pyth.ts` resolves feed IDs + session; prices need a licensed
      Hermes base URL (`PYTH_HERMES_URL`). DoD: smoke runs the advanced engine
      on live equity prices; `confidence-interval pricing` verified against
      Pyth docs (TODO_VERIFY flag in code).
- [ ] **On-chain Pyth price updates** · L · `TODO_VERIFY`
      Post PriceUpdateV2 via pyth-solana-receiver so any party can re-verify
      prices on-chain. DoD: receiver integrated, devnet smoke reads on-chain
      price for at least one asset.
- [ ] **On-chain auditor registry** · M
      `AuditorPermission` account (brief §5): vault records authorized auditor
      pubkeys; disclosure events reference them. Complements the off-chain
      envelope flow in `sdk/src/auditor.ts`. DoD: grant/revoke/reveal flow
      tested.
- [ ] **Dashboard: advanced-risk + liquidation views** · M
      Surface the advanced engine (vols, contributions, scenario ladder) and
      LIQUIDATED status/seizure in the institution pane; show committee
      approvals in the lender pane. DoD: screenshots updated in README.
- [ ] **Multi-asset liquidation** · M
      Current LIQUIDATE seizes one designated asset per attestation. Extend to
      value-weighted seizure across custody assets until debt (+bonus) is
      covered. DoD: test with 2-asset seizure; attestation v3 layout if needed.
- [ ] **AttestationLogged indexer + alerting** · S/M
      Off-chain indexer over `AttestationLogged`/`MarginStatusChanged` events;
      alert when decisions contradict public oracle state. DoD: demo alert on
      a synthetic mis-signature.

### P2 — hardening / polish

- [ ] **Omnibus custody pool (ingress step 1)** · L
      Shared custody PDA so per-institution ATAs disappear (removes direct
      size attribution; see docs/INGRESS_PRIVACY.md option 1). DoD: deposits
      land in pool, vault accounting via credits, smoke updated.
- [ ] **Commitment/nullifier privacy pool (ingress step 2)** · XL
      The real ingress fix — design doc first (INGRESS_PRIVACY.md option 2),
      then circuit/note scheme. DoD: deposit invisible at pool level.
- [ ] **Policy versioning / regimes** · M
      Multiple live policies (conservative/standard), policy_id per regime,
      migration for existing vaults.
- [ ] **Interest accrual prototype** · M
      Facility-level accrual between events (block-time based), repay
      includes interest. Brief excluded it from the hackathon; needed for a
      real product.
- [ ] **CI: clippy + audit + coverage** · S
      `cargo clippy -- -D warnings`, `cargo audit`, coverage report for
      `sdk/src/risk*`.
- [ ] **Arcium MXE spike** · XL
      Encrypted holdings → MPC risk computation (Arcis constraints: fixed
      size, no Vec/loops). Feasibility note in docs/DEPENDENCIES.md. DoD:
      hello-world MXE decision consumed by credit_gate.
- [ ] **xStocks mainnet compatibility assessment** · M · `TODO_VERIFY`
      Real mint integration risks: permanent delegate, pause authority, US
      restrictions. DoD: written assessment + (if legal) devnet test with
      wrapped real mints.

---

## ⛔ EXPLICITLY OUT OF SCOPE (do not build)

- A lending market (liquidity curves, yield, lender shares) — CreditGate is
  intentionally minimal.
- A token, DAO, or governance beyond the single-key policy/upgrade authorities.
- Institutional KYC/compliance infrastructure.
- Production liquidation auctions (prototype seizure only).
- Claiming private ingress, real xStocks compatibility, Kamino integration,
  or audited cryptography — none of those exist; see README limitations.

---

## 🔑 OPERATIONAL NOTES

- Devnet program IDs + upgrade authority: see README "Devnet deployment".
- `scripts/upgrade-devnet-resume.sh` is safe to re-run; it resumes partial
  write-buffers after RPC 429 bursts.
- Deterministic demo keys are public (`demoKeypair`, seed version v2) — never
  reuse the pattern with real value.
- Golden vectors (`tests/fixtures/advanced-golden.json`) intentionally fail
  the suite if risk behavior changes — regenerate only with review:
  `npx tsx scripts/gen-golden-vectors.ts`.
