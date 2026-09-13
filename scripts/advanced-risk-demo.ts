/**
 * Advanced risk engine demo — deterministic seeded history → full report.
 * Run: npx tsx scripts/advanced-risk-demo.ts
 */
import {
  DEFAULT_ADVANCED_POLICY,
  evaluateRiskAdvanced,
  Scenario,
} from "../sdk/src/risk-advanced";

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

const SYMBOLS = ["AAPLx", "NVDAx", "SPYx"];
const BETAS: Record<string, number> = { AAPLx: 1.1, NVDAx: 1.6, SPYx: 1.0 };
const IDIO: Record<string, number> = { AAPLx: 0.012, NVDAx: 0.022, SPYx: 0.006 };
const PRICES: Record<string, number> = { AAPLx: 20_000, NVDAx: 10_000, SPYx: 50_000 };
const QTYS: Record<string, number> = { AAPLx: 150_000, NVDAx: 200_000, SPYx: 100_000 };
const ADV: Record<string, number> = { AAPLx: 7000, NVDAx: 6000, SPYx: 8000 };

const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

function main() {
  const rng = mulberry32(7);
  const rows: number[][] = [];
  for (let t = 0; t < 120; t++) {
    const mkt = 0.0003 * (rng() * 2 - 1) * 5;
    rows.push(SYMBOLS.map((s) => BETAS[s] * mkt + IDIO[s] * (rng() * 2 - 1) * 2));
  }
  const assets = SYMBOLS.map((s) => ({
    symbol: s,
    qtyUnits: QTYS[s],
    priceCents: PRICES[s],
    confCents: { AAPLx: 10, NVDAx: 16, SPYx: 7 }[s]!,
    staticAdvanceBps: ADV[s],
    stale: false,
    session: 0,
  }));
  const scenarios: Scenario[] = [
    { name: "base", marketShock: 0 },
    { name: "market −10%", marketShock: -0.1 },
    { name: "market −25% + NVDA −40%", marketShock: -0.25, idioShock: { NVDAx: -0.15 } },
  ];

  const res = evaluateRiskAdvanced({
    assets,
    returns: { symbols: SYMBOLS, rows },
    scenarios,
    policy: DEFAULT_ADVANCED_POLICY,
    requestedUsdcMicros: 300_000_000_000,
  });

  console.log("\nADVANCED RISK ENGINE REPORT (deterministic, seeded history)");
  console.log("=".repeat(70));
  console.log(
    `\n  Gross NAV            ${usd(res.grossNavCents)}` +
      `\n  Conservative NAV     ${usd(res.navCents)}  (after ${(100 - (res.navCents / res.grossNavCents) * 100).toFixed(3)}% confidence haircut)` +
      `\n  Eligible value       ${usd(res.eligibleValueCents)}  (haircut factor ${res.concentrationFactor.toFixed(3)})` +
      `\n  Effective bets       ${res.effectiveBets.toFixed(2)}` +
      `\n  Requested            $300,000` +
      `\n  Health factor        ${(res.healthFactorBps / 10000).toFixed(2)}×  →  ${res.decision}`,
  );

  console.log("\n  PER-ASSET BREAKDOWN");
  console.log("  " + "-".repeat(66));
  for (const a of res.perAsset) {
    console.log(
      `   ${a.symbol.padEnd(6)} value ${usd(a.valueCents).padStart(9)}  ` +
        `w ${(a.weightBps / 100).toFixed(1).padStart(5)}%  ` +
        `vol ${(a.volDaily * 100).toFixed(2)}%  ` +
        `σ_liq ${(a.volLiq * 100).toFixed(2)}%  ` +
        `AR ${(a.advanceRateBps / 100).toFixed(0).padStart(3)}%  ` +
        `RC ${(a.riskContribution * 100).toFixed(1).padStart(5)}%` +
        (a.hardCapped ? "  [capped]" : "") +
        (a.stale ? "  [STALE]" : ""),
    );
  }

  console.log("\n  SCENARIO LADDER");
  for (const s of res.scenarios) {
    console.log(
      `   ${s.name.padEnd(28)} eligible ${usd(s.eligibleValueCents).padStart(10)}  ` +
        `HF ${(s.healthFactorBps / 10000).toFixed(2)}×  ${s.decision}`,
    );
  }
  console.log(`\n  Worst scenario: ${res.worstScenario.name} (HF ${(res.worstScenario.healthFactorBps / 10000).toFixed(2)}×)`);
  console.log("\n  All quantities are private: this report never goes on chain.");
  console.log("  Only the decision, amount and status reach credit_gate.\n");
}

main();
