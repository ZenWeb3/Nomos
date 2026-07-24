import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import type { Abi, Address, Hex } from "viem";
import { parseEventLogs } from "viem";
import { nox } from "@iexec-nox/nox-hardhat-plugin";
import { createViemHandleClient } from "@iexec-nox/handle";
import NoxComputeArtifact from "@iexec-nox/nox-protocol-contracts/artifacts/contracts/NoxCompute.sol/NoxCompute.json" with { type: "json" };
import { eventArgs } from "../agent/src/events.js";

const NOX_COMPUTE_ABI = NoxComputeArtifact.abi as Abi;

// ctx.nomosPayroll is deliberately `any` (see the Deployment interface below),
// so parseEventLogs can't discriminate its return type by eventName — every
// `.args` access goes through eventArgs<T>() instead. See agent/src/events.ts.
interface PaymentAttestedArgs {
  recipient: string;
  streamId: bigint;
  cycleCount: bigint;
  matchesLedgerHandle: Hex;
}

interface CycleExecutedArgs {
  cycleCount: bigint;
  timestamp: bigint;
  employeeCount: bigint;
}

// ---------------------------------------------------------------------------
// Why this file does NOT use hardhat-network-helpers' `loadFixture`:
//
// `loadFixture` restores chain state via `evm_snapshot`/`evm_revert`. Nox
// handles are deterministic (derived from operands + an on-chain nonce/seed
// — see `_generateHandleUniqueSeed` in Compute.sol), and the actual
// ciphertext for a handle lives off-chain in the Handle Gateway, which is
// NOT chain-snapshot-aware. Reverting the EVM state after a test could let a
// later test's freshly-computed handle collide with a stale, already-
// resolved entry from a rolled-back run in the Gateway's own store, silently
// serving wrong ciphertext instead of failing loudly. Every describe block
// below deploys fresh contracts instead (forward-only, no reverts), which
// sidesteps the question entirely regardless of whether that risk is real.
// ---------------------------------------------------------------------------

// The installed @iexec-nox/nox-hardhat-plugin@0.1.0's public `nox` object is
// narrower than the plugin's own upstream source (references/nox-hardhat-plugin)
// suggests — it exposes only {connect, encryptInput, decrypt, publicDecrypt},
// no `noxComputeAddress`/`handleGatewayUrl` getters (confirmed by reading the
// actually-installed dist/src/nox.js, not the reference clone — the two are
// different versions). Even test/integration/stack.test.ts, which predates
// this file, calls those nonexistent getters — a latent bug there too, out
// of scope to fix here. We reconstruct both values the same way the plugin's
// own internals do (dist/src/nox-config.js): a fixed address for chain 31337
// and an env var the stack-startup step populates.
const NOX_COMPUTE_ADDRESS: Address = "0x75C6AF4430cc474b1bb9b8540b7E46D6f8e1C685";
const HANDLE_GATEWAY_HOST_PORT_ENV = "NOX_HANDLE_GATEWAY_HOST_PORT";

function handleGatewayUrl(): `http://${string}` {
  const raw = process.env[HANDLE_GATEWAY_HOST_PORT_ENV];
  const port = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(
      `[test] Handle gateway host port is not set (${HANDLE_GATEWAY_HOST_PORT_ENV}). Is the Nox stack started?`,
    );
  }
  return `http://127.0.0.1:${port}`;
}

const DECIMALS = 18;
const TOKEN = 10n ** BigInt(DECIMALS);
const SALARY_ALICE = 1_000n * TOKEN;
const SALARY_BOB = 1_500n * TOKEN;
const SALARY_CAROL = 2_000n * TOKEN;
const DEFAULT_SPEND_CAP = 10_000n * TOKEN; // comfortably above alice+bob+carol (4_500)
const LOW_SPEND_CAP = 100n * TOKEN; // below a single salary — forces an over-cap revert
const COOLDOWN_SECONDS = 3600;
const CLIFF_DURATION = 0;
const STREAM_DURATION = 30 * 24 * 3600; // 30 days
const FUND_AMOUNT = 1_000_000n * TOKEN;
const SUBGRAPH_URL_PLACEHOLDER = "https://example.com/subgraphs/id/none";

