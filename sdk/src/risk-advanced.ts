/**
 * ADVANCED RISK ENGINE (v2 math) — production-intent quantitative model.
 *
 * Determinism contract: every function here is pure, uses IEEE-754 f64 with a
 * fixed operation order, no randomness and no wall clock. Assets are always
 * iterated in sorted-symbol order. Golden test vectors (tests/risk-advanced.ts)
 * pin behavior across releases.
 *
 * Model (see risk/ADVANCED_MODEL.md for the formal write-up):
 *
 *  1. Conservative pricing   P⁻ᵢ = Pᵢ − k·confᵢ        (Pyth confidence, k·conf cents)
 *  2. Volatility             EWMA(λ) on log returns, per asset
 *  3. Covariance             EWMA pairwise + δ-blend shrinkage toward the
 *                            constant-correlation matrix + PSD repair
 *                            (Jacobi eigenvalue clip)
 *  4. Liquidation-horizon σ  σᵢ = volᵢ·√(T·m_session)   (m: open 1.0, ext 1.1, closed 1.5)
 *  5. Advance rate           ARᵢ = max(AR_floor, AR_static − z·σᵢ)   (z = 99% quantile)
 *  6. Concentration          effective number of bets N = 1/Σ RCᵢ² from
 *                            Euler risk contributions; portfolio haircut
 *                            factor = clamp(N/N_min, floor, 1)
 *  7. Eligible value         Σᵢ Vᵢ·ARᵢ (stale ⇒ 0) × haircut factor
 *  8. Health factor          HF = eligible_value / outstanding (bps)
 *  9. Scenarios              deterministic ladder: each scenario re-prices P⁻
 *                            with market + idiosyncratic shocks and recomputes
 *                            HF — worst scenario is reported
 */

export interface AdvancedPolicyParams {
  /** Prudential quantile z for the advance-rate subtraction (99% ⇒ 2.3263). */
  zQuantile: number;
  /** EWMA decay for volatility/covariance (RiskMetrics: 0.94). */
  lambdaEwma: number;
  /** Shrinkage intensity toward the constant-correlation target (0..1). */
  shrinkageDelta: number;
  /** Liquidation horizon in days (assumed time to reduce the position). */
  liquidationHorizonDays: number;
  /** Horizon multipliers per market session (closed ⇒ slower response). */
  sessionHorizonMultiplier: { open: number; extended: number; closed: number };
  /** Confidence-interval multiplier for conservative pricing. */
  confMultiplier: number;
  /** Hard single-name cap as share of gross NAV (bps; 4000 = 40%). */
  hardCapBps: number;
  /** Minimum effective number of bets before the haircut factor bites. */
  minEffectiveBets: number;
  /** Floor for the effective advance rate (bps; 2000 = 20%). */
  advanceRateFloorBps: number;
  /** Concentration haircut floor (the penalty factor never goes below this). */
  concentrationFloor: number;
  /** Health-factor bands (bps): credit floor, ineligible floor. */
  creditHfBps: number;
  ineligibleHfBps: number;
}

export const DEFAULT_ADVANCED_POLICY: AdvancedPolicyParams = {
  zQuantile: 2.3263478740408408, // Φ⁻¹(0.99)
  lambdaEwma: 0.94,
  shrinkageDelta: 0.3,
  liquidationHorizonDays: 2,
  sessionHorizonMultiplier: { open: 1.0, extended: 1.1, closed: 1.5 },
  confMultiplier: 2,
  hardCapBps: 4000,
  minEffectiveBets: 2,
  advanceRateFloorBps: 2000,
  concentrationFloor: 0.6,
  creditHfBps: 20000,
  ineligibleHfBps: 15000,
};

/** Simultaneous return rows (oldest → newest), per-asset decimal log returns. */
export interface AlignedReturns {
  symbols: string[];
  /** rows[t][i] = return of symbols[i] at step t. */
  rows: number[][];
}

