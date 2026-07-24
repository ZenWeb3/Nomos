import { Link } from "react-router-dom";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { useStatus } from "../lib/useStatus.js";

export default function Dashboard() {
  return (
    <div className="container" style={{ padding: "24px" }}>
      <nav style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 32 }}>
        <Link to="/" style={{ fontWeight: 700, fontSize: 18, textDecoration: "none" }}>
          Nomos
        </Link>
        <WalletButton />
      </nav>

      <StatusPanel />
    </div>
  );
}

function WalletButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected && address) {
    return (
      <button className="btn btn-secondary mono" onClick={() => disconnect()}>
        {address.slice(0, 6)}...{address.slice(-4)}
      </button>
    );
  }

  return (
    <button className="btn btn-primary" disabled={isPending} onClick={() => connect({ connector: connectors[0] })}>
      {isPending ? "Connecting..." : "Connect Wallet"}
    </button>
  );
}

function StatusPanel() {
  const status = useStatus();

  if (status.isLoading) return <div className="card">Loading...</div>;
  if (status.error) return <div className="card">Failed to load: {status.error.message}</div>;

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Status</h2>
      <Row label="Roster size" value={status.rosterSize.toString()} />
      <Row label="Treasury" value={`${status.treasuryBalanceFormatted} NMS`} />
      <Row label="Cycle count" value={status.cycleCount.toString()} />
      <Row
        label="Next cycle"
        value={status.secondsUntilNextCycle === 0 ? "ready now" : `${status.secondsUntilNextCycle}s`}
      />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
      <span style={{ color: "var(--text-dim)" }}>{label}</span>
      <span className="mono">{value}</span>
    </div>
  );
}
