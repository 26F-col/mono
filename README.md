# Confidential Margin Layer

> **Confidential margin infrastructure for tokenized securities on Solana.** Institutions can lock a portfolio of tokenized equities, calculate collateral risk privately, and prove that a requested loan satisfies a lender's margin policy without publicly revealing the underlying portfolio.

**Problem.** Tokenized stocks made securities programmable, but financing them on public blockchains can expose institutional portfolios, leverage, and trading strategy.

**Solution.** A confidential collateral and risk layer that turns private tokenized-stock portfolios into verifiable borrowing decisions for existing onchain credit markets.

**Positioning.** We are not building another lending protocol. We are building the confidential risk layer that lending protocols can consume.

```
PRIVATE INGRESS          CONFIDENTIAL PORTFOLIO       PRIVATE RISK COMPUTATION
(commitment only)   →    (client-side encryption) →   (off-chain risk engine)
                                                            ↓
CREDIT CONSUMER          MARGIN / CREDIT PROOF
(CreditGate)        ←    (Ed25519-signed attestation)
```

---

## What the demo proves (brief §22)

One scripted run (`scripts/start-demo.sh`) proves:

1. an institution holds a multi-stock portfolio ($500k SPYx + $300k AAPLx + $200k NVDAx);
2. the portfolio is confidential within the implemented privacy model (on-chain: a hash commitment only);
3. the institution requests $300,000 test-USDC credit;
4. private/confidential risk logic evaluates the portfolio off-chain;
5. the lender learns **approve/reject** — not the portfolio;
6. CreditGate verifies the proof on-chain and releases credit;
7. a price/session shock (NVDA −30%, market close, oracle outage) changes the public margin status;
8. hidden portfolio details stay hidden per the confidentiality table below.

## Quick start

```bash
# 1. build programs (requires solana-cli 3.x + anchor 0.31.1)
anchor build            # avm use 0.31.1

# 2. start a fresh localnet, deploy, and run the narrative demo
./scripts/start-demo.sh

# 3. run the assertion suite (8 success criteria + negative paths)
anchor test

# 3b. privacy audit — proves the confidentiality claims hold (localnet + devnet)
npm run privacy-audit

# 4. dashboards (against the still-running validator)
cd app && npm install && npm run dev   # http://localhost:5173
#    devnet mode: http://localhost:5173/?cluster=devnet  (after devnet smoke)
```

## Devnet deployment

The three programs (v2) are deployed to Solana **devnet** at these addresses
(same keypairs as localnet, so IDs are identical across clusters):

| program | devnet ID |
|---|---|
| `mock_oracle` | `2fYvWaHejSYB1RNzsjrpQBMkmSNTXbYV9FWkRYXSj6Do` |
| `confidential_vault` | `F5vxqZkc4tL4RxMjapgA4LM1qL3mskKur4RY6pjeyy4L` |
| `credit_gate` | `6uLcY78dvjTYhwLzZUmridf5zUiEmmDHpLhidHezao3S` |

```bash
# deploy (needs ≥ ~5.5 SOL in ~/.config/solana/id.json for program rent)
bash scripts/deploy-devnet.sh

# full credit cycle on devnet: mints → deposit → commit → attested request →
# NVDA stress → margin-call report → recovery → repay (writes app/public/devnet-state.json)
npx tsx scripts/devnet-smoke.ts
```

The devnet deployment still uses clearly-labelled TEST mints created by the
smoke script (they are not real xStocks), and the same documented limitations
apply — devnet programs are unaudited prototype binaries.

Note: the program keypairs under `programs/*` are committed intentionally to
pin deterministic addresses. They are not secrets — the **upgrade authority**
is the deployer wallet, which is never in this repository.

## Architecture

