#!/bin/bash
# Copy built IDLs into the app (run after `anchor build`).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p app/src/idl
cp target/idl/mock_oracle.json app/src/idl/
cp target/idl/confidential_vault.json app/src/idl/
cp target/idl/credit_gate.json app/src/idl/
echo "IDLs synced to app/src/idl/"
