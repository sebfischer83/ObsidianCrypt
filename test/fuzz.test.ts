import { describe, expect, it } from "vitest";
import { Contexts, envelopeKind, EnvelopeKind, openEnvelope } from "../src/crypto/EncryptionFormat";
import { decodeChunkIndex } from "../src/sync/ChunkedContent";
import type { SyncLimits } from "../src/sync/SyncEngine";
import { concatBytes } from "../src/util/bytes";
import { crypto, twoDevices, twoDevicesOn, type Device } from "./fakes/harness";
import { CrashError, FakeRemoteRepository } from "./fakes/FakeRemoteRepository";
import { SyncError } from "../src/errors/SyncError";
import { followMove, moveVault } from "../src/sync/VaultMigration";
import { changeVaultPassword } from "../src/sync/VaultSetup";
import { RemoteError } from "../src/errors/RemoteError";
import { ObjectStoreRepository } from "../src/store/ObjectStoreRepository";
import { parseCommit, parseRoot, parseSub } from "../src/store/StoreRecords";
import { MemoryBlobStore, StoreCrash } from "./fakes/MemoryBlobStore";

/** Every commit's objects (object id → stored envelope) of a fake git remote. */
function fakeSnapshots(remote: FakeRemoteRepository): Array<Map<string, Uint8Array>> {
  return [...remote.commits.values()].map((commit) => {
    const objects = new Map<string, Uint8Array>();
    for (const [path, data] of commit.files) {
      const m = path.match(/^objects\/[0-9a-f]{2}\/([0-9a-f]{32})$/);
      if (m) objects.set(m[1] as string, data);
    }
    return objects;
  });
}

/** The same for an object store: every commit record, its root and subtrees. */
function storeSnapshots(store: MemoryBlobStore): Array<Map<string, Uint8Array>> {
  const out: Array<Map<string, Uint8Array>> = [];
  const get = (key: string): Uint8Array => (store.objects.get(key) as { bytes: Uint8Array }).bytes;
  for (const key of store.objects.keys()) {
    const m = key.match(/^commits\/[0-9a-f]{2}\/([0-9a-f]{64})$/);
    if (!m) continue;
    const commit = parseCommit(get(key), m[1] as string);
    const root = parseRoot(get(`trees/${commit.root.slice(0, 2)}/${commit.root}`));
    const objects = new Map<string, Uint8Array>();
    for (const [bucket, subId] of Object.entries(root.f)) {
      for (const [id, leaf] of Object.entries(parseSub(get(`trees/${subId.slice(0, 2)}/${subId}`), bucket).e)) {
        if (leaf.b) objects.set(id, get(`blobs/${leaf.b.slice(0, 2)}/${leaf.b}`));
      }
    }
    out.push(objects);
  }
  return out;
}

/** Every plaintext ever committed (recoverable from the history), chunked files reassembled. */
async function remoteHistory(remote: FakeRemoteRepository | ObjectStoreRepository, device: Device): Promise<Set<string>> {
  const out = new Set<string>();
  const open = (kind: EnvelopeKind, data: Uint8Array, context: string): Promise<Uint8Array> => openEnvelope(crypto, device.keys.objectKey, kind, data, context);
  const snapshots = remote instanceof FakeRemoteRepository ? fakeSnapshots(remote) : storeSnapshots(remote.store as MemoryBlobStore);
  for (const objects of snapshots) {
    const chunkIds = new Set<string>();
    const indexes: Array<ReturnType<typeof decodeChunkIndex>> = [];
    for (const [id, data] of objects) {
      if (envelopeKind(data) !== EnvelopeKind.ChunkIndex) continue;
      const chunks = decodeChunkIndex(await open(EnvelopeKind.ChunkIndex, data, Contexts.chunkIndex(device.keys.vaultId, id)));
      for (const c of chunks) chunkIds.add(c.id);
      indexes.push(chunks);
    }
    for (const chunks of indexes) {
      const parts = [];
      for (const c of chunks) parts.push(await open(EnvelopeKind.Object, objects.get(c.id) as Uint8Array, Contexts.object(device.keys.vaultId, c.id)));
      out.add(new TextDecoder().decode(concatBytes(...parts)));
    }
    for (const [id, data] of objects) {
      if (chunkIds.has(id) || envelopeKind(data) !== EnvelopeKind.Object) continue;
      out.add(new TextDecoder().decode(await open(EnvelopeKind.Object, data, Contexts.object(device.keys.vaultId, id))));
    }
  }
  return out;
}

