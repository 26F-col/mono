#!/bin/bash
set -euo pipefail

# Compile Circom circuits to R1CS constraint system and WASM witness generator
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CIRCUITS_DIR="$(dirname "$SCRIPT_DIR")"

cd "$CIRCUITS_DIR"

mkdir -p build

echo "Compiling Circom circuits (WASM witness generation)..."
if command -v circom &> /dev/null; then
  circom src/margin_proof.circom --r1cs --wasm --sym -o build/ -l node_modules -l ../node_modules
  echo "Compilation complete. WASM witness generator and R1CS artifacts created in build/."
else
  echo "Error: circom compiler not found in PATH." >&2
  exit 1
fi

