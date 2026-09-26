const UNDERLYING: Record<string, string> = {
    SPYx: "SPY",
    AAPLx: "AAPL",
    NVDAx: "NVDA",
};

const DEFAULT_BASE_URL = "https://query1.finance.yahoo.com/v8/finance/chart";

/**
 * KNOWN RELIABILITY RISK (verified against current reports, not just old
 * training data): Yahoo's anti-bot detection operates at the TLS fingerprint
 * level (JA3/JA4), not just headers — a plain runtime `fetch` (no browser TLS
 * impersonation) can get HTTP 429 on every request to query{1,2}.finance.yahoo.com
 * regardless of User-Agent or other headers. The `/v8/finance/chart` endpoint
 * itself generally does not require the cookie+crumb dance other Yahoo
 * endpoints need, but that doesn't help if the TLS handshake itself gets you
 * rate-limited. In other words: this tier may fail often or always in
 * production depending on the runtime's TLS stack and Yahoo's current
 * blocking behavior, which can change without notice. Treat it as
 * best-effort, not a reliable Level 2 — getLastCloseCents() already returns
 * null on any failure, so callers fall through to the next tier correctly;
 * this comment is here so a 429 in the logs isn't mistaken for a code bug.
 */
export class YahooPriceSource {
    constructor(
        private underlyingMap: Record<string, string> = UNDERLYING,
        private timeoutMs = 8000,
        private baseUrl = DEFAULT_BASE_URL,
    ) {}

    async getLastCloseCents(symbol: string): Promise<number | null> {
        const underlying = this.underlyingMap[symbol];
        if (!underlying) return null;

        const usd = await this.fetchYahooLastClose(underlying);
        return usd !== null && usd > 0 ? Math.round(usd * 100) : null;
    }

    private async fetchYahooLastClose(underlying: string): Promise<number | null> {
        const url = `${this.baseUrl}/${encodeURIComponent(underlying)}?interval=1d&range=5d`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const res = await fetch(url, {
                signal: controller.signal,
                headers: { "User-Agent": "Mozilla/5.0 (compatible; CML-oracle/1.0)" },
            });
            if (!res.ok) {
                if (res.status === 429) {
                    // Distinguish this from an ordinary miss in the logs — see the
                    // class-level comment on why this can be persistent, not transient.
                    console.warn(`[yahoo] ${underlying}: HTTP 429 (rate-limited/blocked)`);
                }
                return null;
            }
            const body = (await res.json()) as any;
            const result = body?.chart?.result?.[0];
            if (!result) return null;

            const closes: (number | null)[] = result.indicators?.quote?.[0]?.close ?? [];
            for (let i = closes.length - 1; i >= 0; i--) {
                const c = closes[i];
                if (typeof c === "number" && Number.isFinite(c) && c > 0) return c;
            }
            const reg = result.meta?.regularMarketPrice;
            if (typeof reg === "number" && reg > 0) return reg;
            return null;
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }
}