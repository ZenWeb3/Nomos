// `nomos verify --cycle N` — independent verification, not a keeper-trust
// exercise. For every PaymentAttested handle emitted in the given cycle:
//   1. publicDecrypt it via the Handle Gateway (anyone can do this — the
//      handle was marked publicly decryptable by NomosPayroll itself).
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
import { loadCliEnv } from "./env.js";

interface AttestationRow {
  recipient: string;
  streamId: bigint;
  matches: boolean;
}

// Public RPC providers (thirdweb included) cap eth_getLogs to a fixed block
// range per call, so an unbounded fromBlock:"earliest" query fails
// outright. The provider's error messages disagreed with themselves about
// the exact cap (10,000 in one message, 1,000 enforced in practice) — 900
// stays safely under either. Scan backward from the chain tip in chunks,
// stopping as soon as a chunk yields a match. MAX_CHUNKS bounds the worst
// case (no match anywhere) rather than scanning forever.
const LOG_CHUNK_SIZE = 900n;
const MAX_CHUNKS = 400; // ~360k blocks, well beyond this project's lifetime on Sepolia

async function findPaymentAttestedLogs(
  publicClient: ReturnType<typeof createPublicClient>,
  address: `0x${string}`,
  cycle: number,
  fromBlockOverride?: bigint,
) {
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

export async function verifyCommand(cycle: number, fromBlock?: bigint): Promise<number> {
  const env = loadCliEnv(process.env);
  const publicClient = createPublicClient({ chain: sepolia, transport: http(env.sepoliaRpcUrl) });

  // publicDecrypt doesn't check *who* is asking — that's the whole point —
  // but @iexec-nox/handle's client still needs a wallet-shaped object to
  // construct. An ephemeral, disposable key is the honest way to express
  // "this identity doesn't matter."
  const ephemeralWallet = createWalletClient({
    account: privateKeyToAccount(generatePrivateKey()),
    chain: sepolia,
    transport: http(env.sepoliaRpcUrl),
  });
  const handleClient = await createNoxHandleClient(ephemeralWallet);

  const logs = await findPaymentAttestedLogs(publicClient, env.nomosPayrollAddress, cycle, fromBlock);

  if (logs.length === 0) {
    console.log(`No PaymentAttested events found for cycle ${cycle}.`);
    return 1;
  }

  const gatewayAddress = (await publicClient.readContract({
    address: NOX_COMPUTE_ADDRESS,
    abi: NOX_COMPUTE_ABI,
    functionName: "gateway",
  })) as string;

  const rows: AttestationRow[] = [];
  for (const eventLog of logs) {
    const args = eventLog.args as {
      recipient: string;
      streamId: bigint;
      cycleCount: bigint;
      matchesLedgerHandle: Hex;
    };

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

  console.log(`Cycle ${cycle} — attestations signed by Nox Gateway ${gatewayAddress}\n`);
  printTable(rows);

  const allVerified = rows.every((r) => r.matches);
  console.log(allVerified ? "\nAll attestations verified true." : "\nAt least one attestation is FALSE — see above.");
  return allVerified ? 0 : 1;
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
