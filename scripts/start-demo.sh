#!/bin/bash
# Start a fresh localnet with the three programs loaded at genesis, then run
# the narrative demo. The validator is left running for the dashboards.
set -euo pipefail
cd "$(dirname "$0")/.."

LEDGER=".demo-ledger"
RPC=http://127.0.0.1:8899
ORACLE_ID=$(solana-keygen pubkey programs/mock_oracle/mock_oracle-keypair.json)
VAULT_ID=$(solana-keygen pubkey programs/confidential_vault/confidential_vault-keypair.json)
GATE_ID=$(solana-keygen pubkey programs/credit_gate/credit_gate-keypair.json)

echo "==> Building programs (if needed)"
[ -f target/deploy/credit_gate.so ] || ~/.avm/bin/anchor-0.31.1 build 2>/dev/null || anchor build

echo "==> Starting fresh local validator (ledger: $LEDGER)"
pkill -f "solana-test-validator" 2>/dev/null || true
sleep 1
rm -rf "$LEDGER"
solana-test-validator --reset --ledger "$LEDGER" \
  --bpf-program "$ORACLE_ID" target/deploy/mock_oracle.so \
  --bpf-program "$VAULT_ID" target/deploy/confidential_vault.so \
  --bpf-program "$GATE_ID" target/deploy/credit_gate.so \
  > "$LEDGER.log" 2>&1 &
VALIDATOR_PID=$!
echo "    validator pid $VALIDATOR_PID (log: $LEDGER.log)"

for i in $(seq 1 60); do
  if curl -s -X POST -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "$RPC" | grep -q ok; then
    break
  fi
  sleep 0.5
done
echo "    RPC is up"

echo "==> Funding the demo wallet"
for i in 1 2 3 4; do solana airdrop 100 --url "$RPC" > /dev/null 2>&1 || true; done
solana balance --url "$RPC"

echo "==> Programs (loaded at genesis)"
echo "    mock_oracle        $ORACLE_ID"
echo "    confidential_vault $VAULT_ID"
echo "    credit_gate        $GATE_ID"

echo "==> Running the narrative demo"
npx tsx scripts/demo.ts
echo
echo "Validator left running (pid $VALIDATOR_PID) for the dashboards:"
echo "  cd app && npm install && npm run dev   ->  http://localhost:5173"
echo "Stop it later with:  kill $VALIDATOR_PID"