/** Small deterministic PRNG (mulberry32). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ["a.md", "b.md", "c.md", "Dir/d.md", "Dir/e.md", "Other/f.md", "A.md"];

function randomOps(device: Device, rnd: () => number, label: string, counter: { n: number }): void {
  const steps = 1 + Math.floor(rnd() * 4);
  for (let i = 0; i < steps; i++) {
    const paths = device.fs.paths().filter((p) => !p.startsWith(".obsidian"));
    const op = rnd();
    const pick = (list: string[]): string | undefined => list[Math.floor(rnd() * list.length)];
    if (op < 0.35 || paths.length === 0) {
      const name = pick(NAMES) as string;
      device.fs.setText(name, `${label}-${counter.n++}`);
    } else if (op < 0.6) {
      const p = pick(paths) as string;
      device.fs.setText(p, `${label}-${counter.n++}`);
    } else if (op < 0.8) {
      const p = pick(paths) as string;
      device.fs.remove(p);
    } else {
      const from = pick(paths) as string;
      const to = pick(NAMES) as string;
      if (!(device.fs.paths().some((x) => x.toLowerCase() === to.toLowerCase()))) {
        device.fs.move(from, to);
        if (rnd() < 0.7) device.store.recordRename(from, to);
      }
    }
  }
}

/** All contents on a device including its trash. */
function contents(device: Device): Set<string> {
  const out = new Set(Object.values(device.fs.snapshot()));
  for (const t of device.fs.trashed) out.add(new TextDecoder().decode(t.data));
  return out;
}

async function syncChecked(device: Device, remote: FakeRemoteRepository | ObjectStoreRepository): Promise<void> {
  const before = new Set(Object.values(device.fs.snapshot()));
  await device.sync();
  const after = contents(device);
  const history = await remoteHistory(remote, device);
  // Invariant: local content is never destroyed. It is still in the vault, in the trash, or it had been
  // uploaded before and is recoverable from the version history.
  for (const c of before) expect(after.has(c) || history.has(c), `lost local content "${c}"`).toBe(true);
}

const VARIANTS: ReadonlyArray<{ label: string; limits: Partial<SyncLimits> }> = [
  { label: "", limits: {} },
  // Tiny chunks: most files become chunk indexes, exercising reuse/removal of chunks under every scenario.
  { label: " (chunked)", limits: { chunkSize: 3 } },
];

for (const variant of VARIANTS) {
describe(`randomised two-device sessions (no data loss, convergence)${variant.label}`, () => {
  const SEEDS = Number(fuzzSeeds() ?? 40);
  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`seed ${seed}`, async () => {
      const rnd = prng(seed);
      const { a, b, remote } = await twoDevices(variant.limits);
      const counter = { n: 0 };
      const everWritten = new Set<string>();
      for (let round = 0; round < 6; round++) {
        randomOps(a, rnd, "A", counter);
        randomOps(b, rnd, "B", counter);
        for (const c of Object.values(a.fs.snapshot())) everWritten.add(c);
        for (const c of Object.values(b.fs.snapshot())) everWritten.add(c);
        const order = rnd() < 0.5 ? [a, b] : [b, a];
        for (const d of order) {
          await syncChecked(d, remote);
          // Occasionally a key update (password / recovery key) right after a sync, as the plugin does it.
          if (rnd() < 0.15) await changeVaultPassword({ crypto, remote, store: d.store, keys: d.keys, deviceId: d.deviceId, newPassword: `password number ${counter.n++} long enough` });
        }
      }
      // Quiesce: after a few rounds without edits both devices are identical.
      for (let i = 0; i < 2; i++) {
        await syncChecked(a, remote);
        await syncChecked(b, remote);
      }
      expect(a.fs.snapshot()).toEqual(b.fs.snapshot());
      // No leftover pending changes.
      expect(await a.engine.countPendingChanges()).toBe(0);
      expect(await b.engine.countPendingChanges()).toBe(0);
    });
  }
});

