import type { FeedView } from "./risk";
import type { PriceOracle } from "./oracle";
import { SESSION } from "./config";

/**
 * xStocks REST oracle – free replacement for the licensed Pyth Hermes
 * engine in pyth.ts.
 *
 * VERIFIED against live xStocks API docs (docs.xstocs.fi, 2026-09-16):
 *   - `GET /public/assets/{symbol}/price-data` is PUBLIC (no key), returns
 *   `{ quote: number | null }` – indicative USD price.
 *   - `GET /public/assets/{symbol}` is PUBLIC, returns `trading.openNow`,
 *   `trading.currentPerion`, `isTradingHalted` – used here as the REAL
 *   market-session signal (replaces marketSessionNow()).
 *   - Demo symbols (SPYx, AAPLx, NVDAx from config.ts) match xStocks
 *   own symbol convention 1:1 – no feed-id resolution needed.
 *
 *   TODO_VERIFY – know gaps vs. the Pth interface this replace; confirm
 *   against current xStocks docs before using this beyond a hackathon demo:
 *     1. NO CONFIDENCE INTERVAL. Pyth publishes price ± confidence (stdev);
 *        `/price-data` returns a bare `quote`, no uncertainty band. FeedView
 *        has no confidence field today, son nothing downstream breaks – but
 *        any risk logic added later that assumes Pyth-grade confidence must
 *        NOT point at this oracle without deriving one first (candidate:
 *        bid/ask spread from the *authenticated* xChange RFQ endpoint,
 *        /trades/xchange/assets/{id} – not available on the public tier).
 *
 *     2. NO PUBLISH TIMESTAMP. The API returns only the current quote, not
 *        when it was last updated venue-side – so `isStale` here reflects
 *        OUR fetch clock (age since we last saw a non-null quote), not a
 *        venue publish_time the way Pyth's did.
 *
 *     3. `currentPeriod` string values are inferred from the one example in
 *        the docs ("market"); exact enum (pre-market/after-hours/closed
 *        naming) is NOT confirmed – verify against a live response before
 *        trusting the EXTENDED mapping below.
 *
 *     4. `quote: null` (halted / no live price) is treated as
 *        stale/unavailable rather than thrown, mirroring the old
 *        Pyth-unlicensed fallback shape (priceCents: -1, isStale: true).
 */

const DEFAULT_XSTOCKS_API = "https://api.xstocks.fi/api/v2";

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

export class XStocksOracle implements PriceOracle {
    /** Last time we saw a non-null quote per symbol – own-clock staleness. */
    private lastSeen = new Map<string, number>();

    constructor(
        private stalenessMs = 120_000,
        private endpoint = process.env.XSTOCKS_API_URL ?? DEFAULT_XSTOCKS_API,
    ) {}

    private async fetchPrice(symbol: string): Promise<number | null> {
        const res = await fetch(`${this.endpoint}/public/assets/${symbol}/price-data`);
        if (!res.ok) throw new Error(`xstocks price-data failed for ${symbol}: ${res.status}`);
        const body = (await res.json()) as XStocksPriceData;
        return body.quote;
    }

    private async fetchSession(symbol: string): Promise<number> {
        const res = await fetch(`${this.endpoint}/public/assets/${symbol}`);
        if (!res.ok) return SESSION.CLOSED; // fail closed on unknown state
        const body = (await res.json()) as XStocksAsset;
        if (body.isTradingHalted || body.trading?.isTradingHalted) return SESSION.CLOSED;
        const period = body.trading?.currentPeriod?.toLowerCase();
        if (period === "market") return SESSION.OPEN;
        if (period === "pre-market" || period === "after-hours" || period === "extended") {
            return SESSION.EXTENDED; // TODO_VERIFY exact string values
        }
        if (body.trading?.openNow) return SESSION.OPEN;
        return SESSION.CLOSED;
    }

    async getFeeds(symbols: string[]): Promise<Record<string, FeedView>> {
        const now = Date.now();
        const out: Record<string, FeedView> = {};
        await Promise.all(
            symbols.map(async (symbol) => {
                try {
                    const [quote, marketSession] = await Promise.all([
                        this.fetchPrice(symbol),
                        this.fetchSession(symbol),
                    ]);
                    if (quote === null) {
                        out[symbol] = {symbol, priceCents: -1, marketSession, isStale: true };
                        return;
                    }
                    this.lastSeen.set(symbol, now);
                    out[symbol] = { symbol, priceCents: Math.round(quote * 100), marketSession, isStale: false };
                } catch {
                    const lastOkAt = this.lastSeen.get(symbol);
                    out[symbol] = {
                        symbol,
                        priceCents: -1,
                        marketSession: SESSION.CLOSED,
                        isStale: lastOkAt === undefined || now - lastOkAt > this.stalenessMs,
                    };
                }
            }),
        );
        return out;
    }
}