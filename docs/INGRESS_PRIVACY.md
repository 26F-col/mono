# INGRESS_PRIVACY.md — why deposit privacy is still open, and the real fix

Status: **OPEN** (documented gap, not solved in this prototype).
Owner: core. Priority: highest of the remaining gaps.

## The gap

When an institution deposits collateral, the transfer moves public Token-2022
balances from the institution's ATA into the vault's custody ATA. Any observer
can read those balances and infer the **size** of the institution's portfolio
at deposit time. Privacy begins only after ingress: everything the protocol
itself records (commitment, facility, status) is portfolio-free, and the risk
computation happens off-chain.

We deliberately did **not** ship a fake fix (mixing a few hops, random chunking,
or timing obfuscation). Those add friction and a false sense of security —
deterministic flow analysis undoes them, and the product brief forbids claiming
privacy guarantees stronger than the underlying primitive.

## What would actually close it

### Option A — Token-2022 Confidential Balances (CB)
- Convert custody ATAs to confidential balances; deposits land as ElGamal-
  encrypted amounts; transfers between confidential accounts are hidden.
- **Blockers for a rushed port:** the ElGamal/AES keys cannot live safely in a
  PDA — the official guidance is an off-chain operator holding keys and
  generating ZK proofs client-side (verified in the Confidential-Balances
  sample FAQ, docs/DEPENDENCIES.md). Losing the key = permanent loss of the
  balance. Needs an operator/keeper service, not just program changes.
- Real xStocks mints already carry `confidentialTransferMint` initialized
  (`autoApproveNewAccounts: false`, no auditor key) — compatible in principle.

### Option B — Commitment-based privacy pool (Tornado-style, application level)
- Institutions deposit into an omnibus pool against a **deposit commitment**
  (hash of secret nullifier + amount + salt). Withdrawals/attestations later
  reveal only the nullifier. Observers see pool totals, never per-institution
  flows.
- **Cost:** a nullifier circuit or a hash-based spendable-note scheme, plus a
  redesign of vault accounting (pool shares vs per-vault custody) and of the
  liquidation path (seizure must target a note, not an ATA).
- **Fit:** this is the architecture-compatible option — the attestation model
  already keeps quantities off-chain; the pool removes the last public link.

### Option C — Arcium MXE (encrypted computation)
- Deposits could remain public while *portfolio aggregation and risk* run
  inside MPC. Does not hide deposit flows by itself; pairs with A or B.

## Recommended sequence

1. Omnibus custody pool with plain transfers (removes the per-vault ATA, keeps
   deposit-linkage risk — half measure, ships in days).
2. Commitment/nulifier pool design (above) — the real fix, ~2–4 weeks.
3. CB integration once operator-key management is solved (research notes in
   docs/DEPENDENCIES.md).

Until then, every surface of this repo states the leak plainly: the privacy
audit asserts custody balances are public (check B), and the README marks
ingress as the top prototype limitation.
