import { PersonalAccessTokenAuth } from "../src/github/GitHubAuth";
import { GitHubClient } from "../src/github/GitHubClient";
import { GitObjectsApi } from "../src/github/GitObjectsApi";
import { GitHubRemoteRepository } from "../src/github/GitHubRemoteRepository";
import { remoteConformance } from "./fakes/conformance";
import { FakeGitHubServer } from "./fakes/FakeGitHubServer";
import { FakeRemoteRepository } from "./fakes/FakeRemoteRepository";

remoteConformance("in-memory fake", async () => new FakeRemoteRepository());

remoteConformance("GitHub (emulated API)", async () => {
  const server = new FakeGitHubServer();
  const client = new GitHubClient({ http: server, auth: new PersonalAccessTokenAuth(() => server.token), sleep: async () => undefined, minWriteIntervalMs: 0 });
  return new GitHubRemoteRepository(new GitObjectsApi(client, server.owner, server.repo), { branch: "main" });
});
