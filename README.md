# Nox Hardhat plugin – example project

This package consumes [`@iexec-nox/nox-hardhat-plugin`](../plugin) via a pnpm
workspace link to demonstrate how to build and test an [ERC-7984] confidential
fungible token backed by the Nox TEE.

`contracts/MyConfidentialToken.sol` extends `ERC7984` from
`@iexec-nox/nox-confidential-contracts`.

## Getting started

```sh
pnpm install
pnpm build
```

Run the full test suite (Foundry unit tests + Node.js integration tests):

```sh
pnpm hardhat test
```

The plugin transparently:

1. compiles the project (including `NoxCompute` pulled from
   `@iexec-nox/nox-protocol-contracts`),
2. starts a Hardhat node on `0.0.0.0:8545`,
3. injects `NoxCompute` at its well-known address and initializes it,
4. brings up the offchain stack (KMS, ingestor, runner, handle gateway, NATS,
   S3) via Docker Compose,
5. runs your tests,
6. tears everything down.

[ERC-7984]: https://eips.ethereum.org/EIPS/eip-7984
