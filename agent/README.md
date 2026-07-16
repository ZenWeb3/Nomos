# Nomos Keeper Agent

The "dumb external keeper" from `CONTRACT_DESIGN.md` §0: a plain Node
process, not TEE-hosted, holding the agent's private key. It has no policy
logic of its own — cooldown, spend cap, and allowlist enforcement all live
on-chain in `NomosPayroll`. Its only job is to notice when a cycle is due,
decrypt what it's authorized to decrypt, and submit `runCycle`.

See the repo root `CONTRACT_DESIGN.md` for why this design was chosen
(Nox has no native scheduling) and `SPRINT.md`'s Sprint 3 section for the
attestation story: the thing that makes a cycle independently verifiable
isn't a TEE the keeper runs inside — it's the Nox Gateway's EIP-712
signature over each `PaymentAttested` handle, checkable by anyone via
`publicDecrypt` (see `cli/`).

## Running

```sh
pnpm hardhat compile   # once, or after any contract change — the agent reads the ABI from artifacts/
pnpm agent             # runs agent/src/index.ts via tsx
```

Runs until `SIGTERM`/`SIGINT`. Every state transition is logged
(`[timestamp] [LEVEL] [scope] message key=value ...`) — this is the log a
demo recording should show.

## Required environment variables

| Variable | Description |
|---|---|
| `NOMOS_PAYROLL_ADDRESS` | Deployed `NomosPayroll` address (from `deployments/sepolia.json`) |
| `NOMOS_TOKEN_ADDRESS` | Deployed payroll token address (`NomosToken`, or whatever `payrollToken` was set to) |
| `AGENT_PRIVATE_KEY` | Private key for the address `NomosPayroll.agent` currently points at. In this hackathon's setup, owner and agent are the same key, so this can reuse `DEPLOYER_PRIVATE_KEY` — see the "Future work" note below. |
| `SEPOLIA_RPC_URL` | Same RPC URL used everywhere else in this repo |

## Optional environment variables

| Variable | Default | Description |
|---|---|---|
| `CHECK_INTERVAL_SECONDS` | `15` | How often the keeper polls on-chain state between ticks |
| `COOLDOWN_BUFFER_SECONDS` | `5` | Extra margin added on top of `policy.cooldownSeconds` before the keeper considers a cycle due — avoids a race where the keeper's clock and the chain's block timestamp disagree by a few seconds right at the cooldown boundary |

## Expected behavior per tick

1. Read on-chain state: employee roster, `lastRunTimestamp`, `cycleCount`, policy, treasury balance.
2. Decide whether a cycle is due (cooldown + buffer elapsed, roster non-empty, treasury sufficient).
3. If not due: log why, sleep until the next tick.
4. If due: decrypt each employee's salary (the agent key is `Nox.allow`-granted on every salary handle by `addEmployee`), build the `CyclePayment[]` array in roster order, fetch the `_withinCapHandle` decryption proof, **simulate** `runCycle` first.
5. If simulation reverts: log the revert reason, do not submit a transaction, retry next tick.
6. If simulation succeeds: submit `runCycle` for real, wait for the receipt, log the tx hash and new cycle count.
7. Any unexpected error in a tick is caught and logged; the loop keeps running (with backoff) rather than crashing. Only `SIGTERM`/`SIGINT` stop it.

## Future work

- **Separate owner and agent keys.** Right now `NomosPayroll`'s
  constructor sets `agent = deployer` for hackathon simplicity
  (`scripts/deploy-sepolia.ts`). A real deployment should use a distinct
  agent key with narrower blast radius than the owner key.
- **Natural-language policy input.** `setPolicy`'s interface
  (`{cooldownSeconds, cliffDuration, streamDuration, spendCap}`, all plain
  named fields) was deliberately kept simple enough that a future
  LLM-driven "describe your payroll policy in English" translator could
  target it directly — not built in Sprint 3, but nothing here should make
  it harder to add later.
- **iApp wrapping.** Running the keeper itself inside an iExec iApp/TEE is
  explicitly out of scope for Sprint 3 — see `SPRINT.md`.
