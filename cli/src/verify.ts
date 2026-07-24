// `nomos verify --cycle N` / `nomos verify --all` — independent verification,
// not a keeper-trust exercise. For every PaymentAttested handle emitted for
// the target cycle(s):
//   1. publicDecrypt it via the Handle Gateway (anyone can — the handle was
//      marked publicly decryptable by NomosPayroll itself).
//   2. Independently re-verify the returned proof on-chain by calling
//      NoxCompute.validateDecryptionProof directly — the exact same check
//      NomosPayroll performs internally. It reverts if the signature
//      doesn't check out against the Gateway's registered key, so a
//      successful call here is a real cryptographic guarantee, not just
//      trust in whatever the Gateway HTTP response said.
// This is the honest "TEE attestation" story for this project: the proof
// is the Nox Gateway's EIP-712 signature, not anything the keeper itself
// vouches for.

import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { NOMOS_PAYROLL_ABI } from "../../agent/src/contracts.js";
import { createNoxHandleClient, NOX_COMPUTE_ABI, NOX_COMPUTE_ADDRESS } from "../../agent/src/nox.js";
import { eventArgs } from "../../agent/src/events.js";
import { loadCliEnv } from "./env.js";
import { printJson } from "./json.js";

export interface AttestationRow {
  recipient: string;
  streamId: bigint;
  matches: boolean;
}

export interface CycleVerification {
  cycle: number;
  rows: AttestationRow[];
  verified: boolean;
}

export type VerifyOneResult =
  | { found: true; gatewayAddress: string; cycle: number; rows: AttestationRow[]; verified: boolean }
  | { found: false; cycle: number };

export type VerifyAllResult =
  | { found: true; gatewayAddress: string; cycles: CycleVerification[]; allVerified: boolean }
  | { found: false };

interface PaymentAttestedArgs {
  recipient: string;
  streamId: bigint;
  cycleCount: bigint;
  matchesLedgerHandle: Hex;
}

type PaymentAttestedLog = Awaited<ReturnType<ReturnType<typeof createPublicClient>["getContractEvents"]>>[number];

// Public RPC providers cap eth_getLogs to a fixed block range per call, so an
// unbounded fromBlock:"earliest" query fails outright. The provider's error
// messages disagreed with themselves about the exact cap (10,000 in one
// message, 1,000 enforced in practice) — 900 stays safely under either.
const LOG_CHUNK_SIZE = 900n;
const MAX_CHUNKS = 400; // ~360k blocks, well beyond this project's lifetime on Sepolia

/** Scan backward from the chain tip in chunks, stopping as soon as a chunk yields a match for `cycle`. */
async function findLogsForCycle(
  publicClient: ReturnType<typeof createPublicClient>,
  address: `0x${string}`,
  cycle: number,
  fromBlockOverride?: bigint,
): Promise<PaymentAttestedLog[]> {
  const latest = await publicClient.getBlockNumber();

  if (fromBlockOverride !== undefined) {
    return publicClient.getContractEvents({
      address,
      abi: NOMOS_PAYROLL_ABI,
      eventName: "PaymentAttested",
      args: { cycleCount: BigInt(cycle) },
      fromBlock: fromBlockOverride,
      toBlock: latest,
    });
  }

  let toBlock = latest;
  for (let chunk = 0; chunk < MAX_CHUNKS && toBlock > 0n; chunk++) {
    const fromBlock = toBlock > LOG_CHUNK_SIZE ? toBlock - LOG_CHUNK_SIZE : 0n;
    const logs = await publicClient.getContractEvents({
      address,
      abi: NOMOS_PAYROLL_ABI,
      eventName: "PaymentAttested",
      args: { cycleCount: BigInt(cycle) },
      fromBlock,
      toBlock,
    });
    if (logs.length > 0) return logs;
    if (fromBlock === 0n) break;
    toBlock = fromBlock - 1n;
  }
  return [];
}

