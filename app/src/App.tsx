import { useCallback, useEffect, useState } from "react";

import { CLUSTER, makeClient, loadDemoState, actors, DEMO_PORTFOLIO } from "./lib";
import type { FeedView } from "@sdk/risk";
import type { PublicKey } from "@solana/web3.js";
import type { RiskResult } from "@sdk/risk";
import { DEMO_REQUEST_USDC_MICROS, STATUS, STATUS_NAME, SESSION, TEST_ASSETS } from "@sdk/config";

const usd = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const usdc = (micros: number) => `${(micros / 1e6).toLocaleString("en-US")} USDC`;
const short = (pk: string) => `${pk.slice(0, 8)}…${pk.slice(-4)}`;

interface ChainState {
  connected: boolean;
  vault: { collateralLocked: boolean; commitment: Buffer; commitmentNonce: number } | null;
  facility: { outstandingUsdc: number; marginStatus: number } | null;
  gate: { totalReleasedUsdc: number; attesters: PublicKey[]; attestersRequired: number } | null;
  sessions: Record<string, number>;
  stale: Record<string, boolean>;
  prices: Record<string, number>;
}

export default function App() {
  const client = makeClient();
  const [state, setState] = useState<ChainState>({
    connected: false,
    vault: null,
    facility: null,
    gate: null,
    sessions: {},
    stale: {},
    prices: {},
  });
  const [ready, setReady] = useState(false);
  const [risk, setRisk] = useState<RiskResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<{ ok: boolean; msg: string }[]>([]);

  const addLog = (ok: boolean, msg: string) =>
    setLog((l) => [{ ok, msg }, ...l].slice(0, 8));

  useEffect(() => {
    loadDemoState(client).then(setReady);
  }, [client]);

  const refresh = useCallback(async () => {
    const safe = async <T,>(p: Promise<T>): Promise<T | null> => {
      try {
        return await p;
      } catch {
        return null;
      }
    };
    // Devnet public RPC rate-limits per IP: sequential reads + one retry.
    const attempt = async () => {
      const vault = await safe(client.getVault(actors.institution.publicKey));
      const facility = await safe(client.getFacility(actors.institution.publicKey));
      const gate = await safe(client.getGate());
      const policy = await safe(client.getPolicy(actors.policyAuth.publicKey));
      const feeds = await safe(client.oracle.getFeeds(TEST_ASSETS.map((a) => a.symbol)));
      return { vault, facility, gate, policy, feeds };
    };
    let { vault, facility, gate, policy, feeds } = await attempt();
    if (!vault && CLUSTER === "devnet") {
      await new Promise((r) => setTimeout(r, 8000));
      ({ vault, facility, gate, policy, feeds } = await attempt());
    }
    if (!vault) {
      setState((s) => ({ ...s, connected: false }));
      return;
    }
    const prices: Record<string, number> = {};
    const sessions: Record<string, number> = {};
    const stale: Record<string, boolean> = {};
    if (feeds) {
      for (const [sym, f] of Object.entries(feeds)) {
        prices[sym] = f.priceCents;
        sessions[sym] = f.marketSession;
        stale[sym] = f.isStale;
      }
    }
    setState({
      connected: true,
      vault,
      facility,
      gate,
      sessions,
      stale,
      prices,
    });
    // Private evaluation happens in THIS browser only — it never goes on chain.
    if (policy && ready && Object.keys(feeds ?? {}).length > 0) {
      try {
        const r = await client.evaluatePrivately({
          holdings: DEMO_PORTFOLIO,
          policy,
          requestedUsdcMicros:
            facility && facility.outstandingUsdc > 0 ? facility.outstandingUsdc : DEMO_REQUEST_USDC_MICROS,
          feeds: feeds as Record<string, FeedView>,
        });
        setRisk(r);
      } catch {
        /* oracle reads unavailable this round — keep last private evaluation */
      }
    }
  }, [client, ready]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, CLUSTER === "devnet" ? 15000 : 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
      addLog(true, label);
    } catch (e: any) {
      addLog(false, `${label} — ${shortError(e)}`);
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const status = state.facility?.marginStatus;

  return (
    <div className="root">
      <header>
        <div>
          <h1>Confidential Margin Layer</h1>
          <div className="subtitle">
            confidential collateral &amp; risk proofs for tokenized equities on Solana
          </div>
        </div>
        <div className="badges">
          <span className="badge red">TEST TOKENS</span>
          <span className={`badge ${CLUSTER === "devnet" ? "green" : "amber"}`}>
            {CLUSTER === "devnet" ? "DEVNET" : "LOCALNET"}
          </span>
          <span className="badge amber">DEMO KEYS — DO NOT USE IN PRODUCTION</span>
          <span className={state.connected ? "badge green" : "badge gray"}>
            {state.connected ? "● connected" : "○ validator offline"}
          </span>
        </div>
      </header>

      <div className="panes">
        {/* ----------------------------- INSTITUTION ---------------------------- */}
        <section className="pane private">
          <h2>
            Institution view <span className="tag">PRIVATE</span>
          </h2>
          <p className="hint">
            Holdings below come from the institution's local encrypted records —
            they are <b>not</b> on chain. Risk metrics are computed here, in this
            dashboard.
          </p>

          <table>
            <thead>
              <tr>
                <th>asset</th>
                <th>qty</th>
                <th>price</th>
                <th>value</th>
                <th>weight</th>
                <th>flags</th>
              </tr>
            </thead>
            <tbody>
              {(risk?.perAsset ?? []).map((a) => (
                <tr key={a.symbol}>
                  <td>{a.symbol}</td>
                  <td>{(a.qtyUnits / 100).toLocaleString()} sh</td>
                  <td>${(a.priceCents / 100).toFixed(2)}</td>
                  <td>{usd(a.valueCents)}</td>
                  <td>{(a.weightBps / 100).toFixed(1)}%</td>
                  <td>
                    {a.stale && <span className="pill bad">stale oracle</span>}
                    {a.concentrationPenaltyBps < 10000 && (
                      <span className="pill warn">concentration ×0.75</span>
                    )}
                    {!a.stale && a.concentrationPenaltyBps >= 10000 && (
                      <span className="pill ok">ok</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="cards">
            <div className="card">
              <div className="k">NAV (private)</div>
              <div className="v">{risk ? usd(risk.navCents) : "—"}</div>
            </div>
            <div className="card">
              <div className="k">Eligible collateral (private)</div>
              <div className="v">{risk ? usd(risk.eligibleValueCents) : "—"}</div>
            </div>
            <div className="card">
              <div className="k">Health factor (private)</div>
              <div className="v">{risk ? `${(risk.healthFactorBps / 10000).toFixed(2)}×` : "—"}</div>
            </div>
            <div className="card">
              <div className="k">Private decision</div>
              <div className={`v ${risk?.decision === "ELIGIBLE" ? "good" : risk?.decision === "MARGIN_CALL" ? "warn" : "bad"}`}>
                {risk?.decision ?? "—"}
              </div>
            </div>
          </div>

          <div className="session">
            Market session:{" "}
            {TEST_ASSETS.map((a) => (
              <span key={a.symbol} className="pill mono">
                {a.symbol}: {state.stale[a.symbol] ? "STALE" : ["OPEN", "EXTENDED", "CLOSED"][state.sessions[a.symbol] ?? 0]}
              </span>
            ))}
          </div>

          <h3>Actions</h3>
          <div className="actions">
            <button
              disabled={busy !== null || !state.connected}
              onClick={() =>
                run("Request $300,000 credit", async () => {
                  const policy = await client.getPolicy(actors.policyAuth.publicKey);
                  const pre = await client.evaluatePrivately({
                    holdings: DEMO_PORTFOLIO,
                    policy,
                    requestedUsdcMicros:
                      state.facility && state.facility.outstandingUsdc > 0
                        ? state.facility.outstandingUsdc
                        : DEMO_REQUEST_USDC_MICROS,
                  });
                  if (pre.decision !== "ELIGIBLE") {
                    throw new Error(
                      `private evaluation: ${pre.decision} at HF ${(pre.healthFactorBps / 10000).toFixed(2)}× — publish fresh prices ("Restore prices") or add collateral`,
                    );
                  }
                  // Refresh the confidential snapshot: every credit draw is
                  // evaluated against a fresh portfolio version (nonce bump).
                  await client.commitPortfolio(actors.institution, {
                    institution: actors.institution.publicKey.toBase58(),
                    holdings: DEMO_PORTFOLIO,
                    navCents: 100_000_000,
                    committedAt: Date.now(),
                  });
                  await client.requestCreditWithHoldings({
                    institution: actors.institution,
                    attesters: [actors.attester1, actors.attester2],
                    policyAuthority: actors.policyAuth.publicKey,
                    holdings: DEMO_PORTFOLIO,
                    requestedUsdcMicros: DEMO_REQUEST_USDC_MICROS,
                  });
                })
              }
            >
              Request $300k credit
            </button>
            <button
              disabled={
                busy !== null ||
                !state.connected ||
                !state.facility ||
                state.facility.outstandingUsdc === 0
              }
              onClick={() =>
                run("Repay loan", async () => {
                  await client.repay({
                    institution: actors.institution,
                    amountUsdcMicros: state.facility!.outstandingUsdc,
                  });
                })
              }
            >
              Repay outstanding
            </button>
          </div>

          <h3>Stress controls (oracle authority)</h3>
          <div className="actions">
            <button
              disabled={busy !== null || !state.connected}
              onClick={() =>
                run("NVDA −30%", async () => {
                  await client.oracle.setPrice("NVDAx", 70_00);
                })
              }
            >
              NVDA −30%
            </button>
            <button
              disabled={busy !== null || !state.connected}
              onClick={() =>
                run("Restore prices", async () => {
                  await client.oracle.setPrice("SPYx", 500_00);
                  await client.oracle.setPrice("AAPLx", 200_00);
                  await client.oracle.setPrice("NVDAx", 100_00);
                })
              }
            >
              Restore prices
            </button>
            <button
              disabled={busy !== null || !state.connected}
              onClick={() =>
                run("Market → CLOSED", async () => {
                  for (const a of TEST_ASSETS) await client.oracle.setMarketSession(a.symbol, SESSION.CLOSED);
                })
              }
            >
              US market → CLOSED
            </button>
            <button
              disabled={busy !== null || !state.connected}
              onClick={() =>
                run("Market → OPEN", async () => {
                  for (const a of TEST_ASSETS) await client.oracle.setMarketSession(a.symbol, SESSION.OPEN);
                })
              }
            >
              US market → OPEN
            </button>
            <button
              disabled={busy !== null || !state.connected}
              onClick={() =>
                run("Oracle outage (NVDA stale)", async () => {
                  await client.oracle.simulateStale("NVDAx");
                })
              }
            >
              Simulate oracle outage (NVDA)
            </button>
            <button
              disabled={busy !== null || !state.connected}
              onClick={() =>
                run("Publish margin status update", async () => {
                  const res = await client.reportMarginStatus({
                    submitter: actors.lender,
                    attesters: [actors.attester1, actors.attester2],
                    policyAuthority: actors.policyAuth.publicKey,
                    institution: actors.institution.publicKey,
                    holdings: DEMO_PORTFOLIO,
                    requestedUsdcMicros:
                      state.facility && state.facility.outstandingUsdc > 0
                        ? state.facility.outstandingUsdc
                        : DEMO_REQUEST_USDC_MICROS,
                  });
                  return res.decision;
                })
              }
            >
              Publish margin status (lender)
            </button>
          </div>

          {log.length > 0 && (
            <div className="log">
              {log.map((l, i) => (
                <div key={i} className={l.ok ? "ok" : "bad"}>
                  {l.ok ? "✔" : "✖"} {l.msg}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ------------------------------- LENDER ------------------------------ */}
        <section className="pane public">
          <h2>
            Public / Lender view <span className="tag">ON-CHAIN ONLY</span>
          </h2>
          <p className="hint">
            Everything here is readable by anyone from chain. Notice what is
            <b> not</b> here: the portfolio.
          </p>

          <div className="confidential-grid">
            <div className="conf">
              <div className="k">Portfolio</div>
              <div className="v locked">CONFIDENTIAL 🔒</div>
            </div>
            <div className="conf">
              <div className="k">NAV</div>
              <div className="v locked">CONFIDENTIAL 🔒</div>
            </div>
            <div className="conf">
              <div className="k">Holdings</div>
              <div className="v locked">CONFIDENTIAL 🔒</div>
            </div>
          </div>

          <table>
            <tbody>
              <tr>
                <td>Vault</td>
                <td className="mono">
                  {state.vault ? short(actors.institution.publicKey.toBase58()) : "—"}
                </td>
              </tr>
              <tr>
                <td>Collateral locked</td>
                <td>{state.vault?.collateralLocked ? "YES" : "NO"}</td>
              </tr>
              <tr>
                <td>Snapshot commitment</td>
                <td className="mono">
                  {state.vault ? `${Buffer.from(state.vault.commitment).toString("hex").slice(0, 20)}… (nonce ${state.vault.commitmentNonce})` : "—"}
                </td>
              </tr>
              <tr>
                <td>Risk policy</td>
                <td>institutional_equity_v1</td>
              </tr>
              <tr>
                <td>Requested loan</td>
                <td>{state.facility && state.facility.outstandingUsdc > 0 ? usdc(state.facility.outstandingUsdc) : "—"}</td>
              </tr>
              <tr>
                <td>Attester pinned</td>
                <td className="mono">
                  {state.gate
                    ? `${state.gate.attestersRequired}-of-${state.gate.attesters.length} committee: ` +
                      state.gate.attesters.map((a) => short(a.toBase58())).join(" · ")
                    : "—"}
                </td>
              </tr>
            </tbody>
          </table>

          <div className={`status-banner s-${status ?? -1}`}>
            {status === undefined || status === null
              ? "NO FACILITY"
              : `MARGIN STATUS: ${STATUS_NAME[status]}`}
          </div>

          <p className="hint">
            The lender verified an <b>Ed25519 MarginAttestation</b> from the pinned
            risk engine before releasing credit — and learns only the decision, the
            amount, and this status. Roadmap: replace the trusted attester with MPC
            (Arcium) or ZK so even the attester learns nothing.
          </p>
        </section>
      </div>

      <footer>
        Hackathon prototype · the raw custody token balances ARE public (documented
        ingress leak) · see README for the full confidentiality table ·{" "}
        <a href="https://github.com" onClick={(e) => e.preventDefault()}>
          IMPLEMENTATION_PLAN.md
        </a>
      </footer>
    </div>
  );
}

function shortError(e: any): string {
  const s = String(e?.message ?? e);
  const anchorErr = s.match(/Error Code: (\w+)\. Error Number: \d+\. Error Message: ([^"\\]+)/);
  if (anchorErr) return `${anchorErr[1]} — ${anchorErr[2].trim()}`;
  const m = s.match(/([A-Z][A-Za-z]+Error)/g);
  return m ? m[m.length - 1] : s.slice(0, 140);
}
