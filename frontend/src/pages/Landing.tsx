import { Link } from "react-router-dom";
import { useStatus } from "../lib/useStatus.js";

export default function Landing() {
  return (
    <div>
      <nav className="container" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "24px" }}>
        <span style={{ fontWeight: 700, fontSize: 18 }}>Nomos</span>
        <div style={{ display: "flex", gap: 12 }}>
          <a className="btn btn-secondary" href="https://github.com/zenweb3/nomos" target="_blank" rel="noreferrer">
            GitHub
          </a>
          <Link className="btn btn-primary" to="/app">
            Open Dashboard
          </Link>
        </div>
      </nav>

      <header className="container" style={{ padding: "80px 24px 60px", textAlign: "center" }}>
        <span className="pill">Live on Ethereum Sepolia · iExec Nox · Sablier</span>
        <h1 style={{ fontSize: 52, lineHeight: 1.1, margin: "24px 0 16px", maxWidth: 780, marginInline: "auto" }}>
          Payroll where salaries stay private — but the math is provable.
        </h1>
        <p style={{ fontSize: 19, color: "var(--text-dim)", maxWidth: 620, marginInline: "auto" }}>
          Nomos runs confidential, agent-executed payroll. Individual salaries and the payroll total never touch
          the chain in the clear — but anyone can independently verify every payment was correct.
        </p>
        <div style={{ display: "flex", gap: 12, justifyContent: "center", marginTop: 32 }}>
          <Link className="btn btn-primary" to="/app">
            Open Dashboard
          </Link>
          <a className="btn btn-secondary" href="#how">
            How it works
          </a>
        </div>
      </header>

      <LiveProof />

      <section id="how" className="container" style={{ padding: "80px 24px" }}>
        <h2 style={{ fontSize: 32, marginBottom: 40 }}>Hidden vs. verifiable</h2>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
          <div className="card">
            <h3 style={{ color: "var(--danger)", marginTop: 0 }}>Hidden</h3>
            <ul style={{ color: "var(--text-dim)", paddingLeft: 20 }}>
              <li>Individual salary amounts</li>
              <li>Who's actually on payroll</li>
              <li>The confidential aggregate outflow (auditor-only)</li>
            </ul>
          </div>
          <div className="card">
            <h3 style={{ color: "var(--accent)", marginTop: 0 }}>Verifiable</h3>
            <ul style={{ color: "var(--text-dim)", paddingLeft: 20 }}>
              <li>Every payment matched its confidential ledger entry</li>
              <li>Total outflow stayed under the on-chain spend cap</li>
              <li>Only allowlisted addresses were ever paid</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="container" style={{ padding: "0 24px 80px" }}>
        <h2 style={{ fontSize: 32, marginBottom: 40 }}>Architecture</h2>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 24 }}>
          <ArchCard title="Nox" desc="Confidential contract holds encrypted salaries, roster, and policy as opaque handles." />
          <ArchCard title="Agent" desc="Reads roster state on schedule, applies deterministic rules, fires payments — no LLM in the loop." />
          <ArchCard title="Sablier" desc="Real streaming payments on Sepolia. Amounts are unlinkable to individual salaries from outside." />
        </div>
      </section>

      <footer className="container" style={{ padding: "40px 24px", borderTop: "1px solid var(--border)", color: "var(--text-dim)", fontSize: 14 }}>
        Built for the iExec WTF Hackathon Summer Edition. Not audited — testnet only.
      </footer>
    </div>
  );
}

function ArchCard({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      <p style={{ color: "var(--text-dim)", margin: 0 }}>{desc}</p>
    </div>
  );
}

function LiveProof() {
  const status = useStatus();

  if (status.isLoading || status.error) return null;

  return (
    <section className="container" style={{ padding: "0 24px 60px" }}>
      <div className="card" style={{ display: "flex", justifyContent: "space-around", textAlign: "center", flexWrap: "wrap", gap: 24 }}>
        <Stat label="Cycles run" value={status.cycleCount.toString()} />
        <Stat label="Employees" value={status.rosterSize.toString()} />
        <Stat label="Treasury" value={`${status.treasuryBalanceFormatted} NMS`} />
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 28, fontWeight: 700, color: "var(--accent)" }}>{value}</div>
      <div style={{ color: "var(--text-dim)", fontSize: 14 }}>{label}</div>
    </div>
  );
}