/**
 * Scan backward collecting every PaymentAttested log regardless of cycle.
 * Cycles are sequential starting at 1, so scanning can stop early the moment
 * a cycle-1 log is seen — everything before that is guaranteed to be older
 * than the roster's first executed cycle.
 */
async function findAllLogs(
  publicClient: ReturnType<typeof createPublicClient>,
  address: `0x${string}`,
  fromBlockOverride?: bigint,
): Promise<PaymentAttestedLog[]> {
  const latest = await publicClient.getBlockNumber();

  if (fromBlockOverride !== undefined) {
    return publicClient.getContractEvents({
      address,
      abi: NOMOS_PAYROLL_ABI,
      eventName: "PaymentAttested",
      fromBlock: fromBlockOverride,
      toBlock: latest,
    });
  }

  const allLogs: PaymentAttestedLog[] = [];
  let toBlock = latest;
  for (let chunk = 0; chunk < MAX_CHUNKS && toBlock > 0n; chunk++) {
    const fromBlock = toBlock > LOG_CHUNK_SIZE ? toBlock - LOG_CHUNK_SIZE : 0n;
    const logs = await publicClient.getContractEvents({
      address,
      abi: NOMOS_PAYROLL_ABI,
      eventName: "PaymentAttested",
      fromBlock,
      toBlock,
    });
    allLogs.push(...logs);
    const sawCycleOne = logs.some((eventLog) => eventArgs<PaymentAttestedArgs>(eventLog).cycleCount === 1n);
    if (sawCycleOne || fromBlock === 0n) break;
    toBlock = fromBlock - 1n;
  }
  return allLogs;
}

/** publicDecrypt + independently re-verify every log's attestation on-chain. Returns rows in log order. */
async function verifyLogs(
  publicClient: ReturnType<typeof createPublicClient>,
  sepoliaRpcUrl: string,
  logs: PaymentAttestedLog[],
): Promise<AttestationRow[]> {
  const ephemeralWallet = createWalletClient({
    account: privateKeyToAccount(generatePrivateKey()),
    chain: sepolia,
    transport: http(sepoliaRpcUrl),
  });
  const handleClient = await createNoxHandleClient(ephemeralWallet);

  const rows: AttestationRow[] = [];
  for (const eventLog of logs) {
    const args = eventArgs<PaymentAttestedArgs>(eventLog);
    const { value, decryptionProof } = await handleClient.publicDecrypt<"bool">(args.matchesLedgerHandle);

    // Independent on-chain re-verification — see file header.
    await publicClient.readContract({
      address: NOX_COMPUTE_ADDRESS,
      abi: NOX_COMPUTE_ABI,
      functionName: "validateDecryptionProof",
      args: [args.matchesLedgerHandle, decryptionProof],
    });

    rows.push({ recipient: args.recipient, streamId: args.streamId, matches: value as boolean });
  }
  return rows;
}

function printTable(rows: AttestationRow[]): void {
  const col1 = "Recipient";
  const col2 = "Stream ID";
  const col3 = "Attestation";
  const w1 = Math.max(col1.length, ...rows.map((r) => r.recipient.length));
  const w2 = Math.max(col2.length, ...rows.map((r) => r.streamId.toString().length));

  console.log(`${col1.padEnd(w1)} | ${col2.padEnd(w2)} | ${col3}`);
  console.log(`${"-".repeat(w1)}-|-${"-".repeat(w2)}-|-${"-".repeat(col3.length)}`);
  for (const row of rows) {
    const mark = row.matches ? "✓ verified" : "✗ FAILED";
    console.log(`${row.recipient.padEnd(w1)} | ${row.streamId.toString().padEnd(w2)} | ${mark}`);
  }
}