export interface AssetRiskInput {
  symbol: string;
  /** Token units (shares × 10^decimals). */
  qtyUnits: number;
  /** Last price, USD cents per share. */
  priceCents: number;
  /** Pyth-style confidence interval, USD cents (same scale as price). */
  confCents: number;
  /** Static (issuer/asset) advance rate, bps. */
  staticAdvanceBps: number;
  /** Oracle feed freshness. */
  stale: boolean;
  /** Market session: 0 open, 1 extended, 2 closed. */
  session: number;
}

export interface Scenario {
  name: string;
  /** Common shock applied to every asset, decimal (−0.10 = −10%). */
  marketShock: number;
  /** Per-symbol idiosyncratic shock, decimal. */
  idioShock?: Record<string, number>;
}

export interface AdvancedAssetRisk {
  symbol: string;
  qtyUnits: number;
  priceCents: number;
  confCents: number;
  conservativePriceCents: number;
  valueCents: number;
  weightBps: number;
  /** EWMA daily volatility (decimal). */
  volDaily: number;
  /** Liquidation-horizon volatility (decimal, session-adjusted). */
  volLiq: number;
  /** Effective advance rate after quantile subtraction (bps). */
  advanceRateBps: number;
  /** Euler risk-contribution share (Σ = 1). */
  riskContribution: number;
  hardCapped: boolean;
  stale: boolean;
  eligibleValueCents: number;
}

export interface ScenarioResult {
  name: string;
  eligibleValueCents: number;
  healthFactorBps: number;
  decision: "ELIGIBLE" | "MARGIN_CALL" | "INELIGIBLE";
}

export interface AdvancedRiskResult {
  grossNavCents: number;
  navCents: number; // conservative NAV (post confidence haircut)
  perAsset: AdvancedAssetRisk[];
  /** Correlation-implied effective number of bets. */
  effectiveBets: number;
  /** Concentration haircut factor applied to eligible value (≤ 1). */
  concentrationFactor: number;
  eligibleValueCents: number;
  requestedUsdcMicros: number;
  healthFactorBps: number;
  decision: "ELIGIBLE" | "MARGIN_CALL" | "INELIGIBLE";
  worstScenario: ScenarioResult;
  scenarios: ScenarioResult[];
}

// ---------------------------------------------------------------------------
// Linear algebra (deterministic)
// ---------------------------------------------------------------------------

/** Transpose-free symmetric matrix helpers (n×n flat arrays, row-major). */
export function ewmaVariance(returns: number[], lambda: number, seed?: number): number {
  if (returns.length === 0) return seed ?? 0;
  let v = seed ?? returns[0] * returns[0];
  for (let t = 1; t < returns.length; t++) {
    v = lambda * v + (1 - lambda) * returns[t] * returns[t];
  }
  return v;
}

/** Pairwise EWMA covariance over aligned rows, for the (i, j) column pair. */
function ewmaCovPair(ri: number[], rj: number[], lambda: number): number {
  const n = Math.min(ri.length, rj.length);
  if (n === 0) return 0;
  let c = ri[0] * rj[0];
  for (let t = 1; t < n; t++) c = lambda * c + (1 - lambda) * ri[t] * rj[t];
  return c;
}

/** EWMA covariance matrix over aligned return rows. */
export function ewmaCovariance(rows: number[][], lambda: number): number[][] {
  const n = rows.length > 0 ? rows[0].length : 0;
  const cov: number[][] = [];
  for (let i = 0; i < n; i++) {
    cov[i] = [];
    for (let j = 0; j < n; j++) {
      const colI = rows.map((r) => r[i]);
      const colJ = rows.map((r) => r[j]);
      cov[i][j] = ewmaCovPair(colI, colJ, lambda);
    }
  }
  return cov;
}

