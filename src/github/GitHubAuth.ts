import { RemoteError } from "../errors/RemoteError";

/**
 * Authentication strategy. Version 1 ships fine-grained personal access tokens; GitHub App / OAuth device
 * flow can implement the same interface later.
 */
export interface AuthProvider {
  /** Value of the Authorization header. Must never be logged or included in errors. */
  authorizationHeader(): Promise<string>;
  /** Every string that must be redacted from any diagnostic output. */
  secrets(): string[];
}

export class PersonalAccessTokenAuth implements AuthProvider {
  constructor(private readonly getToken: () => string | null) {}

  async authorizationHeader(): Promise<string> {
    const token = this.getToken();
    if (!token) throw new RemoteError("Authentication");
    return `Bearer ${token}`;
  }

  secrets(): string[] {
    const token = this.getToken();
    return token ? [token] : [];
  }
}

/** Replaces any secret in a string (defense in depth for diagnostics). */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join("<redacted>");
  return out;
}
