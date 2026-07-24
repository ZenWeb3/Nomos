// Hardhat's build-artifact ABIs are plain JSON, so `resolveJsonModule`
// widens their `type`/`name`/`stateMutability` fields to `string` instead of
// literal unions — viem's event-log types are keyed off exactly those
// literals, so without them `getContractEvents`'s return type can't
// discriminate which log variant carries `.args`, and the property doesn't
// type-check even before a cast is applied. `as const` can't fix this after
// the fact (it only narrows literal expressions, and a JSON import's value
// has already widened by the time it's a reference), so every event-args
// access goes through this cast instead of `log.args as T`, which fails at
// the `.args` step, not the cast.
export function eventArgs<T>(log: unknown): T {
  return (log as { args: T }).args;
}
