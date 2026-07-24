// `nomos audit --auditor-key <path>` — proves the auditor mechanism works
// by actually using it: loads a private key, uses it to decrypt the
// confidential aggregate outflow handle. Any other key gets an ACL
// rejection from the Handle Gateway (isViewer check on-chain fails, since
// only addresses granted via grantAuditor — or agent/employee on their own
// salary — have persistent Nox.allow access to a given handle).

import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { NOMOS_PAYROLL_ABI } from "../../agent/src/contracts.js";
import { createNoxHandleClient } from "../../agent/src/nox.js";
import { loadCliEnv } from "./env.js";
import { loadPrivateKeyFromFile } from "./keys.js";
import { printJson } from "./json.js";

export type AuditResult =
  | { authorized: true; auditorAddress: string; aggregateOutflowRaw: string }
  | { authorized: false; auditorAddress: string; error: string };

export async function collectAudit(keyFilePath: string): Promise<AuditResult> {
  const env = loadCliEnv(process.env);
  const account = privateKeyToAccount(loadPrivateKeyFromFile(keyFilePath));

  const publicClient = createPublicClient({ chain: sepolia, transport: http(env.sepoliaRpcUrl) });
  const walletClient = createWalletClient({ account, chain: sepolia, transport: http(env.sepoliaRpcUrl) });
  const handleClient = await createNoxHandleClient(walletClient);

  const aggregateHandle = (await publicClient.readContract({
    address: env.nomosPayrollAddress,
    abi: NOMOS_PAYROLL_ABI,
    functionName: "getAggregateOutflowHandle",
  })) as Hex;

  try {
    const { value } = await handleClient.decrypt<"uint256">(aggregateHandle);
    return { authorized: true, auditorAddress: account.address, aggregateOutflowRaw: value.toString() };
  } catch (error) {
    return {
      authorized: false,
      auditorAddress: account.address,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function printAuditText(r: AuditResult): void {
  console.log(`Auditing as ${r.auditorAddress}...`);
  if (r.authorized) {
    console.log(`Confidential aggregate outflow: ${r.aggregateOutflowRaw} (raw uint256, token's smallest unit)`);
  } else {
    console.error("Decryption failed — this address is not authorized to view the aggregate outflow handle.");
    console.error(`(Expected unless ${r.auditorAddress} was granted via grantAuditor.)`);
    console.error(`Underlying error: ${r.error}`);
  }
}

export async function auditCommand(keyFilePath: string, json: boolean): Promise<number> {
  const result = await collectAudit(keyFilePath);
  if (json) printJson(result);
  else printAuditText(result);
  return result.authorized ? 0 : 1;
}
