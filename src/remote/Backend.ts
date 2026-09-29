import type { CryptoProvider } from "../crypto/CryptoProvider";
import type { HttpClient } from "../net/HttpClient";
import type { Logger } from "../util/Logger";
import type { BackendKind, BackendLocation } from "./BackendLocation";
import type { Credentials, CredentialsFor } from "./Credentials";
import type { RemoteRepository } from "./RemoteRepository";

export interface BackendDeps {
  readonly http: HttpClient;
  readonly crypto: CryptoProvider;
  readonly logger: Logger;
}

/** What a location looks like from the outside (setup, move target check). */
export interface BackendCheck {
  /** "missing": the location does not exist (or the credentials cannot see it). */
  readonly access: "ok" | "missing";
  readonly writable: boolean;
  /** null if the backend has no notion of public/private (it is as private as its access control). */
  readonly isPrivate: boolean | null;
}

/**
 * One storage backend. main.ts builds everything through this registry; nothing outside a backend's own
 * folder knows its API.
 */
export interface BackendDescriptor<K extends BackendKind = BackendKind> {
  readonly kind: K;
  /** Human readable name ("GitHub"). */
  readonly label: string;
  build(location: Extract<BackendLocation, { kind: K }>, credentials: CredentialsFor<K>, deps: BackendDeps): RemoteRepository;
  check(location: Extract<BackendLocation, { kind: K }>, credentials: CredentialsFor<K>, deps: BackendDeps): Promise<BackendCheck>;
  /** Stored size in bytes as reported by the backend, if it can tell. */
  size?(location: Extract<BackendLocation, { kind: K }>, credentials: CredentialsFor<K>, deps: BackendDeps): Promise<number | null>;
  /** Creates a missing location (e.g. a private GitHub repository), if the backend supports it. */
  create?(location: Extract<BackendLocation, { kind: K }>, credentials: CredentialsFor<K>, deps: BackendDeps): Promise<void>;
}

const registry = new Map<BackendKind, BackendDescriptor>();

export function registerBackend<K extends BackendKind>(descriptor: BackendDescriptor<K>): void {
  registry.set(descriptor.kind, descriptor as unknown as BackendDescriptor);
}

export function backendFor(kind: BackendKind): BackendDescriptor {
  const descriptor = registry.get(kind);
  if (!descriptor) throw new Error(`backend ${kind} is not available`);
  return descriptor;
}

export function hasBackend(kind: BackendKind): boolean {
  return registry.has(kind);
}

/** Checks that credentials belong to the location's backend (a mismatch is a programming error). */
export function assertMatching(location: BackendLocation, credentials: Credentials): void {
  if (location.kind !== credentials.kind) throw new Error("credentials do not match the backend");
}
