/**
 * Generates tests/fixtures/advanced-golden.json — the golden vector pinning
 * advanced-engine behavior. Deterministic: seeded mulberry32 + Box-Muller.
 * Run: npx tsx scripts/gen-golden-vectors.ts
 */
import * as fs from "fs";
import * as path from "path";
import { evaluateRiskAdvanced, DEFAULT_ADVANCED_POLICY, AlignedReturns, Scenario } from "../sdk/src/risk-advanced";

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYMBOLS = ["AAPLx", "NVDAx", "SPYx"]; // sorted order
const BETAS: Record<string, number> = { AAPLx: 1.1, NVDAx: 1.6, SPYx: 1.0 };
const IDIO_VOL: Record<string, number> = { AAPLx: 0.012, NVDAx: 0.022, SPYx: 0.006 };
const DAYS = 120;

function main() {
  const rng = mulberry32(42);
  const rows: number[][] = [];
  for (let t = 0; t < DAYS; t++) {
    const market = 0.0004 * (rng() * 2 - 1) * 4; // factor return
    const row = SYMBOLS.map((s) => BETAS[s] * market + IDIO_VOL[s] * (rng() * 2 - 1) * 2);
    rows.push(row);
  }
  const returns: AlignedReturns = { symbols: SYMBOLS, rows };

  const assets = [
    { symbol: "AAPLx", qtyUnits: 150_000, priceCents: 20_000, confCents: 12, staticAdvanceBps: 7000, stale: false, session: 0 },
    { symbol: "NVDAx", qtyUnits: 200_000, priceCents: 10_000, confCents: 18, staticAdvanceBps: 6000, stale: false, session: 0 },
    { symbol: "SPYx", qtyUnits: 100_000, priceCents: 50_000, confCents: 8, staticAdvanceBps: 8000, stale: false, session: 0 },
  ];

  const scenarios: Scenario[] = [
    { name: "base", marketShock: 0 },
    { name: "market -10%", marketShock: -0.10 },
    { name: "market -25% + NVDA -40%", marketShock: -0.25, idioShock: { NVDAx: -0.15 } },
  ];

  const result = evaluateRiskAdvanced({
    assets,
    returns,
    scenarios,
    policy: DEFAULT_ADVANCED_POLICY,
    requestedUsdcMicros: 300_000_000_000,
  });

  const fixture = {
    generatedWith: "risk-advanced.ts (v2 math)",
    seed: 42,
    input: { assets, scenarios, policy: DEFAULT_ADVANCED_POLICY, requestedUsdcMicros: 300_000_000_000 },
    returnsSymbols: returns.symbols,
    returnsRows: returns.rows,
    result,
  };
  const out = path.resolve(__dirname, "../tests/fixtures/advanced-golden.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(fixture, null, 2));
  console.log("golden vector written:", out);
  console.log(JSON.stringify({
    nav: result.navCents,
    eligible: result.eligibleValueCents,
    hf: result.healthFactorBps,
    nEff: result.effectiveBets.toFixed(4),
    worst: result.worstScenario,
  }, null, 1));
}

main();
