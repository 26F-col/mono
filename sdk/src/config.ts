import { Keypair, PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";

/** Program IDs (see programs/<name>/<name>-keypair.json). */
export const PROGRAM_IDS = {
  mockOracle: new PublicKey("2fYvWaHejSYB1RNzsjrpQBMkmSNTXbYV9FWkRYXSj6Do"),
  confidentialVault: new PublicKey("F5vxqZkc4tL4RxMjapgA4LM1qL3mskKur4RY6pjeyy4L"),
  creditGate: new PublicKey("6uLcY78dvjTYhwLzZUmridf5zUiEmmDHpLhidHezao3S"),
};

export const LOCALNET_URL = "http://127.0.0.1:8899";

export const DECISION = { ELIGIBLE: 0, INELIGIBLE: 1, MARGIN_CALL: 2, LIQUIDATE: 3 } as const;
export const STATUS = { COMPLIANT: 0, MARGIN_CALL: 1, INELIGIBLE: 2, REPAID: 3, LIQUIDATED: 4 } as const;
export const SESSION = { OPEN: 0, EXTENDED: 1, CLOSED: 2 } as const;

export const STATUS_NAME: Record<number, string> = {
  0: "COMPLIANT",
  1: "MARGIN_CALL — additional collateral required",
  2: "INELIGIBLE",
  3: "REPAID",
  4: "LIQUIDATED — collateral seized by credit layer",
};

export const DECISION_NAME: Record<number, string> = {
  0: "ELIGIBLE",
  1: "INELIGIBLE",
  2: "MARGIN_CALL",
};

/** Token-2022 test mints standing in for xStocks. NOT production xStocks. */
export interface TestAsset {
  symbol: string;
  decimals: number;
  /** USD cents per share at demo start. */
  initialPriceCents: number;
}

export const TEST_ASSETS: TestAsset[] = [
  { symbol: "SPYx", decimals: 2, initialPriceCents: 500_00 },
  { symbol: "AAPLx", decimals: 2, initialPriceCents: 200_00 },
  { symbol: "NVDAx", decimals: 2, initialPriceCents: 100_00 },
];

export const USDC_SYMBOL = "USDC";
export const USDC_DECIMALS = 6;

/** Anchor-style 8-byte symbol key for PDA seeds / feed accounts. */
export function symbolBytes(symbol: string): Buffer {
  const b = Buffer.alloc(8);
  Buffer.from(symbol, "ascii").copy(b);
  return b;
}

export const POLICY_ID = Buffer.from("INSTEQV1", "ascii");

/** Prototype risk parameters (brief §7). DEMO ASSUMPTIONS, not production. */
export const DEFAULT_POLICY = {
  session: { marketOpenBps: 10_000, extendedHoursBps: 9_000, marketClosedBps: 8_000 },
  concentration: { thresholdBps: 4_000, penaltyBps: 7_500 },
  creditHfBps: 20_000,
  ineligibleHfBps: 15_000,
  maxStalenessSlots: 4500,
};

/** Demo portfolio: $500k SPYx + $300k AAPLx + $200k NVDAx = $1,000,000 NAV. */
export const DEMO_PORTFOLIO = [
  { symbol: "SPYx", qtyUnits: 100_000 }, // 1,000 sh @ $500.00
  { symbol: "AAPLx", qtyUnits: 150_000 }, // 1,500 sh @ $200.00
  { symbol: "NVDAx", qtyUnits: 200_000 }, // 2,000 sh @ $100.00
];

/** $300,000 test-USDC credit request, in micro-units (6 decimals). */
export const DEMO_REQUEST_USDC_MICROS = 300_000_000_000;

export function usdcToMicros(usdc: number): number {
  return Math.round(usdc * 1_000_000);
}

// ---------------------------------------------------------------------------
// Deterministic demo actors (browser- and node-safe, NOT cryptographic)
// ---------------------------------------------------------------------------

/** Tiny FNV-style expansion for reproducible demo seeds. DEMO ONLY. */
export function seedFor(name: string): Uint8Array {
  const out = new Uint8Array(32);
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  for (let i = 0; i < 32; i++) {
    h = Math.imul(h ^ (i + 1), 0x27d4eb2d);
    h ^= h >>> 15;
    out[i] = h & 0xff;
  }
  return out;
}

/**
 * Actor seed version: bumped when the on-chain layout changed (v2 = quorum
 * gate + withdrawal lock + liquidation + recovery), so fresh state is used.
 */
export const ACTOR_SEED_VERSION = "v2";

/** Deterministic demo actors (so reruns are reproducible). DEMO ONLY. */
export function demoKeypair(name: string): Keypair {
  return Keypair.fromSeed(seedFor(`${name}:${ACTOR_SEED_VERSION}`));
}
