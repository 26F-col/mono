import { XStocksOracle, DEFAULT_XSTOCKS_API } from "../sdk/src/xstocks";
import { TEST_ASSETS } from "../sdk/src/config";

const CONFIG = {
    endpoint: process.env.XSTOCKS_API_URL ?? DEFAULT_XSTOCKS_API,
    stalenessMs: 120_000,
    timeoutMs: 8_000,
    cacheTtlMs: 15_000,
};

// Collect all onError calls to:
//   (a) print them in fail() - for failure diagnostics,
//   (b) catch partial failures that the feed health check doesn't show
//       (e.g., fetchSession fails but fetchPrice succeeds -> the feed appears
//       healthy, even though the session is forced to CLOSED).
//   (c) verify that a warm call produces no errors (the cache should short-circuit before fetchOne.)
interface CollectedError {
    symbol: string;
    phase: "price" | "session";
    message: string;
}

function installFetchCounter(): {
    count: () => number;
    timestamp: () => number[];
    reset: () => void;
    uninstall: () => void;
} {
    const original = globalThis.fetch;
    const starts: number[] = [];
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
        starts.push(Date.now());
        return original(...args);
    }) as typeof fetch;
    return {
        count: () => starts.length,
        timestamp: () => starts.slice(),
        reset: () => {
            starts.length = 0;
        },
        uninstall: () => {
            globalThis.fetch = original;
        },
    };
}

function fail(msg: string, errors: CollectedError[]): never {
    console.error(`\nSMOKE FAIL: ${msg}`);
    console.error(`Run config: ${JSON.stringify(CONFIG)}`);
    if (errors.length > 0) {
        console.error(`Collected ${errors.length} onError call(s):`);
        for (const e of errors) {
            console.error(` - ${e.symbol} [${e.phase}]: ${e.message}`);
        }
    } else {
        console.error("No onError calls collected (failure was not from fetch).");
    }
    process.exitCode = 1;
    throw new Error(msg);
}

function formatErrors(errors: CollectedError[]): string {
    if (errors.length === 0) return "(none)";
    return errors.map((e) => `${e.symbol}[${e.phase}]`).join(", ");
}

