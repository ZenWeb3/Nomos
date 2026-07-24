import { Fragment } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, EyeOff, ShieldCheck, Cpu, Bot, Waves, Lock, CheckCircle2 } from "lucide-react";
import { useStatus } from "../lib/useStatus.js";
import { GithubMark } from "../components/GithubMark.js";

export default function Landing() {
  return (
    <div>
      <Nav />
      <Hero />
      <LiveProof />
      <HiddenVsVerifiable />
      <HowItWorks />
      <FinalCta />
      <Footer />
    </div>
  );
}

function Nav() {
  return (
    <nav
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        backdropFilter: "blur(12px)",
        background: "rgba(5,5,10,0.7)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div className="container" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 24px" }}>
        <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 20, letterSpacing: "-0.02em" }}>
          Nomos
        </span>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <a
            className="btn btn-secondary"
            href="https://github.com/zenweb3/nomos"
            target="_blank"
            rel="noreferrer"
            style={{ padding: "10px 18px" }}
          >
            <GithubMark size={16} />
            GitHub
          </a>
          <Link className="btn btn-primary" to="/app" style={{ padding: "10px 20px" }}>
            Open Dashboard
            <ArrowRight size={16} />
          </Link>
        </div>
      </div>
    </nav>
  );
}

function Hero() {
  return (
    <header style={{ position: "relative", padding: "120px 24px 100px", textAlign: "center", overflow: "hidden" }}>
      <div className="glow-bg" />
      <div className="grid-overlay" />
      <div className="container">
        <span className="pill">
          <span className="pill-dot" />
          Live on Ethereum Sepolia
        </span>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "clamp(40px, 6vw, 68px)",
            lineHeight: 1.05,
            letterSpacing: "-0.03em",
            margin: "28px auto 20px",
            maxWidth: 820,
          }}
        >
          Payroll where salaries <br />
          stay <span className="gradient-text">private</span> — but the math is{" "}
          <span className="gradient-text">provable</span>.
        </h1>
        <p style={{ fontSize: 19, color: "var(--text-dim)", maxWidth: 600, marginInline: "auto" }}>
          Nomos runs confidential, agent-executed payroll on iExec Nox and Sablier. Individual salaries and the
          payroll total never touch the chain in the clear — but anyone can independently verify every payment
          was correct.
        </p>
        <div style={{ display: "flex", gap: 14, justifyContent: "center", marginTop: 36, flexWrap: "wrap" }}>
          <Link className="btn btn-primary" to="/app" style={{ padding: "14px 28px", fontSize: 16 }}>
            Open Dashboard
            <ArrowRight size={18} />
          </Link>
          <a className="btn btn-secondary" href="#how" style={{ padding: "14px 28px", fontSize: 16 }}>
            How it works
          </a>
        </div>
      </div>
    </header>
  );
}

function LiveProof() {
  const status = useStatus();
  if (status.isLoading || status.error) return null;

  return (
    <section className="container" style={{ padding: "0 24px 100px" }}>
      <div
        className="card"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 32,
          textAlign: "center",
        }}
      >
        <Stat label="Cycles run" value={status.cycleCount.toString()} />
        <Stat label="Employees" value={status.rosterSize.toString()} />
        <Stat label="Treasury" value={`${status.treasuryBalanceFormatted} NMS`} />
        <Stat label="Next cycle" value={status.secondsUntilNextCycle === 0 ? "ready" : `${status.secondsUntilNextCycle}s`} />
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        className="mono gradient-text"
        style={{ fontSize: 30, fontWeight: 600, fontFamily: "var(--font-display)" }}
      >
        {value}
      </div>
      <div style={{ color: "var(--text-faint)", fontSize: 13, marginTop: 4 }}>{label}</div>
    </div>
  );
}

