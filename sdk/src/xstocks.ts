import type { FeedView } from "./risk";
import type { PriceOracle } from "./oracle";
import { SESSION } from "./config";
import {clearTimeout} from "node:timers";

/**
 * xStocks REST oracle - free replacement for the licensed Pyth Hermes
 * engine in pyth.ts.
 *
 * VERIFIED against live xStocks API docs (docs.xstocs.fi, 2026-09-16):
 *   - `GET /public/assets/{symbol}/price-data` is PUBLIC (no key), returns
 *   `{ quote: number | null }` - indicative USD price.
 *   - `GET /public/assets/{symbol}` is PUBLIC, returns `trading.openNow`,
 *   `trading.currentPerion`, `isTradingHalted` - used here as the REAL
 *   market-session signal (replaces marketSessionNow()).
 *   - Demo symbols (SPYx, AAPLx, NVDAx from config.ts) match xStocks
 *   own symbol convention 1:1 - no feed-id resolution needed.
 *
 *   TODO_VERIFY – know gaps vs. the Pth interface this replace; confirm
 *   against current xStocks docs before using this beyond a hackathon demo:
 *     1. NO CONFIDENCE INTERVAL. Pyth publishes price ± confidence (stdev);
 *        `/price-data` returns a bare `quote`, no uncertainty band. FeedView
 *        has no confidence field today, son nothing downstream breaks – but
 *        any risk logic added later that assumes Pyth-grade confidence must
 *        NOT point at this oracle without deriving one first (candidate:
 *        bid/ask spread from the *authenticated* xChange RFQ endpoint,
 *        /trades/xchange/assets/{id} - not available on the public tier).
 *
 *     2. NO PUBLISH TIMESTAMP. The API returns only the current quote, not
 *        when it was last updated venue-side - so `isStale` here reflects
 *        OUR fetch clock (age since we last saw a non-null quote), not a
 *        venue publish_time the way Pyth's did.
 *
 *     3. `currentPeriod` string values are inferred from the one example in
 *        the docs ("market"); exact enum (pre-market/after-hours/closed
 *        naming) is NOT confirmed - verify against a live response before
 *        trusting the EXTENDED mapping below.
 *
 *     4. `quote: null` (halted / no live price) is treated as
 *        stale/unavailable rather than thrown, mirroring the old
 *        Pyth-unlicensed fallback shape (priceCents: -1, isStale: true).
 */

export const DEFAULT_XSTOCKS_API = "https://api.xstocks.fi/api/v2";

interface XStocksPriceData {
    quote: number | null;
}

interface XStocksTrading {
    currency: string;
    tradingHoursMode: string;
    isTradingHalted: boolean;
    currentPeriod: string; // TODO_VERIFY exact enum against live response
    openNow: boolean;
    nextChangeAt: string;
}

interface XStocksAsset {
    symbol: string;
    isTradingHalted: boolean;
    trading: XStocksTrading | null;
}

type MarketSession = (typeof SESSION)[keyof  typeof SESSION];
type ErrorPhase = "price" | "session";
type ErrorHandler = (symbol: string, phase: ErrorPhase, err: unknown) => void;

const defaultOnError: ErrorHandler = (symbol, phase, err) =>
    console.warn(
        `[xstocks] WARN ${phase} fetch failed for ${symbol}:`,
        err instanceof Error ? err.message : err,
    );

/** Fetch + parse JSON under one timeout that covers the whole round trip. */
async function fetchJsonWithTimeout<T>(url: string, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(
        () => controller.abort(new Error(`timeout after ${timeoutMs}ms: ${url}`)),
        timeoutMs,
    );
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`request failed: ${res.status} ${url}`);
        return (await res.json()) as T;
    } finally {
        clearTimeout(timer);
    }
}

interface SymbolState {
    feed: FeedView;
    attemptedAt: number; // when this resolution actually settled
    goodAt?: number; // last time priceCents !== -1 (replaces separate lastSeen map)
}

export class XStocksOracle implements PriceOracle {
    private state = new Map<string, SymbolState>();
    private inflight = new Map<string, Promise<FeedView>>();
    private lastLoggedAt = new Map<string, number>(); // key: `${symbol}:${phase}`

