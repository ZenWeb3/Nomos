import { useReadContracts } from "wagmi";
import { formatEther } from "viem";
import { NOMOS_PAYROLL_ABI, NOMOS_TOKEN_ABI, NOMOS_PAYROLL_ADDRESS, NOMOS_TOKEN_ADDRESS } from "./contracts.js";

export function useStatus() {
  const payroll = { address: NOMOS_PAYROLL_ADDRESS, abi: NOMOS_PAYROLL_ABI } as const;

  const { data, isLoading, error } = useReadContracts({
    contracts: [
      { ...payroll, functionName: "getEmployees" },
      { address: NOMOS_TOKEN_ADDRESS, abi: NOMOS_TOKEN_ABI, functionName: "balanceOf", args: [NOMOS_PAYROLL_ADDRESS] },
      { ...payroll, functionName: "cycleCount" },
      { ...payroll, functionName: "lastRunTimestamp" },
      { ...payroll, functionName: "policy" },
    ],
  });

  if (data === undefined || isLoading) return { isLoading: true as const, error };

  const [employees, treasuryBalance, cycleCount, lastRunTimestamp, policy] = data;
  if (
    employees.status !== "success" ||
    treasuryBalance.status !== "success" ||
    cycleCount.status !== "success" ||
    lastRunTimestamp.status !== "success" ||
    policy.status !== "success"
  ) {
    return { isLoading: false as const, error: error ?? new Error("Contract read failed") };
  }

  const [cooldownSeconds] = policy.result as [bigint, number, number, bigint];
  const lastRunAt = lastRunTimestamp.result as bigint;
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const nextAllowed = lastRunAt + cooldownSeconds;
  const secondsUntilNextCycle = nextAllowed > nowSeconds ? Number(nextAllowed - nowSeconds) : 0;

  return {
    isLoading: false as const,
    error: undefined,
    rosterSize: (employees.result as string[]).length,
    treasuryBalanceFormatted: formatEther(treasuryBalance.result as bigint),
    cycleCount: cycleCount.result as bigint,
    lastRunTimestamp: lastRunAt,
    secondsUntilNextCycle,
  };
}
