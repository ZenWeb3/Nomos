// Shared JSON-output support for --json across all nomos commands.

/** JSON.stringify replacer that renders bigint as a plain decimal string (JSON has no bigint literal). */
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, bigintReplacer, 2));
}