/** Shrink Σ toward the constant-correlation target and repair PSD via Jacobi. */
export function shrinkAndRepairPSD(cov: number[][], delta: number): number[][] {
  const n = cov.length;
  const variances = cov.map((row, i) => Math.max(row[i], 1e-18));
  // Constant-correlation target F.
  let corrSum = 0;
  let corrCount = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i !== j) {
        corrSum += cov[i][j] / Math.sqrt(variances[i] * variances[j]);
        corrCount++;
      }
    }
  }
  const rhoBar = corrCount > 0 ? corrSum / corrCount : 0;
  const F: number[][] = variances.map((vi, i) =>
    variances.map((vj, j) => (i === j ? vi : rhoBar * Math.sqrt(vi * vj))),
  );
  // δ-blend.
  const shrunk: number[][] = cov.map((row, i) =>
    row.map((c, j) => delta * cov[i][j] + (1 - delta) * F[i][j]),
  );
  // PSD repair: eigen-decompose (Jacobi), clip negatives, reconstruct.
  const { values, vectors } = jacobiEigenvalues(shrunk);
  const clipped = values.map((v) => Math.max(v, 1e-14));
  return reconstruct(clipped, vectors, n);
}

/** Cyclic Jacobi eigenvalue decomposition for symmetric matrices. */
export function jacobiEigenvalues(
  a: number[][],
  maxSweeps = 50,
  tol = 1e-14,
): { values: number[]; vectors: number[][] } {
  const n = a.length;
  const m = a.map((row) => [...row]);
  const v: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) off += m[i][j] * m[i][j];
    if (Math.sqrt(off) < tol) break;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(m[p][q]) < 1e-300) continue;
        const theta = (m[q][q] - m[p][p]) / (2 * m[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const mkp = m[k][p];
          const mkq = m[k][q];
          m[k][p] = c * mkp - s * mkq;
          m[k][q] = s * mkp + c * mkq;
        }
        for (let k = 0; k < n; k++) {
          const mpk = m[p][k];
          const mqk = m[q][k];
          m[p][k] = c * mpk - s * mqk;
          m[q][k] = s * mpk + c * mqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { values: m.map((row, i) => row[i]), vectors: v };
}

function reconstruct(values: number[], vectors: number[][], n: number): number[][] {
  const out: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        out[i][j] += values[k] * vectors[i][k] * vectors[j][k];
      }
    }
  }
  // Symmetrize against float drift.
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) out[j][i] = out[i][j];
  return out;
}

// ---------------------------------------------------------------------------
// Risk pieces
// ---------------------------------------------------------------------------

/** Conservative price: price − k·conf (never below zero). */
export function conservativePriceCents(priceCents: number, confCents: number, k: number): number {
  return Math.max(0, priceCents - k * confCents);
}

/**
 * Effective advance rate: the static (issuer/asset) haircut minus the
 * prudential allowance for the market move at quantile z over the
 * liquidation horizon — floored so the advance rate never goes negative.
 */
export function quantileAdvanceRateBps(
  staticBps: number,
  volLiq: number,
  z: number,
  floorBps: number,
): number {
  const marketAllowanceBps = Math.round(z * volLiq * 10000);
  return Math.max(floorBps, staticBps - marketAllowanceBps);
}

export function liquidationVol(
  volDaily: number,
  horizonDays: number,
  sessionMultiplier: number,
): number {
  return volDaily * Math.sqrt(horizonDays * sessionMultiplier);
}

