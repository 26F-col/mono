import { AnchorProvider } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";

import { ConfidentialMarginClient, demoKeypair } from "@sdk/client";
import { DEMO_PORTFOLIO, LOCALNET_URL } from "@sdk/config";
import type { TestMints } from "@sdk/client";

/**
 * Cluster switch: append ?cluster=devnet to the app URL to run against the
 * devnet deployment (scripts/devnet-smoke.ts must have been run once so
 * /devnet-state.json exists).
 */
const params = new URLSearchParams(window.location.search);
export const CLUSTER: "localnet" | "devnet" =
  params.get("cluster") === "devnet" ? "devnet" : "localnet";
// Devnet RPC: set VITE_DEVNET_RPC in app/.env.local (e.g. a Helius endpoint)
// to avoid api.devnet.solana.com's aggressive per-IP limits.
export const RPC_URL =
  CLUSTER === "devnet"
    ? (import.meta.env.VITE_DEVNET_RPC as string | undefined) ??
      "https://api.devnet.solana.com"
    : LOCALNET_URL;
const STATE_FILE = CLUSTER === "devnet" ? "/devnet-state.json" : "/demo-state.json";

import mockOracleIdl from "./idl/mock_oracle.json";
import confidentialVaultIdl from "./idl/confidential_vault.json";
import creditGateIdl from "./idl/credit_gate.json";

/** Minimal wallet for browser demos (anchor's Wallet class is node-only here). */
class KeypairWallet {
  constructor(public keypair: Keypair) {}
  get publicKey() {
    return this.keypair.publicKey;
  }
  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T) {
    const anyTx = tx as any;
    if (typeof anyTx.partialSign === "function") anyTx.partialSign(this.keypair);
    else if (typeof anyTx.sign === "function") anyTx.sign([this.keypair]);
    return tx;
  }
  async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]) {
    return txs.map((tx) => this.signTransaction(tx));
  }
}

/**
 * The app runs against the localnet state produced by scripts/start-demo.sh.
 * Demo keys are deterministic and PUBLIC — fine for a hackathon demo,
 * catastrophic in production (see README, prototype limitations).
 */
export const actors = {
  institution: demoKeypair("institution"),
  attester1: demoKeypair("attester-1"),
  attester2: demoKeypair("attester-2"),
  attester3: demoKeypair("attester-3"),
  oracle: demoKeypair("oracle-authority"),
  policyAuth: demoKeypair("policy-authority"),
  lender: demoKeypair("lender"),
};

export function makeClient(): ConfidentialMarginClient {
  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new AnchorProvider(
    connection,
    new KeypairWallet(actors.institution) as any,
    { commitment: "confirmed" },
  );
  return new ConfidentialMarginClient(provider, actors.oracle, {
    idls: {
      "mock-oracle": mockOracleIdl as any,
      "confidential-vault": confidentialVaultIdl as any,
      "credit-gate": creditGateIdl as any,
    },
  });
}

/**
 * Bind the TEST mints created by scripts/start-demo.sh (their addresses are
 * random per run, so the demo writes them to app/public/demo-state.json).
 */
export async function loadDemoState(client: ConfidentialMarginClient): Promise<boolean> {
  try {
    const res = await fetch(STATE_FILE);
    if (!res.ok) return false;
    const state = await res.json();
    const bySymbol = new Map<string, { mint: PublicKey; decimals: number; priceCents: number }>();
    for (const [sym, mint] of Object.entries(state.mints)) {
      if (sym === "usdc") continue;
      bySymbol.set(sym, { mint: new PublicKey(mint as string), decimals: 2, priceCents: 0 });
    }
    client.bindMints({ usdc: new PublicKey(state.mints.usdc), bySymbol });
    return true;
  } catch {
    return false;
  }
}

export { DEMO_PORTFOLIO };
