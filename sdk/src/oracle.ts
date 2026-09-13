import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { BN, Program } from "@coral-xyz/anchor";
import { PROGRAM_IDS, SESSION, symbolBytes } from "./config";
import type { FeedView } from "./risk";
import { Buffer } from "buffer";

/**
 * PriceOracle interface — the seam that isolates the risk engine from any
 * concrete oracle. The prototype ships MockOracleClient; a production
 * integration (e.g. Pyth) implements the same interface.
 */
export interface PriceOracle {
  /** Current feeds for the given symbols, including staleness + session. */
  getFeeds(symbols: string[]): Promise<Record<string, FeedView>>;
}

export function feedPda(symbol: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("price"), symbolBytes(symbol)],
    PROGRAM_IDS.mockOracle,
  )[0];
}

export class MockOracleClient implements PriceOracle {
  constructor(
    private connection: Connection,
    private program: Program,
    private authority: Keypair,
  ) {}

  async initializeFeed(symbol: string, priceCents: number, stalenessWindowSlots = 4500) {
    const sig = await this.program.methods
      .initializeFeed(symbolBytes(symbol), new BN(priceCents), new BN(stalenessWindowSlots))
      .accounts({
        authority: this.authority.publicKey,
        feed: feedPda(symbol),
        systemProgram: SystemProgram.programId,
      })
      .signers([this.authority])
      .rpc();
    return sig;
  }

  /** Publish a new price (publishes freshness too, like a real oracle). */
  async setPrice(symbol: string, priceCents: number) {
    return this.program.methods
      .setPrice(new BN(priceCents))
      .accounts({ authority: this.authority.publicKey, feed: feedPda(symbol) })
      .signers([this.authority])
      .rpc();
  }

  async setMarketSession(symbol: string, session: number) {
    if (session > SESSION.CLOSED) throw new Error("invalid session");
    return this.program.methods
      .setMarketSession(session)
      .accounts({ authority: this.authority.publicKey, feed: feedPda(symbol) })
      .signers([this.authority])
      .rpc();
  }

  /** DEMO CONTROL: simulate an oracle outage (feed goes stale). */
  async simulateStale(symbol: string) {
    return this.program.methods
      .simulateStaleFeed()
      .accounts({ authority: this.authority.publicKey, feed: feedPda(symbol) })
      .signers([this.authority])
      .rpc();
  }

  async getFeeds(symbols: string[]): Promise<Record<string, FeedView>> {
    const slot = await this.connection.getSlot("confirmed");
    const out: Record<string, FeedView> = {};
    for (const symbol of symbols) {
      const feed = (await (this.program.account as any).priceFeed.fetch(feedPda(symbol))) as any;
      const staleness = feed.stalenessWindowSlots as BN;
      const publishSlot = feed.publishSlot as BN;
      out[symbol] = {
        symbol,
        priceCents: feed.priceCents.toNumber(),
        marketSession: feed.marketSession,
        isStale: (feed.outage as boolean) || slot - publishSlot.toNumber() > staleness.toNumber(),
      };
    }
    return out;
  }
}

/**
 * TODO_VERIFY: Pyth integration placeholder.
 *
 * The prototype does NOT integrate Pyth. Whether Pyth publishes equity price
 * feeds usable on Solana devnet/localnet must be verified against current
 * Pyth documentation before any code is written against it (see
 * docs/DEPENDENCIES.md). This class exists only to keep the PriceOracle
 * seam explicit.
 */
export class PythOracleStub implements PriceOracle {
  async getFeeds(): Promise<Record<string, FeedView>> {
    throw new Error(
      "PythOracleStub: not integrated in this prototype (TODO_VERIFY). Use MockOracleClient.",
    );
  }
}