/** Effective number of bets from Euler risk contributions (w'Σw based). */
export function effectiveBets(
  weights: number[],
  cov: number[][],
): { nEff: number; contributions: number[] } {
  const n = weights.length;
  // Euler risk-contribution shares (reported for transparency).
  const mrc: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += cov[i][j] * weights[j];
    mrc[i] = s;
  }
  const pvar = weights.reduce((acc, w, i) => acc + w * mrc[i], 0);
  const pvol = Math.sqrt(Math.max(pvar, 1e-24));
  const contributions: number[] = weights.map((w, i) => (w * mrc[i]) / pvar);
  const sumRc = contributions.reduce((a, b) => a + b, 0);
  const normed = contributions.map((c) => (sumRc > 0 ? c / sumRc : 1 / n));

  // Meucci (2009) effective number of bets: project the portfolio onto the
  // covariance eigen-portfolios, p_k = λ_k·(w·v_k)² / (w'Σw), then
  // N_eff = exp(−Σ p_k ln p_k). Unlike Euler shares this distinguishes
  // correlation structure: perfectly correlated assets collapse to N = 1.
  if (pvar <= 1e-24) return { nEff: n, contributions: normed };
  const { values, vectors } = jacobiEigenvalues(cov);
  const p: number[] = [];
  for (let k = 0; k < n; k++) {
    let dot = 0;
    for (let i = 0; i < n; i++) dot += weights[i] * vectors[i][k];
    p.push((Math.max(values[k], 0) * dot * dot) / pvar);
  }
  const pTotal = p.reduce((a, b) => a + b, 0);
  let nEff = n;
  if (pTotal > 0) {
    const shares = p.map((x) => x / pTotal).filter((x) => x > 0);
    let entropy = 0;
    for (const x of shares) entropy -= x * Math.log(x);
    nEff = Math.exp(entropy);
  }
  return { nEff, contributions: normed };
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export interface EvaluateAdvancedInput {
  assets: AssetRiskInput[];
  /** Aligned log-return rows for volatility/covariance (per AssetRiskInput order). */
  returns: AlignedReturns;
  /** Scenarios evaluated on top of the base computation. */
  scenarios: Scenario[];
  policy: AdvancedPolicyParams;
  /** Requested credit, test-USDC micros. */
  requestedUsdcMicros: number;
}

