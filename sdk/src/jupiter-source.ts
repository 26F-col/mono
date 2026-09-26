// Verified against Jupiter's current docs (developers.jup.ag/docs/price):
// base URL api.jup.ag, endpoint /price/v3?ids=..., auth via the x-api-key
// header — Pro tier. Jupiter also documents a keyless "Lite" base
// (lite-api.jup.ag/price/v3, ~0.5 RPS) for exactly the no-key case.
const JUPITER_PRO_BASE = "https://api.jup.ag/price/v3";
const JUPITER_LITE_BASE = "https://lite-api.jup.ag/price/v3";
const DEFAULT_TIMEOUT_MS = 8000;

export class JupiterPriceSource {
    constructor(
        private apiKey: string,
        private timeoutMs = DEFAULT_TIMEOUT_MS,
        private proBase = JUPITER_PRO_BASE,
        private liteBase = JUPITER_LITE_BASE,
    ) {}

    async getPrices(mints: string[]): Promise<Record<string, number>> {
        if (mints.length === 0) return {};

        // No key configured: the Pro endpoint rejects a blank x-api-key, so use
        // Jupiter's own keyless Lite endpoint instead of failing outright.
        const usingLite = !this.apiKey;
        const base = usingLite ? this.liteBase : this.proBase;
        const params = new URLSearchParams({ ids: mints.join(",") });
        const headers: Record<string, string> = usingLite ? {} : { "x-api-key": this.apiKey };

        const res = await fetch(`${base}?${params.toString()}`, {
            headers,
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) throw new Error(`Jupiter HTTP ${res.status} (${usingLite ? "lite" : "pro"})`);

        const json = (await res.json()) as Record<string, { usdPrice?: number }>;
        const out: Record<string, number> = {};
        for (const [mint, data] of Object.entries(json)) {
            if (data?.usdPrice != null) out[mint] = Math.round(data.usdPrice * 100);
        }
        return out;
    }
}