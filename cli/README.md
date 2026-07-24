# Nomos Verification CLI

Independent verification tooling — deliberately separate from the keeper
(`agent/`). None of these commands trust the keeper; `verify`, `audit`, and
`my-salary` each perform their own cryptographic checks against Nox and
NomosPayroll directly.

See `SPRINT.md`'s Sprint 3 section for the attestation story this CLI
exists to demonstrate: the thing that makes a payroll cycle independently
checkable isn't a TEE the keeper runs inside — it's the Nox Gateway's
EIP-712 signature over each `PaymentAttested` handle, and separately, Nox's
ACL system gating who can decrypt confidential handles (the aggregate
outflow for auditors, each salary for its own employee).

## Running

```sh
pnpm hardhat compile   # once, or after any contract change
pnpm nomos <command>   # runs cli/src/index.ts via tsx
```

## Required environment variables (all commands)

| Variable | Description |
|---|---|
| `NOMOS_PAYROLL_ADDRESS` | Deployed `NomosPayroll` address |
| `NOMOS_TOKEN_ADDRESS` | Deployed payroll token address |
| `SEPOLIA_RPC_URL` | Same RPC URL used everywhere else in this repo |

## Machine-readable output

Every command accepts `--json`, which replaces the formatted report with a
single `JSON.stringify`d object on stdout (`bigint` fields render as decimal
strings, since JSON has no bigint literal). Useful for scripting, screenshots
you don't want to hand-format, or eventually wiring the frontend to shell out
to this CLI instead of reimplementing the same reads.

```sh
pnpm nomos status --json
```

## `nomos status [--json] [--watch] [--interval <seconds>]`

No keys needed — reads only plaintext on-chain state.

```sh
pnpm nomos status
```

Prints roster size, treasury balance, cycle count, last-run timestamp, and
seconds until the next cycle is cooldown-eligible.

`--watch` re-fetches and reprints on an interval (default 5s, override with
`--interval`) until Ctrl+C — clears the screen between ticks in text mode,
so it's meant to sit in its own terminal during a demo. In `--json` mode the
screen isn't cleared, so `--watch --json` produces an append-only stream of
JSON objects, one per tick — suitable for piping somewhere that wants to
observe state over time rather than a single snapshot.

## `nomos verify (--cycle <n> | --all) [--from-block <n>] [--json]`

No keys needed. For every `PaymentAttested` event in the target cycle(s):

1. `publicDecrypt`s the attestation handle via the Handle Gateway (anyone
   can — the handle was marked publicly decryptable by `NomosPayroll`
   itself in `runCycle`).
2. Independently re-verifies the returned proof **on-chain**, by calling
   `NoxCompute.validateDecryptionProof` directly — the exact same check
   `NomosPayroll` performs internally. This reverts if the signature
   doesn't check out against the Gateway's registered key, so a successful
   call is a real cryptographic guarantee, not trust in an HTTP response.

Pass exactly one of `--cycle <n>` or `--all` — `--all` finds and verifies
every cycle the contract has ever run, not just one.

```sh
pnpm nomos verify --cycle 1
```

```
Cycle 1 — attestations signed by Nox Gateway 0xE13191F53671957C8a48A7A3Ff15E16450a1552F

Recipient                                  | Stream ID | Attestation
-------------------------------------------|-----------|------------
0x945Dc258d3632D4e5D7E194B86Fc5A509bDdeddC | 21        | ✓ verified
0x33F0b95155727eb0fE4A9B3f78eBD911612b8018 | 22        | ✓ verified
0xFce690bD2d197DD7B1e1dbeff10DAc796F715c6F | 23        | ✓ verified

All attestations verified true.
```

```sh
pnpm nomos verify --all
```

Prints the same table per cycle, in order, followed by an overall summary
line. Exits `0` only if every cycle found has every attestation `true`; `1`
if any attestation anywhere is `false`, or no events are found at all.

**Note on `--from-block`**: without it, `verify` scans backward from the
chain tip in ~900-block windows (the RPC provider this repo uses caps
`eth_getLogs` well below the "10,000" its own error message claims — 900
stays safely under the limit actually enforced). `--all` stops early the
moment it sees cycle 1's log, since cycles are sequential and everything
before that is guaranteed older than the roster's first execution — but on
a long-lived deployment this can still mean many round trips. If you
already know roughly which block the contract was deployed at (a deploy
script prints this), pass `--from-block` to skip straight there instead of
scanning.

## `nomos audit --auditor-key <path> [--json]`

Requires a real key — this is one of two commands that isn't "anyone can
run it" (the other is `my-salary`). Proves the auditor mechanism works by
actually using it: decrypts `NomosPayroll`'s confidential aggregate outflow
handle.

```sh
pnpm nomos audit --auditor-key deployments/sepolia.json
```

```
Auditing as 0x13B0D721BBa04a0458BEa454B4fDB6953cbB2c52...
Confidential aggregate outflow: 45000000000000000000000 (raw uint256, token's smallest unit)
```

**Any key that was never granted via `grantAuditor` gets an ACL error**,
not a decrypted value — this is the mechanism actually being enforced by
Nox, not something this CLI fakes:

```
Auditing as 0x3788c0556129Ede5B3b203B8863A91dDcc541Dd5...
Decryption failed — this address is not authorized to view the aggregate outflow handle.
(Expected unless 0x3788c0556129Ede5B3b203B8863A91dDcc541Dd5 was granted via grantAuditor.)
Underlying error: Handle (0x0000...) does not exist or user (0x3788...) is not authorized to decrypt it
```

## `nomos my-salary --key <path> [--employee <name-or-address>] [--json]`

Requires a real key. The individual-employee counterpart to `audit`: proves
that `Nox.allow(salary, recipient)` in `addEmployee` really does grant each
employee decrypt access to *only their own* salary handle, nothing else on
the roster.

```sh
pnpm nomos my-salary --key deployments/sepolia.json --employee alice
```

```
Checking salary as 0xcfFa76281F3B342E4D2Bb64c421e572B2Bf55e2a...
Your salary: 10000 tokens (raw: 10000000000000000000000)
```

If the address isn't on the current roster at all, you get that told to you
directly rather than a confusing decrypt failure:

```
Checking salary as 0x1689d6c3f1735a8bb888e98b5546B82666A02a40...
0x1689d6c3f1735a8bb888e98b5546B82666A02a40 is not on the current roster — there is no salary to decrypt.
```

## Private key files (`--auditor-key`, `--key`)

Both accept the same file shapes, resolved by `cli/src/keys.ts`:

- a raw hex private key as the entire file content
- `{ "privateKey": "0x..." }`
- `{ "auditor": { "privateKey": "0x..." } }` (an auditor-shaped deployments JSON)
- `{ "employees": [{ "name", "address", "privateKey" }, ...] }` — pass
  `--employee <name-or-address>` (required for `my-salary` whenever the file
  has more than one employee; case-insensitive) to pick which entry to use

This means `deployments/*.json` — which already holds every testnet key a
deploy script generated — can be pointed at directly for any of these
commands without extracting keys into their own files by hand first. When a
selector is given, it always targets `employees[]` specifically, even if the
same file also has an `auditor` key sitting next to it — otherwise `--key
deployments/sepolia.json --employee alice` would be one unrelated key away
from silently decrypting as the auditor instead of as alice.
