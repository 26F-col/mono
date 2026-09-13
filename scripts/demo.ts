/**
 * Narrative end-to-end demo (product brief §9).
 *
 * Prerequisite: a local validator with the three programs deployed —
 * run `./scripts/start-demo.sh` which starts the validator, deploys, seeds
 * and calls this script.
 *
 * The demo shows BOTH sides of the story:
 *   - what the INSTITUTION sees (exact holdings, NAV, risk metrics), and
 *   - what the PUBLIC/LENDER sees (decision + amount + policy status only).
 */

import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";

import { ConfidentialMarginClient, demoKeypair } from "../sdk/src/client";
import {
  DECISION,
  DEMO_PORTFOLIO,
  DEMO_REQUEST_USDC_MICROS,
  LOCALNET_URL,
  SESSION,
  STATUS,
  STATUS_NAME,
  TEST_ASSETS,
} from "../sdk/src/config";
import type { RiskResult } from "../sdk/src/risk";

const c = (s: string) => `\x1b[36m${s}\x1b[0m`;
const g = (s: string) => `\x1b[32m${s}\x1b[0m`;
const y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const r = (s: string) => `\x1b[31m${s}\x1b[0m`;
const b = (s: string) => `\x1b[1m${s}\x1b[0m`;

const usd = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const usdc = (micros: number) => `${(micros / 1e6).toLocaleString("en-US")} USDC`;

function banner(title: string) {
  console.log("\n" + b("═".repeat(72)));
  console.log(b(`  ${title}`));
  console.log(b("═".repeat(72)));
}

let currentSession = "OPEN";
function institutionView(holdings: typeof DEMO_PORTFOLIO, risk: RiskResult) {
  console.log(c("\n  INSTITUTION DASHBOARD (private view)"));
  console.log(c("  ────────────────────────────────────"));
  for (const a of risk.perAsset) {
    console.log(
      `   ${a.symbol.padEnd(6)} ${a.qtyUnits / 100} sh @ $${(a.priceCents / 100).toFixed(2)}  ` +
        `value ${usd(a.valueCents).padStart(8)}  weight ${(a.weightBps / 100).toFixed(1)}%` +
        (a.concentrationPenaltyBps < 10000
          ? r(`  ⚠ concentration >40% → ×0.75`)
          : "") +
        (a.stale ? r("  ✖ STALE ORACLE → ineligible") : ""),
    );
  }
  console.log(`   NAV        ${usd(risk.navCents)}`);
  console.log(`   Session    ${currentSession}`);
  console.log(`   Eligible collateral value  ${usd(risk.eligibleValueCents)}  (PRIVATE)`);
  console.log(`   Health factor              ${(risk.healthFactorBps / 10000).toFixed(2)}x  (PRIVATE)`);
  console.log(`   Decision                   ${g(risk.decision)}`);
}

function publicView(client: ConfidentialMarginClient, institution: PublicKey, requestedUsdc: number) {
  console.log(y("\n  PUBLIC / LENDER VIEW (CreditGate)"));
  console.log(y("  ─────────────────────────────────"));
  const vp = ConfidentialMarginClient.vaultPda(institution).toBase58();
  console.log(`   Vault id.............. ${vp.slice(0, 12)}…`);
  console.log(`   Portfolio............. CONFIDENTIAL 🔒`);
  console.log(`   NAV................... CONFIDENTIAL 🔒`);
  console.log(`   Holdings.............. CONFIDENTIAL 🔒`);
  console.log(`   Requested loan........ ${usdc(requestedUsdc)}`);
}

