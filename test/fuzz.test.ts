import { describe, expect, it } from "vitest";
import { Contexts, envelopeKind, EnvelopeKind, openEnvelope } from "../src/crypto/EncryptionFormat";
import { decodeChunkIndex } from "../src/sync/ChunkedContent";
import type { SyncLimits } from "../src/sync/SyncEngine";
import { concatBytes } from "../src/util/bytes";
import { crypto, twoDevices, type Device } from "./fakes/harness";
import { CrashError, type FakeRemoteRepository } from "./fakes/FakeRemoteRepository";
import { GitHubError } from "../src/errors/GitHubError";

/** Every plaintext ever committed (recoverable from the git history), chunked files reassembled. */
async function remoteHistory(remote: FakeRemoteRepository, device: Device): Promise<Set<string>> {
  const out = new Set<string>();
  const open = (kind: EnvelopeKind, data: Uint8Array, context: string): Promise<Uint8Array> => openEnvelope(crypto, device.keys.objectKey, kind, data, context);
  for (const commit of remote.commits.values()) {
    const objects = new Map<string, Uint8Array>();
    for (const [path, data] of commit.files) {
      const m = path.match(/^objects\/[0-9a-f]{2}\/([0-9a-f]{32})$/);
      if (m) objects.set(m[1] as string, data);
    }
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

async function syncChecked(device: Device, remote: FakeRemoteRepository): Promise<void> {
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
        for (const d of order) await syncChecked(d, remote);
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
              throw new GitHubError("Network");
            }
          };
        }
        try {
          await d.sync();
        } catch (error: unknown) {
          if (!(error instanceof CrashError) && !(error instanceof GitHubError)) throw error;
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
