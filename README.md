# Nomos

Confidential, agent-run payroll. Built for the iExec WTF Hackathon Summer
Edition on **iExec Nox** (confidential compute — encrypted state as
on-chain handles, resolved off-chain in a TEE) and **Sablier Lockup**
(real streaming payouts, not lump-sum transfers).

Individual salaries and the aggregate payroll outflow are encrypted
end-to-end — never readable on-chain, never emitted in an event. Policy
(cooldown between cycles, per-employee allowlist, and the spend-cap
*value*) is enforced in plaintext on-chain, because a policy no one can
observe isn't a policy anyone can trust.

## How it works

1. The owner adds employees with client-side-encrypted salaries
   (`addEmployee`) and sets policy (`setPolicy`: cooldown, spend cap,
   Sablier stream duration/cliff).
2. An external **keeper** — a plain Node process holding the `agent` key,
   not itself TEE-hosted (see [Attestation story](#attestation-story)
   below) — polls on-chain state. When the cooldown has elapsed and the
   roster is within the spend cap, it decrypts each salary it's
   authorized to see, and calls `runCycle`.
3. `runCycle` is restricted to the `agent` key — this is what closes the
   fund-drain vector inherent to Nox's decrypt model (no on-chain
   primitive lets a contract trustlessly verify an ACL-private value; see
   `CONTRACT_DESIGN.md` §0). For each employee it opens a real Sablier
   linear stream for their salary, and emits a `PaymentAttested` handle —
   a Nox-computed boolean (`paid amount == ledger amount`) marked publicly
   decryptable, so anyone can independently confirm the agent paid the
   right amount without ever learning what that amount was.
4. Anyone can run the verification CLI to check those attestations
   without trusting the keeper at all. A granted auditor key can
   separately decrypt the confidential aggregate outflow.

## Attestation story

This project's "TEE attestation" is **not** the keeper running inside a
TEE — the keeper is an ordinary Node process, signed by the agent's plain
private key, with no enclave of its own (Nox has no native scheduling
primitive; the schedule loop has to live somewhere outside Nox, and that
somewhere is this process — see `NOTES.md`).

What *is* attested is narrower and independently checkable: every
`PaymentAttested` event carries a Nox handle for `Nox.eq(amountPaid,
ledgerSalary)`, computed inside Nox's TEE-run Runner and marked publicly
decryptable. `publicDecrypt`ing that handle returns the boolean **plus an
EIP-712 signature from the Nox Gateway** over `(handle, result)`, which
anyone can re-verify on-chain via `NoxCompute.validateDecryptionProof` —
not by trusting an HTTP response, but by getting a real revert-or-succeed
answer from the chain itself. That's what `cli/ verify` does for every
recipient in a cycle, and it never asks the keeper for anything.

So: the *schedule* is trust-the-keeper (it's a plain signed process, just
like a cron job would be); the *payment correctness* is not — it's a
cryptographic proof anyone can check independently, after the fact,
forever.

## Repo layout

| Path | What |
|---|---|
| `contracts/NomosPayroll.sol` | Encrypted salary table, on-chain policy engine, per-cycle Sablier stream creation, publicly-verifiable payment attestations. |
| `contracts/NomosToken.sol` | Self-mintable demo ERC-20 payroll token (see `SPRINT.md` Sprint 2 log for why — the Sepolia DAI faucet turned out to be owner-gated). |
| `contracts/interfaces/ISablierLockupLinearReal.sol` | Hand-verified interface matching the actually-deployed Sepolia Sablier contract (the npm package's ABI silently diverges from it). |
| `agent/` | The keeper — see [`agent/README.md`](agent/README.md). |
| `cli/` | Independent verification CLI (`status`, `verify`, `audit`) — see [`cli/README.md`](cli/README.md). |
| `scripts/deploy-sepolia.ts` | Deploys fresh, funds the treasury, adds employees, grants an auditor, runs one cycle end-to-end. |
| `test/NomosPayroll.test.ts` | 24 Hardhat/viem tests: access control, policy enforcement, Nox ACL semantics, attestation, handle rotation. |
| `CONTRACT_DESIGN.md`, `NOTES.md`, `SPRINT.md` | Design rationale, Nox research notes, sprint tracker (not part of the public repo — see `.gitignore`). |

## Quickstart

```sh
pnpm install
pnpm hardhat compile
pnpm test                                              # 24/24 local tests

cp .env.example .env                                   # fill in SEPOLIA_RPC_URL, DEPLOYER_PRIVATE_KEY, SABLIER_LOCKUP_SEPOLIA
pnpm hardhat run scripts/deploy-sepolia.ts --network sepolia   # deploys fresh, runs cycle 1

# then, with NOMOS_PAYROLL_ADDRESS / NOMOS_TOKEN_ADDRESS / AGENT_PRIVATE_KEY set (see agent/README.md):
pnpm agent                                              # keeper runs subsequent cycles autonomously

pnpm nomos status                                       # no keys needed
pnpm nomos verify --cycle 1                             # independently verify attestations
pnpm nomos audit --auditor-key deployments/sepolia.json # decrypt confidential aggregate outflow
```

## Known limitations

See `CONTRACT_DESIGN.md` §8: in-flight Sablier streams survive
`removeEmployee`; auditor/agent Nox ACL grants are rotation-based, not
immediately revocable (a rotated-out agent's decrypt access on
already-set salary handles has no expiry this sprint); owner and agent
are the same key in this hackathon's deployment (see `agent/README.md`'s
"Future work").
