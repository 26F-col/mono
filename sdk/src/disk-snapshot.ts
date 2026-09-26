import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { FeedView } from "./risk";

export interface PriceSnapshot {
    symbol: string;
    priceCents: number;
    marketSession: FeedView["marketSession"];
    savedAt: number; // Unix timestamp (ms)
}

const DEFAULT_SNAPSHOT_PATH = join(process.cwd(), "data", "price-snapshots.json");
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

/**
 * Durable last-known-price fallback, one JSON file on disk.
 *
 * - Writes are ATOMIC: data is written to a temp file, then renamed over the
 *   real path. A crash mid-write leaves only the temp file — the real file
 *   is never left half-written / unparsable.
 * - A corrupt file is renamed aside (never silently discarded), so history
 *   isn't lost without a trace and can be inspected/recovered.
 * - Concurrency: the in-memory cache is loaded once per instance. Every save
 *   re-reads the file and merges by per-symbol `savedAt` (newest wins) before
 *   writing, so another process/instance writing this file is picked up
 *   rather than clobbered wholesale. This is a best-effort mitigation, not a
 *   lock: two saves racing within the same few milliseconds can still
 *   interleave. For anything beyond a best-effort fallback cache, use a real
 *   datastore with actual locking instead.
 */
export class DiskSnapshotSource {
    private cache: Map<string, PriceSnapshot> | null = null;

    constructor(private path: string = DEFAULT_SNAPSHOT_PATH) {}

    private async readFromDisk(): Promise<Map<string, PriceSnapshot>> {
        if (!existsSync(this.path)) return new Map();
        let raw: string;
        try {
            raw = await readFile(this.path, "utf-8");
        } catch {
            return new Map();
        }
        try {
            const arr: PriceSnapshot[] = JSON.parse(raw);
            return new Map(arr.map((s) => [s.symbol, s]));
        } catch (err) {
            // Don't silently drop history: move the corrupt file aside so it can be
            // inspected/recovered, and start fresh rather than pretending it was empty.
            const corruptPath = `${this.path}.corrupt-${Date.now()}`;
            console.error(
                `[snapshot] ${this.path} is not valid JSON (${(err as Error).message}); ` +
                `moving it to ${corruptPath} and starting fresh`,
            );
            try {
                await rename(this.path, corruptPath);
            } catch (renameErr) {
                console.error(`[snapshot] could not rename corrupt file: ${(renameErr as Error).message}`);
            }
            return new Map();
        }
    }

    private async load(): Promise<Map<string, PriceSnapshot>> {
        if (this.cache) return this.cache;
        this.cache = await this.readFromDisk();
        return this.cache;
    }

    async getSnapshot(symbol: string): Promise<PriceSnapshot | null> {
        const snapshots = await this.load();
        const snap = snapshots.get(symbol);
        if (!snap) return null;
        const age = Date.now() - snap.savedAt;
        if (age > MAX_AGE_MS) {
            console.warn(`[snapshot] ${symbol} too old (${Math.round(age / 3_600_000)}h)`);
            return null;
        }
        return snap;
    }

    /** Save one snapshot. Prefer saveSnapshots() when writing several at once
     *  (e.g. once per getFeeds() call) — each call here is a full file rewrite. */
    async saveSnapshot(snap: PriceSnapshot): Promise<void> {
        await this.saveSnapshots([snap]);
    }

    /** Save several snapshots in a single file write. */
    async saveSnapshots(snaps: PriceSnapshot[]): Promise<void> {
        if (snaps.length === 0) return;
        await this.load(); // ensure this.cache is populated before merging

        // Merge with what's on disk right now (may have been written by another
        // process/instance since we last loaded), preferring whichever side is
        // newer per symbol, then apply our own fresh writes on top.
        const onDisk = await this.readFromDisk();
        const merged = new Map(this.cache);
        for (const [symbol, diskSnap] of onDisk) {
            const memSnap = merged.get(symbol);
            if (!memSnap || diskSnap.savedAt > memSnap.savedAt) merged.set(symbol, diskSnap);
        }
        for (const snap of snaps) merged.set(snap.symbol, snap); // our writes always win
        this.cache = merged;

        const dir = dirname(this.path);
        if (!existsSync(dir)) await mkdir(dir, { recursive: true });

        const tmpPath = `${this.path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const data = JSON.stringify([...merged.values()], null, 2);
        await writeFile(tmpPath, data, "utf-8");
        await rename(tmpPath, this.path);
    }
}