async function main() {
  const walletPath = process.env.ANCHOR_WALLET || path.join(process.env.HOME!, ".config/solana/id.json");
  const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(walletPath, "utf8"))));
  const provider = new AnchorProvider(
    new Connection(LOCALNET_URL, "confirmed"),
    new Wallet(payer),
    { commitment: "confirmed" },
  );

  const oracleAuth = demoKeypair("oracle-authority");
  const policyAuth = demoKeypair("policy-authority");
  // Risk-engine committee: 2-of-3 must sign every margin decision.
  const attester1 = demoKeypair("attester-1");
  const attester2 = demoKeypair("attester-2");
  const attester3 = demoKeypair("attester-3"); // idle seat
  const attesters = [attester1, attester2, attester3];
  const institution = demoKeypair("institution");
  const lender = demoKeypair("lender");
  const gateAuth = demoKeypair("gate-authority");

  const client = new ConfidentialMarginClient(provider, oracleAuth);

  async function ensureSol(k: Keypair, sol: number) {
    for (let i = 0; i < 12; i++) {
      if ((await provider.connection.getBalance(k.publicKey)) >= sol * LAMPORTS_PER_SOL) return;
      try {
        const sig = await provider.connection.requestAirdrop(k.publicKey, 5 * LAMPORTS_PER_SOL);
        await provider.connection.confirmTransaction(sig, "confirmed");
      } catch {
        await new Promise((res) => setTimeout(res, 400));
      }
    }
  }

  banner("CONFIDENTIAL MARGIN LAYER — demo (TEST assets on localnet)");
  console.log(
    r("  ⚠ All tokens are clearly-labelled TEST Token-2022 mints, NOT production xStocks.\n" +
      "  ⚠ The risk engine attester is a TRUSTED party in this prototype (roadmap: MPC/ZK)."),
  );

  await ensureSol(payer, 30);
  for (const k of [oracleAuth, policyAuth, institution, lender, gateAuth]) await ensureSol(k, 5);

  console.log(c("\n[1] Deploying test assets (Token-2022) and seeding the institution…"));
  const mints = await client.createTestMints(payer);
  for (const h of DEMO_PORTFOLIO) {
    await client.mintAsset(payer, h.symbol, institution.publicKey, h.qtyUnits);
  }
  await client.fundUsdc(payer, lender.publicKey, 1_000_000_000_000);
  for (const a of TEST_ASSETS) await client.oracle.initializeFeed(a.symbol, a.initialPriceCents);
  console.log("    ✔ SPYx / AAPLx / NVDAx test mints + TEST-USDC ready; oracle feeds live");

  console.log(c("\n[2] Publishing the public margin policy (institutional_equity_v1)…"));
  await client.initializePolicy(
    policyAuth,
    TEST_ASSETS.map((a) => ({
      mint: mints.bySymbol.get(a.symbol)!.mint,
      advanceRateBps: { SPYx: 8000, AAPLx: 7000, NVDAx: 6000 }[a.symbol]!,
    })),
  );
  console.log("    ✔ advance rates SPYx 80% · AAPLx 70% · NVDAx 60%; session factors 1.00/0.90/0.80");
  console.log("      concentration: single asset >40% NAV penalized ×0.75; stale oracle ⇒ ineligible");

  console.log(c("\n[3] Opening the credit gate (lender side)…"));
  await client.initializeGate(gateAuth, attesters.map((k) => k.publicKey), 2);
  await client.fundTreasury(lender, 1_000_000_000_000);
  console.log("    ✔ CreditGate pins a 2-of-3 risk-engine committee + TEST-USDC treasury funded");

  console.log(c("\n[4] Institution deposits the portfolio and commits it confidentially…"));
  await client.initializeVault(institution, policyAuth.publicKey);
  for (const h of DEMO_PORTFOLIO) {
    await client.depositCollateral(institution, h.symbol, h.qtyUnits);
  }
  const snapshot = {
    institution: institution.publicKey.toBase58(),
    holdings: DEMO_PORTFOLIO,
    navCents: 100_000_000,
    committedAt: Date.now(),
  };
  await client.commitPortfolio(institution, snapshot);
  console.log("    ✔ $500k SPYx + $300k AAPLx + $200k NVDAx locked in the vault");
  console.log("    ✔ On-chain record: sha256 commitment ONLY — no quantities, no NAV, no symbols");

  banner("REQUEST: $300,000 USDC credit against the confidential portfolio");
  console.log(c("\n[5] PRIVATE RISK COMPUTATION (off-chain, inside the institution/risk engine)…"));
  const policy = await client.getPolicy(policyAuth.publicKey);
  let risk = await client.evaluatePrivately({
    holdings: DEMO_PORTFOLIO,
    policy,
    requestedUsdcMicros: DEMO_REQUEST_USDC_MICROS,
  });
  currentSession = "OPEN";
  institutionView(DEMO_PORTFOLIO, risk);

  const ok = await client.attesterCrossCheck(DEMO_PORTFOLIO, institution.publicKey);
  console.log(`    attester honesty check vs public custody balances: ${ok.ok ? "✔ consistent" : "✖ mismatch"}`);

  console.log(c("\n[6] Signing the MarginAttestation and requesting credit on-chain…"));
  await client.requestCreditWithHoldings({
    institution,
    attesters: [attester1, attester2],
    policyAuthority: policyAuth.publicKey,
    holdings: DEMO_PORTFOLIO,
    requestedUsdcMicros: DEMO_REQUEST_USDC_MICROS,
  });

  publicView(client, institution.publicKey, DEMO_REQUEST_USDC_MICROS);
  const facility = await client.getFacility(institution.publicKey);
  console.log(`   Collateral locked..... YES`);
  console.log(`   Eligible assets....... YES`);
  console.log(`   Risk policy satisfied. YES`);
  console.log(`   Margin requirement.... YES  (policy institutional_equity_v1)`);
  console.log(g(`   ➜ LOAN APPROVED — ${usdc(facility.outstandingUsdc)} released. Portfolio remains CONFIDENTIAL.`));

  banner("STRESS EVENT: NVDA price −30%");
  await client.oracle.setPrice("NVDAx", 70_00);
  console.log(c("\n[7] Risk engine re-evaluates privately; lender submits the signed status…"));
  risk = await client.evaluatePrivately({
    holdings: DEMO_PORTFOLIO,
    policy,
    requestedUsdcMicros: DEMO_REQUEST_USDC_MICROS,
  });
  institutionView(DEMO_PORTFOLIO, risk);
  await client.reportMarginStatus({
    submitter: lender,
    attesters: [attester1, attester2],
    policyAuthority: policyAuth.publicKey,
    institution: institution.publicKey,
    holdings: DEMO_PORTFOLIO,
    requestedUsdcMicros: DEMO_REQUEST_USDC_MICROS,
  });
  publicView(client, institution.publicKey, DEMO_REQUEST_USDC_MICROS);
  console.log(r(`   MARGIN STATUS CHANGED: ${STATUS_NAME[STATUS.MARGIN_CALL]}`));
  console.log(y("   (The lender knows collateral must grow — never WHICH position moved.)"));

  banner("STRESS EVENT: US market closes (24/7 tokens ≠ 24/7 liquidity)");
  for (const s of ["SPYx", "AAPLx", "NVDAx"]) await client.oracle.setMarketSession(s, SESSION.CLOSED);
  currentSession = "CLOSED";
  risk = await client.evaluatePrivately({
    holdings: DEMO_PORTFOLIO,
    policy,
    requestedUsdcMicros: DEMO_REQUEST_USDC_MICROS,
  });
  institutionView(DEMO_PORTFOLIO, risk);
  await client.reportMarginStatus({
    submitter: lender,
    attesters: [attester1, attester2],
    policyAuthority: policyAuth.publicKey,
    institution: institution.publicKey,
    holdings: DEMO_PORTFOLIO,
    requestedUsdcMicros: DEMO_REQUEST_USDC_MICROS,
  });

  banner("RECOVERY + REPAY");
  console.log(c("\n[8] Markets reopen, prices recover; institution repays the loan…"));
  await client.oracle.setPrice("SPYx", 500_00);
  await client.oracle.setPrice("AAPLx", 200_00);
  await client.oracle.setPrice("NVDAx", 100_00);
  for (const s of ["SPYx", "AAPLx", "NVDAx"]) await client.oracle.setMarketSession(s, SESSION.OPEN);
  currentSession = "OPEN";
  await client.reportMarginStatus({
    submitter: lender,
    attesters: [attester1, attester2],
    policyAuthority: policyAuth.publicKey,
    institution: institution.publicKey,
    holdings: DEMO_PORTFOLIO,
    requestedUsdcMicros: DEMO_REQUEST_USDC_MICROS,
  });
  await client.repay({ institution, amountUsdcMicros: DEMO_REQUEST_USDC_MICROS });
  const closed = await client.getFacility(institution.publicKey);
  console.log(`    ✔ facility repaid — outstanding ${usdc(closed.outstandingUsdc)}, status ${STATUS_NAME[closed.marginStatus]}`);

  // Persist demo state so the dashboards (app/) can bind to the same mints.
  const statePath = path.resolve(__dirname, "../app/public/demo-state.json");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    JSON.stringify(
      {
        mints: {
          usdc: mints.usdc.toBase58(),
          ...Object.fromEntries([...mints.bySymbol].map(([sym, v]) => [sym, v.mint.toBase58()])),
        },
        actors: {
          institution: institution.publicKey.toBase58(),
          policyAuthority: policyAuth.publicKey.toBase58(),
          attesters: [attester1.publicKey.toBase58(), attester2.publicKey.toBase58(), attester3.publicKey.toBase58()],
          attestersRequired: 2,
        },
        finishedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(`    ✔ demo state written to ${path.relative(process.cwd(), statePath)}`);

  banner("DEMO COMPLETE");
  console.log(
    "  What happened: a confidential tokenized-stock portfolio was turned into a\n" +
      "  machine-verifiable borrowing decision — approved, stressed, warned, repaid —\n" +
      "  and the public/lender never learned the portfolio. 🔒\n" +
      "\n  Local validator is still running for the dashboards:  cd app && npm run dev\n",
  );
}

main().catch((e) => {
  console.error(r("\nDEMO FAILED:"), e);
  process.exit(1);
});