export function evaluateRiskAdvanced(input: EvaluateAdvancedInput): AdvancedRiskResult {
  const P = input.policy;
  // Deterministic order: sort assets by symbol.
  const assets = [...input.assets].sort((a, b) => (a.symbol < b.symbol ? -1 : 1));

  // Align returns to the sorted asset order.
  const symbolIdx = new Map(input.returns.symbols.map((s, i) => [s, i]));
  const returnsRows = input.returns.rows;
  const nAssets = assets.length;

  // 1–2. Conservative prices and values.
  const conservative = assets.map((a) => conservativePriceCents(a.priceCents, a.confCents, P.confMultiplier));
  const values = assets.map((a, i) => (a.qtyUnits * conservative[i]) / 100);
  const grossNav = assets.reduce((s, a) => s + (a.qtyUnits * a.priceCents) / 100, 0);
  const nav = values.reduce((s, v) => s + v, 0);

  // Weights on conservative values.
  const weights = values.map((v) => (nav > 0 ? v / nav : 0));

  // 3–4. Volatility, covariance, liquidation-horizon vol.
  const vols = assets.map((a, i) => {
    const col = symbolIdx.has(a.symbol) ? returnsRows.map((r) => r[symbolIdx.get(a.symbol)!]) : [];
    const mult =
      a.session === 0
        ? P.sessionHorizonMultiplier.open
        : a.session === 1
          ? P.sessionHorizonMultiplier.extended
          : P.sessionHorizonMultiplier.closed;
    const raw = ewmaVariance(col, P.lambdaEwma);
    return liquidationVol(Math.sqrt(Math.max(raw, 0)), P.liquidationHorizonDays, mult);
  });

  // Covariance over aligned rows in SORTED order (for effective bets).
  const sortedRows = returnsRows.length
    ? returnsRows.map((r) => assets.map((a) => r[symbolIdx.get(a.symbol) ?? 0]))
    : [];
  let cov = ewmaCovariance(sortedRows, P.lambdaEwma);
  cov = shrinkAndRepairPSD(cov, P.shrinkageDelta);

  // 5. Advance rates.
  const advanceBps = assets.map((a, i) =>
    a.stale ? 0 : quantileAdvanceRateBps(a.staticAdvanceBps, vols[i], P.zQuantile, P.advanceRateFloorBps),
  );

  // 6. Hard single-name cap.
  const hardCap = assets.map((a, i) => {
    const weightBps = nav > 0 ? Math.round((values[i] / nav) * 10000) : 0;
    return weightBps > P.hardCapBps;
  });

  // 7. Eligible value per asset (pre-concentration).
  const eligiblePre = assets.map((a, i) => {
    if (a.stale) return 0;
    let v = values[i] * (advanceBps[i] / 10000);
    if (hardCap[i]) v *= P.hardCapBps / 10000; // scale over-cap portion
    return v;
  });

  // 8. Concentration: effective bets on the covariance of RETURNS with
  //    weights proportional to eligible value.
  const eligibleTotalPre = eligiblePre.reduce((s, v) => s + v, 0);
  const wElig = eligiblePre.map((v) => (eligibleTotalPre > 0 ? v / eligibleTotalPre : 1 / nAssets));
  const { nEff, contributions } = effectiveBets(wElig, cov);
  const concentrationFactor = Math.max(
    P.concentrationFloor,
    Math.min(1, nEff / P.minEffectiveBets),
  );

  const eligibleValueCents = eligibleTotalPre * concentrationFactor;

  // 9. Health factor and decision.
  const healthFactorBps =
    input.requestedUsdcMicros > 0
      ? Math.floor((eligibleValueCents * 10000 * 10000) / input.requestedUsdcMicros)
      : 0;
  const decision: AdvancedRiskResult["decision"] =
    healthFactorBps >= P.creditHfBps
      ? "ELIGIBLE"
      : healthFactorBps >= P.ineligibleHfBps
        ? "MARGIN_CALL"
        : "INELIGIBLE";

  const perAsset: AdvancedAssetRisk[] = assets.map((a, i) => ({
    symbol: a.symbol,
    qtyUnits: a.qtyUnits,
    priceCents: a.priceCents,
    confCents: a.confCents,
    conservativePriceCents: conservative[i],
    valueCents: Math.round(values[i]),
    weightBps: nav > 0 ? Math.round((values[i] / nav) * 10000) : 0,
    volDaily: Math.sqrt(Math.max(ewmaVariance(
      symbolIdx.has(a.symbol) ? returnsRows.map((r) => r[symbolIdx.get(a.symbol)!]) : [],
      P.lambdaEwma,
    ), 0)),
    volLiq: vols[i],
    advanceRateBps: advanceBps[i],
    riskContribution: contributions[i],
    hardCapped: hardCap[i],
    stale: a.stale,
    eligibleValueCents: Math.round(eligiblePre[i] * concentrationFactor),
  }));

  // 10. Deterministic scenario ladder.
  const scenarios = input.scenarios.map((sc) => {
    let elig = 0;
    assets.forEach((a, i) => {
      if (a.stale) return;
      const idio = sc.idioShock?.[a.symbol] ?? 0;
      const p = Math.max(0, conservative[i] * (1 + sc.marketShock + idio));
      const val = (a.qtyUnits * p) / 100;
      const weightP = nav > 0 ? val / (nav * (1 + sc.marketShock) || 1) : 0;
      void weightP;
      let v = val * (advanceBps[i] / 10000);
      if (hardCap[i] && nav > 0) {
        const wP = val / Math.max(nav * (1 + sc.marketShock), 1);
        if (wP * 10000 > P.hardCapBps) v *= P.hardCapBps / 10000;
      }
      elig += v;
    });
    const eligWithFactor = elig * concentrationFactor;
    const hf =
      input.requestedUsdcMicros > 0
        ? Math.floor((eligWithFactor * 10000 * 10000) / input.requestedUsdcMicros)
        : 0;
    const dec: ScenarioResult["decision"] =
      hf >= P.creditHfBps ? "ELIGIBLE" : hf >= P.ineligibleHfBps ? "MARGIN_CALL" : "INELIGIBLE";
    return { name: sc.name, eligibleValueCents: Math.round(eligWithFactor), healthFactorBps: hf, decision: dec };
  });
  const worstScenario = scenarios.reduce(
    (worst, s) => (s.healthFactorBps < worst.healthFactorBps ? s : worst),
    scenarios[0] ?? { name: "none", eligibleValueCents: 0, healthFactorBps: 0, decision: "INELIGIBLE" as const },
  );

  return {
    grossNavCents: Math.round(grossNav),
    navCents: Math.round(nav),
    perAsset,
    effectiveBets: nEff,
    concentrationFactor,
    eligibleValueCents: Math.round(eligibleValueCents),
    requestedUsdcMicros: input.requestedUsdcMicros,
    healthFactorBps,
    decision,
    worstScenario,
    scenarios,
  };
}
