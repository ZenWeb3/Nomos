// `nomos status` — no keys needed, reads only plaintext on-chain state.

import { createPublicClient, formatEther, http } from "viem";
import { sepolia } from "viem/chains";
import { NOMOS_PAYROLL_ABI, ERC20_ABI } from "../../agent/src/contracts.js";
import { loadCliEnv } from "./env.js";
import { printJson } from "./json.js";

export interface StatusResult {
  nomosPayrollAddress: string;
  rosterSize: number;
  treasuryBalanceRaw: bigint;
  treasuryBalanceFormatted: string;
  cycleCount: bigint;
  lastRunTimestamp: bigint;
  lastRunIso: string | null; // null = never run
  secondsUntilNextCycle: number;
}

export async function collectStatus(): Promise<StatusResult> {
  const env = loadCliEnv(process.env);
  const publicClient = createPublicClient({ chain: sepolia, transport: http(env.sepoliaRpcUrl) });
  const payroll = { address: env.nomosPayrollAddress, abi: NOMOS_PAYROLL_ABI } as const;

  const [employees, treasuryBalance, cycleCount, lastRunTimestamp, policy] = await Promise.all([
    publicClient.readContract({ ...payroll, functionName: "getEmployees" }) as Promise<string[]>,
    publicClient.readContract({
      address: env.nomosTokenAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [env.nomosPayrollAddress],
    }) as Promise<bigint>,
    publicClient.readContract({ ...payroll, functionName: "cycleCount" }) as Promise<bigint>,
    publicClient.readContract({ ...payroll, functionName: "lastRunTimestamp" }) as Promise<bigint>,
    publicClient.readContract({ ...payroll, functionName: "policy" }) as Promise<
      [bigint, number, number, bigint]
    >,
  ]);

  const [cooldownSeconds] = policy;
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const nextAllowed = lastRunTimestamp + cooldownSeconds;
  const secondsUntilNextCycle = nextAllowed > nowSeconds ? Number(nextAllowed - nowSeconds) : 0;

  return {
    nomosPayrollAddress: env.nomosPayrollAddress,
    rosterSize: employees.length,
    treasuryBalanceRaw: treasuryBalance,
    treasuryBalanceFormatted: formatEther(treasuryBalance),
    cycleCount,
    lastRunTimestamp,
    lastRunIso: lastRunTimestamp === 0n ? null : new Date(Number(lastRunTimestamp) * 1000).toISOString(),
    secondsUntilNextCycle,
  };
}

export function printStatusText(r: StatusResult): void {
  console.log("Nomos status");
  console.log("============");
  console.log(`NomosPayroll:      ${r.nomosPayrollAddress}`);
  console.log(`Roster size:       ${r.rosterSize}`);
  console.log(`Treasury balance:  ${r.treasuryBalanceFormatted} tokens`);
  console.log(`Cycle count:       ${r.cycleCount}`);
  console.log(`Last run:          ${r.lastRunIso ?? "never"}`);
  console.log(
    `Next cycle in:     ${r.secondsUntilNextCycle}s${r.secondsUntilNextCycle === 0 ? " (ready now, pending roster/treasury checks)" : ""}`,
  );
}

export async function statusCommand(json: boolean): Promise<void> {
  const result = await collectStatus();
  if (json) printJson(result);
  else printStatusText(result);
}

/** Re-fetches and reprints on an interval until Ctrl+C. Each tick is a fresh read — no shared state between ticks. */
export async function statusWatchCommand(intervalSeconds: number, json: boolean): Promise<void> {
  let stopped = false;
  let wakeEarly: (() => void) | undefined;
  process.once("SIGINT", () => {
    stopped = true;
    wakeEarly?.();
  });

  while (!stopped) {
    const result = await collectStatus();
    if (stopped) break;

    if (!json) console.clear();
    if (json) printJson(result);
    else {
      printStatusText(result);
      console.log(`\n(refreshing every ${intervalSeconds}s — Ctrl+C to stop)`);
    }

    await new Promise<void>((resolve) => {
      wakeEarly = resolve;
      setTimeout(resolve, intervalSeconds * 1000);
    });
  }
}
