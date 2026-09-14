import { expect } from "chai";
import {
  zkCommit,
  proveThreshold,
  verifyThreshold,
  ThresholdProofPublic,
} from "../sdk/src/zk";
import { DEMO_PORTFOLIO } from "../sdk/src/config";

describe("ZK milestone: Poseidon commitment + threshold proof", () => {
  const salt = 42n;
  const holdingKeys = DEMO_PORTFOLIO.map((h) => BigInt(h.qtyUnits));

  it("commitment: same holdings + salt → same Poseidon output", () => {
    const a = zkCommit(DEMO_PORTFOLIO, salt);
    const b = zkCommit(DEMO_PORTFOLIO, salt);
    expect(a.commitment).to.eq(b.commitment);
    expect(a.sha256Hex).to.eq(b.sha256Hex);
  });

  it("commitment: different salt → different output", () => {
    const a = zkCommit(DEMO_PORTFOLIO, 42n);
    const b = zkCommit(DEMO_PORTFOLIO, 43n);
    expect(a.commitment).to.not.eq(b.commitment);
  });

  it("commitment: different holdings → different output", () => {
    const a = zkCommit(DEMO_PORTFOLIO, salt);
    const modified = DEMO_PORTFOLIO.map((h, i) =>
      i === 0 ? { ...h, qtyUnits: h.qtyUnits + 1 } : h,
    );
    const b = zkCommit(modified, salt);
    expect(a.commitment).to.not.eq(b.commitment);
  });

  it("threshold proof: verifies when the claimed HF meets the threshold", () => {
    const commit = zkCommit(DEMO_PORTFOLIO, salt);
    const pubInputs: ThresholdProofPublic = {
      commitment: commit.commitment,
      thresholdHfBps: 20000,
      requestedUsdcMicros: 300_000_000_000,
    };
    const proof = proveThreshold(DEMO_PORTFOLIO, salt, pubInputs, 21000);
    expect(verifyThreshold(proof, pubInputs)).to.be.true;
  });

  it("threshold proof: fails when the HF is below the threshold", () => {
    const commit = zkCommit(DEMO_PORTFOLIO, salt);
    const pubInputs: ThresholdProofPublic = {
      commitment: commit.commitment,
      thresholdHfBps: 20000,
      requestedUsdcMicros: 300_000_000_000,
    };
    const proof = proveThreshold(DEMO_PORTFOLIO, salt, pubInputs, 15000);
    expect(verifyThreshold(proof, pubInputs)).to.be.false;
  });

  it("threshold proof: Fiat-Shamir challenge binds the claimed HF", () => {
    const commit = zkCommit(DEMO_PORTFOLIO, salt);
    const pubInputs: ThresholdProofPublic = {
      commitment: commit.commitment,
      thresholdHfBps: 20000,
      requestedUsdcMicros: 300_000_000_000,
    };
    const proof = proveThreshold(DEMO_PORTFOLIO, salt, pubInputs, 21000);
    // Tamper with the claimed HF.
    const tampered = { ...proof, claimedHfBps: "99000" };
    expect(verifyThreshold(tampered, pubInputs)).to.be.false;
  });
});