    constructor(
        private stalenessMs = 120_000,
        private endpoint = process.env.XSTOCKS_API_URL ?? DEFAULT_XSTOCKS_API,
        private timeoutMs = 5_000,
        private cacheTtlMs = 15_000,
        private onError: ErrorHandler = defaultOnError,
        private maxCacheEntries = 500,
        private logRateLimitMs = 30_000,
    ) {
        if (this.cacheTtlMs > this.stalenessMs) {
            throw new RangeError(
                `XStocksOracle: cacheTtlMs (${this.cacheTtlMs}) must be <= stalenessMs (${this.stalenessMs}) - ` +
                `a cached "fresh" feed must not outlive the window the error-fallback path treats as stale.`,
            );
        }
    }

    private fetchPrice(symbol: string): Promise<number | null> {
        return fetchJsonWithTimeout<XStocksPriceData>(
            `${this.endpoint}/public/assets/${symbol}/price-data`,
            this.timeoutMs,
        ).then((body) => body.quote);
    }

    private async fetchSession(symbol: string): Promise<MarketSession> {
        const body = await fetchJsonWithTimeout<XStocksAsset>(
            `${this.endpoint}/public/assets/${symbol}`,
            this.timeoutMs,
        );
        if (body.isTradingHalted || body.trading?.isTradingHalted) return SESSION.CLOSED;
        const period = body.trading?.currentPeriod?.toLowerCase();
        if (period === "market") return SESSION.OPEN;
        if (period === "pre-market" || period === "after-hours" || period === "extended") {
            return SESSION.EXTENDED; // TODO_VERIFY exact string values
        }
        if (body.trading?.openNow) return SESSION.OPEN;
        return SESSION.CLOSED;
    }

    private logError(symbol: string, phase: ErrorPhase, err: unknown) {
        const key = `${symbol}:${phase}`;
        const now = Date.now();
        const last = this.lastLoggedAt.get(key) ?? 0;
        if (now - last < this.logRateLimitMs) return;
        this.lastLoggedAt.set(key, now);
        this.onError(symbol, phase, err);
    }

    private recordState(symbol: string, feed: FeedView) {
        const attemptedAt = Date.now();
        const prevGoodAt = this.state.get(symbol)?.goodAt;
        const goodAt = feed.priceCents !== -1 ? attemptedAt : prevGoodAt;
        this.state.delete(symbol); // move to "most precent" for eviction order
        this.state.set(symbol, { feed, attemptedAt, goodAt });
        while (this.state.size > this.maxCacheEntries) {
            const oldest = this.state.keys().next().value;
            if (oldest === undefined) break;
            this.state.delete(oldest);
        }
    }

    private async fetchOne(symbol: string): Promise<FeedView> {
        let quote: number | null;
        try {
            quote = await this.fetchPrice(symbol);
        } catch (err) {
            this.logError(symbol, "price", err);
            const goodAt = this.state.get(symbol)?.goodAt;
            const feed: FeedView = {
                symbol,
                priceCents: -1,
                marketSession: SESSION.CLOSED, // fail closed - session unknown too
                isStale: goodAt === undefined || Date.now() - goodAt > this.stalenessMs,
            };
            this.recordState(symbol, feed);
            return feed;
        }

        let marketSession: MarketSession;
        try {
            marketSession = await this.fetchSession(symbol);
        } catch (err) {
            this.logError(symbol, "session", err);
            marketSession = SESSION.CLOSED;
        }

        const feed: FeedView =
            quote === null
                ? { symbol, priceCents: -1, marketSession, isStale: true }
                : { symbol, priceCents: Math.round(quote * 100), marketSession, isStale: false };

        this.recordState(symbol, feed);
        return feed;
    }

    /** Coalesces concurrent request for the same symbol into one fetch */
    private resolve(symbol: string): Promise<FeedView> {
        const pending = this.inflight.get(symbol);
        if (pending) return pending;
        const promise = this.fetchOne(symbol).finally(() => this.inflight.delete(symbol));
        this.inflight.set(symbol, promise);
        return promise;
    }

    async getFeeds(symbols: string[]): Promise<Record<string, FeedView>> {
        const now = Date.now();
        const out: Record<string, FeedView> = {};
        const toFetch: string[] = [];

        for (const symbol of symbols) {
            const cached = this.state.get(symbol);
            if (cached && now - cached.attemptedAt < this.cacheTtlMs) {
                out[symbol] = cached.feed;
            } else {
                toFetch.push(symbol);
            }
        }

        await Promise.all(toFetch.map(async (symbol) => (out[symbol] = await this.resolve(symbol))));
        return out;
    }
}