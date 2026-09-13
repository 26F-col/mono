import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotent,
  createMint,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import {
  AnchorProvider,
  BN,
  Idl,
  Program,
} from "@coral-xyz/anchor";

import {
  DEFAULT_POLICY,
  demoKeypair,
  POLICY_ID,
  PROGRAM_IDS,
  TEST_ASSETS,
  USDC_DECIMALS,
} from "./config";
import { FeedView, Holding, PolicyAsset, PolicyParams, RiskResult, evaluateRisk } from "./risk";
import {
  AdvancedPolicyParams,
  AdvancedRiskResult,
  AlignedReturns,
  AssetRiskInput,
  Scenario,
  evaluateRiskAdvanced,
} from "./risk-advanced";
import { MockOracleClient } from "./oracle";
import { AttestationPayload, buildAttestation, ed25519VerifyInstruction } from "./attestation";
import { PortfolioSnapshot, commitmentHash, encryptPortfolio } from "./portfolio";
import { Buffer } from "buffer";
import nacl from "tweetnacl";

export { demoKeypair };
export { PROGRAM_IDS };
export const SYSVAR_INSTRUCTIONS_PUBKEY = new PublicKey(
  "Sysvar1nstructions1111111111111111111111111",
);

/**
 * Node-only IDL loading from `target/idl`. Browsers must pass pre-imported
 * IDLs via ClientOpts.idls (see the app).
 */
function loadIdl(name: string): Idl {
  if (typeof process === "undefined" || !process.versions?.node) {
    throw new Error(`IDL ${name} not provided: pass idls via ClientOpts in the browser`);
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const req = eval("require") as NodeRequire;
  const path = req("path") as typeof import("path");
  const fs = req("fs") as typeof import("fs");
  // Anchor writes IDLs under target/idl/. Depending on the anchor version the
  // file name follows the Cargo package (kebab) or the cdylib lib name (snake).
  const candidates: string[] = [];
  for (const dir of ["../../target/idl", "../target/idl", "../../../target/idl"]) {
    for (const n of [name, name.replace(/-/g, "_")]) {
      candidates.push(path.resolve(__dirname, dir, `${n}.json`));
    }
  }
  candidates.push(path.resolve(process.cwd(), `target/idl/${name.replace(/-/g, "_")}.json`));
  candidates.push(path.resolve(process.cwd(), `target/idl/${name}.json`));
  for (const p of candidates) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  }
  throw new Error(
    `IDL not found for ${name}; run \`anchor build\` first (tried ${candidates.join(", ")})`,
  );
}

export interface ClientOpts {
  /** Browser/ESM environments pass pre-imported IDLs here. */
  idls?: Record<string, Idl>;
}

export interface TestMints {
  usdc: PublicKey;
  bySymbol: Map<string, { mint: PublicKey; decimals: number; priceCents: number }>;
}

export interface PolicyView {
  policyId: Buffer;
  params: PolicyParams;
  assets: { mint: PublicKey; advanceRateBps: number }[];
}

export class ConfidentialMarginClient {
  oracle: MockOracleClient;
  mints?: TestMints;

  constructor(
    public provider: AnchorProvider,
    private oracleAuthority: Keypair,
    opts: ClientOpts = {},
  ) {
    const idls = opts.idls ?? {};
    const idl = (n: string) => idls[n] ?? loadIdl(n);
    this.mockOracle = new Program(idl("mock-oracle"), provider);
    this.vaultProgram = new Program(idl("confidential-vault"), provider);
    this.gateProgram = new Program(idl("credit-gate"), provider);
    this.oracle = new MockOracleClient(provider.connection, this.mockOracle, oracleAuthority);
  }

  mockOracle: Program;
  vaultProgram: Program;
  gateProgram: Program;

  // ------------------------------------------------------------------ PDAs