describe(`randomised sessions with crashes, restarts and offline periods${variant.label}`, () => {
  const SEEDS = Number(fuzzSeeds() ?? 40);
  const points = ["afterBlobUpload", "afterTreeCreation", "afterCommitCreation", "beforeRefUpdate", "afterRefUpdate"] as const;
  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`seed ${seed}`, async () => {
      const rnd = prng(seed * 7919);
      const { a, b, remote } = await twoDevices(variant.limits);
      const counter = { n: 0 };
      const attempt = async (d: Device): Promise<void> => {
        const before = new Set(Object.values(d.fs.snapshot()));
        const r = rnd();
        if (r < 0.15) remote.crashAt = points[Math.floor(rnd() * points.length)] ?? null;
        else if (r < 0.25) remote.offline = true;
        else if (r < 0.32) {
          let reads = 0;
          remote.onReadObject = () => {
            if (++reads === 2) {
              remote.onReadObject = null;
              throw new RemoteError("Network");
            }
          };
        }
        try {
          await d.sync();
        } catch (error: unknown) {
          if (!(error instanceof CrashError) && !(error instanceof RemoteError)) throw error;
          if (error instanceof CrashError || rnd() < 0.5) await d.restart();
        } finally {
          remote.crashAt = null;
          remote.offline = false;
          remote.onReadObject = null;
        }
        const after = contents(d);
        const history = await remoteHistory(remote, d);
        for (const c of before) expect(after.has(c) || history.has(c), `lost local content "${c}"`).toBe(true);
      };
      for (let round = 0; round < 6; round++) {
        randomOps(a, rnd, "A", counter);
        randomOps(b, rnd, "B", counter);
        for (const d of rnd() < 0.5 ? [a, b] : [b, a]) await attempt(d);
      }
      for (let i = 0; i < 3; i++) {
        await syncChecked(a, remote);
        await syncChecked(b, remote);
      }
      expect(a.fs.snapshot()).toEqual(b.fs.snapshot());
      expect(await a.engine.countPendingChanges()).toBe(0);
    });
  }
});
}

