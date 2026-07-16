import type { Address } from "viem";

export interface CliEnv {
  nomosPayrollAddress: Address;
  nomosTokenAddress: Address;
  sepoliaRpcUrl: string;
}

export function loadCliEnv(env: NodeJS.ProcessEnv): CliEnv {
  return {
    nomosPayrollAddress: requireEnv(env, "NOMOS_PAYROLL_ADDRESS") as Address,
    nomosTokenAddress: requireEnv(env, "NOMOS_TOKEN_ADDRESS") as Address,
    sepoliaRpcUrl: requireEnv(env, "SEPOLIA_RPC_URL"),
  };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value.trim();
}
