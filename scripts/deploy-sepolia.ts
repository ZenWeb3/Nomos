import "dotenv/config";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Address, Hex } from "viem";
import { createWalletClient, formatEther, http, parseEventLogs } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createViemHandleClient, NotYetComputedHandleError } from "@iexec-nox/handle";

// =============================================================================
// Nomos — Sepolia deployment + one full end-to-end payroll cycle.
//
// Run: pnpm hardhat run scripts/deploy-sepolia.ts --network sepolia
//
// Uses Hardhat's network connection only for contract-artifact-aware
// deployment convenience (`viem.sendDeploymentTransaction`/`getContractAt`).
// All actual signing goes through a wallet client this script constructs
// itself from DEPLOYER_PRIVATE_KEY, read directly from .env — this sidesteps
// any ambiguity in how hardhat.config.ts's `accounts` array happens to
// format that key, and satisfies "read from .env" literally rather than
// indirectly through Hardhat's config layer.
// =============================================================================

const EXPLORER = "https://sepolia.etherscan.io";
const CHAIN_ID = 11_155_111;
const TOKEN = 10n ** 18n;

const MINT_AMOUNT = 1_000_000n * TOKEN;
const DEPOSIT_AMOUNT = 1_000_000n * TOKEN;

const POLICY = {
  cooldownSeconds: 60,
  cliffDuration: 0,
  streamDuration: 3600, // 1 hour — completes visibly during a demo
  spendCap: 100_000n * TOKEN,
};

const EMPLOYEE_SPECS = [
  { name: "alice", salary: 10_000n * TOKEN },
  { name: "bob", salary: 15_000n * TOKEN },
  { name: "carol", salary: 20_000n * TOKEN },
] as const;

const COOLDOWN_WAIT_MS = 65_000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `[deploy-sepolia] Missing required environment variable ${name}. ` +
        `Set it in .env before running this script (see .env.example) — ` +
        `refusing to guess or fall back silently.`,
    );
  }
  return value.trim();
}

function normalizePrivateKey(raw: string): Hex {
  const trimmed = raw.trim();
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as Hex;
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Nox's off-chain pipeline (Ingestor -> Runner -> Handle Gateway) resolves a
 * handle asynchronously after the triggering transaction lands. The SDK's
 * own decrypt/publicDecrypt calls already retry a handful of times
 * internally (~7s total — see NotYetComputedHandleError in decrypt.js /
 * publicDecrypt.js), but that budget was tuned against the plugin's local
 * Docker stack, which resolves near-instantly. The real Sepolia-testnet
 * infrastructure this script talks to is not guaranteed to be that fast, so
 * we wrap every decrypt/publicDecrypt call with a much more patient outer
 * retry, logging progress so a long wait doesn't look like a hang.
 */
async function withPatience<T>(
  label: string,
  fn: () => Promise<T>,
  { retries = 40, delayMs = 15_000 }: { retries?: number; delayMs?: number } = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const reason =
        error instanceof NotYetComputedHandleError ? "not yet computed" : (error as Error).message;
      console.log(`  [${label}] attempt ${attempt}/${retries} not ready yet (${reason}) — waiting ${delayMs / 1000}s...`);
      await sleep(delayMs);
    }
  }
  throw new Error(`[deploy-sepolia] ${label} did not resolve after ${retries} attempts`, {
    cause: lastError,
  });
}

async function sendAndWait(publicClient: any, hash: Hex, label: string) {
  console.log(`  ${label}: ${EXPLORER}/tx/${hash} (waiting for confirmation...)`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 300_000 });
  if (receipt.status !== "success") {
    throw new Error(`[deploy-sepolia] Transaction reverted (${label}): ${EXPLORER}/tx/${hash}`);
  }
  console.log(`  ${label}: confirmed in block ${receipt.blockNumber}`);
  return receipt;
}

interface FreshActor {
  name: string;
  address: Address;
  privateKey: Hex;
}

