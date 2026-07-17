// The keeper loop. This is "the agent" in the CONTRACT_DESIGN.md sense
// only insofar as it holds the agent key and decides when to call
// `runCycle` — the actual policy enforcement (cooldown, spend cap,
// allowlist) lives on-chain in NomosPayroll itself. This process is
// deliberately dumb: it has no independent judgment about salaries or
// policy, it just watches on-chain state and, when conditions are met,
// decrypts what it's authorized to decrypt and submits a transaction.

import type { Address, Hex } from "viem";
import { createLogger } from "./log.js";
import { createNoxHandleClient } from "./nox.js";
import { createSepoliaClients, normalizePrivateKey, type SepoliaClients } from "./sepolia.js";
import { NOMOS_PAYROLL_ABI, ERC20_ABI } from "./contracts.js";

export interface KeeperConfig {
  nomosPayrollAddress: Address;
  nomosTokenAddress: Address;
  agentPrivateKey: Hex;
  sepoliaRpcUrl: string;
  checkIntervalSeconds: number;
  cooldownBufferSeconds: number;
}

export interface RunKeeperLoopOptions {
  signal?: AbortSignal;
}

const log = createLogger("keeper");

const EXPLORER = "https://sepolia.etherscan.io";
const MAX_BACKOFF_MS = 5 * 60 * 1000;

type TickOutcome = "ran" | "not-ready" | "simulation-reverted";

interface OnChainState {
  employees: Address[];
  lastRunTimestamp: bigint;
  cycleCount: bigint;
  cooldownSeconds: bigint;
  streamDuration: number;
  treasuryBalance: bigint;
}

async function readOnChainState(
  sepolia: SepoliaClients,
  config: KeeperConfig,
): Promise<OnChainState> {
  const payroll = { address: config.nomosPayrollAddress, abi: NOMOS_PAYROLL_ABI } as const;

  const [employees, lastRunTimestamp, cycleCount, policy, treasuryBalance] = await Promise.all([
    sepolia.publicClient.readContract({ ...payroll, functionName: "getEmployees" }) as Promise<Address[]>,
    sepolia.publicClient.readContract({ ...payroll, functionName: "lastRunTimestamp" }) as Promise<bigint>,
    sepolia.publicClient.readContract({ ...payroll, functionName: "cycleCount" }) as Promise<bigint>,
    sepolia.publicClient.readContract({ ...payroll, functionName: "policy" }) as Promise<
      [bigint, number, number, bigint]
    >,
    sepolia.publicClient.readContract({
      address: config.nomosTokenAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [config.nomosPayrollAddress],
    }) as Promise<bigint>,
  ]);

  const [cooldownSeconds, , streamDuration] = policy;

  return { employees, lastRunTimestamp, cycleCount, cooldownSeconds, streamDuration, treasuryBalance };
}

function isCooldownDue(state: OnChainState, cooldownBufferSeconds: number): boolean {
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const nextAllowed = state.lastRunTimestamp + state.cooldownSeconds + BigInt(cooldownBufferSeconds);
  return nowSeconds >= nextAllowed;
}

