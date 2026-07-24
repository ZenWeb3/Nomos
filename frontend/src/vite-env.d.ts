/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SEPOLIA_RPC_URL: string;
  readonly VITE_NOMOS_PAYROLL_ADDRESS: `0x${string}`;
  readonly VITE_NOMOS_TOKEN_ADDRESS: `0x${string}`;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
