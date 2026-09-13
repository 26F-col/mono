#!/bin/bash
# Resume-style devnet program upgrade: keeps resuming the same write-buffer
# until complete, then upgrades the program in place.
set -uo pipefail
cd "$(dirname "$0")/.."
RPC=${RPC:-https://api.devnet.solana.com}
WALLET=${HOME}/.config/solana/id.json

upgrade () {
  local name=$1
  local so="target/deploy/$name.so"
  local id
  id=$(solana-keygen pubkey "programs/$name/$name-keypair.json")

  # Already up to date?
  local size
  size=$(stat -f%z "$so")
  local current
  current=$(solana program show "$id" --url "$RPC" 2>/dev/null | grep -oE "Data Size: [0-9]+" | grep -oE "[0-9]+" || echo 0)
  if [ "$current" = "$size" ]; then
    echo "    = $name already at v2 (data size $size)"; return 0
  fi

  local BUF=""
  for attempt in $(seq 1 20); do
    echo "    [$name] write-buffer attempt $attempt (buffer: ${BUF:-new})"
    local out
    if [ -n "$BUF" ]; then
      out=$(solana program write-buffer "$so" --buffer "$BUF" --url "$RPC" --keypair "$WALLET" --with-compute-unit-price 20000 2>&1)
    else
      out=$(solana program write-buffer "$so" --url "$RPC" --keypair "$WALLET" --with-compute-unit-price 20000 2>&1)
    fi
    BUF=$(echo "$out" | grep -oE "Buffer: [A-Za-z0-9]+" | head -1 | cut -d" " -f2)
    if echo "$out" | grep -q "Buffer $BUF.*created\|Buffer $BUF [A-Za-z0-9]*$"; then :; fi
    # success = the command exited 0 and printed the buffer id
    if [ -n "$BUF" ] && ! echo "$out" | grep -qE "Error|error"; then
      echo "    [$name] buffer complete: $BUF"
      break
    fi
    sleep 150
  done

  if [ -z "$BUF" ]; then echo "    ✖ $name buffer never completed"; return 1; fi

  for attempt in 1 2 3 4 5; do
    if solana program deploy "$so" --program-id "$id" --buffer "$BUF" \
        --upgrade-authority "$WALLET" --url "$RPC" --keypair "$WALLET" \
        --skip-fee-check 2>&1 | grep -qE "Program Id:|$id"; then
      echo "    ✔ $name upgraded"
      return 0
    fi
    echo "    [$name] deploy attempt $attempt failed — sleeping 90s"
    sleep 90
  done
  return 1
}

upgrade mock_oracle || exit 1
upgrade confidential_vault || exit 1
upgrade credit_gate || exit 1
echo "ALL_UPGRADED"