async function main() {
    const symbols = TEST_ASSETS.map((a) => a.symbol);
    if (symbols.length === 0) {
        console.error("SMOKE FAIL: TEST_ASSETS is empty - nothing to check");
        process.exitCode = 1;
        return;
    }

    console.log(`Run config: ${JSON.stringify(CONFIG)}`);
    console.log(`Symbols: ${symbols.join(", ")}`);

    const collectedErrors: CollectedError[] = [];
    const onError = (symbol: string, phase: "price" | "session", err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        collectedErrors.push({ symbol, phase, message });
        console.warn(`[xstocks] WARN ${phase} fetch failed for ${symbol}:`, message);
    };

    const oracle = new XStocksOracle(
        CONFIG.stalenessMs,
        CONFIG.endpoint,
        CONFIG.timeoutMs,
        CONFIG.cacheTtlMs,
        onError,
    );
    const counter = installFetchCounter();

    try {
        // Cold call
        const coldStart = Date.now();
        const feelsCold = await oracle.getFeeds(symbols);
        const coldElapsed = Date.now() - coldStart;
        const coldCalls = counter.count();
        const coldTs = counter.timestamp();
        const coldErrors = collectedErrors.slice();

        // 1) Healthcheck for each feed - most informative in the event of an API failure.
        for (const symbol of symbols) {
            const feed = feelsCold[symbol];
            if (!feed) fail(`${symbol} - no result from getFeeds`, coldErrors);
            if (feed.symbol !== symbol) {
                fail(`${symbol} - feed.symbol=${feed.symbol} (key desynchronization)`, coldErrors);
            }
            console.log(
                `  [cold] ${symbol}: pricesCents=${feed.priceCents} marketSession=${feed.marketSession} isStale=${feed.isStale}`,
            );
            if (feed.priceCents <= 0 || feed.isStale) {
                fail(
                    `${symbol} - there is no realistic price (priceCents=${feed.priceCents}, isStale=${feed.isStale}). ` +
                    `See onError below to distinguish between "trading halted and network down.".`,
                    coldErrors,
                );
            }
        }

        // 2) Partial failures. The Health check above does NOT catch the case where fetchSession
        // failed but fetchPrice succeeded: the feed outputs priceCents > 0, isStale = false,
        // and marketSession = CLOSED (forced). It looks healthy even though the session
        // is actually unknown. onError is the only signal
        if (coldErrors.length > 0) {
            console.warn(
                `WARN: all feeds are healthy, but onError was called ${coldErrors.length} time(s): ${formatErrors(coldErrors)}. ` +
                `This could be a partial failure (e.g., session is down but price is fine) - the feed appears healthy, ` +
                `but marketSession for such symbols is forced to CLOSED.`
            );
        }

        // 3) Now that all feeds are healthy, chacking the number of requests makes sense.
        const expectedColdCalls = symbols.length * 2;
        if (coldCalls !== expectedColdCalls) {
            fail(
                `cold call made ${coldCalls} HTTP-requests, expected ${expectedColdCalls} ` +
                `(${symbols.length} * 2). All feeds are healthy and onError ${coldErrors.length}, ` +
                `so this is a regression in getFeeds (duplication or structure change).`,
                coldErrors,
            );
        }

        // 4) Concurrency through timestamps - regardless of API speed.
        if (symbols.length > 1) {
            const firstBatchSpread = coldTs[symbols.length - 1] - coldTs[0];
            const SPREAD_THRESHOLD_MS = 500;
            if (firstBatchSpread > SPREAD_THRESHOLD_MS) {
                fail(
                    `the first ${symbols.length} fetchPrice requests started with a spread of ${firstBatchSpread}ms ` +
                    `(threshold ${SPREAD_THRESHOLD_MS}ms). In parallel getFeeds, they start in one tick` +
                    `Promise.all; large spread = sequential processing.`,
                    coldErrors,
                );
            }
        }

        // Warm call
        counter.reset();
        collectedErrors.length = 0;
        const warmStart = Date.now();
        const feedsWarm = await oracle.getFeeds(symbols);
        const warmElapsed = Date.now() - warmStart;
        const warmCalls = counter.count();
        const warmErrors = collectedErrors.slice();

        const gapSinceLastFetch = warmStart - coldStart - coldElapsed;
        if (gapSinceLastFetch >= CONFIG.cacheTtlMs) {
            console.warn(
                `WARN: at least has passed between cold and warm ${gapSinceLastFetch}ms ` +
                `(>= cacheTtlMs=${CONFIG.cacheTtlMs}ms) - the cache had the right to rot, ` +
                `skipping "0 requests" check.`,
            );
        } else if (warmCalls !== 0) {
            fail(
                `Warm getFeeds() make ${warmCalls} HTTP-requests instead of 0 (within the TTl) - the cache missed.`,
                warmErrors,
            );
        }

        // 5) Warm call should not generate any onError: cache head
        // short close TOO fetchOne. If there are errors here - or cache
        // didn't work (already checked above), or something else weird.
        if (warmErrors.length > 0) {
            fail(
                `Warm call create ${warmErrors.length} onError call(s): ${formatErrors(warmErrors)}. ` +
                `The cache should have returned everything offline - no fetches, no errors.`,
                warmErrors,
            );
        }

        for (const symbol of symbols) {
            const warm = feedsWarm[symbol];
            if (!warm) fail(`${symbol} - don't have warm-feed from getFeeds (regression)`, warmErrors);
            console.log(`[warm] ${symbol}: priceCents=${warm.priceCents} (from cache)`);
        }

        const firstBatchSpread = symbols.length > 1 ? coldTs[symbols.length - 1] - coldTs[0] : 0;
        console.log(
            `\nSMOKE OK - cold: ${coldCalls} requests by ${coldElapsed}ms ` +
            `(spread the first moment: ${firstBatchSpread}ms, onError: ${coldErrors.length}); ` +
            `warm: ${warmCalls} request from ${warmElapsed}ms (cache verified).`,
        );
    } finally {
        counter.uninstall();
    }
}

main().catch((e) => {
    if (process.exitCode !== 1) {
        console.error("SMOKE FAIL (unhandled):", e);
        console.error(`Run config: ${JSON.stringify(CONFIG)}`);
        process.exitCode = 1;
    }
});