```
programs/
  confidential_vault   Vault PDA custody (Token-2022), hash-commitment to the
                       portfolio snapshot, PUBLIC RiskPolicy account
  credit_gate          demo credit consumer: verifies the Ed25519 MarginAttestation
                       via the Ed25519 native program + instructions sysvar,
                       releases test-USDC, publishes margin status
  mock_oracle          deterministic PriceFeed accounts (price, market session,
                       staleness) behind the PriceOracle interface
sdk/                   TS risk engine, attestation builder/signer, PriceOracle
                       interface, deploy/seed helpers (browser-compatible)
app/                   dual dashboard: Institution (private) vs Public/Lender (on-chain)
tests/                 the 8 success criteria + negative security paths
docs/DEPENDENCIES.md   verified dependency record (brief §11/§20)
```

### The MarginAttestation (brief §14)

A 101-byte message, Ed25519-signed by the pinned risk-engine key:

```
magic "CML1" | vault (32) | commitment (32) | policy_id (8) |
requested_amount u64 | decision u8 | valid_until i64 | nonce u64
```

No private portfolio data by construction. The transaction ships
`[Ed25519Program verify][credit_gate.request_credit]`; the program reads the
pre-instruction back through the instructions sysvar and pins it to the attester
key + exact message (no transplant, no replay: `nonce` must equal the vault's
current portfolio-state version and strictly increase per facility).

### Risk model (transparent and deliberately simple, brief §7)

```
eligible_value = qty × price × advance_rate × session_factor × concentration_penalty
health factor  = Σ eligible_value / outstanding_credit

  HF ≥ 2.00  → new credit allowed, public status COMPLIANT
  1.50–2.00  → public status MARGIN_CALL ("additional collateral required")
  HF < 1.50  → public status INELIGIBLE
stale oracle → asset contributes ZERO (ineligible collateral)
```

Initial prototype parameters (public, stored in the `RiskPolicy` account —
DEMO ASSUMPTIONS, not production risk parameters):

| parameter | SPYx | AAPLx | NVDAx |
|---|---|---|---|
| advance rate | 80% | 70% | 60% |
| session factor (open / extended / closed) | 1.00 / 0.90 / 0.80 | | |
| concentration penalty | single asset >40% of NAV ⇒ ×0.75 | | |

Why market session matters: tokenized equities trade 24/7 while the underlying
market does not — borrowing capacity deliberately degrades outside regular US
market hours and when the oracle is stale. This is a core part of the demo.

## Privacy model (brief §15)

| Data | Public | Institution | Lender | Auditor |
|---|---|---|---|---|
| Exact holdings | NO | YES | NO* | YES* |
| Portfolio NAV | NO | YES | NO* | YES* |
| Health factor / weights | NO | YES | NO | OPTIONAL |
| Encrypted snapshot (client-side AES-GCM) | NO | YES | NO | YES* |
| Snapshot hash commitment | YES | YES | YES | YES |
| Requested credit | YES | YES | YES | YES |
| Policy used | YES | YES | YES | YES |
| Eligibility result | YES | YES | YES | YES |
| Margin status (compliant/call/ineligible) | YES | YES | YES | YES |

`*` = configurable/selective disclosure in future versions. The auditor flow
exists in the SDK: the institution holds the AES key + ciphertext, and the
ciphertext hash is the on-chain commitment — disclosing the key+blob lets an
auditor verify the commitment matches the chain.

## v2 hardening (all on-chain, all tested)

- **Attester quorum** — every margin decision needs K-of-3 risk-engine
  signatures (the demo runs 2-of-3). Impostor signatures don't count toward
  quorum; every consumed attestation is logged publicly (`AttestationLogged`)
  so the committee's behavior is auditable over time.
- **Withdrawal lock** — `credit_gate` freezes vault withdrawals at credit
  release and unfreezes on full repayment or liquidation. Institutions can no
  longer pull collateral while indebted.
- **Liquidation** — when the facility is publicly INELIGIBLE, a LIQUIDATE
  attestation authorizes `credit_gate` to seize the designated custody asset
  to the lender side (debt extinguished, facility marked LIQUIDATED).
- **Controller + recovery** — vault actions are signed by a rotatable
  controller key; a recovery authority can rotate it if the institution loses
  access (institution identity / vault PDA never changes).