export async function collectVerifyOne(cycle: number, fromBlock?: bigint): Promise<VerifyOneResult> {
  const env = loadCliEnv(process.env);
  const publicClient = createPublicClient({ chain: sepolia, transport: http(env.sepoliaRpcUrl) });

  const logs = await findLogsForCycle(publicClient, env.nomosPayrollAddress, cycle, fromBlock);
  if (logs.length === 0) return { found: false, cycle };

  const gatewayAddress = (await publicClient.readContract({
    address: NOX_COMPUTE_ADDRESS,
    abi: NOX_COMPUTE_ABI,
    functionName: "gateway",
  })) as string;

  const rows = await verifyLogs(publicClient, env.sepoliaRpcUrl, logs);
  return { found: true, gatewayAddress, cycle, rows, verified: rows.every((r) => r.matches) };
}

export async function collectVerifyAll(fromBlock?: bigint): Promise<VerifyAllResult> {
  const env = loadCliEnv(process.env);
  const publicClient = createPublicClient({ chain: sepolia, transport: http(env.sepoliaRpcUrl) });

  const logs = await findAllLogs(publicClient, env.nomosPayrollAddress, fromBlock);
  if (logs.length === 0) return { found: false };

  const gatewayAddress = (await publicClient.readContract({
    address: NOX_COMPUTE_ADDRESS,
    abi: NOX_COMPUTE_ABI,
    functionName: "gateway",
  })) as string;

  const byCycle = new Map<bigint, PaymentAttestedLog[]>();
  for (const eventLog of logs) {
    const cycleCount = eventArgs<PaymentAttestedArgs>(eventLog).cycleCount;
    const bucket = byCycle.get(cycleCount);
    if (bucket === undefined) byCycle.set(cycleCount, [eventLog]);
    else bucket.push(eventLog);
  }
  const cycleNumbers = [...byCycle.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const cycles: CycleVerification[] = [];
  for (const cycleCount of cycleNumbers) {
    const rows = await verifyLogs(publicClient, env.sepoliaRpcUrl, byCycle.get(cycleCount) as PaymentAttestedLog[]);
    cycles.push({ cycle: Number(cycleCount), rows, verified: rows.every((r) => r.matches) });
  }

  return { found: true, gatewayAddress, cycles, allVerified: cycles.every((c) => c.verified) };
}

function printVerifyOneText(r: VerifyOneResult): void {
  if (!r.found) {
    console.log(`No PaymentAttested events found for cycle ${r.cycle}.`);
    return;
  }
  console.log(`Cycle ${r.cycle} — attestations signed by Nox Gateway ${r.gatewayAddress}\n`);
  printTable(r.rows);
  console.log(r.verified ? "\nAll attestations verified true." : "\nAt least one attestation is FALSE — see above.");
}

function printVerifyAllText(r: VerifyAllResult): void {
  if (!r.found) {
    console.log("No PaymentAttested events found.");
    return;
  }
  console.log(`Found ${r.cycles.length} cycle(s) — attestations signed by Nox Gateway ${r.gatewayAddress}\n`);
  for (const c of r.cycles) {
    console.log(`Cycle ${c.cycle}`);
    printTable(c.rows);
    console.log(c.verified ? "✓ all verified true" : "✗ at least one attestation FALSE");
    console.log("");
  }
  console.log(
    r.allVerified
      ? `All ${r.cycles.length} cycle(s) fully verified.`
      : "At least one cycle had a failed attestation — see above.",
  );
}

export async function verifyCommand(cycle: number, fromBlock: bigint | undefined, json: boolean): Promise<number> {
  const result = await collectVerifyOne(cycle, fromBlock);
  if (json) printJson(result);
  else printVerifyOneText(result);
  return result.found && result.verified ? 0 : 1;
}

export async function verifyAllCommand(fromBlock: bigint | undefined, json: boolean): Promise<number> {
  const result = await collectVerifyAll(fromBlock);
  if (json) printJson(result);
  else printVerifyAllText(result);
  return result.found && result.allVerified ? 0 : 1;
}
