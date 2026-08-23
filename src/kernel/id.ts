import { randomUUID } from "node:crypto";

export type IdFactory = (prefix: string) => string;

export function createId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
