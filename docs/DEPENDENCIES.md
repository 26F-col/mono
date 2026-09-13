# DEPENDENCIES.md — verified dependency record (brief §11, §20)

Every external protocol/dependency was verified against primary sources before or during
implementation. `UNVERIFIED` means exactly that — no code was written against it.
Research date: 2026-09-12.

---

```
DEPENDENCY: Token-2022 Confidential Transfer / Confidential Balances
CAPABILITY WE NEED: encrypted balances/transfers for collateral custody accounts (private ingress)
VERIFIED SUPPORTED: YES (protocol live on mainnet; confidentialTransferMint extension initialized
  on the real SPYx/AAPLx mints) — program/PDA-controlled flow PARTIAL
SOURCE / DOC LINK: https://solana.com/docs/tokens/extensions/confidential-transfer ;
  https://github.com/solana-foundation/Confidential-Balances-Sample (docs/FAQ.md) ;
  https://github.com/solana-program/token-2022
LIMITATION: ElGamal/AES keys + ZK proofs are client-side by design; PDAs are only "partially"
  supported (an off-chain operator must hold keys and generate proofs; FAQ: losing the ElGamal
  secret key = permanent loss of the confidential balance). Crate `spl-elgamal` does NOT exist —
  ElGamal primitives live in `solana-zk-sdk`. JS support is `@solana-program/token-2022`
  (npm `@solana/spl-token-2022` does not exist). Version skew gotcha: proof crates vs zk-sdk.
FALLBACK (chosen for this prototype): public custody balances + off-chain encryption; the
  ingress leak is documented, never claimed private. Roadmap: operator-held ElGamal keys or Arcium.
```

```
DEPENDENCY: Anchor
CAPABILITY WE NEED: program framework compatible with the installed agave toolchain
VERIFIED SUPPORTED: YES — final choice: anchor 0.31.1 (avm) + @coral-xyz/anchor ^0.31.1
SOURCE / DOC LINK: https://github.com/otter-sec/anchor (releases); https://crates.io/crates/anchor-lang
LIMITATION / MIGRATION NOTES: stable line is 1.2.0 (2026-09-04, repo moved to otter-sec/anchor);
  2.0.0-rc is pre-release; anchor 0.31.1 pins solana-program ^2; the first Anchor line against the
  solana-* 3.x crates is 1.0.0 (2026-04). We started on 0.30.1 and migrated because 0.30's IDL
  extraction is broken on modern toolchains (anchor-syn calls proc-macro2::Span::source_file, removed
  from proc-macro2 in 2025, and requires RUSTFLAGS="--cfg procmacro2_semver_exempt" + a nightly-
  capable rustc — impossible under agave's platform-tools). 0.31.1 removed that dependency entirely.
  Other 0.30→0.31 migrations hit here: `init_if_needed` now needs the anchor-lang
  "init-if-needed" cargo feature; sysvar::instructions helpers became private in solana-program 2.x
  (use `get_instruction_relative(-1, &account_info)`); ATA constraints need explicit
  `associated_token::token_program` for Token-2022; cross-program PDA seeds need
  `seeds::program = <program_id>`.
  Cargo.lock drift note: fresh resolution in 2026 pulls crates using edition2024 / rustc ≥1.85,
  which platform-tools v1.51's cargo 1.84 cannot parse or compile. Committed lock pins:
  borsh 1.5.5, proc-macro-crate 3.2.0, blake3 1.5.5, constant_time_eq 0.3.1, hashbrown 0.15.5,
  indexmap 2.10.0, jobserver 0.1.32, unicode-segmentation 1.12.0, zeroize 1.8.1,
  zeroize_derive 1.4.2, serde 1.0.210, serde_json 1.0.133, serde_bytes 0.11.14, bitflags 2.6.0,
  bytemuck 1.18.0, bytemuck_derive 1.9.3, darling 0.20.11, serde_with 3.12.0, wasm-bindgen 0.2.99,
  js-sys 0.3.76 (direct exact pins in the program manifests), syn 2.0.90, proc-macro2 1.0.86.
FALLBACK: none needed.
```

