/** Small runtime validation helpers for parsing untrusted JSON (remote config/manifest, local state). */

export class ValidationError extends Error {
  constructor(readonly field: string, reason: string) {
    super(`${field}: ${reason}`);
    this.name = "ValidationError";
  }
}

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function expectRecord(value: unknown, field: string): JsonRecord {
  if (!isRecord(value)) throw new ValidationError(field, "expected object");
  return value;
}

export function expectString(value: unknown, field: string, pattern?: RegExp): string {
  if (typeof value !== "string") throw new ValidationError(field, "expected string");
  if (pattern && !pattern.test(value)) throw new ValidationError(field, "invalid format");
  return value;
}

export function expectInteger(value: unknown, field: string, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new ValidationError(field, "expected integer");
  if (value < min || value > max) throw new ValidationError(field, "out of range");
  return value;
}

export function expectBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new ValidationError(field, "expected boolean");
  return value;
}

export function expectLiteral<T extends string | number | boolean>(value: unknown, expected: T, field: string): T {
  if (value !== expected) throw new ValidationError(field, "unexpected value");
  return expected;
}

export function expectArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new ValidationError(field, "expected array");
  return value;
}

export function optionalString(value: unknown, field: string, pattern?: RegExp): string | null {
  if (value === undefined || value === null) return null;
  return expectString(value, field, pattern);
}

/** Rejects unknown keys so manipulated/foreign data cannot smuggle fields through. */
export function expectOnlyKeys(record: JsonRecord, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new ValidationError(`${field}.${key}`, "unexpected field");
  }
}

export const HEX_32 = /^[0-9a-f]{32}$/;
export const HEX_64 = /^[0-9a-f]{64}$/;
export const GIT_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
export const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
