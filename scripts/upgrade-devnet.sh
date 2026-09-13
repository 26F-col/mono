#!/bin/bash
# Upgrade the three devnet programs to the freshly built binaries.
set -uo pipefail
cd "$(dirname "$0")/.."
RPC=${RPC:-https://api.devnet.solana.com}
WALLET=${HOME}/.config/solana/id.json

upgrade () {
  local name=$1
  local id
  id=$(solana-keygen pubkey "programs/$name/$name-keypair.json")
  echo "==> upgrading $name ($id)"
  for attempt in 1 2 3 4 5; do
    if solana program deploy "target/deploy/$name.so" \
        --program-id "$id" \
        --upgrade-authority "$WALLET" \
        --url "$RPC" --keypair "$WALLET" \
        --with-compute-unit-price 20000 \
        --skip-fee-check 2>&1 | grep -qE "Program Id:|$id"; then
      echo "    ✔ $name upgraded"
      return 0
    fi
    echo "    attempt $attempt failed — sleeping 150s (devnet rate limits)"
    sleep 150
  done
  echo "    ✖ $name upgrade failed"; return 1
}

upgrade mock_oracle || exit 1
upgrade confidential_vault || exit 1
upgrade credit_gate || exit 1
echo "ALL_UPGRADED"
