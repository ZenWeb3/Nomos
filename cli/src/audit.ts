// `nomos audit --auditor-key <path>` — proves the auditor mechanism works
// by actually using it: loads a private key, uses it to decrypt the
// confidential aggregate outflow handle. Any other key gets an ACL
// rejection from the Handle Gateway (isViewer check on-chain fails, since
// only addresses granted via grantAuditor — or agent/employee on their own
// salary — have persistent Nox.allow access to a given handle).

import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { NOMOS_PAYROLL_ABI } from "../../agent/src/contracts.js";
import { createNoxHandleClient } from "../../agent/src/nox.js";
import { normalizePrivateKey } from "../../agent/src/sepolia.js";
import { loadCliEnv } from "./env.js";

/**
 * Accepts either a raw hex private key or a deployments JSON file with an
 * `auditor.privateKey` (or top-level `privateKey`) field — the latter so
 * `deployments/*.json` can be pointed at directly without extracting the
 * key by hand first.
 */
function loadPrivateKeyFromFile(path: string): Hex {
  const raw = readFileSync(path, "utf8").trim();
  try {
    const parsed: unknown = JSON.parse(raw);
    const fromJson =
      (parsed as { auditor?: { privateKey?: string }; privateKey?: string })?.auditor?.privateKey ??
      (parsed as { privateKey?: string })?.privateKey;
    if (typeof fromJson === "string") return normalizePrivateKey(fromJson);
  } catch {
    // Not JSON — fall through and treat the whole file as a raw key.
  }
  return normalizePrivateKey(raw);
}

export async function auditCommand(keyFilePath: string): Promise<number> {
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

  console.log(`Auditing as ${account.address}...`);

  try {
    const { value } = await handleClient.decrypt<"uint256">(aggregateHandle);
    console.log(`Confidential aggregate outflow: ${value} (raw uint256, token's smallest unit)`);
    return 0;
  } catch (error) {
    console.error("Decryption failed — this address is not authorized to view the aggregate outflow handle.");
    console.error(`(Expected unless ${account.address} was granted via grantAuditor.)`);
    console.error(`Underlying error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
