/**
 * DEVNET end-to-end smoke test for the deployed programs (RESUMABLE).
 *
 * Every backend piece (mints, feeds, policy, gate, vault, deposits) is
 * deterministic or idempotent: re-running after a partial failure fills in
 * exactly what is missing. Finishes with the full credit cycle:
 * commit → 2-of-3 attested request → stress → margin call → deep stress →
 * liquidation → recovery.
 *
 * Writes app/public/devnet-state.json for the app's ?cluster=devnet mode.
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
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { ConfidentialMarginClient, demoKeypair } from "../sdk/src/client";
import {
  DEMO_PORTFOLIO,
  DEMO_REQUEST_USDC_MICROS,
  demoKeypair as seedDerivedKeypair,
  seedFor,
  SESSION,
  STATUS,
  STATUS_NAME,
  TEST_ASSETS,
} from "../sdk/src/config";

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const ADVANCE_RATES: Record<string, number> = { SPYx: 8000, AAPLx: 7000, NVDAx: 6000 };
const TREASURY_TARGET_USDC = 1_000_000_000_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function robust<T>(label: string, fn: () => Promise<T>, tries = 10): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const out = await fn();
      await sleep(2000);
      return out;
    } catch (e: any) {
      last = e;
      const msg = String(e?.message ?? e);
      if (/429|Too Many|blockhash|timeout/i.test(msg)) {
        const wait = 12_000 * (Math.min(i, 4) + 1);
        console.log(`    … ${label}: retryable — waiting ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
  throw last;
}

function alreadyInUse(e: unknown): boolean {
  return /already in use/i.test(String((e as any)?.message ?? e));
}

async function main() {
  const walletPath = process.env.ANCHOR_WALLET || path.join(process.env.HOME!, ".config/solana/id.json");
  const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(walletPath, "utf8"))));
  const conn = new Connection(RPC, "confirmed");
  const provider = new AnchorProvider(conn, new Wallet(payer), { commitment: "confirmed" });

  const oracleAuth = Keypair.fromSeed(seedFor("oracle-authority"));
  const policyAuth = demoKeypair("policy-authority");
  const attester1 = demoKeypair("attester-1");
  const attester2 = demoKeypair("attester-2");
  const attester3 = demoKeypair("attester-3"); // idle seat
  const attesters = [attester1, attester2];
  const institution = demoKeypair("institution");
  const lender = demoKeypair("lender");
  const gateAuth = demoKeypair("gate-authority");

  const balance = await conn.getBalance(payer.publicKey);
  console.log(`deployer ${payer.publicKey.toBase58()} balance ${(balance / LAMPORTS_PER_SOL).toFixed(3)} SOL on ${RPC}`);
  if (balance / LAMPORTS_PER_SOL < 0.5) {
    throw new Error("deployer wallet needs ≥ ~0.5 SOL for the smoke test");
  }

  const client = new ConfidentialMarginClient(provider, oracleAuth);

  const fund = async (k: Keypair, sol: number) => {
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: k.publicKey, lamports: Math.round(sol * LAMPORTS_PER_SOL) }),
    );
    await provider.sendAndConfirm(tx, []);
  };

  console.log(`[0] oracle authority (this run): ${oracleAuth.publicKey.toBase58()}`);
  console.log("[1] backend state detection…");
  const policyPda = ConfidentialMarginClient.policyPda(policyAuth.publicKey);
  const policyExists = (await conn.getAccountInfo(policyPda)) !== null;
  const gateExists = (await conn.getAccountInfo(ConfidentialMarginClient.gatePda())) !== null;
  console.log(`    policy=${policyExists ? "exists" : "missing"}, gate=${gateExists ? "exists" : "missing"}`);

  // Rebalance: sweep actor wallets into the payer, then top each up.
  // (Actor wallets accumulate SOL across runs; devnet faucet limits top-ups.)
  const actors = [oracleAuth, institution, gateAuth, lender, policyAuth];
  const KEEP = 1_000_000; // keep actors above rent-exemption (≈0.001 SOL)
  for (const k of actors) {
    const bal = await conn.getBalance(k.publicKey);
    if (bal > KEEP + 10_000) {
      const tx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: k.publicKey, toPubkey: payer.publicKey, lamports: bal - KEEP }),
      );
      await provider.sendAndConfirm(tx, [k]);
    }
  }
  for (const k of actors) {
    const bal = await conn.getBalance(k.publicKey);
    const target = 250_000_000; // 0.25 SOL per actor
    if (bal < target) {
      const tx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: k.publicKey, lamports: target - bal }),
      );
      await provider.sendAndConfirm(tx, []);
    }
  }

  // ------------------------------------------------- mints (deterministic)
  const mints = await robust("ensure mints", () => client.ensureDeterministicMints(payer));
  console.log(`    ✔ deterministic test mints (usdc ${mints.usdc.toBase58().slice(0, 8)}…)`);

  const usdcAta = (o: PublicKey) =>
    getAssociatedTokenAddressSync(mints.usdc, o, false, TOKEN_2022_PROGRAM_ID);

  // ------------------------------------------------------------------ feeds
  for (const a of TEST_ASSETS) {
    await robust(`feed ${a.symbol}`, () => client.oracle.initializeFeed(a.symbol, a.initialPriceCents, 4500)).catch(
      (e: any) => {
        if (!alreadyInUse(e)) throw e;
        console.log(`    = feed ${a.symbol} already exists`);
      },
    );
  }

  // ------------------------------------------------------------------ policy
  if (policyExists) {
    // Resume: adopt the policy's existing equity mints (they are pinned by
    // the vault deposits from earlier runs).
    const policyView = await robust("read policy (resume)", () => client.getPolicy(policyAuth.publicKey));
    TEST_ASSETS.forEach((a, i) => {
      const existing = mints.bySymbol.get(a.symbol)!;
      mints.bySymbol.get(a.symbol)!.mint = policyView.assets[i].mint;
      void existing;
    });
    console.log("    = policy exists (reusing its equity mints)");
  } else {
    await robust("initialize policy", () =>
      client
        .initializePolicy(
          policyAuth,
          TEST_ASSETS.map((a) => ({
            mint: mints.bySymbol.get(a.symbol)!.mint,
            advanceRateBps: ADVANCE_RATES[a.symbol],
          })),
        )
        .catch((e: any) => {
          if (!/already in use/i.test(String(e?.message ?? e))) throw e;
        }),
    );
  }

  // -------------------------------------------------------------------- gate
  if (!gateExists) {
    await robust("initialize gate", () =>
      client
        .initializeGate(gateAuth, [attester1.publicKey, attester2.publicKey, attester3.publicKey], 2)
        .catch((e: any) => {
          if (!/already in use/i.test(String(e?.message ?? e))) throw e;
        }),
    );
  }

  // USDC: lender (treasury liquidity) + institution (repay buffer).
  await robust("fund lender USDC", () => client.fundUsdc(payer, lender.publicKey, TREASURY_TARGET_USDC));
  await robust("fund institution USDC", () => client.fundUsdc(payer, institution.publicKey, 1_000_000_000));
  await robust("fund treasury", () => client.fundTreasury(lender, TREASURY_TARGET_USDC));
  console.log("    ✔ backend accounts ready");

  // Mint the portfolio to the institution (creates ATAs; top-up semantics).
  for (const h of DEMO_PORTFOLIO) {
    await robust(`mint ${h.symbol}`, () => client.mintAsset(payer, h.symbol, institution.publicKey, h.qtyUnits));
  }

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

  // Fresh snapshot each run: a credit draw needs a strictly newer version.
  await robust("commit snapshot", () =>
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
  console.log("    ✔ locked + committed (honesty guard ok)");

  // Repay any leftover outstanding from a previous partial run.
  const pre = await robust("read facility", () =>
    client.getFacility(institution.publicKey).catch(() => null),
  );
  if (pre && pre.outstandingUsdc > 0) {
    console.log(`    = repaying leftover ${pre.outstandingUsdc / 1e6} USDC`);
    await robust("repay leftover", () =>
      client.repay({ institution, amountUsdcMicros: pre.outstandingUsdc }),
    );
  }

  // ------------------------------------------------------------ credit flow
  console.log("[3] requesting $300k credit (private eval → Ed25519 attestation → gate)…");
  // Fresh oracle publishes + open session before requesting.
  for (const a of TEST_ASSETS) {
    await robust(`refresh price ${a.symbol}`, () => client.oracle.setPrice(a.symbol, a.initialPriceCents));
    await robust(`session ${a.symbol}`, () => client.oracle.setMarketSession(a.symbol, SESSION.OPEN));
  }
  const policy = await robust("read policy", () => client.getPolicy(policyAuth.publicKey));
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
  console.log(`    ✔ LOAN APPROVED — ${facility.outstandingUsdc / 1e6} USDC outstanding, COMPLIANT (HF 2.10 private)`);

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

  console.log("[4b] deep stress: NVDA outage + SPY −20% + AAPL −10% (closed) → INELIGIBLE…");
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
  console.log("    ✔ public margin status: INELIGIBLE — liquidation armed");

  console.log("[4c] liquidation leg 1: seize NVDA → $150k debt offset…");
  const nvdaMint = mints.bySymbol.get("NVDAx")!.mint;
  const lenderNvdaAta = getAssociatedTokenAddressSync(nvdaMint, lender.publicKey, false, TOKEN_2022_PROGRAM_ID);
  await robust("create lender NVDA ATA", () => client.ensureAta(payer, lender.publicKey, nvdaMint));
  await robust("execute liquidation leg 1", () =>
    client.executeLiquidation({
      submitter: lender,
      attesters,
      policyAuthority: policyAuth.publicKey,
      institution: institution.publicKey,
      holdings: DEMO_PORTFOLIO,
      seizeSymbol: "NVDAx",
      seizeAmount: 200_000,
      debtOffsetUsdc: 150_000_000_000,
      receiver: lenderNvdaAta,
    }),
  );
  const afterLeg1 = await robust("read facility after leg 1", () =>
    client.getFacility(institution.publicKey),
  );
  if (afterLeg1.outstandingUsdc !== 150_000_000_000) throw new Error("leg 1 debt offset failed");
  console.log("    ✔ leg 1: NVDA seized, outstanding $150k, still INELIGIBLE + locked");

  console.log("[4d] liquidation leg 2: seize SPYx → extinguish remainder…");
  const spyMint = mints.bySymbol.get("SPYx")!.mint;
  const lenderSpyAta = getAssociatedTokenAddressSync(spyMint, lender.publicKey, false, TOKEN_2022_PROGRAM_ID);
  await robust("create lender SPY ATA", () => client.ensureAta(payer, lender.publicKey, spyMint));
  await robust("execute liquidation leg 2", () =>
    client.executeLiquidation({
      submitter: lender,
      attesters,
      policyAuthority: policyAuth.publicKey,
      institution: institution.publicKey,
      holdings: DEMO_PORTFOLIO,
      seizeSymbol: "SPYx",
      seizeAmount: 100_000,
      debtOffsetUsdc: 150_000_000_000,
      receiver: lenderSpyAta,
    }),
  );
  const spyCustodyBal = await robust("read seized SPY custody", () =>
    conn.getTokenAccountBalance(
      ConfidentialMarginClient.custodyPda(ConfidentialMarginClient.vaultPda(institution.publicKey), spyMint),
    ),
  );
  if (Number(spyCustodyBal.value.amount) !== 0) throw new Error("seizure did not empty SPY custody");
  console.log("    ✔ leg 2: SPYx seized → lender (facility LIQUIDATED, debt extinguished)");

  console.log("[5] recovery: prices restored → repay remainder…");
  await robust("restore SPY price", () => client.oracle.setPrice("SPYx", 500_00));
  await robust("restore AAPL price", () => client.oracle.setPrice("AAPLx", 200_00));
  await robust("restore NVDA price", () => client.oracle.setPrice("NVDAx", 100_00));
  for (const a of TEST_ASSETS) {
    await robust(`session ${a.symbol}`, () => client.oracle.setMarketSession(a.symbol, SESSION.OPEN));
  }
  const preClose = await robust("read facility pre-close", () => client.getFacility(institution.publicKey));
  if (preClose.outstandingUsdc > 0) {
    await robust("repay", () => client.repay({ institution, amountUsdcMicros: preClose.outstandingUsdc }));
  }
  const closed = await robust("read facility after close", () => client.getFacility(institution.publicKey));
  if (closed.outstandingUsdc !== 0) throw new Error("close failed");
  console.log(`    ✔ facility closed — outstanding 0, status ${STATUS_NAME[closed.marginStatus]}`);

  const statePath = path.resolve(__dirname, "../app/public/devnet-state.json");
  fs.writeFileSync(
    statePath,
    JSON.stringify(
      {
        cluster: "devnet",
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