- **Per-auditor view keys** — auditor disclosures are sealed per-auditor
  (X25519/nacl.box). Each auditor opens only their own envelope; envelopes
  verify against the on-chain commitment.
- **Pyth Hermes oracle (SDK)** — real feed IDs + real market-session state
  resolved from Pyth metadata; live prices require a licensed Hermes endpoint
  (public price updates now return "unauthorized" — verified).

## Prototype limitations (read before demoing)

1. **Ingress leak (the big one).** Collateral sits in vault-owned Token-2022
   token accounts whose balances are publicly readable. An observer can infer
   portfolio *size* from raw token balances. The tests assert this leak
   explicitly instead of hiding it. Production mitigation paths: Token-2022
   Confidential Balances (operator-held ElGamal keys), privacy pools, or
   Arcium MPC — see `docs/DEPENDENCIES.md`.
2. **Trusted attester.** The risk engine is a trusted Ed25519 signer in this
   prototype; it could sign a false result. The production roadmap replaces it
   with MPC (Arcium, live on mainnet) or ZK proofs.
3. **Self-reported commitment.** The on-chain program cannot verify the
   committed snapshot matches the deposited tokens. The demo attester
   cross-checks committed totals against public custody balances
   (`attesterCrossCheck`) as an honesty guard, not a proof.
4. **Test assets.** SPYx/AAPLx/NVDAx/USDC are our own clearly-labelled
   Token-2022 TEST mints. Production xStocks are real Token-2022 mints (SPYx
   `XsoCS1…DF2W`, AAPLx `XsbEhL…zJp`) with public balances, permanent-delegate
   and pause authorities — compatibility is NOT claimed or tested here.
5. **No private ingress.** We do not claim production xStocks deposits are
   private. "Helius privacy infrastructure" (mentioned in early notes) does not
   exist — verified; see `docs/DEPENDENCIES.md`.
6. **Withdrawals are not gated on facility health** in this prototype; a
   production system requires a repayment/release attestation flow.
7. **No liquidation engine.** The stress demo publishes a margin status; it
   does not seize collateral.
8. **Demo keys are public and deterministic.** Everything runs on localnet.
9. **CreditGate is not a lending market** — no interest curves, lender shares,
   yield, or insurance. It is the minimal proof that an external protocol
   (Kamino/Zodial/OTC desk — none integrated, none claimed) could consume our
   attestation.
10. **Identities/parameter tuning.** Advance rates, HF floors and penalties are
    demo numbers, chosen to make the stress ladder legible, not to model risk.

## Repo layout & scripts

```bash
anchor build                     # build programs + IDLs (anchor 0.31.1)
./scripts/start-demo.sh          # fresh localnet + deploy + narrative demo
anchor test                      # assertion suite (success criteria)
./scripts/sync-idl.sh            # copy IDLs into app/ (after anchor build)
yarn demo                        # re-run narrative demo against running validator
```

Note: `Cargo.lock` is committed. Fresh resolutions in 2026 pull crates that
require edition2024 / newer rustc than agave's platform-tools — the lock pins a
compatible set (see `docs/DEPENDENCIES.md`).

## The three-layer honesty split (brief §3)

| Layer | Status |
|---|---|
| Production architecture | vault + off-chain risk + signed attestations + CreditGate; interface-portable to real lenders |
| Privacy primitive available today | commitment-only on-chain state, off-chain encrypted records, decision-only lender view |
| Simulated / demo component | TEST mints, mock oracle, trusted attester, localnet |

Privacy is core to the thesis — but a truthful partially-confidential working
prototype beats a broken application pretending to have perfect privacy.

## Team: what's built, what's next

See [BACKLOG.md](BACKLOG.md) — shipped features, in-flight work, and the
prioritized backlog (P0/P1/P2) with definitions of done.

## License

MIT — see [LICENSE](LICENSE). Hackathon prototype: use at your own risk, expect no support.
