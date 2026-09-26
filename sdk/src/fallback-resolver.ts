import type { PriceOracle } from "./oracle";
import type { FeedView } from "./risk";
import { SESSION } from "./config";
import { DiskSnapshotSource, type PriceSnapshot } from "./disk-snapshot";
import { YahooPriceSource } from "./yahoo-source";
import { JupiterPriceSource } from "./jupiter-source";

export interface TokenAddressMap {
    [symbol: string]: string;
}

/**
 * FeedView plus a confidence interval, mirroring sdk/src/pyth.ts's
 * LiveFeedView so a risk-engine bridge can treat both the same way.
 * Absent (undefined) means "unknown", not "zero" — a bridge must NOT
 * default a missing confCents to 0: a 0-cent interval reads as perfect
 * confidence and would make a stale fallback price look MORE trustworthy
 * than a live tick, not less.
 */
export type FallbackFeedView = FeedView & { confCents?: number };

/**
 * Conservative synthetic confidence for degraded (non-primary) tiers, as
 * basis points of price. These are deliberately wide placeholders — NOT
 * calibrated against real historical pricing error — whose only job is to
 * make a downstream conservativePriceCents() computation treat a degraded
 * price as LESS trustworthy than a live tick, never as equally trustworthy.
 * Tune against real data before relying on the exact numbers.
 */
const DEGRADED_CONF_BPS = {
    yahoo: 200, // 2%: yesterday's official close, not live
    disk: 500, // 5%: our own last-seen snapshot, possibly hours/days old
    jupiter: 800, // 8%: DEX-derived, thinner liquidity, more manipulation risk
} as const;

const syntheticConf = (priceCents: number, bps: number) => Math.ceil((priceCents * bps) / 10_000);

interface CachedFeed {
    feed: FallbackFeedView;
    cachedAt: number;
    /** Shorter for a total failure (-1) than for a real resolution, so an
     *  outage doesn't suppress retries for as long as a real price would be cached. */
    ttlMs: number;
}

export type FallbackTier = "yahoo" | "disk" | "jupiter" | "failed";
export type FallbackEvent = (symbol: string, tier: FallbackTier, detail?: string) => void;

const defaultOnEvent: FallbackEvent = (symbol, tier, detail) => {
    if (tier === "failed") console.warn(`[fallback] ${symbol}: all sources failed, returning -1`);
    else console.log(`[fallback] ${symbol}: ${tier}${detail ? ` ${detail}` : ""}`);
};

export class FallbackPriceResolver implements PriceOracle {
    private disk: DiskSnapshotSource;
    private yahoo: YahooPriceSource;
    private jupiter: JupiterPriceSource;

    private cache = new Map<string, CachedFeed>();

    constructor(
        private primary: PriceOracle,
        private tokenAddresses: TokenAddressMap,
        jupiterApiKey: string,
        private cacheTtlMs = 15_000,
        private failureCacheTtlMs = 5_000,
        private onEvent: FallbackEvent = defaultOnEvent,
        deps?: { disk?: DiskSnapshotSource; yahoo?: YahooPriceSource; jupiter?: JupiterPriceSource },
    ) {
        this.disk = deps?.disk ?? new DiskSnapshotSource();
        this.yahoo = deps?.yahoo ?? new YahooPriceSource();
        this.jupiter = deps?.jupiter ?? new JupiterPriceSource(jupiterApiKey);
    }

