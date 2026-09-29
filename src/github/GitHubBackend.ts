import type { BackendDeps, BackendDescriptor } from "../remote/Backend";
import type { GitHubLocation } from "../remote/BackendLocation";
import type { CredentialsFor } from "../remote/Credentials";
import { PersonalAccessTokenAuth } from "./GitHubAuth";
import { GitHubClient } from "./GitHubClient";
import { GitObjectsApi } from "./GitObjectsApi";
import { GitHubRemoteRepository } from "./GitHubRemoteRepository";

export function gitHubApi(location: GitHubLocation, credentials: CredentialsFor<"github">, deps: BackendDeps): GitObjectsApi {
  const client = new GitHubClient({ http: deps.http, auth: new PersonalAccessTokenAuth(() => credentials.token), logger: deps.logger });
  return new GitObjectsApi(client, location.owner, location.repo);
}

export const gitHubBackend: BackendDescriptor<"github"> = {
  kind: "github",
  label: "GitHub",
  build: (location, credentials, deps) => new GitHubRemoteRepository(gitHubApi(location, credentials, deps), { branch: location.branch }),
  async check(location, credentials, deps) {
    const repo = await gitHubApi(location, credentials, deps).getRepository();
    return repo.exists ? { access: "ok", writable: repo.canPush, isPrivate: repo.isPrivate } : { access: "missing", writable: false, isPrivate: null };
  },
  size: async (location, credentials, deps) => (await gitHubApi(location, credentials, deps).getRepository()).sizeBytes,
  create: (location, credentials, deps) => gitHubApi(location, credentials, deps).createPrivateRepository(),
};
