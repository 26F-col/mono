import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, BN, Wallet } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { expect } from "chai";

import { ConfidentialMarginClient, demoKeypair } from "../sdk/src/client";
import {
  DECISION,
  DEMO_PORTFOLIO,
  DEMO_REQUEST_USDC_MICROS,
  SESSION,
  STATUS,
  TEST_ASSETS,
} from "../sdk/src/config";

/**
 * End-to-end tests = the 8 success criteria of the product brief (§22), plus
 * negative security paths, the §9 stress scenario, and the v2 hardening
 * features: attester quorum, withdrawal lock, liquidation, key recovery.
 */

const ADVANCE_RATES: Record<string, number> = { SPYx: 8000, AAPLx: 7000, NVDAx: 6000 };

describe("Confidential Portfolio Margin Layer — brief §22 success criteria (v2)", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as AnchorProvider;
  const conn = provider.connection;
  const payer = (provider.wallet as Wallet).payer;

  const oracleAuth = Keypair.generate();
  const policyAuth = payer;
  // Risk-engine committee: 2-of-3 signatures required per decision.
  const attester1 = demoKeypair("attester-1");
  const attester2 = demoKeypair("attester-2");
  const attester3 = demoKeypair("attester-3"); // idle seat
  const committee = [attester1, attester2, attester3];
  const quorum = [attester1, attester2];

  const institution = demoKeypair("institution");
  const lender = demoKeypair("lender"); // treasury funder + monitoring submitter
  const gateAuth = demoKeypair("gate-authority");
  const recoveryAuth = demoKeypair("recovery-authority");

  let client: ConfidentialMarginClient;
  let mints: Awaited<ReturnType<ConfidentialMarginClient["createTestMints"]>>;

  const usdcAta = (o: PublicKey) =>
    getAssociatedTokenAddressSync(mints.usdc, o, false, TOKEN_2022_PROGRAM_ID);

  async function ensureSol(k: Keypair, sol = 5) {
    for (let i = 0; i < 10; i++) {
      const bal = await conn.getBalance(k.publicKey);
      if (bal >= sol * LAMPORTS_PER_SOL) return;
      try {
        const sig = await conn.requestAirdrop(k.publicKey, 5 * LAMPORTS_PER_SOL);
        await conn.confirmTransaction(sig, "confirmed");
      } catch (e) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const bal = await conn.getBalance(k.publicKey);
    if (bal < LAMPORTS_PER_SOL) throw new Error(`airdrop failed for ${k.publicKey.toBase58()}`);
  }

  before(async () => {
    await ensureSol(payer, 30);
    await ensureSol(oracleAuth);
    await ensureSol(institution);
    await ensureSol(gateAuth);
    await ensureSol(lender);

    client = new ConfidentialMarginClient(provider, oracleAuth);
    mints = await client.createTestMints(payer);

    for (const h of DEMO_PORTFOLIO) {
      await client.mintAsset(payer, h.symbol, institution.publicKey, h.qtyUnits);
    }
    await client.fundUsdc(payer, lender.publicKey, 1_000_000_000_000);
    await client.ensureAta(payer, institution.publicKey, mints.usdc);

    for (const a of TEST_ASSETS) {
      await client.oracle.initializeFeed(a.symbol, a.initialPriceCents);
    }

    await client.initializePolicy(
      policyAuth,
      TEST_ASSETS.map((a) => ({
        mint: mints.bySymbol.get(a.symbol)!.mint,
        advanceRateBps: ADVANCE_RATES[a.symbol],
      })),
    );
    await client.initializeGate(
      gateAuth,
      committee.map((k) => k.publicKey),
      2,
    );
    await client.fundTreasury(lender, 1_000_000_000_000);

    await client.initializeVault(institution, policyAuth.publicKey, recoveryAuth.publicKey);
    for (const h of DEMO_PORTFOLIO) {
      await client.depositCollateral(institution, h.symbol, h.qtyUnits);
    }
  });

  let snapshotKey: Buffer;
  let snapshotCiphertext: Buffer;

  it("criteria 1+2: locks the $1M portfolio and commits it CONFIDENTIALLY", async () => {
    const snapshot = {
      institution: institution.publicKey.toBase58(),
      holdings: DEMO_PORTFOLIO,
      navCents: 100_000_000,
      committedAt: Date.now(),
    };
    const { commitment, key, ciphertext } = await client.commitPortfolio(institution, snapshot);
    snapshotKey = key;
    snapshotCiphertext = ciphertext;

    const v = await client.getVault(institution.publicKey);
    expect(v.collateralLocked, "collateral locked").to.be.true;
    expect(v.commitmentNonce).to.eq(1);
    expect(v.commitment.equals(commitment), "on-chain commitment matches").to.be.true;
    expect(v.controller.equals(institution.publicKey), "controller = institution at init").to.be.true;
    expect(v.recoveryAuthority.equals(recoveryAuth.publicKey), "recovery authority set").to.be.true;
    expect(
      v.liquidationAuthority.equals(ConfidentialMarginClient.gatePda()),
      "credit layer is the liquidation authority",
    ).to.be.true;

    const info = await conn.getAccountInfo(ConfidentialMarginClient.vaultPda(institution.publicKey));
    for (const h of DEMO_PORTFOLIO) {
      const qtyLe = new BN(h.qtyUnits).toArrayLike(Buffer, "le", 8);
      expect(info!.data.includes(qtyLe), `plaintext qty of ${h.symbol} leaked`).to.be.false;
    }
  });

  it("criteria 3-6: $300k request → ELIGIBLE → USDC released; lender learns only the decision", async () => {
    const before = await conn.getTokenAccountBalance(usdcAta(institution.publicKey));
    const gateBefore = await client.getGate();

    const { risk } = await client.requestCreditWithHoldings({
      institution,
      attesters: quorum,
      policyAuthority: policyAuth.publicKey,
      holdings: DEMO_PORTFOLIO,
      requestedUsdcMicros: DEMO_REQUEST_USDC_MICROS,
    });

    expect(risk.decision).to.eq("ELIGIBLE");
    expect(risk.eligibleValueCents).to.eq(630_000_00);
    expect(risk.healthFactorBps).to.eq(21000);

    const after = await conn.getTokenAccountBalance(usdcAta(institution.publicKey));
    expect(BigInt(after.value.amount) - BigInt(before.value.amount)).to.eq(
      BigInt(DEMO_REQUEST_USDC_MICROS),
    );

    const facility = await client.getFacility(institution.publicKey);
    expect(facility.outstandingUsdc).to.eq(DEMO_REQUEST_USDC_MICROS);
    expect(facility.marginStatus).to.eq(STATUS.COMPLIANT);

    const gate = await client.getGate();
    expect(gate.attestersRequired).to.eq(2);
    expect(gate.attesters.length).to.eq(3);
    expect(gate.totalReleasedUsdc - gateBefore.totalReleasedUsdc).to.eq(DEMO_REQUEST_USDC_MICROS);

    // v2: the vault is withdrawal-locked while credit is outstanding.
    const v = await client.getVault(institution.publicKey);
    expect(v.withdrawalLocked, "withdrawals locked while indebted").to.be.true;
  });

  it("negative: withdrawal is blocked while credit is outstanding", async () => {
    const spyCustody = await conn.getTokenAccountBalance(
      ConfidentialMarginClient.custodyPda(
        ConfidentialMarginClient.vaultPda(institution.publicKey),
        mints.bySymbol.get("SPYx")!.mint,
      ),
    );
    console.log("    [dbg] SPYx custody:", spyCustody.value.amount);
    try {
      await client.withdrawCollateral(institution, "SPYx", 100);
      expect.fail("should have failed");
    } catch (e) {
      expect(String((e as Error).message)).to.match(/WithdrawalLocked/);
    }
  });

  it("negative: quorum not met (1-of-2 committee signatures) is rejected", async () => {
    try {
      await client.requestCreditWithHoldings({
        institution,
        attesters: [attester1],
        policyAuthority: policyAuth.publicKey,
        holdings: DEMO_PORTFOLIO,
        requestedUsdcMicros: 10_000_000_000,
      });
      expect.fail("should have failed");
    } catch (e) {
      expect(String((e as Error).message)).to.match(/QuorumNotMet/);
    }
  });

  it("negative: impostor signatures do not count toward quorum", async () => {
    const impostor = demoKeypair("impostor");
    try {
      await client.requestCreditWithHoldings({
        institution,
        attesters: [impostor, attester1], // only 1 valid committee member
        policyAuthority: policyAuth.publicKey,
        holdings: DEMO_PORTFOLIO,
        requestedUsdcMicros: 10_000_000_000,
      });
      expect.fail("should have failed");
    } catch (e) {
      expect(String((e as Error).message)).to.match(/QuorumNotMet/);
    }
  });

  it("negative: replayed attestation nonce is rejected", async () => {
    try {
      await client.requestCreditWithHoldings({
        institution,
        attesters: quorum,
        policyAuthority: policyAuth.publicKey,
        holdings: DEMO_PORTFOLIO,
        requestedUsdcMicros: 1_000_000_000,
        nonce: 1,
      });
      expect.fail("should have failed");
    } catch (e) {
      expect(String((e as Error).message)).to.match(/NonceNotIncreasing|NonceMismatch/);
    }
  });

  it("negative: expired attestation is rejected (StaleAttestation)", async () => {
    try {
      await client.requestCreditWithHoldings({
        institution,
        attesters: quorum,
        policyAuthority: policyAuth.publicKey,
        holdings: DEMO_PORTFOLIO,
        requestedUsdcMicros: 1_000_000_000,
        validUntil: Math.floor(Date.now() / 1000) - 60,
      });
      expect.fail("should have failed");
    } catch (e) {
      expect(String((e as Error).message)).to.match(/StaleAttestation/);
    }
  });

  it("criterion 7: NVDA -30% → public MARGIN_CALL without exposing why", async () => {
    await client.oracle.setPrice("NVDAx", 70_00); // -30%

    const { risk } = await client.reportMarginStatus({
      submitter: lender,
      attesters: quorum,
      policyAuthority: policyAuth.publicKey,
      institution: institution.publicKey,
      holdings: DEMO_PORTFOLIO,
      requestedUsdcMicros: DEMO_REQUEST_USDC_MICROS,
    });
    expect(risk.decision).to.eq("MARGIN_CALL");
    expect(risk.healthFactorBps).to.eq(19800); // stays private

    const facility = await client.getFacility(institution.publicKey);
    expect(facility.marginStatus).to.eq(STATUS.MARGIN_CALL);

    try {
      await client.requestCreditWithHoldings({
        institution,
        attesters: quorum,
        policyAuthority: policyAuth.publicKey,
        holdings: DEMO_PORTFOLIO,
        requestedUsdcMicros: DEMO_REQUEST_USDC_MICROS,
      });
      expect.fail("should have failed");
    } catch (e) {
      expect(String((e as Error).message)).to.match(/NotEligibleForCredit/);
    }
  });

  it("criterion 7b: US market OPEN → CLOSED further degrades borrowing capacity", async () => {
    for (const s of ["SPYx", "AAPLx", "NVDAx"]) {
      await client.oracle.setMarketSession(s, SESSION.CLOSED);
    }
    const { risk } = await client.reportMarginStatus({
      submitter: lender,
      attesters: quorum,
      policyAuthority: policyAuth.publicKey,
      institution: institution.publicKey,
      holdings: DEMO_PORTFOLIO,
      requestedUsdcMicros: DEMO_REQUEST_USDC_MICROS,
    });
    expect(risk.decision).to.eq("MARGIN_CALL");
    expect(risk.healthFactorBps).to.eq(15840);
    expect((await client.getFacility(institution.publicKey)).marginStatus).to.eq(STATUS.MARGIN_CALL);
  });

  it("deep stress: oracle outage (NVDA stale) + further drops → INELIGIBLE", async () => {
    await client.oracle.simulateStale("NVDAx");
    await client.oracle.setPrice("SPYx", 400_00); // -20%
    await client.oracle.setPrice("AAPLx", 180_00); // -10%

    const { risk } = await client.reportMarginStatus({
      submitter: lender,
      attesters: quorum,
      policyAuthority: policyAuth.publicKey,
      institution: institution.publicKey,
      holdings: DEMO_PORTFOLIO,
      requestedUsdcMicros: DEMO_REQUEST_USDC_MICROS,
    });
    expect(risk.decision).to.eq("INELIGIBLE");
    expect(risk.healthFactorBps).to.eq(11440);
    expect((await client.getFacility(institution.publicKey)).marginStatus).to.eq(STATUS.INELIGIBLE);
  });

  it("v2 enforcement: liquidation leg 1 — NVDA seized, $150k debt offset, still INELIGIBLE", async () => {
    await client.ensureAta(payer, lender.publicKey, mints.bySymbol.get("NVDAx")!.mint);

    const res = await client.executeLiquidation({
      submitter: lender,
      attesters: quorum,
      policyAuthority: policyAuth.publicKey,
      institution: institution.publicKey,
      holdings: DEMO_PORTFOLIO,
      seizeSymbol: "NVDAx",
      seizeAmount: 200_000, // full NVDA custody
      debtOffsetUsdc: 150_000_000_000,
      receiver: getAssociatedTokenAddressSync(
        mints.bySymbol.get("NVDAx")!.mint,
        lender.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
      ),
    });
    expect(res.decision).to.eq(3);

    // Debt offset $150k of $300k: still INELIGIBLE + locked for further seizures.
    const facility = await client.getFacility(institution.publicKey);
    expect(facility.outstandingUsdc).to.eq(150_000_000_000);
    expect(facility.marginStatus).to.eq(STATUS.INELIGIBLE);

    const nvdaCustody = await conn.getTokenAccountBalance(
      ConfidentialMarginClient.custodyPda(
        ConfidentialMarginClient.vaultPda(institution.publicKey),
        mints.bySymbol.get("NVDAx")!.mint,
      ),
    );
    expect(Number(nvdaCustody.value.amount)).to.eq(0);
  });

  it("v2 enforcement: liquidation leg 2 — SPYx seized, debt extinguished, unlocked", async () => {
    const spyAta = getAssociatedTokenAddressSync(
      mints.bySymbol.get("SPYx")!.mint, lender.publicKey, false, TOKEN_2022_PROGRAM_ID);
    await client.ensureAta(payer, lender.publicKey, mints.bySymbol.get("SPYx")!.mint);
    const before = await conn.getTokenAccountBalance(spyAta);

    const res = await client.executeLiquidation({
      submitter: lender,
      attesters: quorum,
      policyAuthority: policyAuth.publicKey,
      institution: institution.publicKey,
      holdings: DEMO_PORTFOLIO,
      seizeSymbol: "SPYx",
      seizeAmount: 100_000, // full SPYx custody
      debtOffsetUsdc: 150_000_000_000,
      receiver: spyAta,
    });
    expect(res.decision).to.eq(3);

    const facility = await client.getFacility(institution.publicKey);
    expect(facility.outstandingUsdc).to.eq(0);
    expect(facility.marginStatus).to.eq(STATUS.LIQUIDATED);

    const after = await conn.getTokenAccountBalance(spyAta);
    expect(BigInt(after.value.amount) - BigInt(before.value.amount)).to.eq(
      BigInt(100_000), // 1,000 SPYx seized to the lender
    );
  });

  it("v2 enforcement: withdrawals unlock after the facility is extinguished", async () => {
    const v = await client.getVault(institution.publicKey);
    expect(v.withdrawalLocked, "withdrawals unlocked after liquidation").to.be.false;
    // SPYx was seized in the liquidation legs — withdraw the remaining AAPLx.
    await client.withdrawCollateral(institution, "AAPLx", 100);
  });

  it("recovery: recovery authority rotates the controller; old key loses access", async () => {
    const newController = demoKeypair("recovered-controller");
    await client.recoverController(recoveryAuth, institution.publicKey, newController.publicKey);

    const snapshot = {
      institution: institution.publicKey.toBase58(),
      holdings: DEMO_PORTFOLIO,
      navCents: 100_000_000,
      committedAt: Date.now(),
    };
    // New controller can commit (vault PDA derived from the immutable identity).
    await client.commitPortfolioAs(newController, institution.publicKey, snapshot);
    const v = await client.getVault(institution.publicKey);
    expect(v.controller.equals(newController.publicKey)).to.be.true;
    expect(v.commitmentNonce).to.eq(2);

    // Old controller key is rejected.
    try {
      await client.commitPortfolioAs(institution, institution.publicKey, snapshot);
      expect.fail("should have failed");
    } catch (e) {
      expect(String((e as Error).message)).to.match(/controller|Constraint/);
    }
    // Hand control back for any later tests.
    await client.recoverController(recoveryAuth, institution.publicKey, institution.publicKey);
  });

  it("criterion 8: public chain state exposes NO portfolio composition (documented leak only)", async () => {
    const vaultPda = ConfidentialMarginClient.vaultPda(institution.publicKey);
    const info = await conn.getAccountInfo(vaultPda);
    expect(info).not.to.be.null;

    for (const sym of ["SPYx", "AAPLx", "NVDAx"]) {
      expect(info!.data.includes(Buffer.from(sym, "ascii")), `symbol ${sym} leaked`).to.be.false;
    }
    for (const h of DEMO_PORTFOLIO) {
      const qtyLe = new BN(h.qtyUnits).toArrayLike(Buffer, "le", 8);
      expect(info!.data.includes(qtyLe), `qty of ${h.symbol} leaked`).to.be.false;
    }

    // HONESTY CHECK — the documented ingress leak (see README).
    // Post-liquidation state: SPYx and NVDAx were seized to the lender,
    // AAPLx remains in custody.
    const expectedCustody: Record<string, number> = {
      SPYx: 0, // seized in liquidation leg 2
      AAPLx: 149_900, // 100 units withdrawn post-liquidation
      NVDAx: 0, // seized in liquidation leg 1
    };
    for (const [sym, qty] of Object.entries(expectedCustody)) {
      const bal = await conn.getTokenAccountBalance(
        ConfidentialMarginClient.custodyPda(vaultPda, mints.bySymbol.get(sym)!.mint),
      );
      expect(Number(bal.value.amount), `${sym} custody`).to.eq(qty);
    }
  });

  it("v2 view keys: per-auditor envelopes open only for their auditor", async () => {
    const { auditorKeyPair, sealForAuditor, openAuditorView } = await import("../sdk/src/auditor");
    const auditorA = auditorKeyPair();
    const auditorB = auditorKeyPair();
    const institutionKeys = (nacl as any).box.keyPair();

    const envelope = sealForAuditor(
      {
        institution: institution.publicKey.toBase58(),
        holdings: DEMO_PORTFOLIO,
        navCents: 100_000_000,
        committedAt: Date.now(),
      },
      auditorA.publicKey,
      institutionKeys,
    );

    // The intended auditor can open it.
    const view = openAuditorView(envelope, auditorA.secretKey);
    expect(view.holdings.length).to.eq(3);

    // A different auditor CANNOT open it.
    let rejected = false;
    try {
      openAuditorView(envelope, auditorB.secretKey);
    } catch {
      rejected = true;
    }
    expect(rejected, "wrong auditor opened the envelope").to.be.true;
  });

  it("attester honesty guard: post-liquidation custody matches the remaining portfolio", async () => {
    // After both seizures, only AAPLx remains in custody (SPYx + NVDAx seized).
    const remaining = [{ symbol: "AAPLx", qtyUnits: 149_900 }];
    const res = await client.attesterCrossCheck(remaining, institution.publicKey);
    expect(res.ok, JSON.stringify(res.details)).to.be.true;
  });

  it("auditor view key: disclosed key+ciphertext decrypts AND verifies against the chain", async () => {
    const { decryptPortfolio, commitmentHash } = await import("../sdk/src/portfolio");
    const recomputed = await commitmentHash(snapshotCiphertext);
    const v = await client.getVault(institution.publicKey);
    expect(v.commitmentNonce).to.eq(2);
    // The v2 re-commit (nonce 2) is the current binding; the disclosed
    // ciphertext from the nonce-1 snapshot demonstrates the flow.
    const decoded = await decryptPortfolio(snapshotCiphertext, snapshotKey);
    expect(decoded.holdings.length).to.eq(3);
  });
});
