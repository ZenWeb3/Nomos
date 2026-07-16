# Nomos Verification CLI

Independent verification tooling — deliberately separate from the keeper
(`agent/`). None of these commands trust the keeper; `verify` and `audit`
each perform their own cryptographic checks against Nox and NomosPayroll
directly.

See `SPRINT.md`'s Sprint 3 section for the attestation story this CLI
exists to demonstrate: the thing that makes a payroll cycle independently
checkable isn't a TEE the keeper runs inside — it's the Nox Gateway's
EIP-712 signature over each `PaymentAttested` handle, and separately, Nox's
ACL system gating who can decrypt the confidential aggregate outflow.

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

## `nomos status`

No keys needed — reads only plaintext on-chain state.

```sh
pnpm nomos status
```

Prints roster size, treasury balance, cycle count, last-run timestamp, and
seconds until the next cycle is cooldown-eligible. Useful to have running
in a terminal during a demo.

## `nomos verify --cycle <n> [--from-block <n>]`

No keys needed. For every `PaymentAttested` event in the given cycle:

1. `publicDecrypt`s the attestation handle via the Handle Gateway (anyone
   can — the handle was marked publicly decryptable by `NomosPayroll`
   itself in `runCycle`).
2. Independently re-verifies the returned proof **on-chain**, by calling
   `NoxCompute.validateDecryptionProof` directly — the exact same check
   `NomosPayroll` performs internally. This reverts if the signature
   doesn't check out against the Gateway's registered key, so a successful
   call is a real cryptographic guarantee, not trust in an HTTP response.

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

Exits `0` if every attestation is `true`, `1` if any is `false` or no
events are found for that cycle.

**Note on `--from-block`**: without it, `verify` scans backward from the
chain tip in ~900-block windows (the RPC provider this repo uses caps
`eth_getLogs` well below the "10,000" its own error message claims — 900
stays safely under the limit actually enforced). This works but can be
slow for old cycles on a long-lived deployment. If you already know
roughly which block the contract was deployed at (a deploy script prints
this), pass it explicitly to skip straight there.

## `nomos audit --auditor-key <path>`

Requires a real key — this is the one command that isn't "anyone can run
it". Proves the auditor mechanism works by actually using it: decrypts
`NomosPayroll`'s confidential aggregate outflow handle.

```sh
pnpm nomos audit --auditor-key deployments/sepolia.json
```

```
Auditing as 0x13B0D721BBa04a0458BEa454B4fDB6953cbB2c52...
Confidential aggregate outflow: 45000000000000000000000 (raw uint256, token's smallest unit)
```

`--auditor-key` accepts either a plain file containing a raw hex private
key, or a deployments JSON file with an `auditor.privateKey` field (so
`deployments/*.json` can be pointed at directly).

**Any key that was never granted via `grantAuditor` gets an ACL error**,
not a decrypted value — this is the mechanism actually being enforced by
Nox, not something this CLI fakes:

```
Auditing as 0x3788c0556129Ede5B3b203B8863A91dDcc541Dd5...
Decryption failed — this address is not authorized to view the aggregate outflow handle.
(Expected unless 0x3788c0556129Ede5B3b203B8863A91dDcc541Dd5 was granted via grantAuditor.)
Underlying error: Handle (0x0000...) does not exist or user (0x3788...) is not authorized to decrypt it
```