/** FUZZ_SEEDS env var (the src tsconfig deliberately has no Node types). */
function fuzzSeeds(): string | undefined {
  return (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.FUZZ_SEEDS;
}

describe("randomised sessions with a vault move in the middle", () => {
  const SEEDS = Number(fuzzSeeds() ?? 40);
  const OLD = { kind: "github", owner: "alice", repo: "vault", branch: "main" } as const;
  const NEW = { kind: "github", owner: "alice", repo: "vault-2", branch: "main" } as const;
  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`seed ${seed}`, async () => {
      const rnd = prng(seed * 104729);
      const { a, b, remote } = await twoDevices(seed % 2 === 0 ? { chunkSize: 3 } : {});
      const target = new FakeRemoteRepository();
      const counter = { n: 0 };
      const moveRound = 1 + Math.floor(rnd() * 4);
      const history = async (d: Device): Promise<Set<string>> => new Set([...(await remoteHistory(remote, d)), ...(await remoteHistory(target, d))]);
      const step = async (d: Device): Promise<void> => {
        const before = new Set(Object.values(d.fs.snapshot()));
        try {
          await d.sync();
        } catch (error: unknown) {
          if (!(error instanceof SyncError) || error.blockReason !== "VaultMoved") throw error;
          await followMove({ crypto, keys: d.keys, store: d.store, deviceId: d.deviceId, sourceLocation: OLD, target });
          d.switchRemote(target);
          await d.sync();
        }
        const after = contents(d);
        const known = await history(d);
        for (const c of before) expect(after.has(c) || known.has(c), `lost local content "${c}"`).toBe(true);
      };
      for (let round = 0; round < 6; round++) {
        randomOps(a, rnd, "A", counter);
        randomOps(b, rnd, "B", counter);
        if (round === moveRound && a.remote === remote) {
          await step(a);
          await moveVault({ crypto, keys: a.keys, store: a.store, deviceId: a.deviceId, source: remote, sourceLocation: OLD, target, targetLocation: NEW, limits: { maxFilesPerCommit: 2 } });
          a.switchRemote(target);
        }
        for (const d of rnd() < 0.5 ? [a, b] : [b, a]) await step(d);
      }
      for (let i = 0; i < 3; i++) {
        await step(a);
        await step(b);
      }
      expect(b.remote).toBe(target);
      expect(a.fs.snapshot()).toEqual(b.fs.snapshot());
      expect(await a.engine.countPendingChanges()).toBe(0);
      expect(await b.engine.countPendingChanges()).toBe(0);
    });
  }
});

for (const chunked of [false, true]) {
  describe(`randomised sessions on the object store with faults at any write${chunked ? " (chunked)" : ""}`, () => {
    const SEEDS = Number(fuzzSeeds() ?? 40);
    const kinds = ["crashBefore", "crashAfter", "ambiguous"] as const;
    for (let seed = 1; seed <= SEEDS; seed++) {
      it(`seed ${seed}`, async () => {
        const rnd = prng(seed * 31337 + (chunked ? 1 : 0));
        const store = new MemoryBlobStore();
        const remote = new ObjectStoreRepository(store, { crypto, skipProbe: true, verifyDelayMs: 0, sleep: async () => undefined });
        const { a, b } = await twoDevicesOn(() => remote, chunked ? { chunkSize: 3 } : {});
        const counter = { n: 0 };
        const attempt = async (d: Device): Promise<void> => {
          const before = new Set(Object.values(d.fs.snapshot()));
          const r = rnd();
          if (r < 0.2) store.fault = { at: store.writeCount + 1 + Math.floor(rnd() * 12), kind: kinds[Math.floor(rnd() * kinds.length)] ?? "crashAfter" };
          else if (r < 0.3) store.offline = true;
          try {
            await d.sync();
            if (rnd() < 0.1) await changeVaultPassword({ crypto, remote, store: d.store, keys: d.keys, deviceId: d.deviceId, newPassword: `password number ${counter.n++} long enough` });
          } catch (error: unknown) {
            if (!(error instanceof StoreCrash) && !(error instanceof RemoteError) && !(error instanceof SyncError && error.code === "ConcurrentRemoteUpdate")) throw error;
            if (error instanceof StoreCrash || rnd() < 0.5) await d.restart();
          } finally {
            store.fault = null;
            store.offline = false;
          }
          const after = contents(d);
          const history = await remoteHistory(remote, d);
          for (const c of before) expect(after.has(c) || history.has(c), `lost local content "${c}"`).toBe(true);
        };
        for (let round = 0; round < 6; round++) {
          randomOps(a, rnd, "A", counter);
          randomOps(b, rnd, "B", counter);
          for (const d of rnd() < 0.5 ? [a, b] : [b, a]) await attempt(d);
        }
        for (let i = 0; i < 3; i++) {
          await syncChecked(a, remote);
          await syncChecked(b, remote);
        }
        expect(a.fs.snapshot()).toEqual(b.fs.snapshot());
        expect(await a.engine.countPendingChanges()).toBe(0);
        expect(await b.engine.countPendingChanges()).toBe(0);
      });
    }
  });
}