```
DEPENDENCY: Ed25519 native program + instructions sysvar (on-chain attestation verification)
CAPABILITY WE NEED: program verifies an off-chain risk engine's signature over the margin decision
VERIFIED SUPPORTED: YES (mechanism documented; precompile live on mainnet)
SOURCE / DOC LINK: https://docs.rs/crate/solana-ed25519-program/latest/source/ed25519-program/src/lib.rs ;
  https://docs.rs/crate/solana-instructions-sysvar/latest ;
  https://github.com/anza-xyz/agave/blob/master/programs/ed25519-tests/tests/process_transaction.rs
LIMITATION: the once-canonical solana-developers/program-examples "ed25519" example was removed in a
  repo reorg; on solana-program 3.x `load_instruction_at` is dev-context-only (this prototype pins
  solana-program 1.18 via anchor 0.30.1, where the on-chain path is fine). Instruction data layout:
  [num_signatures u8][pad u8][14-byte offsets][sig 64][pubkey 32][message].
FALLBACK: none needed; forged/replayed attestations covered by negative tests.
```

```
DEPENDENCY: Arcium (MXE / MPC encrypted computation)
CAPABILITY WE NEED: confidential portfolio risk computation (production form of our "attester")
VERIFIED SUPPORTED: YES (live on Solana mainnet; documented SDKs) — but NOT used in this prototype
SOURCE / DOC LINK: https://docs.arcium.com/
LIMITATION: Arcis DSL forbids Vec/String/HashMap/while/loop (fixed-size circuits only); async
  callback model; callback output must fit one transaction (~1,232 bytes); a full margin engine
  in Arcis inside a hackathon week is high risk.
FALLBACK (chosen): trusted Ed25519 attester stands in for MPC — documented in README as the
  prototype's trust root.
```

```
DEPENDENCY: Helius
CAPABILITY WE NEED: "Helius privacy infrastructure" (claimed in the original brief)
VERIFIED SUPPORTED: NO — DOES NOT EXIST as a privacy product. Helius is RPC/streaming/dispatch infra.
SOURCE / DOC LINK: https://www.helius.dev/
LIMITATION: the brief's mention of "Helius privacy infrastructure" is a misconception; Arcium's own
  docs reference Helius merely as an RPC provider.
FALLBACK: n/a — nothing to integrate.
```

```
DEPENDENCY: Pyth (equity price feeds)
CAPABILITY WE NEED: real SPY/AAPL/NVDA prices marking the collateral
VERIFIED SUPPORTED: YES (mainnet Equity.US.AAPL/USD, Equity.US.SPY/USD, NVDA equity feeds exist;
  pyth-solana-receiver program deployed+executable on mainnet and devnet) — NOT integrated here
SOURCE / DOC LINK: https://docs.pyth.network/price-feeds/use-real-time-data/solana ;
  https://hermes.pyth.network/v2/price_feeds?query=AAPL
LIMITATION: hermes.pyth.network requires an API key since 2026-08-26 (public alt endpoint:
  pyth.dourolabs.app/hermes); docs list Anchor compatibility through 0.31.1 only (Anchor 1.x pairing
  untested); devnet price availability UNVERIFIED from this environment. npm package is
  `@pythnetwork/pyth-solana-receiver` (not "...-receiver-sdk").
FALLBACK (chosen): MockOracleClient behind the PriceOracle interface (sdk/src/oracle.ts).
```

```
DEPENDENCY: xStocks (Backed tokenized stocks)
CAPABILITY WE NEED: tokenized equities as collateral
VERIFIED SUPPORTED: YES (real mints verified on mainnet: SPYx XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W,
  AAPLx XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp; owner = Token-2022, 8 decimals) — NOT used here;
  we mint clearly-labelled TEST tokens instead
SOURCE / DOC LINK: https://xstocks.com/ ; https://docs.xstocks.fi/
LIMITATION: mints carry permanentDelegate + pausableConfig + freeze authority (issuer can seize/pause
  collateral — material risk for any margin protocol); balances are PUBLIC via standard token accounts
  (the confidentialTransferMint extension is initialized but not enforced); US-person distribution
  restrictions.
FALLBACK (chosen): test Token-2022 mints under our control, labelled TEST everywhere in the UI.
```

```
DEPENDENCY: Kamino Finance (klend)
CAPABILITY WE NEED: future external credit consumer for MarginAttestations
VERIFIED SUPPORTED: YES (permissionless deposits via @kamino-finance/klend-sdk 12.0.0,
  KaminoAction.buildDepositTxns) — NOT integrated; do not claim otherwise
SOURCE / DOC LINK: https://github.com/Kamino-Finance/klend-sdk
LIMITATION: whether xStocks reserves exist in Kamino markets is UNVERIFIED; old
  `kamino-lending-sdk` name is dead.
FALLBACK: CreditGate demonstrates the consumer interface (brief §13); Klino/Zodial integrations
  are roadmap items only.
```
