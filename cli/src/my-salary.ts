// `nomos my-salary --key <path> [--employee <name>]` — an employee decrypts
// their OWN salary, and only their own. `addEmployee` grants `Nox.allow(salary,
// recipient)` at add-time (NomosPayroll.sol:146) — a persistent, per-address
// ACL entry, not a shared secret — so this works for exactly the address that
// key controls, and nothing else. Any other key gets the same genuine ACL
// rejection `audit` demonstrates for the aggregate handle, just scoped to one
// employee's salary instead of the roster-wide total.

import { createPublicClient, createWalletClient, formatEther, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { NOMOS_PAYROLL_ABI } from "../../agent/src/contracts.js";
import { createNoxHandleClient } from "../../agent/src/nox.js";
import { loadCliEnv } from "./env.js";
import { loadPrivateKeyFromFile } from "./keys.js";
import { printJson } from "./json.js";

export type MySalaryResult =
  | { onRoster: false; address: string }
  | { onRoster: true; authorized: true; address: string; salaryRaw: string; salaryFormatted: string }
  | { onRoster: true; authorized: false; address: string; error: string };

export async function collectMySalary(keyFilePath: string, employeeSelector?: string): Promise<MySalaryResult> {
  const env = loadCliEnv(process.env);
  const account = privateKeyToAccount(loadPrivateKeyFromFile(keyFilePath, employeeSelector));

  const publicClient = createPublicClient({ chain: sepolia, transport: http(env.sepoliaRpcUrl) });
  const walletClient = createWalletClient({ account, chain: sepolia, transport: http(env.sepoliaRpcUrl) });
  const handleClient = await createNoxHandleClient(walletClient);

  const isAllowlisted = (await publicClient.readContract({
    address: env.nomosPayrollAddress,
    abi: NOMOS_PAYROLL_ABI,
    functionName: "isAllowlisted",
    args: [account.address],
  })) as boolean;

  if (!isAllowlisted) return { onRoster: false, address: account.address };

  const salaryHandle = (await publicClient.readContract({
    address: env.nomosPayrollAddress,
    abi: NOMOS_PAYROLL_ABI,
    functionName: "getEmployeeSalaryHandle",
    args: [account.address],
  })) as Hex;

  try {
    const { value } = await handleClient.decrypt<"uint256">(salaryHandle);
    return {
      onRoster: true,
      authorized: true,
      address: account.address,
      salaryRaw: value.toString(),
      salaryFormatted: formatEther(value),
    };
  } catch (error) {
    return {
      onRoster: true,
      authorized: false,
      address: account.address,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function printMySalaryText(r: MySalaryResult): void {
  console.log(`Checking salary as ${r.address}...`);
  if (!r.onRoster) {
    console.error(`${r.address} is not on the current roster — there is no salary to decrypt.`);
    return;
  }
  if (r.authorized) {
    console.log(`Your salary: ${r.salaryFormatted} tokens (raw: ${r.salaryRaw})`);
  } else {
    console.error("Decryption failed — this address is not authorized to view this salary handle.");
    console.error("(This shouldn't happen for an allowlisted employee — the handle should be self-viewable.)");
    console.error(`Underlying error: ${r.error}`);
  }
}

export async function mySalaryCommand(keyFilePath: string, employeeSelector: string | undefined, json: boolean): Promise<number> {
  const result = await collectMySalary(keyFilePath, employeeSelector);
  if (json) printJson(result);
  else printMySalaryText(result);
  return result.onRoster && result.authorized ? 0 : 1;
}
