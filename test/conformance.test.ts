import { PersonalAccessTokenAuth } from "../src/github/GitHubAuth";
import { GitHubClient } from "../src/github/GitHubClient";
import { GitObjectsApi } from "../src/github/GitObjectsApi";
import { GitHubRemoteRepository } from "../src/github/GitHubRemoteRepository";
import { remoteConformance } from "./fakes/conformance";
import { FakeGitHubServer } from "./fakes/FakeGitHubServer";
import { FakeRemoteRepository } from "./fakes/FakeRemoteRepository";
import { MemoryBlobStore } from "./fakes/MemoryBlobStore";
import { ObjectStoreRepository } from "../src/store/ObjectStoreRepository";
import { crypto } from "./fakes/harness";

remoteConformance("in-memory fake", async () => new FakeRemoteRepository());

remoteConformance("GitHub (emulated API)", async () => {
  const server = new FakeGitHubServer();
  const client = new GitHubClient({ http: server, auth: new PersonalAccessTokenAuth(() => server.token), sleep: async () => undefined, minWriteIntervalMs: 0 });
  return new GitHubRemoteRepository(new GitObjectsApi(client, server.owner, server.repo), { branch: "main" });
});

remoteConformance("object store (in-memory)", async () => new ObjectStoreRepository(new MemoryBlobStore(), { crypto, skipProbe: true }));

remoteConformance("object store with non-atomic CAS (WebDAV-like)", async () => {
  const store = new MemoryBlobStore();
  store.casAtomic = false;
  return new ObjectStoreRepository(store, { crypto, verifyDelayMs: 0, sleep: async () => undefined });
});
