#!/bin/bash
# Deploy the three programs to Solana DEVNET.
#
# Requires the deploy wallet (~/.config/solana/id.json) to hold at least
# ~5.5 SOL (program rent ≈ 2.3 + 1.9 + 1.3 SOL plus fees). Devnet faucet is
# rate-limited per IP — if `solana airdrop` fails, wait or use the web faucet
# at https://faucet.solana.com with the wallet pubkey printed below.
set -euo pipefail
cd "$(dirname "$0")/.."

RPC=${RPC:-https://api.devnet.solana.com}
WALLET=${HOME}/.config/solana/id.json

echo "==> Build (size-optimized)"
~/.avm/bin/anchor-0.31.1 build 2>/dev/null || anchor build

echo "==> Deployer wallet"
echo "    $(solana-keygen pubkey "$WALLET")"
solana balance --url "$RPC"

deploy () {
  local name=$1
  local kp="programs/$name/$name-keypair.json"
  local id
  id=$(solana-keygen pubkey "$kp")
  if solana program show "$id" --url "$RPC" > /dev/null 2>&1; then
    echo "    = $name already deployed: $id (skipping)"
    return 0
  fi
  echo "==> Deploying $name ($id)"
  for attempt in 1 2 3 4 5; do
    if solana program deploy "target/deploy/$name.so" \
        --program-id "$kp" \
        --url "$RPC" --keypair "$WALLET" \
        --with-compute-unit-price 20000 \
        --skip-fee-check; then
      echo "    ✔ $name deployed: $id"
      return 0
    fi
    echo "    attempt $attempt failed (rate limit?) — sleeping 45s"
    sleep 45
  done
  return 1
}

deploy mock_oracle
deploy confidential_vault
deploy credit_gate

echo "==> Done. Devnet program IDs:"
solana-keygen pubkey programs/mock_oracle/mock_oracle-keypair.json
solana-keygen pubkey programs/confidential_vault/confidential_vault-keypair.json
solana-keygen pubkey programs/credit_gate/credit_gate-keypair.json
