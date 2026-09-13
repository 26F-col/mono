// Browser polyfills for Solana stack (must be imported FIRST in main.tsx).
import { Buffer } from "buffer";

const g = globalThis as any;
if (!g.Buffer) g.Buffer = Buffer;
if (!g.global) g.global = globalThis;
if (!g.process) g.process = { env: {}, version: "", browser: true };
