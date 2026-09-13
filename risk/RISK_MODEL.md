# Risk model — worked example

The executable risk engine is `sdk/src/risk.ts` (single source of truth; the
on-chain `RiskPolicy` account holds the parameters below). This document walks
the demo numbers end-to-end so every decision in the scripted demo is
reproducible by hand.

## Parameters (institutional_equity_v1)

| parameter | value |
|---|---|
| advance rates | SPYx 80% · AAPLx 70% · NVDAx 60% |
| session factors | open 1.00 · extended 0.90 · closed 0.80 |
| concentration | single asset >40% of gross NAV ⇒ ×0.75 on that asset |
| stale oracle | asset contributes 0 (ineligible collateral) |
| credit / compliant floor | HF ≥ 2.00 |
| ineligible floor | HF < 1.50 (1.50–2.00 ⇒ MARGIN_CALL) |

```
eligible_value(asset) = qty × price × advance_rate × session_factor × concentration_penalty
HF = Σ eligible_value / outstanding_credit
```

Demo portfolio: 1,000 SPYx @ $500 · 1,500 AAPLx @ $200 · 2,000 NVDAx @ $100.
Credit request: $300,000. All figures in $k.

## Baseline (US market open)

| asset | value | weight | advance | session | concentration | eligible |
|---|---|---|---|---|---|---|
| SPYx | 500 | 50.0% | 0.80 | 1.00 | ×0.75 (weight > 40%) | 300.0 |
| AAPLx | 300 | 30.0% | 0.70 | 1.00 | — | 210.0 |
| NVDAx | 200 | 20.0% | 0.60 | 1.00 | — | 120.0 |
| **NAV** | **1000** | | | | **Σ** | **630.0** |

HF = 630 / 300 = **2.10** ⇒ ELIGIBLE. CreditGate releases $300,000.

## Stress 1 — NVDA −30% ($100 → $70)

NAV 940. Weights: SPYx 53.2% (penalized), AAPLx 31.9%, NVDAx 14.9%.

eligible = 500×0.8×0.75 + 300×0.7 + 140×0.6 = 300 + 210 + 84 = **594**
HF = 594 / 300 = **1.98** ⇒ MARGIN_CALL (public: "additional collateral required").

## Stress 2 — US market closes (on top of stress 1)

eligible = 500×0.8×0.8×0.75 + 300×0.7×0.8 + 140×0.6×0.8
         = 240 + 168 + 67.2 = **475.2**
HF = 475.2 / 300 = **1.58** ⇒ MARGIN_CALL.

## Stress 3 — deep: SPYx −20%, AAPLx −10%, NVDA oracle outage, market closed

NVDA stale ⇒ 0. NAV 810. SPYx 49.4% (penalized), AAPLx 33.3%.

eligible = 400×0.8×0.8×0.75 + 270×0.7×0.8 + 0 = 192 + 151.2 + 0 = **343.2**
HF = 343.2 / 300 = **1.14** ⇒ INELIGIBLE. A fresh $300k draw is rejected
on-chain (`NotEligibleForCredit`).

## Recovery + repayment

Oracle republishes (fresh + prices restored) and the market reopens:
eligible 630 ⇒ HF 2.10 ⇒ COMPLIANT. Institution repays $300,000 ⇒ facility
closed (`REPAID`).

## What the lender sees at each step

Only: requested amount · decision · policy id · collateral-locked flag ·
margin status. NAV, weights, HF and per-asset moves stay off-chain.