  static gatePda(): PublicKey {
    // v2 gate seeds (quorum layout). Must mirror GATE_V2_SEED in the program.
    return PublicKey.findProgramAddressSync(
      [Buffer.from("gate"), Buffer.from("gate-v2")],
      PROGRAM_IDS.creditGate,
    )[0];
  }
  static policyPda(authority: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), authority.toBuffer(), POLICY_ID],
      PROGRAM_IDS.confidentialVault,
    )[0];
  }
  static vaultPda(institution: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), institution.toBuffer()],
      PROGRAM_IDS.confidentialVault,
    )[0];
  }
  static facilityPda(vault: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("facility"), ConfidentialMarginClient.gatePda().toBuffer(), vault.toBuffer()],
      PROGRAM_IDS.creditGate,
    )[0];
  }
  static custodyPda(vault: PublicKey, mint: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(mint, vault, true, TOKEN_2022_PROGRAM_ID);
  }
  static ata(owner: PublicKey, mint: PublicKey): PublicKey {
    // allowOwnerOffCurve: the gate PDA and vault PDAs own ATAs too.
    return getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
  }

  // ----------------------------------------------------------------- setup

  /** Create clearly-labelled TEST Token-2022 mints. NOT production xStocks. */
  async createTestMints(payer: Keypair): Promise<TestMints> {
    const usdc = await createMint(
      this.provider.connection,
      payer,
      payer.publicKey,
      null,
      USDC_DECIMALS,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    const bySymbol = new Map<string, { mint: PublicKey; decimals: number; priceCents: number }>();
    for (const a of TEST_ASSETS) {
      const mint = await createMint(
        this.provider.connection,
        payer,
        payer.publicKey,
        null,
        a.decimals,
        undefined,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      bySymbol.set(a.symbol, { mint, decimals: a.decimals, priceCents: a.initialPriceCents });
    }
    this.mints = { usdc, bySymbol };
    return this.mints;
  }

  bindMints(mints: TestMints) {
    this.mints = mints;
  }

  requireMints(): TestMints {
    if (!this.mints) throw new Error("mints not created/bound; call createTestMints first");
    return this.mints;
  }

  async ensureAta(payer: Keypair, owner: PublicKey, mint: PublicKey) {
    await createAssociatedTokenAccountIdempotent(
      this.provider.connection,
      payer,
      mint,
      owner,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
  }

  async fundUsdc(payer: Keypair, owner: PublicKey, usdcMicros: number) {
    const { usdc } = this.requireMints();
    await this.ensureAta(payer, owner, usdc);
    await mintTo(
      this.provider.connection,
      payer,
      usdc,
      ConfidentialMarginClient.ata(owner, usdc),
      payer.publicKey,
      usdcMicros,
      [],
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
  }

  /** Mint equity test-tokens to the institution and seed its ATA. */
  async mintAsset(payer: Keypair, symbol: string, owner: PublicKey, qtyUnits: number) {
    const mints = this.requireMints();
    const entry = mints.bySymbol.get(symbol)!;
    await this.ensureAta(payer, owner, entry.mint);
    await mintTo(
      this.provider.connection,
      payer,
      entry.mint,
      ConfidentialMarginClient.ata(owner, entry.mint),
      payer.publicKey,
      qtyUnits,
      [],
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
  }

  async initializePolicy(authority: Keypair, assets: { mint: PublicKey; advanceRateBps: number }[]) {
    const p = DEFAULT_POLICY;
    return this.vaultProgram.methods
      .initializePolicy(
        [...POLICY_ID],
        {
          session: {
            marketOpenBps: p.session.marketOpenBps,
            extendedHoursBps: p.session.extendedHoursBps,
            marketClosedBps: p.session.marketClosedBps,
          },
          concentration: {
            thresholdBps: p.concentration.thresholdBps,
            penaltyBps: p.concentration.penaltyBps,
          },
          creditHfBps: p.creditHfBps,
          ineligibleHfBps: p.ineligibleHfBps,
          maxStalenessSlots: new BN(p.maxStalenessSlots),
        },
        assets.map((a) => ({ mint: new PublicKey(a.mint), advanceRateBps: a.advanceRateBps })),
      )
      .accounts({
        authority: authority.publicKey,
        policy: ConfidentialMarginClient.policyPda(authority.publicKey),
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();
  }

  async initializeVault(institution: Keypair, policyAuthority: PublicKey, recoveryAuthority?: PublicKey) {
    return this.vaultProgram.methods
      .initializeVault(recoveryAuthority ?? institution.publicKey, ConfidentialMarginClient.gatePda())
      .accounts({
        institution: institution.publicKey,
        vault: ConfidentialMarginClient.vaultPda(institution.publicKey),
        policy: ConfidentialMarginClient.policyPda(policyAuthority),
        systemProgram: SystemProgram.programId,
      })
      .signers([institution])
      .rpc();
  }

  /** Institution-side key rotation. */
  async setController(institution: Keypair, newController: PublicKey) {
    return this.vaultProgram.methods
      .setController(newController)
      .accounts({
        controller: institution.publicKey,
        vault: ConfidentialMarginClient.vaultPda(institution.publicKey),
      })
      .signers([institution])
      .rpc();
  }

  /** Recovery authority rotates the controller (lost-key recovery). */
  async recoverController(recoveryAuthority: Keypair, institution: PublicKey, newController: PublicKey) {
    return this.vaultProgram.methods
      .recoverController(newController)
      .accounts({
        recoveryAuthority: recoveryAuthority.publicKey,
        vault: ConfidentialMarginClient.vaultPda(institution),
      })
      .signers([recoveryAuthority])
      .rpc();
  }

  async setRecoveryAuthority(controller: Keypair, newRecovery: PublicKey) {
    return this.vaultProgram.methods
      .setRecoveryAuthority(newRecovery)
      .accounts({
        controller: controller.publicKey,
        vault: ConfidentialMarginClient.vaultPda(controller.publicKey),
      })
      .signers([controller])
      .rpc();
  }

  /** Withdraw collateral (blocked while a credit facility is outstanding). */
  async withdrawCollateral(controller: Keypair, symbol: string, amount: number) {
    const mints = this.requireMints();
    const mint = mints.bySymbol.get(symbol)!.mint;
    const vault = ConfidentialMarginClient.vaultPda(controller.publicKey);
    return this.vaultProgram.methods
      .withdrawCollateral(new BN(amount))
      .accounts({
        vault,
        controller: controller.publicKey,
        mint,
        destination: ConfidentialMarginClient.ata(controller.publicKey, mint),
        custody: ConfidentialMarginClient.custodyPda(vault, mint),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([controller])
      .rpc();
  }

  async initializeGate(authority: Keypair, attesters: PublicKey[], attestersRequired: number) {
    if (attesters.length !== 3) throw new Error("exactly 3 attester seats (pad with extras)");
    const { usdc } = this.requireMints();
    return this.gateProgram.methods
      .initializeGate(
        attesters.map((k) => new PublicKey(k)),
        attestersRequired,
      )
      .accounts({
        authority: authority.publicKey,
        gate: ConfidentialMarginClient.gatePda(),
        usdcMint: usdc,
        treasury: ConfidentialMarginClient.ata(ConfidentialMarginClient.gatePda(), usdc),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();
  }

  /**
   * Run the ADVANCED risk engine privately (v2 math: confidence pricing,
   * EWMA vols, shrinkage covariance, quantile advance rates, effective bets,
   * scenario ladder). Pure computation — nothing goes on chain.
   */
  evaluateRiskAdvancedPrivately(args: {
    assets: AssetRiskInput[];
    returns: AlignedReturns;
    scenarios: Scenario[];
    policy: AdvancedPolicyParams;
    requestedUsdcMicros: number;
  }): AdvancedRiskResult {
    return evaluateRiskAdvanced({
      assets: args.assets,
      returns: args.returns,
      scenarios: args.scenarios,
      policy: args.policy,
      requestedUsdcMicros: args.requestedUsdcMicros,
    });
  }

  /** Read the attester committee. */
  async getAttesterCommittee(): Promise<{ attesters: PublicKey[]; required: number }> {
    const g = await this.getGate();
    return { attesters: g.attesters, required: g.attestersRequired };
  }

  async fundTreasury(funder: Keypair, usdcMicros: number) {
    const { usdc } = this.requireMints();
    // The funder's ATA must already exist (callers use fundUsdc first).
    return this.gateProgram.methods
      .fundTreasury(new BN(usdcMicros))
      .accounts({
        funder: funder.publicKey,
        gate: ConfidentialMarginClient.gatePda(),
        usdcMint: usdc,
        funderUsdc: ConfidentialMarginClient.ata(funder.publicKey, usdc),
        treasury: ConfidentialMarginClient.ata(ConfidentialMarginClient.gatePda(), usdc),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([funder])
      .rpc();
  }

  async depositCollateral(signer: Keypair, symbol: string, amount: number) {
    const mints = this.requireMints();
    const mint = mints.bySymbol.get(symbol)!.mint;
    // signer = the vault CONTROLLER (defaults to the institution key).
    const vault = ConfidentialMarginClient.vaultPda(signer.publicKey);
    const v = (await (this.vaultProgram.account as any).vault.fetch(vault)) as any;
    return this.vaultProgram.methods
      .depositCollateral(new BN(amount))
      .accounts({
        vault,
        controller: signer.publicKey,
        policy: v.policy,
        mint,
        source: ConfidentialMarginClient.ata(signer.publicKey, mint),
        custody: ConfidentialMarginClient.custodyPda(vault, mint),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([signer])
      .rpc();
  }

  /**
   * Encrypt the snapshot client-side and register ONLY sha256(domain ‖ ct).
   * Returns the ciphertext + key so the institution can keep its private
   * records (or disclose to an auditor later).
   */
  async commitPortfolio(
    institution: Keypair,
    snapshot: PortfolioSnapshot,
    portfolioKey?: Buffer,
  ): Promise<{ ciphertext: Buffer; key: Buffer; commitment: Buffer }> {
    return this.commitPortfolioAs(institution, institution.publicKey, snapshot, portfolioKey);
  }

  /** Commit with an explicit signing key (post-recovery the controller may
   * differ from the immutable vault identity). */
  async commitPortfolioAs(
    signer: Keypair,
    institutionIdentity: PublicKey,
    snapshot: PortfolioSnapshot,
    portfolioKey?: Buffer,
  ): Promise<{ ciphertext: Buffer; key: Buffer; commitment: Buffer }> {
    const { ciphertext, key } = await encryptPortfolio(snapshot, portfolioKey);
    const commitment = await commitmentHash(ciphertext);
    await this.vaultProgram.methods
      .commitPortfolio([...commitment])
      .accounts({
        vault: ConfidentialMarginClient.vaultPda(institutionIdentity),
        controller: signer.publicKey,
      })
      .signers([signer])
      .rpc();
    return { ciphertext, key, commitment };
  }

  // ----------------------------------------------------------- risk + flow

  async getPolicy(policyAuthority: PublicKey): Promise<PolicyView> {
    const p = (await (this.vaultProgram.account as any).riskPolicy.fetch(
      ConfidentialMarginClient.policyPda(policyAuthority),
    )) as any;
    return {
      policyId: Buffer.from(p.policyId),
      params: {
        session: {
          marketOpenBps: p.params.session.marketOpenBps,
          extendedHoursBps: p.params.session.extendedHoursBps,
          marketClosedBps: p.params.session.marketClosedBps,
        },
        concentration: {
          thresholdBps: p.params.concentration.thresholdBps,
          penaltyBps: p.params.concentration.penaltyBps,
        },
        creditHfBps: p.params.creditHfBps,
        ineligibleHfBps: p.params.ineligibleHfBps,
        maxStalenessSlots: p.params.maxStalenessSlots.toNumber(),
      },
      assets: p.assets.map((a: any) => ({
        mint: a.mint as PublicKey,
        advanceRateBps: a.advanceRateBps,
      })),
    };
  }

  /**
   * PRIVATE RISK COMPUTATION — runs entirely off-chain over plaintext
   * holdings + oracle feeds + the public policy. Portfolio data never leaves
   * this function except inside the institution's own process.
   */
  async evaluatePrivately(args: {
    holdings: Holding[];
    policy: PolicyView;
    requestedUsdcMicros: number;
    feeds?: Record<string, FeedView>;
  }): Promise<RiskResult> {
    const mints = this.requireMints();
    const feeds = args.feeds ?? (await this.oracle.getFeeds([...mints.bySymbol.keys()]));
    const mintToSymbol = new Map([...mints.bySymbol].map(([sym, v]) => [v.mint.toBase58(), sym]));
    const assets: PolicyAsset[] = args.policy.assets.map((a) => ({
      symbol: mintToSymbol.get(a.mint.toBase58())!,
      mint: a.mint.toBase58(),
      advanceRateBps: a.advanceRateBps,
    }));
    return evaluateRisk({
      holdings: args.holdings,
      feeds,
      assets,
      policy: args.policy.params,
      requestedUsdcMicros: args.requestedUsdcMicros,
    });
  }

  /**
   * Attester honesty guard (see IMPLEMENTATION_PLAN §5): the committed
   * portfolio must match the vault's publicly visible custody balances before
   * an attestation is issued. This uses only PUBLIC chain data.
   */
  async attesterCrossCheck(holdings: Holding[], institution: PublicKey) {
    const mints = this.requireMints();
    const vault = ConfidentialMarginClient.vaultPda(institution);
    const details: { symbol: string; ok: boolean; committed: number; custody: number }[] = [];
    for (const h of holdings) {
      const entry = mints.bySymbol.get(h.symbol)!;
      const custody = ConfidentialMarginClient.custodyPda(vault, entry.mint);
      const acc = await this.provider.connection.getTokenAccountBalance(custody, "confirmed");
      const custodyAmt = Number(acc.value.amount);
      details.push({
        symbol: h.symbol,
        ok: custodyAmt === h.qtyUnits,
        committed: h.qtyUnits,
        custody: custodyAmt,
      });
    }
    return { ok: details.every((d) => d.ok), details };
  }

  private async buildAttestationFor(args: {
    institution: PublicKey;
    attester: Keypair;
    requestedUsdcMicros: number;
    decision: number;
    policyAuthority: PublicKey;
    /** Negative-path test hooks: override validity/nonce. */
    validUntil?: number;
    nonce?: number;
    /** LIQUIDATE only. */
    seizeMint?: PublicKey;
    seizeAmount?: number;
  }): Promise<{ signed: ReturnType<typeof buildAttestation>; vault: PublicKey; policy: PolicyView }> {
    const vault = ConfidentialMarginClient.vaultPda(args.institution);
    const v = (await (this.vaultProgram.account as any).vault.fetch(vault)) as any;
    const policy = await this.getPolicy(args.policyAuthority);
    const signed = buildAttestation(
      {
        vault,
        commitment: Buffer.from(v.commitment),
        policyId: policy.policyId,
        requestedAmountUsdc: args.requestedUsdcMicros,
        decision: args.decision,
        nonce: args.nonce ?? v.commitmentNonce.toNumber(),
        validUntil: args.validUntil,
        seizeMint: args.seizeMint ?? PublicKey.default,
        seizeAmount: args.seizeAmount ?? 0,
      },
      args.attester,
    );
    return { signed, vault, policy };
  }

  private attestationArg(payload: AttestationPayload) {
    return {
      commitment: [...payload.commitment],
      policyId: [...payload.policyId],
      requestedAmountUsdc: new BN(payload.requestedAmountUsdc),
      decision: payload.decision,
      validUntil: new BN(payload.validUntil),
      nonce: new BN(payload.nonce),
      seizeMint: payload.seizeMint,
      seizeAmount: new BN(payload.seizeAmount),
    };
  }

  /** Publish a margin-status change derived from the private evaluation. */
  async requestCreditWithHoldings(args: {
    institution: Keypair;
    /** Committee members signing this attestation (must meet gate quorum). */
    attesters: Keypair[];
    policyAuthority: PublicKey;
    holdings: Holding[];
    requestedUsdcMicros: number;
    /** Override the decision to test rejection paths. */
    forceDecision?: number;
    /** Negative-path hooks. */
    validUntil?: number;
    nonce?: number;
    send?: boolean;
  }): Promise<{ risk: RiskResult; attestation: AttestationPayload; txSig?: string }> {
    if (args.attesters.length === 0) throw new Error("at least one attester required");
    const policy = await this.getPolicy(args.policyAuthority);
    const risk = await this.evaluatePrivately({
      holdings: args.holdings,
      policy,
      requestedUsdcMicros: args.requestedUsdcMicros,
    });
    const decision =
      args.forceDecision !== undefined
        ? args.forceDecision
        : risk.decision === "ELIGIBLE"
          ? 0
          : risk.decision === "MARGIN_CALL"
            ? 2
            : 1;

    const { signed, vault } = await this.buildAttestationFor({
      institution: args.institution.publicKey,
      attester: args.attesters[0],
      requestedUsdcMicros: args.requestedUsdcMicros,
      decision,
      policyAuthority: args.policyAuthority,
      validUntil: args.validUntil,
      nonce: args.nonce,
    });

    if (args.send === false) {
      return { risk, attestation: signed.payload };
    }

    const { usdc } = this.requireMints();
    const gate = ConfidentialMarginClient.gatePda();
    // First member signs the full message; the rest sign its SHA-256 digest
    // (equally binding, keeps the transaction within size limits).
    const digest = Buffer.from(
      await (globalThis as any).crypto.subtle.digest("SHA-256", signed.message),
    );
    const edIxs = args.attesters.map((k, i) => {
      const payload = i === 0 ? signed.message : digest;
      return ed25519VerifyInstruction(
        k.publicKey.toBuffer(),
        payload,
        nacl.sign.detached(payload, k.secretKey),
      );
    });
    const gateIx = await this.gateProgram.methods
      .requestCredit(this.attestationArg(signed.payload))
      .accounts({
        institution: args.institution.publicKey,
        gate,
        vault,
        policy: ConfidentialMarginClient.policyPda(args.policyAuthority),
        facility: ConfidentialMarginClient.facilityPda(vault),
        usdcMint: usdc,
        institutionUsdc: ConfidentialMarginClient.ata(args.institution.publicKey, usdc),
        treasury: ConfidentialMarginClient.ata(gate, usdc),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        vaultProgram: PROGRAM_IDS.confidentialVault,
      })
      .instruction();

    const tx = new Transaction().add(...edIxs, gateIx);
    const txSig = await this.provider.sendAndConfirm(tx, [args.institution]);
    return { risk, attestation: signed.payload, txSig };
  }

  /** Publish a margin-status change derived from the private evaluation. */
  async reportMarginStatus(args: {
    submitter: Keypair;
    attesters: Keypair[];
    policyAuthority: PublicKey;
    institution: PublicKey;
    holdings: Holding[];
    requestedUsdcMicros: number;
    forceDecision?: number;
    send?: boolean;
  }): Promise<{ risk: RiskResult; decision: number; txSig?: string }> {
    const policy = await this.getPolicy(args.policyAuthority);
    const risk = await this.evaluatePrivately({
      holdings: args.holdings,
      policy,
      requestedUsdcMicros: args.requestedUsdcMicros,
    });
    const decision =
      args.forceDecision !== undefined
        ? args.forceDecision
        : risk.decision === "ELIGIBLE"
          ? 0
          : risk.decision === "MARGIN_CALL"
            ? 2
            : 1;

    const { signed, vault } = await this.buildAttestationFor({
      institution: args.institution,
      attester: args.attesters[0],
      requestedUsdcMicros: args.requestedUsdcMicros,
      decision,
      policyAuthority: args.policyAuthority,
    });

    if (args.send === false) {
      return { risk, decision };
    }

    const gate = ConfidentialMarginClient.gatePda();
    // First member signs the full message; the rest sign its SHA-256 digest
    // (equally binding, keeps the transaction within size limits).
    const digest = Buffer.from(
      await (globalThis as any).crypto.subtle.digest("SHA-256", signed.message),
    );
    const edIxs = args.attesters.map((k, i) => {
      const payload = i === 0 ? signed.message : digest;
      return ed25519VerifyInstruction(
        k.publicKey.toBuffer(),
        payload,
        nacl.sign.detached(payload, k.secretKey),
      );
    });
    const gateIx = await this.gateProgram.methods
      .reportMarginStatus(this.attestationArg(signed.payload))
      .accounts({
        submitter: args.submitter.publicKey,
        gate,
        vault,
        policy: ConfidentialMarginClient.policyPda(args.policyAuthority),
        facility: ConfidentialMarginClient.facilityPda(vault),
        instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(...edIxs, gateIx);
    const txSig = await this.provider.sendAndConfirm(tx, [args.submitter]);
    return { risk, decision, txSig };
  }

  /**
   * ENFORCEMENT: execute a liquidation on a LIQUIDATE attestation. Only
   * possible after the facility is publicly INELIGIBLE. Seizes the designated
   * custody asset to the receiver and marks the facility LIQUIDATED.
   */
  async executeLiquidation(args: {
    submitter: Keypair;
    attesters: Keypair[];
    policyAuthority: PublicKey;
    institution: PublicKey;
    holdings: Holding[];
    seizeSymbol: string;
    seizeAmount: number;
    /** ATA (or any token account) receiving the seized collateral. */
    receiver: PublicKey;
  }): Promise<{ decision: number; txSig: string }> {
    const mints = this.requireMints();
    const policy = await this.getPolicy(args.policyAuthority);
    const risk = await this.evaluatePrivately({
      holdings: args.holdings,
      policy,
      requestedUsdcMicros: 1, // placeholder; decision is forced LIQUIDATE
    });
    void risk;
    const seizeMint = mints.bySymbol.get(args.seizeSymbol)!.mint;
    const { signed, vault } = await this.buildAttestationFor({
      institution: args.institution,
      attester: args.attesters[0],
      requestedUsdcMicros: 0,
      decision: 3, // DECISION_LIQUIDATE
      policyAuthority: args.policyAuthority,
      seizeMint,
      seizeAmount: args.seizeAmount,
    });

    const gate = ConfidentialMarginClient.gatePda();
    // First member signs the full message; the rest sign its SHA-256 digest
    // (equally binding, keeps the transaction within size limits).
    const digest = Buffer.from(
      await (globalThis as any).crypto.subtle.digest("SHA-256", signed.message),
    );
    const edIxs = args.attesters.map((k, i) => {
      const payload = i === 0 ? signed.message : digest;
      return ed25519VerifyInstruction(
        k.publicKey.toBuffer(),
        payload,
        nacl.sign.detached(payload, k.secretKey),
      );
    });
    const gateIx = await this.gateProgram.methods
      .executeLiquidation(this.attestationArg(signed.payload))
      .accounts({
        submitter: args.submitter.publicKey,
        gate,
        vault,
        policy: ConfidentialMarginClient.policyPda(args.policyAuthority),
        facility: ConfidentialMarginClient.facilityPda(vault),
        seizeMint,
        seizeCustody: ConfidentialMarginClient.custodyPda(vault, seizeMint),
        liquidationReceiver: args.receiver,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        vaultProgram: PROGRAM_IDS.confidentialVault,
        instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(...edIxs, gateIx);
    const txSig = await this.provider.sendAndConfirm(tx, [args.submitter]);
    return { decision: 3, txSig };
  }

  async repay(args: { institution: Keypair; amountUsdcMicros: number }): Promise<string> {
    const { usdc } = this.requireMints();
    const vault = ConfidentialMarginClient.vaultPda(args.institution.publicKey);
    return this.gateProgram.methods
      .repay(new BN(args.amountUsdcMicros))
      .accounts({
        institution: args.institution.publicKey,
        gate: ConfidentialMarginClient.gatePda(),
        vault,
        facility: ConfidentialMarginClient.facilityPda(vault),
        usdcMint: usdc,
        institutionUsdc: ConfidentialMarginClient.ata(args.institution.publicKey, usdc),
        treasury: ConfidentialMarginClient.ata(ConfidentialMarginClient.gatePda(), usdc),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        vaultProgram: PROGRAM_IDS.confidentialVault,
      })
      .signers([args.institution])
      .rpc();
  }

  // ------------------------------------------------------------- accessors

  async getVault(institution: PublicKey) {
    const v = (await (this.vaultProgram.account as any).vault.fetch(
      ConfidentialMarginClient.vaultPda(institution),
    )) as any;
    return {
      institution: v.institution as PublicKey,
      controller: v.controller as PublicKey,
      recoveryAuthority: v.recoveryAuthority as PublicKey,
      liquidationAuthority: v.liquidationAuthority as PublicKey,
      policy: v.policy as PublicKey,
      collateralLocked: v.collateralLocked as boolean,
      withdrawalLocked: v.withdrawalLocked as boolean,
      commitment: Buffer.from(v.commitment),
      commitmentNonce: (v.commitmentNonce as BN).toNumber(),
      depositCount: v.depositCount,
    };
  }

  async getFacility(institution: PublicKey) {
    const vault = ConfidentialMarginClient.vaultPda(institution);
    const f = (await (this.gateProgram.account as any).creditFacility.fetch(
      ConfidentialMarginClient.facilityPda(vault),
    )) as any;
    return {
      outstandingUsdc: (f.outstandingUsdc as BN).toNumber(),
      marginStatus: f.marginStatus as number,
      lastCreditNonce: (f.lastCreditNonce as BN).toNumber(),
      lastStatusNonce: (f.lastStatusNonce as BN).toNumber(),
    };
  }

  async getGate() {
    const g = (await (this.gateProgram.account as any).creditGate.fetch(ConfidentialMarginClient.gatePda())) as any;
    return {
      authority: g.authority as PublicKey,
      attesters: (g.attesters as PublicKey[]).map((pk) => pk as PublicKey),
      attestersRequired: g.attestersRequired as number,
      usdcMint: g.usdcMint as PublicKey,
      totalReleasedUsdc: (g.totalReleasedUsdc as BN).toNumber(),
    };
  }

  connection(): Connection {
    return this.provider.connection;
  }
}
