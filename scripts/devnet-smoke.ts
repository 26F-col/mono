/**
 * DEVNET end-to-end smoke test for the deployed programs.
 *
 * Prereq: `bash scripts/deploy-devnet.sh` (programs on devnet) and the deploy
 * wallet funded. Runs the full credit cycle:
 *
 *   mints + feeds + policy + gate → deposit → confidential commit →
 *   private eval → Ed25519-attested credit request → NVDA stress →
 *   margin-call report → recovery → repay
 *
 * RESUMABLE: safe to re-run after partial failures. Existing on-chain state
 * (feeds, policy, gate, vault, deposits) is detected and reused; only missing
 * pieces are created. The recovered equity mints are mapped by POLICY ORDER
 * (policy.assets[i] corresponds to TEST_ASSETS[i]).
 *
 * Writes app/public/devnet-state.json so the app can run with ?cluster=devnet.
 */
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { ConfidentialMarginClient, demoKeypair } from "../sdk/src/client";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  DEMO_PORTFOLIO,
  DEMO_REQUEST_USDC_MICROS,
  SESSION,
  STATUS,
  STATUS_NAME,
  TEST_ASSETS,
} from "../sdk/src/config";

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const ADVANCE_RATES: Record<string, number> = { SPYx: 8000, AAPLx: 7000, NVDAx: 6000 };
const TREASURY_TARGET_USDC = 1_000_000_000_000; // $1M test-USDC

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Devnet public RPC rate-limits aggressively: space ops out and retry 429s. */
async function robust<T>(label: string, fn: () => Promise<T>, tries = 10): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const out = await fn();
      await sleep(2500);
      return out;
    } catch (e: any) {
      last = e;
      const msg = String(e?.message ?? e);
      if (/429|Too Many|blockhash|timeout/i.test(msg)) {
        const wait = 12_000 * (Math.min(i, 4) + 1);
        console.log(`    … ${label}: ${msg.includes("429") ? "429" : "retryable"} — waiting ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
  throw last;
}

async function main() {
  const walletPath = process.env.ANCHOR_WALLET || path.join(process.env.HOME!, ".config/solana/id.json");
  const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(walletPath, "utf8"))));
  const conn = new Connection(RPC, "confirmed");
  const provider = new AnchorProvider(conn, new Wallet(payer), { commitment: "confirmed" });

  const oracleAuth = demoKeypair("oracle-authority");
  const policyAuth = demoKeypair("policy-authority");
  const attester1 = demoKeypair("attester-1");
  const attester2 = demoKeypair("attester-2");
  const attesters = [attester1, attester2];
  const institution = demoKeypair("institution");
  const lender = demoKeypair("lender");
  const gateAuth = demoKeypair("gate-authority");

  const balance = await conn.getBalance(payer.publicKey);
  console.log(`deployer ${payer.publicKey.toBase58()} balance ${(balance / LAMPORTS_PER_SOL).toFixed(3)} SOL on ${RPC}`);
  if (balance / LAMPORTS_PER_SOL < 1.5) {
    throw new Error("deployer wallet needs ≥ ~1.5 SOL for the smoke test (fees + actor rents)");
  }

  const client = new ConfidentialMarginClient(provider, oracleAuth);

  const fund = async (k: Keypair, sol: number) => {
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: k.publicKey, lamports: Math.round(sol * LAMPORTS_PER_SOL) }),
    );
    await provider.sendAndConfirm(tx, []);
  };

  // Fund all actors BEFORE any on-chain interaction (fee payers + rents).
  await fund(oracleAuth, 0.15);
  await fund(institution, 0.6);
  await fund(gateAuth, 0.25);
  await fund(lender, 0.15);
  await fund(policyAuth, 0.1);

  // ---------------------------------------------------------------- backend
  // Detect pre-existing backend state so re-runs resume instead of conflict.
  const gateExists = (await conn.getAccountInfo(ConfidentialMarginClient.gatePda())) !== null;
  console.log(`[1] backend state: ${gateExists ? "existing (resuming)" : "fresh"}`);

  let mints;
  if (gateExists) {
    // Recover the mints pinned by the existing gate/policy (policy asset order
    // is deterministic: TEST_ASSETS order).
    const gate = await robust("read gate", () => client.getGate());
    const policy = await robust("read policy", () => client.getPolicy(policyAuth.publicKey));
    const bySymbol = new Map<string, { mint: PublicKey; decimals: number; priceCents: number }>();
    TEST_ASSETS.forEach((a, i) =>
      bySymbol.set(a.symbol, { mint: policy.assets[i].mint, decimals: a.decimals, priceCents: a.initialPriceCents }),
    );
    mints = { usdc: gate.usdcMint, bySymbol };
    client.bindMints(mints);
    console.log(`    = reusing usdc ${mints.usdc.toBase58().slice(0, 8)}… and ${bySymbol.size} equity mints`);
  } else {
    mints = await robust("create mints", () => client.createTestMints(payer));
    for (const a of TEST_ASSETS) {
      await robust(`feed ${a.symbol}`, () => client.oracle.initializeFeed(a.symbol, a.initialPriceCents, 4500));
    }
    await robust("initialize policy", () =>
      client.initializePolicy(
        policyAuth,
        TEST_ASSETS.map((a) => ({
          mint: mints!.bySymbol.get(a.symbol)!.mint,
          advanceRateBps: ADVANCE_RATES[a.symbol],
        })),
      ),
    );
    await robust("initialize gate", () =>
    client.initializeGate(
      gateAuth,
      [attester1.publicKey, attester2.publicKey, demoKeypair("attester-3").publicKey],
      2,
    ),
  );
  }

  await fund(oracleAuth, 0.15);
  await fund(institution, 0.6);
  await fund(gateAuth, 0.25);
  await fund(lender, 0.15);
  await fund(policyAuth, 0.1);

  // Lender holds the treasury liquidity; top up if a previous run spent it.
  await robust("fund lender USDC", () => client.fundUsdc(payer, lender.publicKey, TREASURY_TARGET_USDC));
  await robust("top up treasury", () => client.fundTreasury(lender, TREASURY_TARGET_USDC));

  // Mint fresh portfolio tokens to the institution ONLY for the shortfall
  // (a completed previous run already holds them).
  for (const h of DEMO_PORTFOLIO) {
    await robust(`mint ${h.symbol}`, () => client.mintAsset(payer, h.symbol, institution.publicKey, h.qtyUnits));
  }
  console.log("    ✔ backend accounts ready");

  // ------------------------------------------------------------------ vault
  const vaultPda = ConfidentialMarginClient.vaultPda(institution.publicKey);
  const vaultExists = (await conn.getAccountInfo(vaultPda)) !== null;
  if (!vaultExists) {
    await robust("initialize vault", () => client.initializeVault(institution, policyAuth.publicKey));
  } else {
    console.log("    = vault exists (resuming)");
  }

  // Deposit exactly the shortfall per asset (deposits are cumulative).
  for (const h of DEMO_PORTFOLIO) {
    const mint = mints.bySymbol.get(h.symbol)!.mint;
    const custody = ConfidentialMarginClient.custodyPda(vaultPda, mint);
    const balInfo = await robust(`custody ${h.symbol}`, () =>
      conn.getTokenAccountBalance(custody).catch(() => null),
    );
    const bal = balInfo ? Number(balInfo.value.amount) : 0;
    const shortfall = h.qtyUnits - bal;
    if (shortfall > 0) {
      await robust(`deposit ${h.symbol}`, () => client.depositCollateral(institution, h.symbol, shortfall));
      console.log(`    ✔ deposited ${shortfall} ${h.symbol} (shortfall)`);
    } else {
      console.log(`    = ${h.symbol} already locked (${bal})`);
    }
  }

  // Re-commit on EVERY run: a fresh snapshot version is required for a fresh
  // credit draw (nonce must strictly increase past any consumed draw).
  const { commitment } = await robust("commit snapshot", () =>
    client.commitPortfolio(institution, {
      institution: institution.publicKey.toBase58(),
      holdings: DEMO_PORTFOLIO,
      navCents: 100_000_000,
      committedAt: Date.now(),
    }),
  );
  const cross = await robust("attester cross-check", () =>
    client.attesterCrossCheck(DEMO_PORTFOLIO, institution.publicKey),
  );
  if (!cross.ok) throw new Error(`attester cross-check failed: ${JSON.stringify(cross.details)}`);
  console.log(`    ✔ locked + committed ${Buffer.from(commitment).toString("hex").slice(0, 12)}… (honesty guard ok)`);

  // ------------------------------------------------------------ credit flow
  // Repay any outstanding credit from a previous partial run first: the credit
  // draw is only permitted while the private evaluation is ELIGIBLE.
  const pre = await robust("read facility", () =>
    client.getFacility(institution.publicKey).catch(() => null),
  );
  if (pre && pre.outstandingUsdc > 0) {
    console.log(`    = repaying leftover outstanding ${pre.outstandingUsdc / 1e6} USDC from a previous run`);
    await robust("repay leftover", () =>
      client.repay({ institution, amountUsdcMicros: pre.outstandingUsdc }),
    );
  }

  console.log("[3] requesting $300k credit (private eval → Ed25519 attestation → gate)…");
  // Fresh oracle publishes first: stale feeds legitimately make the collateral
  // ineligible, and the gate would (correctly) refuse the draw.
  for (const a of TEST_ASSETS) {
    await robust(`refresh price ${a.symbol}`, () => client.oracle.setPrice(a.symbol, a.initialPriceCents));
    await robust(`session ${a.symbol}`, () => client.oracle.setMarketSession(a.symbol, SESSION.OPEN));
  }
  const policy = await robust("read policy (2)", () => client.getPolicy(policyAuth.publicKey));
  const preRisk = await robust("pre-evaluate", () =>
    client.evaluatePrivately({
      holdings: DEMO_PORTFOLIO,
      policy,
      requestedUsdcMicros: DEMO_REQUEST_USDC_MICROS,
    }),
  );
  if (preRisk.decision !== "ELIGIBLE") {
    throw new Error(`private evaluation is ${preRisk.decision} (HF ${(preRisk.healthFactorBps / 10000).toFixed(2)}×) — not requesting`);
  }
  const req = await robust("request credit", () =>
    client.requestCreditWithHoldings({
      institution,
      attesters,
      policyAuthority: policyAuth.publicKey,
      holdings: DEMO_PORTFOLIO,
      requestedUsdcMicros: DEMO_REQUEST_USDC_MICROS,
    }),
  );
  if (req.risk.decision !== "ELIGIBLE" || req.risk.healthFactorBps !== 21000) {
    throw new Error(`unexpected baseline: ${req.risk.decision} HF ${req.risk.healthFactorBps}`);
  }
  const facility = await robust("read facility (2)", () => client.getFacility(institution.publicKey));
  if (facility.outstandingUsdc !== DEMO_REQUEST_USDC_MICROS) throw new Error("credit not released");
  console.log(`    ✔ LOAN APPROVED — ${facility.outstandingUsdc / 1e6} USDC outstanding, status COMPLIANT (HF 2.10 private)`);

  console.log("[4] stress: NVDA −30% → margin call report…");
  await robust("set NVDA price", () => client.oracle.setPrice("NVDAx", 70_00));
  const stressed = await robust("report margin status", () =>
    client.reportMarginStatus({
      submitter: lender,
      attesters,
      policyAuthority: policyAuth.publicKey,
      institution: institution.publicKey,
      holdings: DEMO_PORTFOLIO,
      requestedUsdcMicros: DEMO_REQUEST_USDC_MICROS,
    }),
  );
  const stressedFacility = await robust("read facility after stress", () =>
    client.getFacility(institution.publicKey),
  );
  if (stressed.risk.decision !== "MARGIN_CALL" || stressedFacility.marginStatus !== STATUS.MARGIN_CALL) {
    throw new Error(`unexpected stress state: ${stressed.risk.decision}`);
  }
  console.log(`    ✔ public margin status: ${STATUS_NAME[STATUS.MARGIN_CALL]} (portfolio stays confidential)`);

  console.log("[4b] deep stress: NVDA outage + SPY −20% + AAPL −10% (market closed) → INELIGIBLE…");
  await robust("simulate NVDA outage", () => client.oracle.simulateStale("NVDAx"));
  await robust("set SPY price", () => client.oracle.setPrice("SPYx", 400_00));
  await robust("set AAPL price", () => client.oracle.setPrice("AAPLx", 180_00));
  for (const a of TEST_ASSETS) {
    await robust(`close ${a.symbol}`, () => client.oracle.setMarketSession(a.symbol, SESSION.CLOSED));
  }
  const deep = await robust("report deep stress", () =>
    client.reportMarginStatus({
      submitter: lender,
      attesters,
      policyAuthority: policyAuth.publicKey,
      institution: institution.publicKey,
      holdings: DEMO_PORTFOLIO,
      requestedUsdcMicros: DEMO_REQUEST_USDC_MICROS,
    }),
  );
  if (deep.risk.decision !== "INELIGIBLE") throw new Error(`expected INELIGIBLE, got ${deep.risk.decision}`);
  console.log("    ✔ public margin status: INELIGIBLE — liquidation is now armed");

  console.log("[4c] liquidation: committee authorizes seizure of NVDA custody to the lender…");
  const nvdaMint = mints.bySymbol.get("NVDAx")!.mint;
  const lenderNvdaAta = getAssociatedTokenAddressSync(nvdaMint, lender.publicKey, false, TOKEN_2022_PROGRAM_ID);
  await robust("create lender NVDA ATA", () =>
    client.ensureAta(payer, lender.publicKey, nvdaMint),
  );
  await robust("execute liquidation", () =>
    client.executeLiquidation({
      submitter: lender,
      attesters,
      policyAuthority: policyAuth.publicKey,
      institution: institution.publicKey,
      holdings: DEMO_PORTFOLIO,
      seizeSymbol: "NVDAx",
      seizeAmount: 200_000,
      receiver: lenderNvdaAta,
    }),
  );
  const seized = await robust("read seized custody", () =>
    conn.getTokenAccountBalance(ConfidentialMarginClient.custodyPda(
      ConfidentialMarginClient.vaultPda(institution.publicKey),
      nvdaMint,
    )),
  );
  if (Number(seized.value.amount) !== 0) throw new Error("seizure did not empty NVDA custody");
  console.log("    ✔ 2,000 NVDAx seized from custody → lender (facility LIQUIDATED, debt extinguished)");

  console.log("[5] recovery: prices restored → COMPLIANT → repay…");
  await robust("restore NVDA price", () => client.oracle.setPrice("NVDAx", 100_00));
  await robust("report compliant", () =>
    client.reportMarginStatus({
      submitter: lender,
      attesters,
      policyAuthority: policyAuth.publicKey,
      institution: institution.publicKey,
      holdings: DEMO_PORTFOLIO,
      requestedUsdcMicros: DEMO_REQUEST_USDC_MICROS,
    }),
  );
  const preClose = await robust("read facility pre-close", () => client.getFacility(institution.publicKey));
  if (preClose.outstandingUsdc > 0) {
    await robust("repay", () => client.repay({ institution, amountUsdcMicros: preClose.outstandingUsdc }));
  }
  const closed = await robust("read facility after close", () => client.getFacility(institution.publicKey));
  if (closed.outstandingUsdc !== 0) throw new Error("close failed");
  console.log(`    ✔ facility closed — outstanding 0, status ${STATUS_NAME[closed.marginStatus]}`);

  const onDevnet = RPC.includes("devnet");
  const statePath = path.resolve(
    __dirname,
    `../app/public/${onDevnet ? "devnet" : "localnet"}-state.json`,
  );
  fs.writeFileSync(
    statePath,
    JSON.stringify(
      {
        cluster: onDevnet ? "devnet" : "localnet",
        rpc: RPC,
        mints: {
          usdc: mints.usdc.toBase58(),
          ...Object.fromEntries([...mints.bySymbol].map(([sym, v]) => [sym, v.mint.toBase58()])),
        },
        actors: {
          institution: institution.publicKey.toBase58(),
          policyAuthority: policyAuth.publicKey.toBase58(),
          attesters: [attester1.publicKey.toBase58(), attester2.publicKey.toBase58()],
        },
        programs: {
          mockOracle: "2fYvWaHejSYB1RNzsjrpQBMkmSNTXbYV9FWkRYXSj6Do",
          confidentialVault: "F5vxqZkc4tL4RxMjapgA4LM1qL3mskKur4RY6pjeyy4L",
          creditGate: "6uLcY78dvjTYhwLzZUmridf5zUiEmmDHpLhidHezao3S",
        },
        finishedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(`    ✔ devnet state written to ${path.relative(process.cwd(), statePath)}`);
  console.log("\nDEVNET END-TO-END SMOKE TEST PASSED");
}

main().catch((e) => {
  console.error("DEVNET SMOKE FAILED:", e?.message ?? e);
  process.exit(1);
});