    async getFeeds(symbols: string[]): Promise<Record<string, FallbackFeedView>> {
        const now = Date.now();
        const out: Record<string, FallbackFeedView> = {};
        const toResolve: string[] = [];

        for (const symbol of symbols) {
            const cached = this.cache.get(symbol);
            if (cached && now - cached.cachedAt < cached.ttlMs) {
                out[symbol] = cached.feed;
            } else {
                toResolve.push(symbol);
            }
        }
        if (toResolve.length === 0) return out;

        // Snapshots to persist are collected here and written ONCE at the end of
        // this call (was: one full-file rewrite per symbol, sequentially awaited).
        const toSnapshot: PriceSnapshot[] = [];

        // ── Level 1: live price from the primary oracle ──
        const primaryFeeds = await this.primary.getFeeds(toResolve);
        const unresolved: string[] = [];
        for (const symbol of toResolve) {
            const feed = primaryFeeds[symbol] as FallbackFeedView | undefined;
            if (feed && feed.priceCents > 0 && !feed.isStale) {
                out[symbol] = feed; // pass confCents through untouched if the primary supplied one
                this.cache.set(symbol, { feed, cachedAt: Date.now(), ttlMs: this.cacheTtlMs });
                toSnapshot.push({ symbol, priceCents: feed.priceCents, marketSession: feed.marketSession, savedAt: Date.now() });
            } else {
                unresolved.push(symbol);
            }
        }
        if (unresolved.length === 0) {
            if (toSnapshot.length > 0) await this.disk.saveSnapshots(toSnapshot);
            return out;
        }

        // ── Level 2: Yahoo Finance ──
        const afterYahoo: string[] = [];
        for (const symbol of unresolved) {
            const cents = await this.yahoo.getLastCloseCents(symbol);
            if (cents !== null && cents > 0) {
                const feed: FallbackFeedView = {
                    symbol,
                    priceCents: cents,
                    // Session is unknown on a degraded tier; CLOSED is a conservative
                    // REPORTING default only — isStale=true already zeroes this asset's
                    // eligible value in the advanced risk engine regardless of session.
                    marketSession: SESSION.CLOSED,
                    isStale: true,
                    confCents: syntheticConf(cents, DEGRADED_CONF_BPS.yahoo),
                };
                out[symbol] = feed;
                this.cache.set(symbol, { feed, cachedAt: Date.now(), ttlMs: this.cacheTtlMs });
                toSnapshot.push({ symbol, priceCents: cents, marketSession: SESSION.CLOSED, savedAt: Date.now() });
                this.onEvent(symbol, "yahoo", `close ${cents} cents`);
            } else {
                afterYahoo.push(symbol);
            }
        }
        if (afterYahoo.length === 0) {
            if (toSnapshot.length > 0) await this.disk.saveSnapshots(toSnapshot);
            return out;
        }

        // ── Level 3: snapshot on disk ──
        const afterSnapshot: string[] = [];
        for (const symbol of afterYahoo) {
            const snap = await this.disk.getSnapshot(symbol);
            if (snap) {
                const feed: FallbackFeedView = {
                    symbol,
                    priceCents: snap.priceCents,
                    marketSession: SESSION.CLOSED,
                    isStale: true,
                    confCents: syntheticConf(snap.priceCents, DEGRADED_CONF_BPS.disk),
                };
                out[symbol] = feed;
                this.cache.set(symbol, { feed, cachedAt: Date.now(), ttlMs: this.cacheTtlMs });
                this.onEvent(symbol, "disk", `${snap.priceCents} cents`);
            } else {
                afterSnapshot.push(symbol);
            }
        }
        if (afterSnapshot.length === 0) {
            if (toSnapshot.length > 0) await this.disk.saveSnapshots(toSnapshot);
            return out;
        }

        // ── Level 4: Jupiter ──
        const mints = afterSnapshot.map((s) => this.tokenAddresses[s]).filter(Boolean);
        let jupiterPrices: Record<string, number> = {};
        if (mints.length > 0) {
            try {
                jupiterPrices = await this.jupiter.getPrices(mints);
            } catch (err) {
                console.warn("[fallback] Jupiter failed:", err);
            }
        }

        for (const symbol of afterSnapshot) {
            const mint = this.tokenAddresses[symbol];
            const cents = mint ? jupiterPrices[mint] : undefined;

            let feed: FallbackFeedView;
            if (cents != null && cents > 0) {
                feed = {
                    symbol,
                    priceCents: cents,
                    marketSession: SESSION.CLOSED,
                    isStale: true,
                    confCents: syntheticConf(cents, DEGRADED_CONF_BPS.jupiter),
                };
                this.onEvent(symbol, "jupiter", `${cents} cents`);
                toSnapshot.push({ symbol, priceCents: cents, marketSession: SESSION.CLOSED, savedAt: Date.now() });
            } else {
                feed = { symbol, priceCents: -1, marketSession: SESSION.CLOSED, isStale: true };
                this.onEvent(symbol, "failed");
            }
            out[symbol] = feed;
            this.cache.set(symbol, {
                feed,
                cachedAt: Date.now(),
                ttlMs: feed.priceCents > 0 ? this.cacheTtlMs : this.failureCacheTtlMs,
            });
        }

        if (toSnapshot.length > 0) await this.disk.saveSnapshots(toSnapshot);
        return out;
    }
}