/** One tick: read state, decide readiness, and — if ready — run a cycle. */
async function tick(
  sepolia: SepoliaClients,
  handleClient: Awaited<ReturnType<typeof createNoxHandleClient>>,
  config: KeeperConfig,
): Promise<TickOutcome> {
  const state = await readOnChainState(sepolia, config);

  if (state.employees.length === 0) {
    log.info("not ready: no employees on the roster", { cycleCount: state.cycleCount });
    return "not-ready";
  }

  if (!isCooldownDue(state, config.cooldownBufferSeconds)) {
    const nextAllowed = state.lastRunTimestamp + state.cooldownSeconds + BigInt(config.cooldownBufferSeconds);
    const secondsRemaining = Number(nextAllowed) - Math.floor(Date.now() / 1000);
    log.info("not ready: cooldown has not elapsed", { secondsRemaining: Math.max(secondsRemaining, 0) });
    return "not-ready";
  }

  log.info("cooldown elapsed and roster non-empty — decrypting salaries", {
    employeeCount: state.employees.length,
  });

  // Decrypt each salary the agent is authorized to see (Nox.allow'd to the
  // agent by addEmployee), in the same order the contract will check
  // positionally in runCycle. Order matters: _employees uses swap-and-pop,
  // so this must be a fresh read each tick, never cached across ticks.
  const payroll = { address: config.nomosPayrollAddress, abi: NOMOS_PAYROLL_ABI } as const;
  const payments: Array<{ recipient: Address; amount: bigint }> = [];
  for (const recipient of state.employees) {
    const handle = (await sepolia.publicClient.readContract({
      ...payroll,
      functionName: "getEmployeeSalaryHandle",
      args: [recipient],
    })) as Hex;
    const { value: amount } = await handleClient.decrypt<"uint256">(handle);
    payments.push({ recipient, amount: amount as bigint });
  }

  const totalExpected = payments.reduce((sum, p) => sum + p.amount, 0n);
  if (state.treasuryBalance < totalExpected) {
    log.warn("not ready: treasury balance insufficient for this cycle's total payroll", {
      treasuryBalance: state.treasuryBalance,
      totalExpected,
    });
    return "not-ready";
  }

  const withinCapHandle = (await sepolia.publicClient.readContract({
    ...payroll,
    functionName: "getWithinCapHandle",
  })) as Hex;
  const { value: withinCap, decryptionProof } = await handleClient.publicDecrypt<"bool">(withinCapHandle);
  log.info("fetched within-cap proof", { withinCap });
  if (!withinCap) {
    log.warn("not ready: roster is currently over the spend cap (on-chain check will also reject this)");
    return "not-ready";
  }

  log.info("simulating runCycle before spending gas", { payments: payments.length });
  let simulation;
  try {
    simulation = await sepolia.publicClient.simulateContract({
      ...payroll,
      functionName: "runCycle",
      args: [decryptionProof, payments],
      account: sepolia.account,
    });
  } catch (error) {
    log.warn("runCycle simulation reverted — not submitting a transaction, will retry next tick", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "simulation-reverted";
  }

  log.info("simulation succeeded — submitting runCycle");
  const hash = await sepolia.walletClient.writeContract(simulation.request);
  log.info("runCycle submitted", { hash, explorerUrl: `${EXPLORER}/tx/${hash}` });

  const receipt = await sepolia.publicClient.waitForTransactionReceipt({ hash, timeout: 300_000 });
  if (receipt.status !== "success") {
    throw new Error(`runCycle transaction reverted on-chain: ${EXPLORER}/tx/${hash}`);
  }

  const newCycleCount = (await sepolia.publicClient.readContract({
    ...payroll,
    functionName: "cycleCount",
  })) as bigint;

  log.info("runCycle confirmed", {
    hash,
    explorerUrl: `${EXPLORER}/tx/${hash}`,
    blockNumber: receipt.blockNumber,
    cycleCount: newCycleCount,
    employeesPaid: payments.length,
  });

  return "ran";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Runs the keeper loop indefinitely until `options.signal` aborts. Every
 * tick is caught independently — an unexpected error never crashes the
 * loop, it just triggers exponential backoff (capped at 5 minutes) before
 * the next attempt. Only SIGTERM/SIGINT (wired in index.ts via the signal
 * passed here) stop the loop.
 */
export async function runKeeperLoop(config: KeeperConfig, options: RunKeeperLoopOptions = {}): Promise<void> {
  const sepolia = createSepoliaClients(config.sepoliaRpcUrl, config.agentPrivateKey);
  const handleClient = await createNoxHandleClient(sepolia.walletClient);

  log.info("keeper started", {
    agent: sepolia.account.address,
    nomosPayroll: config.nomosPayrollAddress,
    nomosToken: config.nomosTokenAddress,
    checkIntervalSeconds: config.checkIntervalSeconds,
    cooldownBufferSeconds: config.cooldownBufferSeconds,
  });

  const baseIntervalMs = config.checkIntervalSeconds * 1000;
  let backoffMs = baseIntervalMs;

  while (!options.signal?.aborted) {
    let sleepMs = baseIntervalMs;
    try {
      await tick(sepolia, handleClient, config);
      backoffMs = baseIntervalMs; // any tick that completes without throwing resets backoff
    } catch (error) {
      log.error("tick failed unexpectedly — backing off", {
        error: error instanceof Error ? error.message : String(error),
        nextRetryMs: backoffMs,
      });
      sleepMs = backoffMs;
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }

    if (options.signal?.aborted) break;
    await sleep(sleepMs, options.signal);
  }

  log.info("keeper stopped");
}

export function loadKeeperConfigFromEnv(env: NodeJS.ProcessEnv): KeeperConfig {
  return {
    nomosPayrollAddress: requireEnv(env, "NOMOS_PAYROLL_ADDRESS") as Address,
    nomosTokenAddress: requireEnv(env, "NOMOS_TOKEN_ADDRESS") as Address,
    agentPrivateKey: normalizePrivateKey(requireEnv(env, "AGENT_PRIVATE_KEY")),
    sepoliaRpcUrl: requireEnv(env, "SEPOLIA_RPC_URL"),
    checkIntervalSeconds: parsePositiveInt(env.CHECK_INTERVAL_SECONDS, 15),
    cooldownBufferSeconds: parsePositiveInt(env.COOLDOWN_BUFFER_SECONDS, 5),
  };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `Missing required environment variable ${name}. Set it before running the keeper (see agent/README.md).`,
    );
  }
  return value.trim();
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got "${raw}"`);
  }
  return parsed;
}