// Mirrors nox.ts's own internal poll — needed here because per-actor decrypt
// checks (§ Confidentiality) bypass the plugin's `nox` singleton (which is
// hard-bound to account[0] — see `createHandleClient` in the plugin source)
// and go through hand-built HandleClients instead, which don't get the
// plugin's automatic wait-for-resolution wrapper.
const RESOLVE_MAX_RETRIES = 60;
const RESOLVE_DELAY_MS = 100;

async function waitForHandlesResolved(handles: Hex[]): Promise<void> {
  const url = `${handleGatewayUrl()}/v0/public/handles/status`;
  for (let attempt = 0; attempt < RESOLVE_MAX_RETRIES; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handles }),
    });
    if (response.ok) {
      const data = (await response.json()) as {
        payload: { statuses: Array<{ handle: string; resolved: boolean }> };
      };
      const resolvedByHandle = new Map(
        data.payload.statuses.map((s) => [s.handle.toLowerCase(), s.resolved]),
      );
      if (handles.every((h) => resolvedByHandle.get(h.toLowerCase()) === true)) {
        return;
      }
    }
    await new Promise((r) => setTimeout(r, RESOLVE_DELAY_MS));
  }
  throw new Error(
    `Handles not resolved after ${(RESOLVE_MAX_RETRIES * RESOLVE_DELAY_MS) / 1000}s: ${handles.join(", ")}`,
  );
}

