import { describe, expect, it } from "vitest";
import { SyncEngine } from "../src/sync/SyncEngine";
import { Logger, type LogLevel } from "../src/util/Logger";
import { toBase64, utf8Encode } from "../src/util/bytes";
import { FakeRemoteRepository } from "./fakes/FakeRemoteRepository";
import { crypto, DEFAULT_FILTER, Device, PASSWORD } from "./fakes/harness";

/** Every representation in which a secret string might leak. */
export function leakForms(secret: string): Uint8Array[] {
  const forms = new Set<string>([secret, secret.normalize("NFC"), secret.normalize("NFD"), secret.toLowerCase()]);
  const out: Uint8Array[] = [];
  for (const s of forms) {
    out.push(utf8Encode(s));
    out.push(utf8Encode(JSON.stringify(s).slice(1, -1))); // JSON-escaped
    const utf16 = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) {
      utf16[i * 2] = s.charCodeAt(i) & 0xff;
      utf16[i * 2 + 1] = s.charCodeAt(i) >> 8;
    }
    out.push(utf16);
    // base64 of the secret at every byte alignment (first/last group mixes with unknown neighbours)
    for (let pad = 0; pad < 3; pad++) {
      const b64 = toBase64(utf8Encode("x".repeat(pad) + s)).slice(pad ? 4 : 0, -4);
      if (b64.length >= 12) out.push(utf8Encode(b64));
    }
  }
  return out;
}

export function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

export function findLeaks(stored: Uint8Array[], secrets: string[]): string[] {
  const leaks: string[] = [];
  for (const secret of secrets) {
    for (const form of leakForms(secret)) {
      if (stored.some((blob) => contains(blob, form))) {
        leaks.push(secret);
        break;
      }
    }
  }
  return leaks;
}

const SECRETS = [
  "SuperSecretNote",
  "Customer Müller",
  "Finanzen",
  "password123",
  "Privat",
  "Meine Passwörter",
  "Kunden",
  "Müller GmbH",
  "Insolvenz",
  "IBAN DE89370400440532013000",
];

async function populate(device: Device): Promise<void> {
  device.fs.setText("Privat/Meine Passwörter.md", "SuperSecretNote: password123");
  device.fs.setText("Kunden/Müller GmbH.md", "Customer Müller – Insolvenz – IBAN DE89370400440532013000");
  device.fs.setText("Finanzen/Übersicht.md", "Finanzen 2026");
  device.fs.setText(".obsidian/app.json", '{"note":"SuperSecretNote"}');
  device.fs.setBytes("Kunden/scan.pdf", utf8Encode("%PDF-1.7 Customer Müller"));
}

describe("no plaintext on the remote (§55, §59)", () => {
  it("contents, file names, folder names, commit messages and metadata are never stored in plaintext", async () => {
    const remote = new FakeRemoteRepository();
    const a = new Device(remote);
    await a.createVault();
    await populate(a);
    await a.sync();

    // Modifications, renames and deletions produce further commits – check them too.
    a.fs.move("Kunden/Müller GmbH.md", "Kunden/Archiv/Müller GmbH.md");
    a.store.recordRename("Kunden/Müller GmbH.md", "Kunden/Archiv/Müller GmbH.md");
    a.fs.setText("Finanzen/Übersicht.md", "Finanzen 2027 password123");
    a.fs.remove("Kunden/scan.pdf");
    await a.sync();

    const b = new Device(remote);
    await b.connect();
    await b.sync();
    expect(b.fs.text("Privat/Meine Passwörter.md")).toBe("SuperSecretNote: password123");

    const stored = remote.everythingStored();
    expect(findLeaks(stored, [...SECRETS, "Übersicht", "Archiv", "scan.pdf", PASSWORD])).toEqual([]);
    // Only the fixed layout is visible.
    for (const path of remote.headFiles()) {
      expect(path).toMatch(/^(\.vaultsync\/config|\.vaultsync\/manifest\.enc|objects\/[0-9a-f]{2}\/[0-9a-f]{32})$/);
    }
    for (const commit of remote.commits.values()) {
      expect(commit.message).toMatch(/^(Initialize encrypted vault|Encrypted vault sync: \d+ changes?)\n\nDevice: [0-9a-f-]+\n$/);
    }
  });

  it("the master key and the recovery key are never stored", async () => {
    const remote = new FakeRemoteRepository();
    const a = new Device(remote);
    const recoveryKey = (await a.createVault()) as string;
    a.fs.setText("x.md", "x");
    await a.sync();
    const mk = a.keys.exportMasterKey();
    const stored = remote.everythingStored();
    expect(stored.some((blob) => contains(blob, mk))).toBe(false);
    expect(findLeaks(stored, [toBase64(mk), recoveryKey, recoveryKey.replace(/-/g, "")])).toEqual([]);
  });

  it("logs never contain paths or contents", async () => {
    const remote = new FakeRemoteRepository();
    const a = new Device(remote);
    await a.createVault();
    await populate(a);
    const lines: string[] = [];
    const logger = new Logger({ write: (_l: LogLevel, message, fields) => lines.push(message + JSON.stringify(fields)) }, "debug");
    const engine = new SyncEngine({
      crypto,
      fs: a.fs,
      remote,
      store: a.store,
      getKeys: () => a.keys,
      filterSettings: DEFAULT_FILTER,
      deviceId: a.deviceId,
      logger,
    });
    await engine.sync();
    a.fs.setText("Privat/Meine Passwörter.md", "changed SuperSecretNote");
    remote.offline = true;
    await engine.sync().catch(() => undefined);
    remote.offline = false;
    await engine.sync();
    expect(lines.length).toBeGreaterThan(0);
    const all = [utf8Encode(lines.join("\n"))];
    expect(findLeaks(all, [...SECRETS, ".md"])).toEqual([]);
  });
});

describe("leak detector (positive control)", () => {
  it("finds plaintext in every encoding it claims to cover", () => {
    const secret = "Müller GmbH";
    const samples = [
      utf8Encode(`xx${secret}yy`),
      utf8Encode(`{"a":"${secret.normalize("NFD")}"}`),
      utf8Encode(`prefix ${toBase64(utf8Encode(`ab${secret}cd`))}`),
      utf8Encode(`z${toBase64(utf8Encode(secret))}`),
    ];
    for (const sample of samples) expect(findLeaks([sample], [secret])).toEqual([secret]);
    expect(findLeaks([crypto.randomBytes(4096)], [secret])).toEqual([]);
  });
});

describe("error display", () => {
  it("shows foreign error messages but never credentials", async () => {
    const { describeError } = await import("../src/errors/VaultSyncError");
    const token = "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz";
    const shown = describeError(new Error(`request failed: Authorization: Bearer ${token} / ${token} / ghp_abcdefghijklmnop123`), [token]);
    expect(shown).toContain("request failed");
    expect(shown).not.toContain(token);
    expect(shown).not.toContain("ghp_abcdefghijklmnop123");
    expect(describeError(new TypeError("x is undefined"))).toBe("Unexpected error (TypeError: x is undefined)");
  });
});
