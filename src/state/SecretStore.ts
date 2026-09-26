/**
 * Storage for secrets (GitHub token, optionally the vault master key). Production uses Obsidian's
 * SecretStorage (OS keychain backed). Secrets are never written to data.json or to the vault.
 */
export interface SecretStore {
  /** Whether secrets survive a restart (false → memory only, user must re-enter). */
  readonly persistent: boolean;
  get(id: string): string | null;
  set(id: string, value: string): void;
  delete(id: string): void;
}

const SECRET_ID = /^[a-z0-9-]+$/;

export function assertSecretId(id: string): void {
  if (!SECRET_ID.test(id)) throw new Error("Invalid secret id");
}

export class MemorySecretStore implements SecretStore {
  readonly persistent = false;
  private readonly values = new Map<string, string>();

  get(id: string): string | null {
    return this.values.get(id) ?? null;
  }

  set(id: string, value: string): void {
    assertSecretId(id);
    this.values.set(id, value);
  }

  delete(id: string): void {
    this.values.delete(id);
  }
}

/** Short, strictly lowercase-alphanumeric-with-dashes ids (Obsidian validates secret ids). */
export const SecretIds = {
  githubToken: (deviceId: string): string => `egsync-token-${deviceId.replace(/[^0-9a-f]/g, "").slice(0, 16)}`,
  masterKey: (vaultId: string): string => `egsync-mk-${vaultId.replace(/[^0-9a-f]/g, "").slice(0, 32)}`,
} as const;