// @iexec-nox/handle's ViemBlockchainService derives "the user" from
// `walletClient.getAddresses()[0]` (see WalletClientAdapter.getAddress in
// the installed package), NOT from `walletClient.account`. On a local
// Hardhat node every wallet client returned by `getWalletClients()` shares
// the same underlying JSON-RPC provider, so `getAddresses()` always answers
// with the node's full account list regardless of which client you call it
// on — every actor's handle client would silently resolve to account[0].
// This proxy overrides just `getAddresses()` to report the one address we
// actually mean, while leaving `.account`/`.signTypedData`/`.extend`/etc.
// untouched so signing still goes through the real bound account.
function scopedForAddress(walletClient: any, address: Address) {
  return new Proxy(walletClient, {
    get(target, prop, receiver) {
      if (prop === "getAddresses") {
        return async () => [address];
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

async function handleClientFor(walletClient: any) {
  const scoped = scopedForAddress(walletClient, walletClient.account.address);
  return createViemHandleClient(scoped, {
    smartContractAddress: NOX_COMPUTE_ADDRESS,
    gatewayUrl: handleGatewayUrl(),
    subgraphUrl: SUBGRAPH_URL_PLACEHOLDER,
  });
}

// viem decodes addresses read back from contract storage/logs in checksummed
// (mixed-case) form, while `getWalletClients()`'s `.account.address` comes
// back lowercase — same 20 bytes, different string casing. Compare loosely.
function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

async function isAllowedOnChain(publicClient: any, handle: Hex, account: Address): Promise<boolean> {
  return publicClient.readContract({
    address: NOX_COMPUTE_ADDRESS,
    abi: NOX_COMPUTE_ABI,
    functionName: "isAllowed",
    args: [handle, account],
  });
}

interface Deployment {
  viem: any;
  networkHelpers: any;
  publicClient: any;
  owner: any;
  agent: any;
  alice: any;
  bob: any;
  carol: any;
  auditor: any;
  random: any;
  mockToken: any;
  mockSablier: any;
  nomosPayroll: any;
}

async function deploy(
  opts: { spendCap?: bigint; cooldownSeconds?: number } = {},
): Promise<Deployment> {
  const { viem, networkHelpers } = await nox.connect();
  const publicClient = await viem.getPublicClient();
  const [owner, agent, alice, bob, carol, auditor, random] = await viem.getWalletClients();

  const mockToken = await viem.deployContract("MockERC20", ["Mock DAI", "mDAI", DECIMALS], {
    client: { wallet: owner },
  });
  const mockSablier = await viem.deployContract("MockSablierLockupLinear", [], {
    client: { wallet: owner },
  });
  const nomosPayroll = await viem.deployContract(
    "NomosPayroll",
    [
      agent.account.address,
      mockToken.address,
      mockSablier.address,
      BigInt(opts.cooldownSeconds ?? COOLDOWN_SECONDS),
      CLIFF_DURATION,
      STREAM_DURATION,
      opts.spendCap ?? DEFAULT_SPEND_CAP,
    ],
    { client: { wallet: owner } },
  );

  return {
    viem,
    networkHelpers,
    publicClient,
    owner,
    agent,
    alice,
    bob,
    carol,
    auditor,
    random,
    mockToken,
    mockSablier,
    nomosPayroll,
  };
}

async function addEmployee(ctx: Deployment, employeeClient: any, amount: bigint) {
  const { handle, handleProof } = await nox.encryptInput(amount, "uint256", ctx.nomosPayroll.address);
  const txHash = await ctx.nomosPayroll.write.addEmployee(
    [handle, handleProof, employeeClient.account.address],
    { account: ctx.owner.account.address },
  );
  await ctx.publicClient.waitForTransactionReceipt({ hash: txHash });

  const salaryHandle = (await ctx.nomosPayroll.read.getEmployeeSalaryHandle([
    employeeClient.account.address,
  ])) as Hex;
  const aggregateHandle = (await ctx.nomosPayroll.read.getAggregateOutflowHandle()) as Hex;
  const withinCapHandle = (await ctx.nomosPayroll.read.getWithinCapHandle()) as Hex;
  await waitForHandlesResolved([salaryHandle, aggregateHandle, withinCapHandle]);

  return { txHash, salaryHandle, aggregateHandle, withinCapHandle };
}

async function fundTreasury(ctx: Deployment, fromClient: any, amount: bigint) {
  let txHash = await ctx.mockToken.write.mint([fromClient.account.address, amount], {
    account: ctx.owner.account.address,
  });
  await ctx.publicClient.waitForTransactionReceipt({ hash: txHash });

  txHash = await ctx.mockToken.write.approve([ctx.nomosPayroll.address, amount], {
    account: fromClient.account.address,
  });
  await ctx.publicClient.waitForTransactionReceipt({ hash: txHash });

  txHash = await ctx.nomosPayroll.write.deposit([amount], { account: fromClient.account.address });
  return ctx.publicClient.waitForTransactionReceipt({ hash: txHash });
}

async function runCycle(
  ctx: Deployment,
  payments: Array<{ recipient: Address; amount: bigint }>,
) {
  const withinCapHandle = (await ctx.nomosPayroll.read.getWithinCapHandle()) as Hex;
  await waitForHandlesResolved([withinCapHandle]);
  const { decryptionProof } = await nox.publicDecrypt(withinCapHandle);

  const txHash = await ctx.nomosPayroll.write.runCycle([decryptionProof, payments], {
    account: ctx.agent.account.address,
  });
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: txHash });
  return { txHash, receipt };
}

// =============================================================================

describe("NomosPayroll — Access Control", () => {
  let ctx: Deployment;

  before(async () => {
    ctx = await deploy();
  });

  it("non-agent cannot call runCycle", { timeout: 60_000 }, async () => {
    await ctx.viem.assertions.revertWithCustomError(
      ctx.nomosPayroll.write.runCycle(["0x", []], { account: ctx.random.account.address }),
      ctx.nomosPayroll,
      "NotAgent",
    );
  });

  it("non-owner cannot addEmployee", { timeout: 60_000 }, async () => {
    const { handle, handleProof } = await nox.encryptInput(1n, "uint256", ctx.nomosPayroll.address);
    await ctx.viem.assertions.revertWithCustomError(
      ctx.nomosPayroll.write.addEmployee([handle, handleProof, ctx.alice.account.address], {
        account: ctx.random.account.address,
      }),
      ctx.nomosPayroll,
      "NotOwner",
    );
  });

  it("non-owner cannot removeEmployee", { timeout: 60_000 }, async () => {
    await ctx.viem.assertions.revertWithCustomError(
      ctx.nomosPayroll.write.removeEmployee([ctx.alice.account.address], {
        account: ctx.random.account.address,
      }),
      ctx.nomosPayroll,
      "NotOwner",
    );
  });

  it("non-owner cannot setPolicy", { timeout: 60_000 }, async () => {
    await ctx.viem.assertions.revertWithCustomError(
      ctx.nomosPayroll.write.setPolicy(
        [COOLDOWN_SECONDS, CLIFF_DURATION, STREAM_DURATION, DEFAULT_SPEND_CAP],
        { account: ctx.random.account.address },
      ),
      ctx.nomosPayroll,
      "NotOwner",
    );
  });

  it("non-owner cannot setAgent", { timeout: 60_000 }, async () => {
    await ctx.viem.assertions.revertWithCustomError(
      ctx.nomosPayroll.write.setAgent([ctx.random.account.address], {
        account: ctx.random.account.address,
      }),
      ctx.nomosPayroll,
      "NotOwner",
    );
  });

  it("non-owner cannot grantAuditor", { timeout: 60_000 }, async () => {
    await ctx.viem.assertions.revertWithCustomError(
      ctx.nomosPayroll.write.grantAuditor([ctx.auditor.account.address], {
        account: ctx.random.account.address,
      }),
      ctx.nomosPayroll,
      "NotOwner",
    );
  });

  it("non-owner cannot revokeAuditor", { timeout: 60_000 }, async () => {
    // onlyOwner runs before the function body, so a non-owner caller hits
    // NotOwner regardless of whether the auditor was ever granted.
    await ctx.viem.assertions.revertWithCustomError(
      ctx.nomosPayroll.write.revokeAuditor([ctx.auditor.account.address], {
        account: ctx.random.account.address,
      }),
      ctx.nomosPayroll,
      "NotOwner",
    );
  });

  it("deposit() succeeds from any caller (permissionless by design)", { timeout: 60_000 }, async () => {
    const amount = 50n * TOKEN;
    await ctx.mockToken.write.mint([ctx.random.account.address, amount], {
      account: ctx.owner.account.address,
    });
    await ctx.mockToken.write.approve([ctx.nomosPayroll.address, amount], {
      account: ctx.random.account.address,
    });
    const txHash = await ctx.nomosPayroll.write.deposit([amount], {
      account: ctx.random.account.address,
    });
    await ctx.viem.assertions.emit(txHash, ctx.nomosPayroll, "Deposited");
    assert.equal(await ctx.nomosPayroll.read.totalDeposited(), amount);
  });
});

// =============================================================================

describe("NomosPayroll — Happy Path", () => {
  let ctx: Deployment;

  before(async () => {
    ctx = await deploy();
  });

  it("addEmployee with encrypted salary updates roster, aggregate, and ACL grants", { timeout: 60_000 }, async () => {
    const { txHash, salaryHandle } = await addEmployee(ctx, ctx.alice, SALARY_ALICE);

    await ctx.viem.assertions.emitWithArgs(txHash, ctx.nomosPayroll, "EmployeeAdded", [
      ctx.alice.account.address,
    ]);
    const employees = (await ctx.nomosPayroll.read.getEmployees()) as Address[];
    assert.deepEqual(
      employees.map((a) => a.toLowerCase()),
      [ctx.alice.account.address.toLowerCase()],
    );
    assert.equal(await ctx.nomosPayroll.read.isAllowlisted([ctx.alice.account.address]), true);

    // ACL grants applied by addEmployee: allowThis (persistent, for the contract's
    // own future reads) + allow(recipient) + allow(agent) — verified directly
    // on-chain against NoxCompute, not inferred from decrypt success/failure.
    assert.equal(
      await isAllowedOnChain(ctx.publicClient, salaryHandle, ctx.nomosPayroll.address),
      true,
      "NomosPayroll itself should retain persistent access (Nox.allowThis)",
    );
    assert.equal(
      await isAllowedOnChain(ctx.publicClient, salaryHandle, ctx.alice.account.address),
      true,
      "alice should be allowed to view her own salary handle",
    );
    assert.equal(
      await isAllowedOnChain(ctx.publicClient, salaryHandle, ctx.agent.account.address),
      true,
      "agent should be allowed to view alice's salary handle",
    );
  });

  it("deposit funds via mock ERC20 transferFrom", { timeout: 60_000 }, async () => {
    await fundTreasury(ctx, ctx.owner, FUND_AMOUNT);
    assert.equal(await ctx.mockToken.read.balanceOf([ctx.nomosPayroll.address]), FUND_AMOUNT);
    assert.equal(await ctx.nomosPayroll.read.totalDeposited(), FUND_AMOUNT);
  });

  it("setPolicy with plaintext spendCap, cooldown, durations", { timeout: 60_000 }, async () => {
    const txHash = await ctx.nomosPayroll.write.setPolicy(
      [COOLDOWN_SECONDS, CLIFF_DURATION, STREAM_DURATION, DEFAULT_SPEND_CAP],
      { account: ctx.owner.account.address },
    );
    await ctx.viem.assertions.emitWithArgs(txHash, ctx.nomosPayroll, "PolicyUpdated", [
      BigInt(COOLDOWN_SECONDS),
      CLIFF_DURATION,
      STREAM_DURATION,
      DEFAULT_SPEND_CAP,
    ]);
  });

  it(
    "runCycle by agent creates Sablier streams, emits attestation + cycle events, updates schedule state",
    { timeout: 60_000 },
    async () => {
      const { receipt } = await runCycle(ctx, [{ recipient: ctx.alice.account.address, amount: SALARY_ALICE }]);

      const callsLength = await ctx.mockSablier.read.callsLength();
      assert.equal(callsLength, 1n);
      const call = await ctx.mockSablier.read.calls([0n]);
      // MockSablierLockupLinear.RecordedCall: sender, recipient, depositAmount, token, cancelable, transferable, cliffDuration, totalDuration
      assert.ok(sameAddress(call[1], ctx.alice.account.address), "recorded recipient should match");
      assert.equal(call[2], SALARY_ALICE, "recorded depositAmount should match the plaintext salary submitted");

      const attested = parseEventLogs({
        abi: ctx.nomosPayroll.abi,
        logs: receipt.logs,
        eventName: "PaymentAttested",
      });
      assert.equal(attested.length, 1);
      assert.ok(sameAddress(eventArgs<PaymentAttestedArgs>(attested[0]).recipient, ctx.alice.account.address));
      assert.equal(eventArgs<PaymentAttestedArgs>(attested[0]).cycleCount, 1n);

      const cycleExecuted = parseEventLogs({
        abi: ctx.nomosPayroll.abi,
        logs: receipt.logs,
        eventName: "CycleExecuted",
      });
      assert.equal(cycleExecuted.length, 1);
      assert.equal(eventArgs<CycleExecutedArgs>(cycleExecuted[0]).cycleCount, 1n);
      assert.equal(eventArgs<CycleExecutedArgs>(cycleExecuted[0]).employeeCount, 1n);

      assert.equal(await ctx.nomosPayroll.read.cycleCount(), 1n);
      const block = await ctx.publicClient.getBlock({ blockNumber: receipt.blockNumber });
      assert.equal(await ctx.nomosPayroll.read.lastRunTimestamp(), block.timestamp);
    },
  );
});

// =============================================================================

describe("NomosPayroll — Policy Enforcement", () => {
  it("runCycle reverts when the aggregate exceeds spendCap", { timeout: 60_000 }, async () => {
    const ctx = await deploy({ spendCap: LOW_SPEND_CAP });
    await addEmployee(ctx, ctx.alice, SALARY_ALICE); // 1000 tokens > 100-token cap
    await fundTreasury(ctx, ctx.owner, FUND_AMOUNT);

    const withinCapHandle = (await ctx.nomosPayroll.read.getWithinCapHandle()) as Hex;
    await waitForHandlesResolved([withinCapHandle]);
    const { value: withinCap } = await nox.publicDecrypt(withinCapHandle);
    assert.equal(withinCap, false, "sanity: the roster should indeed be over cap before we assert the revert");

    await ctx.viem.assertions.revertWithCustomError(
      runCycle(ctx, [{ recipient: ctx.alice.account.address, amount: SALARY_ALICE }]).then((r) => r.txHash),
      ctx.nomosPayroll,
      "OverSpendCap",
    );
  });

  it("runCycle reverts before the cooldown has elapsed", { timeout: 60_000 }, async () => {
    const ctx = await deploy({ cooldownSeconds: COOLDOWN_SECONDS });
    await addEmployee(ctx, ctx.alice, SALARY_ALICE);
    await fundTreasury(ctx, ctx.owner, FUND_AMOUNT);

    await runCycle(ctx, [{ recipient: ctx.alice.account.address, amount: SALARY_ALICE }]);

    await ctx.viem.assertions.revertWithCustomError(
      runCycle(ctx, [{ recipient: ctx.alice.account.address, amount: SALARY_ALICE }]).then((r) => r.txHash),
      ctx.nomosPayroll,
      "CooldownNotElapsed",
    );
  });

  it("runCycle reverts on a positional recipient mismatch", { timeout: 60_000 }, async () => {
    const ctx = await deploy();
    await addEmployee(ctx, ctx.alice, SALARY_ALICE);
    await addEmployee(ctx, ctx.bob, SALARY_BOB);
    await fundTreasury(ctx, ctx.owner, FUND_AMOUNT);

    // getEmployees() order is [alice, bob]; submit them swapped.
    await ctx.viem.assertions.revertWithCustomError(
      runCycle(ctx, [
        { recipient: ctx.bob.account.address, amount: SALARY_BOB },
        { recipient: ctx.alice.account.address, amount: SALARY_ALICE },
      ]).then((r) => r.txHash),
      ctx.nomosPayroll,
      "RecipientMismatch",
    );
  });

  it("runCycle reverts on a wrong-length payments array", { timeout: 60_000 }, async () => {
    const ctx = await deploy();
    await addEmployee(ctx, ctx.alice, SALARY_ALICE);
    await addEmployee(ctx, ctx.bob, SALARY_BOB);
    await fundTreasury(ctx, ctx.owner, FUND_AMOUNT);

    await ctx.viem.assertions.revertWithCustomError(
      runCycle(ctx, [{ recipient: ctx.alice.account.address, amount: SALARY_ALICE }]).then((r) => r.txHash),
      ctx.nomosPayroll,
      "PaymentsLengthMismatch",
    );
  });
});

// =============================================================================

describe("NomosPayroll — Confidentiality (ACL semantics)", () => {
  let ctx: Deployment;
  let aliceSalaryHandle: Hex;
  let bobSalaryHandle: Hex;
  let aggregateHandle: Hex;
  let withinCapHandle: Hex;

  before(async () => {
    ctx = await deploy();
    const aliceResult = await addEmployee(ctx, ctx.alice, SALARY_ALICE);
    aliceSalaryHandle = aliceResult.salaryHandle;
    const bobResult = await addEmployee(ctx, ctx.bob, SALARY_BOB);
    bobSalaryHandle = bobResult.salaryHandle;
    aggregateHandle = bobResult.aggregateHandle;
    withinCapHandle = bobResult.withinCapHandle;

    const txHash = await ctx.nomosPayroll.write.grantAuditor([ctx.auditor.account.address], {
      account: ctx.owner.account.address,
    });
    await ctx.publicClient.waitForTransactionReceipt({ hash: txHash });
  });

  it("employee alice can decrypt her own salary handle", { timeout: 60_000 }, async () => {
    const aliceHandleClient = await handleClientFor(ctx.alice);
    const { value } = await aliceHandleClient.decrypt(aliceSalaryHandle);
    assert.equal(value, SALARY_ALICE);
  });

  it("employee alice cannot decrypt bob's salary handle", { timeout: 60_000 }, async () => {
    const aliceHandleClient = await handleClientFor(ctx.alice);
    await assert.rejects(aliceHandleClient.decrypt(bobSalaryHandle), /not authorized/i);
  });

  it("auditor can decrypt the aggregate outflow handle after grantAuditor", { timeout: 60_000 }, async () => {
    const auditorHandleClient = await handleClientFor(ctx.auditor);
    const { value } = await auditorHandleClient.decrypt(aggregateHandle);
    assert.equal(value, SALARY_ALICE + SALARY_BOB);
  });

  it("a random address cannot decrypt the aggregate outflow handle", { timeout: 60_000 }, async () => {
    const randomHandleClient = await handleClientFor(ctx.random);
    await assert.rejects(randomHandleClient.decrypt(aggregateHandle), /not authorized/i);
  });

  it("anyone can publicDecrypt the within-cap boolean", { timeout: 60_000 }, async () => {
    const randomHandleClient = await handleClientFor(ctx.random);
    const { value } = await randomHandleClient.publicDecrypt(withinCapHandle);
    assert.equal(value, true);
  });
});

// =============================================================================

describe("NomosPayroll — Attestation (detective control)", () => {
  let ctx: Deployment;

  // A short cooldown here (rather than the suite default) keeps the second
  // it()'s time.increase() small — the underlying chain is shared across
  // the whole file (one Hardhat node for the run), so any chain-time jump
  // here persists into every test that runs after this block, and Nox's
  // encrypted-input proofs carry a real-time-bound expiry (Compute.sol's
  // "Proof expired" check) that a large jump can trip for later tests.
  const SHORT_COOLDOWN_SECONDS = 5;

  before(async () => {
    ctx = await deploy({ cooldownSeconds: SHORT_COOLDOWN_SECONDS });
    await addEmployee(ctx, ctx.alice, SALARY_ALICE);
    await addEmployee(ctx, ctx.bob, SALARY_BOB);
    await fundTreasury(ctx, ctx.owner, FUND_AMOUNT);
  });

  it("a correctly-run cycle attests true for every recipient", { timeout: 60_000 }, async () => {
    const { receipt } = await runCycle(ctx, [
      { recipient: ctx.alice.account.address, amount: SALARY_ALICE },
      { recipient: ctx.bob.account.address, amount: SALARY_BOB },
    ]);

    const attested = parseEventLogs({
      abi: ctx.nomosPayroll.abi,
      logs: receipt.logs,
      eventName: "PaymentAttested",
    });
    assert.equal(attested.length, 2);

    const handles = attested.map((log) => eventArgs<PaymentAttestedArgs>(log).matchesLedgerHandle);
    await waitForHandlesResolved(handles);

    for (const log of attested) {
      const args = eventArgs<PaymentAttestedArgs>(log);
      const { value } = await nox.publicDecrypt(args.matchesLedgerHandle);
      assert.equal(
        value,
        true,
        `attestation for ${args.recipient} should be true — the paid amount matched the confidential ledger`,
      );
    }
  });

  // This is the demo money-shot for the "verifiable execution" pitch: the
  // contract has NO way to prevent a misbehaving agent from paying the wrong
  // amount (§0 of CONTRACT_DESIGN.md — no on-chain primitive exists to verify
  // an ACL-restricted plaintext against its handle before spending real
  // funds). What it CAN do is refuse to lie about it afterward: the
  // per-payment attestation is computed from the actual amount that was
  // just paid, so a wrong payment gets a publicly-verifiable `false`,
  // forever, without ever revealing what the correct amount should have
  // been. Detective, not preventive — and that distinction is the point.
  it("a misbehaving agent's wrong payment executes, but its attestation is publicly verifiable as false", { timeout: 60_000 }, async () => {
    // The previous test already ran one cycle; advance past the cooldown so
    // this second cycle isn't rejected for an unrelated reason.
    await ctx.networkHelpers.time.increase(SHORT_COOLDOWN_SECONDS);

    const wrongAmount = SALARY_ALICE + 1n * TOKEN; // agent claims alice earns 1 token more than the ledger says

    const { receipt } = await runCycle(ctx, [
      { recipient: ctx.alice.account.address, amount: wrongAmount }, // wrong
      { recipient: ctx.bob.account.address, amount: SALARY_BOB }, // correct
    ]);

    // The contract did NOT revert — this is expected and is the whole point.
    assert.equal(receipt.status, "success");

    const callsLength = await ctx.mockSablier.read.callsLength();
    const lastCall = await ctx.mockSablier.read.calls([callsLength - 1n]);
    assert.equal(lastCall[2], SALARY_BOB, "bob's stream was funded with the correct amount");

    const attested = parseEventLogs({
      abi: ctx.nomosPayroll.abi,
      logs: receipt.logs,
      eventName: "PaymentAttested",
    });
    const aliceAttestation = attested.find((log) =>
      sameAddress(eventArgs<PaymentAttestedArgs>(log).recipient, ctx.alice.account.address),
    )!;
    const bobAttestation = attested.find((log) =>
      sameAddress(eventArgs<PaymentAttestedArgs>(log).recipient, ctx.bob.account.address),
    )!;
    const aliceAttestationArgs = eventArgs<PaymentAttestedArgs>(aliceAttestation);
    const bobAttestationArgs = eventArgs<PaymentAttestedArgs>(bobAttestation);

    await waitForHandlesResolved([aliceAttestationArgs.matchesLedgerHandle, bobAttestationArgs.matchesLedgerHandle]);

    const { value: aliceMatches } = await nox.publicDecrypt(aliceAttestationArgs.matchesLedgerHandle);
    const { value: bobMatches } = await nox.publicDecrypt(bobAttestationArgs.matchesLedgerHandle);

    assert.equal(
      aliceMatches,
      false,
      "alice's attestation must be false — the agent paid more than her confidential ledger salary",
    );
    assert.equal(bobMatches, true, "bob's attestation must stay true — he was paid correctly");
  });
});

// =============================================================================

describe("NomosPayroll — Handle Rotation on Roster Change", () => {
  it("an auditor granted before any employees are added still has access after the aggregate handle rotates", { timeout: 60_000 }, async () => {
    const ctx = await deploy();

    // Grant the auditor first, while _cycleSpendHandle is still the zero handle.
    let txHash = await ctx.nomosPayroll.write.grantAuditor([ctx.auditor.account.address], {
      account: ctx.owner.account.address,
    });
    await ctx.publicClient.waitForTransactionReceipt({ hash: txHash });

    const handleBeforeAdd = (await ctx.nomosPayroll.read.getAggregateOutflowHandle()) as Hex;

    // addEmployee replaces _cycleSpendHandle with a brand-new handle.
    const { aggregateHandle: handleAfterAdd } = await addEmployee(ctx, ctx.alice, SALARY_ALICE);
    assert.notEqual(
      handleAfterAdd,
      handleBeforeAdd,
      "sanity: addEmployee should have actually replaced the aggregate handle",
    );

    // The re-grant loop in addEmployee (_regrantAuditors) must have re-applied
    // the auditor's access to the NEW handle — prove it both on-chain and via
    // a real off-chain decrypt.
    assert.equal(
      await isAllowedOnChain(ctx.publicClient, handleAfterAdd, ctx.auditor.account.address),
      true,
      "auditor should be re-granted access on the rotated handle",
    );

    const auditorHandleClient = await handleClientFor(ctx.auditor);
    const { value } = await auditorHandleClient.decrypt(handleAfterAdd);
    assert.equal(value, SALARY_ALICE);
  });
});
