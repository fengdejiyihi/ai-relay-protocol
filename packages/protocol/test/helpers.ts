import { readFileSync } from "node:fs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function example(name: string): any {
  return JSON.parse(readFileSync(new URL(`../../../examples/manifests/${name}`, import.meta.url), "utf8"));
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}
