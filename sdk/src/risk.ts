/**
 * Reference risk engine (brief §7).
 *
 * Transparent and deliberately simple:
 *
 *   eligible_value = qty × price × advance_rate × session_factor × concentration_penalty
 *
 *   health factor (HF) = Σ eligible_value / requested_credit
 *     HF ≥ credit_hf_bps      → ELIGIBLE for new credit, status COMPLIANT
 *     ineligible ≤ HF < credit → MARGIN_CALL (public: "additional collateral required")
 *     HF < ineligible_hf_bps  → INELIGIBLE
 *
 * A stale oracle makes the asset contribute zero (ineligible collateral).
 *
 * This module is the PRIVATE side of the system: its outputs beyond `decision`
 * never leave the institution / risk engine. Policy parameters come from the
 * on-chain RiskPolicy account so the policy is public and configurable, while
 * the portfolio inputs stay off-chain.
 */

export interface SessionParams {
  marketOpenBps: number;
  extendedHoursBps: number;
  marketClosedBps: number;
}

export interface ConcentrationParams {
  thresholdBps: number;
  penaltyBps: number;
}

export interface PolicyParams {
  session: SessionParams;
  concentration: ConcentrationParams;
  creditHfBps: number;
  ineligibleHfBps: number;
  maxStalenessSlots: number;
}

export interface PolicyAsset {
  symbol: string;
  mint: string;
  advanceRateBps: number;
}

export interface FeedView {
  symbol: string;
  priceCents: number;
  marketSession: number; // 0 open, 1 extended, 2 closed
  isStale: boolean;
}

export interface Holding {
  symbol: string;
  /** Token units (shares × 10^decimals). */
  qtyUnits: number;
}

export type Decision = "ELIGIBLE" | "MARGIN_CALL" | "INELIGIBLE";

export interface AssetRisk {
  symbol: string;
  qtyUnits: number;
  priceCents: number;
  valueCents: number;
  weightBps: number;
  advanceRateBps: number;
  sessionFactorBps: number;
  concentrationPenaltyBps: number;
  stale: boolean;
  eligibleValueCents: number;
}

export interface RiskResult {
  navCents: number;
  perAsset: AssetRisk[];
  eligibleValueCents: number;
  requestedUsdcMicros: number;
  /** HF × 10000 (integer bps). PRIVATE. */
  healthFactorBps: number;
  decision: Decision;
}

export const BPS = 10_000;

function sessionFactorBps(session: SessionParams, marketSession: number): number {
  switch (marketSession) {
    case 0:
      return session.marketOpenBps;
    case 1:
      return session.extendedHoursBps;
    default:
      return session.marketClosedBps;
  }
}

export function evaluateRisk(input: {
  holdings: Holding[];
  feeds: Record<string, FeedView>;
  assets: PolicyAsset[];
  policy: PolicyParams;
  /** Requested credit in test-USDC micros; 0 = monitoring-only evaluation. */
  requestedUsdcMicros: number;
}): RiskResult {
  const { holdings, feeds, assets, policy, requestedUsdcMicros } = input;
  if (requestedUsdcMicros <= 0) {
    throw new Error("requestedUsdcMicros must be > 0 (evaluate against outstanding debt)");
  }

  const byAsset = new Map(assets.map((a) => [a.symbol, a]));

  // Gross values first (weights are computed over gross NAV).
  const gross = holdings.map((h) => {
    const feed = feeds[h.symbol];
    if (!feed) throw new Error(`no oracle feed for ${h.symbol}`);
    const valueCents = Math.floor((h.qtyUnits * feed.priceCents) / 100);
    return { holding: h, feed, valueCents };
  });
  const navCents = gross.reduce((s, g) => s + g.valueCents, 0);
  if (navCents <= 0) throw new Error("portfolio NAV must be positive");

  const perAsset: AssetRisk[] = gross.map(({ holding, feed, valueCents }) => {
    const asset = byAsset.get(holding.symbol);
    if (!asset) throw new Error(`asset ${holding.symbol} not in policy`);
    const stale = feed.isStale;
    const penalty =
      valueCents * BPS > navCents * policy.concentration.thresholdBps
        ? policy.concentration.penaltyBps
        : BPS;
    const eligibleValueCents = stale
      ? 0
      : Math.floor(
          (valueCents * asset.advanceRateBps * sessionFactorBps(policy.session, feed.marketSession) * penalty) /
            (BPS * BPS * BPS),
        );
    return {
      symbol: holding.symbol,
      qtyUnits: holding.qtyUnits,
      priceCents: feed.priceCents,
      valueCents,
      weightBps: Math.floor((valueCents * BPS) / navCents),
      advanceRateBps: asset.advanceRateBps,
      sessionFactorBps: sessionFactorBps(policy.session, feed.marketSession),
      concentrationPenaltyBps: penalty,
      stale,
      eligibleValueCents,
    };
  });

  const eligibleValueCents = perAsset.reduce((s, a) => s + a.eligibleValueCents, 0);

  // HF in bps: eligibleCents / (micros / 10_000 cents) × 10_000.
  const healthFactorBps = Math.floor((eligibleValueCents * BPS * BPS) / requestedUsdcMicros);
  const decision: Decision =
    healthFactorBps >= policy.creditHfBps
      ? "ELIGIBLE"
      : healthFactorBps >= policy.ineligibleHfBps
        ? "MARGIN_CALL"
        : "INELIGIBLE";
  return {
    navCents,
    perAsset,
    eligibleValueCents,
    requestedUsdcMicros,
    healthFactorBps,
    decision,
  };
}
