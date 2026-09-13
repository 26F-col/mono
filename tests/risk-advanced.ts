import * as fs from "fs";
import * as path from "path";
import { expect } from "chai";

import {
  DEFAULT_ADVANCED_POLICY,
  effectiveBets,
  evaluateRiskAdvanced,
  ewmaVariance,
  jacobiEigenvalues,
  liquidationVol,
  quantileAdvanceRateBps,
  shrinkAndRepairPSD,
  conservativePriceCents,
} from "../sdk/src/risk-advanced";

/**
 * Advanced risk engine tests: hand-computed unit checks, mathematical
 * properties (PSD, monotonicity), and golden-vector regression.
 * Pure math — no validator needed.
 */

describe("advanced risk engine (v2 math)", () => {
  // ------------------------------------------------------------------ EWMA
  it("EWMA variance matches the hand-computed recursion", () => {
    // returns [0.01, 0.02], λ=0.94, seed = r₀² = 1e-4
    // v = 0.94·1e-4 + 0.06·4e-4 = 1.18e-4
    const v = ewmaVariance([0.01, 0.02], 0.94);
    expect(v).to.be.closeTo(1.18e-4, 1e-12);
  });

  it("EWMA variance with fewer observations seeds from r₀²", () => {
    expect(ewmaVariance([0.03], 0.94)).to.eq(9e-4);
    expect(ewmaVariance([], 0.94)).to.eq(0);
  });

  // --------------------------------------------------- conservative pricing
  it("conservative price subtracts k·conf and never goes negative", () => {
    expect(conservativePriceCents(20_000, 12, 2)).to.eq(19_976);
    expect(conservativePriceCents(10, 100, 2)).to.eq(0);
  });

  // ---------------------------------------------------- quantile advance
  it("advance rate subtracts z·σ_liq from the static rate, floored", () => {
    // z·σ·10000 = 2.3263·0.05·10000 ≈ 1163 bps
    expect(quantileAdvanceRateBps(8000, 0.05, 2.3263478740408408, 2000)).to.eq(6837);
    expect(quantileAdvanceRateBps(8000, 0.90, 2.3263478740408408, 2000)).to.eq(2000); // floor
  });

  it("liquidation vol scales with horizon × session multiplier", () => {
    expect(liquidationVol(0.02, 2, 1.0)).to.be.closeTo(0.02 * Math.SQRT2, 1e-12);
    expect(liquidationVol(0.02, 2, 1.5)).to.be.closeTo(0.02 * Math.sqrt(3), 1e-12);
  });

  // --------------------------------------------------------------- PSD
  it("shrinkAndRepairPSD clips negative eigenvalues (PSD repair)", () => {
    // [[1, 1.2], [1.2, 1]] has a negative eigenvalue; after repair all ≥ 0.
    const repaired = shrinkAndRepairPSD(
      [
        [1, 1.2],
        [1.2, 1],
      ],
      0,
    );
    const { values } = jacobiEigenvalues(repaired);
    for (const v of values) expect(v).to.be.at.least(-1e-10);
    // Correlation stays ≤ 1 after repair.
    const corr = repaired[0][1] / Math.sqrt(repaired[0][0] * repaired[1][1]);
    expect(corr).to.be.at.most(1 + 1e-9);
  });

  it("Jacobi eigenvalues of an identity matrix are all ones", () => {
    const { values } = jacobiEigenvalues([
      [1, 0],
      [0, 1],
    ]);
    expect(values[0]).to.be.closeTo(1, 1e-12);
    expect(values[1]).to.be.closeTo(1, 1e-12);
  });

  // ------------------------------------------------------ effective bets
  it("effective bets: uncorrelated equal-vol assets → N = number of assets", () => {
    const { nEff } = effectiveBets(
      [0.5, 0.5],
      [
        [0.04, 0],
        [0, 0.04],
      ],
    );
    expect(nEff).to.be.closeTo(2, 1e-9);
  });

  it("effective bets: perfectly correlated portfolio collapses to N = 1", () => {
    const { nEff } = effectiveBets(
      [0.5, 0.5],
      [
        [0.04, 0.04],
        [0.04, 0.04],
      ],
    );
    expect(nEff).to.be.closeTo(1, 1e-6);
  });

  it("effective bets: uncorrelated unequal vols sit between 1 and N", () => {
    const { nEff } = effectiveBets(
      [0.5, 0.5],
      [
        [0.04, 0],
        [0, 0.09],
      ],
    );
    // Variance concentration in the high-vol leg: 1 < N < 2 (Meucci entropy).
    expect(nEff).to.be.above(1);
    expect(nEff).to.be.below(2);
  });

  // ------------------------------------------------------------ scenarios
  it("scenario ladder is monotonic: worse shock → lower HF", () => {
    const assets = [
      { symbol: "AAPLx", qtyUnits: 150_000, priceCents: 20_000, confCents: 0, staticAdvanceBps: 7000, stale: false, session: 0 },
      { symbol: "NVDAx", qtyUnits: 200_000, priceCents: 10_000, confCents: 0, staticAdvanceBps: 6000, stale: false, session: 0 },
      { symbol: "SPYx", qtyUnits: 100_000, priceCents: 50_000, confCents: 0, staticAdvanceBps: 8000, stale: false, session: 0 },
    ];
    const rows: number[][] = Array.from({ length: 30 }, () => [0.001, 0.002, 0.0005]);
    const scenarios = [
      { name: "base", marketShock: 0 },
      { name: "-10%", marketShock: -0.10 },
      { name: "-25%", marketShock: -0.25 },
    ];
    const res = evaluateRiskAdvanced({
      assets,
      returns: { symbols: ["AAPLx", "NVDAx", "SPYx"], rows },
      scenarios,
      policy: DEFAULT_ADVANCED_POLICY,
      requestedUsdcMicros: 300_000_000_000,
    });
    const [base, m10, m25] = res.scenarios.map((s) => s.healthFactorBps);
    expect(base).to.be.at.least(m10);
    expect(m10).to.be.at.least(m25);
    expect(res.worstScenario.name).to.eq("-25%");
  });

  it("stale assets contribute zero eligible value", () => {
    const assets = [
      { symbol: "AAPLx", qtyUnits: 150_000, priceCents: 20_000, confCents: 0, staticAdvanceBps: 7000, stale: true, session: 0 },
      { symbol: "SPYx", qtyUnits: 100_000, priceCents: 50_000, confCents: 0, staticAdvanceBps: 8000, stale: false, session: 0 },
    ];
    const res = evaluateRiskAdvanced({
      assets,
      returns: { symbols: ["AAPLx", "SPYx"], rows: Array.from({ length: 10 }, () => [0.001, 0.001]) },
      scenarios: [],
      policy: DEFAULT_ADVANCED_POLICY,
      requestedUsdcMicros: 100_000_000_000,
    });
    const aapl = res.perAsset.find((a) => a.symbol === "AAPLx")!;
    expect(aapl.eligibleValueCents).to.eq(0);
    expect(res.eligibleValueCents).to.eq(res.perAsset.find((a) => a.symbol === "SPYx")!.eligibleValueCents);
  });

  // -------------------------------------------------------- golden vector
  const fixturePath = path.resolve(__dirname, "fixtures/advanced-golden.json");

  it("golden vector: regression against the pinned deterministic output", () => {
    expect(fs.existsSync(fixturePath), "run scripts/gen-golden-vectors.ts first").to.be.true;
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    const res = evaluateRiskAdvanced({
      assets: fixture.input.assets,
      returns: { symbols: fixture.returnsSymbols, rows: fixture.returnsRows },
      scenarios: fixture.input.scenarios,
      policy: fixture.input.policy,
      requestedUsdcMicros: fixture.input.requestedUsdcMicros,
    });
    // Exact structural comparison (floats round-trip deterministically in JS).
    const actual = JSON.parse(
      JSON.stringify({
        navCents: res.navCents,
        eligibleValueCents: res.eligibleValueCents,
        healthFactorBps: res.healthFactorBps,
        effectiveBets: res.effectiveBets,
        concentrationFactor: res.concentrationFactor,
        scenarios: res.scenarios,
        worstScenario: res.worstScenario,
        perAsset: res.perAsset,
      }),
    );
    const expected = {
      navCents: fixture.result.navCents,
      eligibleValueCents: fixture.result.eligibleValueCents,
      healthFactorBps: fixture.result.healthFactorBps,
      effectiveBets: fixture.result.effectiveBets,
      concentrationFactor: fixture.result.concentrationFactor,
      scenarios: fixture.result.scenarios,
      worstScenario: fixture.result.worstScenario,
      perAsset: fixture.result.perAsset,
    };
    expect(JSON.stringify(actual)).to.eq(JSON.stringify(expected));
  });
});
