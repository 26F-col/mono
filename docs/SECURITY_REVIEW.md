# SECURITY_REVIEW.md — v2 self-review (pre-judging)

Scope: the three programs as deployed on devnet (see README devnet IDs) plus
the SDK risk engine. Reviewed by the build team — **not** a substitute for an
external audit. Each finding is classified: Fixed / Accepted (documented
prototype limitation) / Open (needs work).

---

## Findings

### F1 — Instruction-sysvar quorum verification (credit_gate)
**Class:** Fixed (design verified against agave loader-v1 source)
The quorum scan reads ALL instructions in the transaction (not just the
preceding one), matching every Ed25519Program ix whose pubkey ∈ attesters
and whose embedded message == the expected attestation message. The native
Ed25519 program has already validated each signature. Pinning to the
committee set + exact message prevents transplant and cross-vault replay.
**Residual:** a committee member could sign two conflicting messages at the
same nonce — mitigated by requiring nonce == vault.commitment_nonce (strictly
monotonic per draw) and the 2-of-3 quorum.

### F2 — Withdrawal lock lifecycle (confidential_vault + credit_gate)
**Class:** Fixed
set_withdrawal_gate is only callable by the gate PDA (CPI). It is set on
credit release and cleared on (a) full repayment or (b) debt extinguished by
liquidation. Controller rotation is blocked while locked.
**Residual:** the lock is binary — no partial unlocks for over-collateralized
positions.

### F3 — Liquidation debt-offset (credit_gate)
**Class:** Fixed (semantics)
The LIQUIDATE attestation's requested_amount_usdc carries the USDC debt
offset; outstanding is reduced via checked subtraction; the unlock fires only
when outstanding reaches zero. Multi-asset seizures chain until extinguished.
**Residual:** the offset value comes from the risk engine (trusted); a
production system would price the seizure on-chain or via an auction.

### F4 — Vault seed versioning
**Class:** Fixed
Vault PDA seeds include b"v2" to prevent layout-mismatch accounts from the
v1→v2 transition. Old PDAs become orphaned (harmless).

### F5 — Attester committee trust
**Class:** Accepted (documented)
The committee is NOT trustless. A colluding majority can sign false
decisions. Mitigations: public AttestationLogged audit trail, 2-of-3 quorum,
custody cross-check in the smoke/SDK. Roadmap: Arcium MPC or ZK proof of
threshold satisfaction.

### F6 — Commitment is self-reported
**Class:** Accepted (documented)
The controller registers sha256(encrypted blob) — the program cannot verify
the blob matches the deposits. The attester's custody cross-check catches
naive mismatches; a determined attacker can still commit a lie about
composition (though the deposits bound the total size). Production: ZK proof
of deposit-consistency.

### F7 — Ingress leak
**Class:** Accepted (documented)
Custody balances are publicly readable. Private ingress (Confidential
Balances / commitment pool) is roadmap. See docs/INGRESS_PRIVACY.md.

### F8 — PDA seed versioning
**Class:** Fixed
Vault/feed seeds include b"v2" to prevent layout-mismatch accounts from the
v1→v2 transition. Old PDAs become orphaned (harmless).

### F9 — Token-2022 ATA constraints
**Class:** Fixed
All ATA constraints carry explicit `associated_token::token_program` —
required for Token-2022 (classic ATA derivation produces a different address).

### F10 — Deposit shortfall rounding
**Class:** Accepted
Deposit shortfall = committed − current custody. A 429-failed deposit leaves
partial custody; the resumable smoke tops up on re-run.

### F11 — Oracle authority key management
**Class:** Accepted (prototype)
The oracle authority is a deterministic test key (seedFor). Production: a
dedicated oracle operator keypair or a decentralized oracle network.

---

## Recommendations (pre-mainnet, if ever)

1. External audit of credit_gate (quorum, liquidation, replay).
2. Formal spec of the attestation message (currently 141B, layout documented
   in credit_gate lib.rs).
3. Rate-limit-aware deployment tooling (the write-buffer 429s during this
   session's devnet upgrade cost significant time — the resumable script
   mitigates but doesn't eliminate the issue).
4. Migration path for on-chain account layouts (b"v2"-style seed versioning
   or an explicit close/reopen flow).
