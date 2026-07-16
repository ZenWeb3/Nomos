// `nomos status` — no keys needed, reads only plaintext on-chain state.

import { createPublicClient, formatEther, http } from "viem";
import { sepolia } from "viem/chains";
import { NOMOS_PAYROLL_ABI, ERC20_ABI } from "../../agent/src/contracts.js";
import { loadCliEnv } from "./env.js";

export async function statusCommand(): Promise<void> {
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
  const secondsUntilNext = nextAllowed > nowSeconds ? Number(nextAllowed - nowSeconds) : 0;

  console.log("Nomos status");
  console.log("============");
  console.log(`NomosPayroll:      ${env.nomosPayrollAddress}`);
  console.log(`Roster size:       ${employees.length}`);
  console.log(`Treasury balance:  ${formatEther(treasuryBalance)} tokens`);
  console.log(`Cycle count:       ${cycleCount}`);
  console.log(
    `Last run:          ${lastRunTimestamp === 0n ? "never" : new Date(Number(lastRunTimestamp) * 1000).toISOString()}`,
  );
  console.log(
    `Next cycle in:     ${secondsUntilNext}s${secondsUntilNext === 0 ? " (ready now, pending roster/treasury checks)" : ""}`,
  );
}