function HiddenVsVerifiable() {
  return (
    <section className="container" style={{ padding: "0 24px 100px" }}>
      <div style={{ textAlign: "center", marginBottom: 56 }}>
        <span className="section-label">The core idea</span>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(28px, 4vw, 40px)", letterSpacing: "-0.02em" }}>
          Hidden vs. verifiable
        </h2>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
        <div className="card">
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: "rgba(255,138,138,0.12)",
              display: "grid",
              placeItems: "center",
              marginBottom: 18,
            }}
          >
            <EyeOff size={20} color="var(--danger)" />
          </div>
          <h3 style={{ margin: "0 0 12px", fontFamily: "var(--font-display)", fontSize: 20 }}>Hidden</h3>
          <FeatureList
            items={["Individual salary amounts", "Who's actually on payroll", "The confidential aggregate outflow"]}
          />
        </div>
        <div className="card">
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: "rgba(125,250,176,0.12)",
              display: "grid",
              placeItems: "center",
              marginBottom: 18,
            }}
          >
            <ShieldCheck size={20} color="var(--accent)" />
          </div>
          <h3 style={{ margin: "0 0 12px", fontFamily: "var(--font-display)", fontSize: 20 }}>Verifiable</h3>
          <FeatureList
            items={[
              "Every payment matched its confidential ledger entry",
              "Total outflow stayed under the on-chain spend cap",
              "Only allowlisted addresses were ever paid",
            ]}
          />
        </div>
      </div>
    </section>
  );
}

function FeatureList({ items }: { items: string[] }) {
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
      {items.map((item) => (
        <li key={item} style={{ display: "flex", gap: 10, color: "var(--text-dim)", fontSize: 15 }}>
          <CheckCircle2 size={17} style={{ flexShrink: 0, marginTop: 2, color: "var(--text-faint)" }} />
          {item}
        </li>
      ))}
    </ul>
  );
}

function HowItWorks() {
  const steps = [
    { icon: Lock, title: "Nox", desc: "Confidential contract holds encrypted salaries, roster, and policy as opaque on-chain handles." },
    { icon: Bot, title: "Agent", desc: "Reads roster state on schedule, applies deterministic rules, fires payments. No LLM in the loop." },
    { icon: Waves, title: "Sablier", desc: "Real streaming payments on Sepolia. Amounts stay unlinkable to individual salaries from outside." },
  ];

  return (
    <section id="how" className="container" style={{ padding: "0 24px 100px" }}>
      <div style={{ textAlign: "center", marginBottom: 56 }}>
        <span className="section-label">Architecture</span>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(28px, 4vw, 40px)", letterSpacing: "-0.02em" }}>
          Three pieces, one guarantee
        </h2>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr auto 1fr", gap: 16, alignItems: "center" }}>
        {steps.map((step, i) => (
          <Fragment key={step.title}>
            <div className="card" style={{ textAlign: "center" }}>
              <div
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 12,
                  background: "var(--surface-hover)",
                  border: "1px solid var(--border)",
                  display: "grid",
                  placeItems: "center",
                  marginInline: "auto",
                  marginBottom: 16,
                }}
              >
                <step.icon size={22} color="var(--accent)" />
              </div>
              <h3 style={{ margin: "0 0 8px", fontFamily: "var(--font-display)", fontSize: 18 }}>{step.title}</h3>
              <p style={{ margin: 0, color: "var(--text-dim)", fontSize: 14 }}>{step.desc}</p>
            </div>
            {i < steps.length - 1 && <ArrowRight size={20} color="var(--text-faint)" style={{ justifySelf: "center" }} />}
          </Fragment>
        ))}
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="container" style={{ padding: "0 24px 120px" }}>
      <div
        className="card"
        style={{
          textAlign: "center",
          padding: "64px 32px",
          background: "linear-gradient(160deg, rgba(125,250,176,0.06), rgba(107,168,255,0.04))",
        }}
      >
        <Cpu size={28} color="var(--accent)" style={{ marginBottom: 16 }} />
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(26px, 4vw, 36px)", letterSpacing: "-0.02em", margin: "0 0 12px" }}>
          See it verify itself
        </h2>
        <p style={{ color: "var(--text-dim)", maxWidth: 480, marginInline: "auto", marginBottom: 32 }}>
          Every attestation on the dashboard is independently re-checked on-chain, live, in your browser.
        </p>
        <Link className="btn btn-primary" to="/app" style={{ padding: "14px 28px", fontSize: 16 }}>
          Open Dashboard
          <ArrowRight size={18} />
        </Link>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="container" style={{ padding: "32px 24px", borderTop: "1px solid var(--border)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <span style={{ color: "var(--text-faint)", fontSize: 14 }}>
          Built for the iExec WTF Hackathon Summer Edition. Testnet only — not audited.
        </span>
        <a
          href="https://github.com/zenweb3/nomos"
          target="_blank"
          rel="noreferrer"
          style={{ color: "var(--text-dim)", fontSize: 14, display: "flex", gap: 6, alignItems: "center" }}
        >
          <GithubMark size={15} />
          Source
        </a>
      </div>
    </footer>
  );
}
