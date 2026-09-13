import type { FeedView } from "./risk";
import type { PriceOracle } from "./oracle";
import { SESSION } from "./config";

/**
 * Pyth Hermes oracle for the PRIVATE risk engine (gap-5, oracle half).
 *
 * VERIFIED against live endpoints (2026-09-13, see docs/DEPENDENCIES.md):
 *   - `https://pyth.dourolabs.app/hermes/v2` and `https://hermes.pyth.network/v2`
 *     both serve /price_feeds metadata WITHOUT a key, including per-symbol
 *     `market_hours.is_open` — which this oracle uses as the REAL
 *     market-session signal (replacing the mock session flag).
 *   - `/updates/price/latest` (the actual prices) returns "unauthorized"
 *     without a licensed endpoint/key. Callers with a license should point
 *     `PYTH_HERMES_URL` (or the constructor) at their licensed Hermes base
 *     URL; the latest-price path is standard Hermes v2.
 *
 * The on-chain MockOracleClient remains the DEMO oracle for the dashboard;
 * a production risk engine would consume Pyth price updates on-chain via
 * the pyth-solana-receiver program (TODO_VERIFY against current docs).
 */

const DEFAULT_HERMES = "https://pyth.dourolabs.app/hermes/v2";

/** Pyth price feed ids for the demo universe (Equity.US.*, verified live). */
export const PYTH_EQUITY_FEEDS: Record<string, string> = {
  SPYx: "19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd",
  AAPLx: "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
  NVDAx: "b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593",
};

/** US equity market session from wall-clock time (Eastern) — fallback only. */
export function marketSessionNow(now = new Date()): number {
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return SESSION.CLOSED;
  const mins = et.getHours() * 60 + et.getMinutes();
  if (mins >= 570 && mins < 960) return SESSION.OPEN; // 09:30–16:00
  if (mins >= 240 && mins < 1200) return SESSION.EXTENDED; // 04:00–20:00
  return SESSION.CLOSED;
}

interface HermesFeed {
  id: string;
  attributes: { symbol?: string; base?: string; display_symbol?: string };
  market_hours?: { is_open?: boolean };
}

export class PythHermesOracle implements PriceOracle {
  private resolved = new Map<string, string>();

  constructor(
    private stalenessSeconds = 120,
    private endpoint = process.env.PYTH_HERMES_URL ?? DEFAULT_HERMES,
  ) {}

  private async resolveId(symbol: string): Promise<string> {
    const known = PYTH_EQUITY_FEEDS[symbol];
    if (known) {
      this.resolved.set(symbol, known);
      return known;
    }
    const base = symbol.replace(/x$/, "");
    const res = await fetch(`${this.endpoint}/price_feeds?query=Equity.US.${base}%2FUSD&asset_type=equity`);
    if (!res.ok) throw new Error(`pyth feed lookup failed: ${res.status}`);
    const feeds = (await res.json()) as HermesFeed[];
    if (!feeds.length) throw new Error(`no pyth feed for ${symbol}`);
    this.resolved.set(symbol, feeds[0].id);
    return feeds[0].id;
  }

  /**
   * Real market-session state from Pyth's market_hours + (if the endpoint is
   * licensed) real prices. Prices fall back to -1 with isStale=true when the
   * endpoint refuses, so callers can distinguish "no live price" from data.
   */
  async getFeeds(symbols: string[]): Promise<Record<string, FeedView>> {
    const ids: string[] = [];
    for (const s of symbols) ids.push(await this.resolveId(s));
    const query = ids.map((id) => `ids%5B%5D=${id}`).join("&");
    const res = await fetch(`${this.endpoint}/updates/price/latest?${query}`);
    if (!res.ok) {
      if (res.status === 401 || /unauthorized/i.test(await res.text().then((t) => t.slice(0, 100)))) {
        // Licensed endpoint required: return real SESSION from metadata,
        // price unknown.
        const out: Record<string, FeedView> = {};
        for (const s of symbols) {
          out[s] = {
            symbol: s,
            priceCents: -1,
            marketSession: await this.sessionFromMetadata(s),
            isStale: true,
          };
        }
        return out;
      }
      throw new Error(`hermes latest failed: ${res.status}`);
    }
    const body = (await res.json()) as { parsed: any[] };
    const nowSec = Math.floor(Date.now() / 1000);
    const out: Record<string, FeedView> = {};
    body.parsed.forEach((p, i) => {
      const expo = Math.abs(Number(p.price.expo));
      const priceUsd = Number(p.price.price) / 10 ** expo;
      out[symbols[i]] = {
        symbol: symbols[i],
        priceCents: Math.round(priceUsd * 100),
        marketSession: marketSessionNow(),
        isStale: nowSec - Number(p.price.publish_time) > this.stalenessSeconds,
      };
    });
    return out;
  }

  /** Real session from Pyth metadata market_hours (public, no key). */
  async sessionFromMetadata(symbol: string): Promise<number> {
    const base = symbol.replace(/x$/, "");
    const res = await fetch(
      `${this.endpoint}/price_feeds?query=Equity.US.${base}%2FUSD&asset_type=equity`,
    );
    if (!res.ok) return marketSessionNow();
    const feeds = (await res.json()) as HermesFeed[];
    const isOpen = feeds[0]?.market_hours?.is_open;
    if (isOpen === undefined) return marketSessionNow();
    return isOpen ? SESSION.OPEN : SESSION.CLOSED;
  }
}