async function main() {
  // ---------------------------------------------------------------------
  // 1. Env validation — fail fast, helpfully, before touching the network.
  // ---------------------------------------------------------------------
  // DAI_SEPOLIA is deliberately not read: its mint() is onlyOwner-gated by
  // the actual token owner (not our deployer) — confirmed both by a real
  // reverted transaction and a free eth_call simulation. Pivoted to
  // deploying our own unrestricted-mint NomosToken instead (step 1 below).
  // See SPRINT.md's Sprint 2 log for the full blocker writeup.
  const sepoliaRpcUrl = requireEnv("SEPOLIA_RPC_URL");
  const rawDeployerKey = requireEnv("DEPLOYER_PRIVATE_KEY");
  const sablierAddress = requireEnv("SABLIER_LOCKUP_SEPOLIA") as Address;
  const deployerPrivateKey = normalizePrivateKey(rawDeployerKey);
  const deployerAccount = privateKeyToAccount(deployerPrivateKey);

  console.log(`[deploy-sepolia] Deployer address: ${deployerAccount.address}`);
  console.log(`[deploy-sepolia] Sablier Lockup: ${sablierAddress}`);

  const { network } = await import("hardhat");
  const connection = await network.create("sepolia");
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();

  const chainId = await publicClient.getChainId();
  if (chainId !== CHAIN_ID) {
    throw new Error(
      `[deploy-sepolia] Expected chain id ${CHAIN_ID} (Ethereum Sepolia), got ${chainId}. Check hardhat.config.ts / SEPOLIA_RPC_URL.`,
    );
  }

  const ethBalance = await publicClient.getBalance({ address: deployerAccount.address });
  console.log(`[deploy-sepolia] Deployer ETH balance: ${formatEther(ethBalance)} ETH`);
  if (ethBalance === 0n) {
    throw new Error(
      `[deploy-sepolia] Deployer address ${deployerAccount.address} has zero Sepolia ETH — fund it from a faucet before running this script.`,
    );
  }

  const deployerWalletClient = createWalletClient({
    account: deployerAccount,
    chain: sepolia,
    transport: http(sepoliaRpcUrl),
  });

  // Auto-resolves gatewayUrl/smartContractAddress/subgraphUrl for chain
  // 11155111 from @iexec-nox/handle's own NETWORK_CONFIGS table — no local
  // overrides needed, unlike the local-stack test setup.
  const handleClient = await createViemHandleClient(deployerWalletClient);

  // ---------------------------------------------------------------------
  // 1. Deploy NomosToken — our own unrestricted-mint demo payroll token,
  //    replacing the DAI_SEPOLIA faucet that turned out to be onlyOwner-gated.
  // ---------------------------------------------------------------------
  console.log("\n=== [1/9] Deploying NomosToken ===");
  const { contract: nomosToken, deploymentTransaction: tokenDeployTx } =
    await viem.sendDeploymentTransaction("NomosToken", [], {
      client: { wallet: deployerWalletClient, public: publicClient },
    });
  await sendAndWait(publicClient, tokenDeployTx.hash, "deploy NomosToken");
  console.log(`  NomosToken: ${nomosToken.address}`);
  console.log(`  ${EXPLORER}/address/${nomosToken.address}`);

  // ---------------------------------------------------------------------
  // 2. Deploy NomosPayroll.
  // ---------------------------------------------------------------------
  console.log("\n=== [2/9] Deploying NomosPayroll ===");
  // Policy is passed to the constructor AND set again explicitly in step 5
  // below (same values) — the explicit setPolicy call is what the sprint
  // asked to exercise as its own visible on-chain step; passing zeros here
  // instead would leave a fragile intermediate state (a zero stream
  // duration) between deploy and that call for no benefit.
  const { contract: nomosPayroll, deploymentTransaction } = await viem.sendDeploymentTransaction(
    "NomosPayroll",
    [
      deployerAccount.address, // agent = deployer, noted as future work in README
      nomosToken.address,
      sablierAddress,
      POLICY.cooldownSeconds,
      POLICY.cliffDuration,
      POLICY.streamDuration,
      POLICY.spendCap,
    ],
    { client: { wallet: deployerWalletClient, public: publicClient } },
  );
  await sendAndWait(publicClient, deploymentTransaction.hash, "deploy NomosPayroll");
  console.log(`  NomosPayroll: ${nomosPayroll.address}`);
  console.log(`  ${EXPLORER}/address/${nomosPayroll.address}`);

  // ---------------------------------------------------------------------
  // 3. Mint NomosToken.
  // ---------------------------------------------------------------------
  console.log("\n=== [3/9] Minting NomosToken ===");
  const mintHash = await nomosToken.write.mint([deployerAccount.address, MINT_AMOUNT]);
  await sendAndWait(publicClient, mintHash, "mint");
  const tokenBalance = (await nomosToken.read.balanceOf([deployerAccount.address])) as bigint;
  console.log(`  Deployer NMS balance: ${tokenBalance / TOKEN} NMS`);

  // ---------------------------------------------------------------------
  // 4. Approve + deposit into the payroll treasury.
  // ---------------------------------------------------------------------
  console.log("\n=== [4/9] Approving + depositing into NomosPayroll ===");
  const approveHash = await nomosToken.write.approve([nomosPayroll.address, DEPOSIT_AMOUNT]);
  await sendAndWait(publicClient, approveHash, "approve");
  const depositHash = await nomosPayroll.write.deposit([DEPOSIT_AMOUNT]);
  await sendAndWait(publicClient, depositHash, "deposit");

  // ---------------------------------------------------------------------
  // 5. setPolicy.
  // ---------------------------------------------------------------------
  console.log("\n=== [5/9] Setting policy ===");
  const setPolicyHash = await nomosPayroll.write.setPolicy([
    POLICY.cooldownSeconds,
    POLICY.cliffDuration,
    POLICY.streamDuration,
    POLICY.spendCap,
  ]);
  await sendAndWait(publicClient, setPolicyHash, "setPolicy");

  // ---------------------------------------------------------------------
  // 6. Add 3 employees with encrypted salaries.
  // ---------------------------------------------------------------------
  console.log("\n=== [6/9] Adding employees with encrypted salaries ===");
  const employees: Array<FreshActor & { salary: bigint }> = [];
  for (const spec of EMPLOYEE_SPECS) {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    console.log(`  ${spec.name}: generated address ${account.address}, salary ${spec.salary / TOKEN} NMS`);

    const { handle, handleProof } = await handleClient.encryptInput(
      spec.salary,
      "uint256",
      nomosPayroll.address,
    );
    const addHash = await nomosPayroll.write.addEmployee([handle, handleProof, account.address]);
    await sendAndWait(publicClient, addHash, `addEmployee(${spec.name})`);

    employees.push({ name: spec.name, address: account.address, privateKey, salary: spec.salary });
  }

  // ---------------------------------------------------------------------
  // 7. Grant an auditor.
  // ---------------------------------------------------------------------
  console.log("\n=== [7/9] Granting auditor access ===");
  const auditorPrivateKey = generatePrivateKey();
  const auditorAccount = privateKeyToAccount(auditorPrivateKey);
  console.log(`  auditor: generated address ${auditorAccount.address}`);
  const grantAuditorHash = await nomosPayroll.write.grantAuditor([auditorAccount.address]);
  await sendAndWait(publicClient, grantAuditorHash, "grantAuditor");
  const auditor: FreshActor = { name: "auditor", address: auditorAccount.address, privateKey: auditorPrivateKey };

  // ---------------------------------------------------------------------
  // 8. Wait for cooldown, then runCycle.
  // ---------------------------------------------------------------------
  console.log(`\n=== [8/9] Waiting ${COOLDOWN_WAIT_MS / 1000}s to satisfy the cooldown ===`);
  await sleep(COOLDOWN_WAIT_MS);

  console.log("\n=== [9/9] Running the payroll cycle ===");
  const withinCapHandle = (await nomosPayroll.read.getWithinCapHandle()) as Hex;
  const { value: withinCapBeforeRun, decryptionProof: withinCapProof } = await withPatience(
    "publicDecrypt(_withinCapHandle)",
    () => handleClient.publicDecrypt(withinCapHandle),
  );
  console.log(`  within spend cap: ${withinCapBeforeRun}`);
  if (!withinCapBeforeRun) {
    throw new Error("[deploy-sepolia] Roster is over the spend cap — aborting before runCycle.");
  }

  const rosterAddresses = (await nomosPayroll.read.getEmployees()) as Address[];
  const payments = rosterAddresses.map((addr) => {
    const employee = employees.find((e) => sameAddress(e.address, addr));
    if (!employee) {
      throw new Error(`[deploy-sepolia] No local salary record for on-chain employee ${addr}`);
    }
    return { recipient: addr, amount: employee.salary };
  });

  const runCycleHash = await nomosPayroll.write.runCycle([withinCapProof, payments]);
  const runCycleReceipt = await sendAndWait(publicClient, runCycleHash, "runCycle");

  const cycleCount = (await nomosPayroll.read.cycleCount()) as bigint;

  const attestedLogs = parseEventLogs({
    abi: nomosPayroll.abi,
    logs: runCycleReceipt.logs,
    eventName: "PaymentAttested",
  });

  console.log("\n--- Streams created ---");
  const streams: Array<{
    recipient: string;
    name: string;
    streamId: string;
    explorerUrl: string;
    attested: boolean;
  }> = [];
  for (const log of attestedLogs) {
    const recipient = log.args.recipient as string;
    const streamId = (log.args.streamId as bigint).toString();
    const employee = employees.find((e) => sameAddress(e.address, recipient));
    const explorerUrl = `${EXPLORER}/nft/${sablierAddress}/${streamId}`;

    const { value: matches } = await withPatience(
      `publicDecrypt(attestation for ${employee?.name ?? recipient})`,
      () => handleClient.publicDecrypt(log.args.matchesLedgerHandle as Hex),
    );

    console.log(`  ${employee?.name ?? recipient} (${recipient})`);
    console.log(`    streamId: ${streamId}`);
    console.log(`    stream NFT: ${explorerUrl}`);
    console.log(`    attestation (paid amount matches confidential ledger): ${matches}`);

    streams.push({
      recipient,
      name: employee?.name ?? "unknown",
      streamId,
      explorerUrl,
      attested: matches as boolean,
    });
  }

  // ---------------------------------------------------------------------
  // Write deployments/sepolia.json + deployments/README.md
  // ---------------------------------------------------------------------
  const deploymentsDir = path.resolve(import.meta.dirname, "..", "deployments");
  await mkdir(deploymentsDir, { recursive: true });

  const output = {
    network: "sepolia",
    chainId: CHAIN_ID,
    deployedAt: new Date().toISOString(),
    nomosPayrollAddress: nomosPayroll.address,
    deployTxHash: deploymentTransaction.hash,
    deployerAddress: deployerAccount.address,
    payrollTokenAddress: nomosToken.address,
    payrollTokenDeployTxHash: tokenDeployTx.hash,
    sablierAddress,
    policy: {
      cooldownSeconds: POLICY.cooldownSeconds,
      cliffDuration: POLICY.cliffDuration,
      streamDuration: POLICY.streamDuration,
      spendCap: POLICY.spendCap.toString(),
    },
    setPolicyTxHash: setPolicyHash,
    depositTxHash: depositHash,
    depositAmount: DEPOSIT_AMOUNT.toString(),
    employees: employees.map((e) => ({
      name: e.name,
      address: e.address,
      privateKey: e.privateKey,
      salary: e.salary.toString(),
    })),
    auditor,
    grantAuditorTxHash: grantAuditorHash,
    runCycleTxHash: runCycleHash,
    cycleCount: cycleCount.toString(),
    withinCap: withinCapBeforeRun,
    streams,
    explorer: {
      contract: `${EXPLORER}/address/${nomosPayroll.address}`,
      deployTx: `${EXPLORER}/tx/${deploymentTransaction.hash}`,
      runCycleTx: `${EXPLORER}/tx/${runCycleHash}`,
    },
  };

  const jsonPath = path.join(deploymentsDir, "sepolia.json");
  await writeFile(jsonPath, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`\n[deploy-sepolia] Wrote ${jsonPath}`);

  const readmePath = path.join(deploymentsDir, "README.md");
  const readme = `# Sepolia Deployment

Last deployed: ${output.deployedAt}

**Keys in \`sepolia.json\` are testnet-only and gitignored (\`/deployments\` in
.gitignore) — never reuse them anywhere real.**

## Addresses

- NomosPayroll: [\`${nomosPayroll.address}\`](${output.explorer.contract})
- Payroll token (NomosToken, NMS — self-deployed demo token, unrestricted
  mint; DAI_SEPOLIA's faucet turned out to be onlyOwner-gated): \`${nomosToken.address}\`
- Sablier Lockup: \`${sablierAddress}\`
- Deployer / owner / agent: \`${deployerAccount.address}\` (same key for
  hackathon simplicity — separating owner and agent keys is future work)

## This run

- Deploy tx: [${deploymentTransaction.hash}](${output.explorer.deployTx})
- runCycle tx: [${runCycleHash}](${output.explorer.runCycleTx})
- Cycle: #${cycleCount}
- Within spend cap: ${withinCapBeforeRun}

## Employees

${employees
  .map(
    (e) =>
      `- **${e.name}** — \`${e.address}\` — salary ${e.salary / TOKEN} NMS (confidential on-chain, plaintext here only because this is a testnet demo key)`,
  )
  .join("\n")}

## Streams

${streams
  .map(
    (s) =>
      `- **${s.name}** — stream #${s.streamId} — [view NFT](${s.explorerUrl}) — attestation (paid amount matches confidential ledger): **${s.attested}**`,
  )
  .join("\n")}

## Auditor

- \`${auditor.address}\` — granted via \`grantAuditor\`, can decrypt the
  confidential aggregate outflow handle off-chain.

## Re-running

\`\`\`sh
pnpm hardhat run scripts/deploy-sepolia.ts --network sepolia
\`\`\`

Deploys a **new** NomosPayroll instance and overwrites this file — it does
not reuse the contract above.
`;
  await writeFile(readmePath, readme, "utf8");
  console.log(`[deploy-sepolia] Wrote ${readmePath}`);

  console.log("\n[deploy-sepolia] Done.");
}

main().catch((error) => {
  console.error("\n[deploy-sepolia] FAILED:", error);
  process.exitCode = 1;
});
