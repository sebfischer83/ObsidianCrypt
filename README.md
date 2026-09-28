# Encrypted GitHub Sync for Obsidian

End-to-end encrypted synchronisation of an Obsidian vault with a GitHub repository – on Windows, macOS,
Linux, iOS and Android. Your vault stays a normal Obsidian vault; GitHub only ever receives encrypted
objects with random names.

> **Status:** Version 0.1 – core, GitHub backend and UI are implemented and covered by automated tests
> (see below). Manual testing on real iOS/Android devices (phase 7) is still outstanding.

## What GitHub can and cannot see

| GitHub **cannot** see | GitHub **can** see |
|---|---|
| File contents, file names, folder names | Number of encrypted objects and their approximate sizes |
| Folder structure, content hashes, timestamps inside the vault | When and how often objects change (commit times) |
| Your password, vault key or recovery key | Random device ids in commit messages |

Repository layout:

```
.vaultsync/config         public parameters (vault id, KDF parameters, wrapped keys, MAC)
.vaultsync/manifest.enc   encrypted mapping object id → path, size, hash
objects/<aa>/<id>         encrypted files (AES-256-GCM)
```

## Security model (short)

* Random 256-bit vault master key; your password protects it via **Argon2id** (64 MiB, t=3) – PBKDF2-SHA256
  (600 000 iterations, WebCrypto) is available as alternative. Changing the password re-wraps only the key.
* Optional **recovery key** (shown once, never stored).
* Every file and the manifest are encrypted with **AES-256-GCM**, fresh random nonce, AAD binds each object to
  its id and the vault. Manipulated data is rejected, never written into the vault.
* The GitHub token and (optionally) the vault key are kept in Obsidian's **SecretStorage** (OS keychain),
  never in `data.json` or the vault.
* No telemetry, no analytics, no network traffic except to `api.github.com`.

**If you lose both the password and the recovery key, your encrypted data cannot be recovered. There is no
backdoor.**

Details: [docs/DESIGN.md](docs/DESIGN.md).

## Disclosures

* **Network use:** the plugin talks only to the GitHub REST API (`https://api.github.com`) of the repository
  you configure. Everything it sends is encrypted, except the public parameters in `.vaultsync/config`
  (random vault id, key-derivation parameters, wrapped keys).
* **Account required:** a GitHub account and a repository you can write to.
* **No telemetry**, no analytics, no ads, no crash reports.
* **Files outside the vault:** none. Local sync state is stored in the plugin folder; the GitHub token and
  (optionally) the vault key are stored in Obsidian's secret storage (OS keychain).

## Installation

* **Beta via BRAT:** install the community plugin *BRAT*, run *“BRAT: Add a beta plugin for testing”* and
  enter `sebfischer83/ObsidianCrypt`.
* **Manually:** copy `main.js`, `manifest.json` and `styles.css` from the latest release into
  `<vault>/.obsidian/plugins/encrypted-github-sync/` and enable the plugin under *Community plugins*.

Requires Obsidian 1.11.4 or newer. Do not use a second sync tool for the same vault at the same time.

## Setup

1. Create an **empty private** repository on GitHub.
2. Create a **fine-grained personal access token**: *Repository access → Only select repositories →* your
   repository; *Permissions → Contents: Read and write* (Metadata: read is added automatically).
3. In Obsidian: *Settings → Encrypted GitHub Sync → Set up*, enter owner, repository, branch and token.
4. Choose a vault password (≥ 12 characters), review the summary (“2,381 files · 1.7 GB will be encrypted and
   uploaded”), store the recovery key.
5. On further devices: install the plugin, enter the same repository and token, then the vault password.
   Existing local files are merged; nothing is deleted during the first sync.

## Everyday use

* Syncs on startup, ~30 s after the last change, on app resume and optionally every 1–60 minutes.
* Commands: *Sync now*, *Pull from GitHub*, *Push to GitHub* (always pulls and merges first), *Show status*,
  *Show conflicts*, *Lock vault*, *Unlock vault*, *Change password*, *Show version history of current note*,
  *Restore deleted files*, *Show sync activity*, *Verify repository*.
* Status bar: `☁ Synced`, `☁ 4 pending`, `↻ Syncing`, `☁ Offline · 37 pending`, `⚠ 2 conflicts`, `⚠ Sync error`.
* **Conflicts** never lose data: if a note was changed on two devices, the remote version keeps the name and
  your version is saved as `Note (conflict 2026-09-26 1a2b3c4d).md`. Delete-vs-modify always keeps the
  modified version. Remote deletions move files to the vault’s `.trash` folder. *Compare* in the conflict list
  shows a line diff of both versions: keep the synced version, keep your copy (the discarded one goes to the
  trash, the replaced one stays in the version history) or open both side by side to merge manually.
* **Version history** for Markdown notes: *Version history* in the file menu or the command *Show version
  history of current note* lists earlier versions (setting *Versions per note*, 1–100, default 20), with
  preview, *Restore* and *Restore as copy*. Versions are decrypted from the encrypted GitHub history – one
  per sync that changed the note, from every device – so nothing extra is stored. Restoring never loses the
  current content: unsynced changes are synced first (or the restore is refused and a copy can be made).
* **Deleted files** (on any device) can be restored from the encrypted history: settings → *Deleted files* or
  the command *Restore deleted files*. The file comes back at its old path, or as `Name (restored).ext` if that
  name is taken – nothing is overwritten.
* **Sync activity**: a local log of which files each sync downloaded, uploaded, moved or deleted, plus restores
  and errors (status dialog → *Activity*). Stored only on this device.
* **Verify repository** downloads and decrypts every file on GitHub and checks it against the encrypted
  manifest (read-only; about one GitHub request per file).
* **Large files** (over 4 MB) are uploaded as encrypted 4 MB chunks; after a change only the changed chunks are
  uploaded again. Maximum file size is configurable up to 256 MB (default 50 MB).
* `.vaultsyncignore` (gitignore-like) excludes files before encryption. `.obsidian` sync is configurable
  (core settings on by default; plugins, themes/snippets and workspace separately).
* If the repository was manipulated (force-push, deleted branch, corrupted manifest, foreign vault, newer
  format) synchronisation stops and your local files are left untouched.

## Upgrading from 0.1.x

This version writes manifest format 2 on its first upload. Devices still running 0.1.x then stop syncing with
“The repository uses a newer format version. Please update the plugin.” – update the plugin on all devices.
No data is touched while a device is stopped.

## Limits

* Files larger than the configured maximum (default 50 MB, hard limit 256 MB) are skipped and reported. Large
  files are held in memory once while syncing, and every version stays in the repository history forever –
  keep an eye on the repository size (GitHub recommends staying below a few GB).
* Empty folders are not synchronised.
* Two files whose names differ only by upper/lower case cannot both be synchronised (case-insensitive
  file systems on Windows/macOS/iOS); the second one is reported and stays local.
* GitHub limits content-creating requests; a very large first upload is split into several commits and may
  take a while.

## Development

```bash
npm install
npm test          # unit, integration, security and randomised tests
npm run build     # typecheck (strict) + bundle to main.js
```

Test suites:

* `crypto.test.ts` – AES-GCM round trips, wrong key / manipulated ciphertext, tag and nonce, nonce uniqueness,
  Argon2id RFC 9106 vector, KDF downgrade protection, key wrapping, password change, recovery key, config MAC.
* `manifest.test.ts` – serialize → encrypt → decrypt → deserialize, strict validation.
* `sync.test.ts` – local/remote create, modify, delete, rename; conflicts; delete vs modify; concurrent pushes;
  tombstones; offline; failure injection at every commit step and during local apply; repository
  manipulation; password change and recovery.
* `security.test.ts` / `github.test.ts` – scans everything stored remotely and every request sent to the
  (emulated) GitHub API for plaintext contents, file and folder names.
* `history.test.ts` – version listing across devices and renames, restore (only when the current content is
  in the history), restore as copy, deleted versions, planted foreign objects, GitHub API requests.
* `chunks.test.ts` – chunked round trips, delta uploads, chunk cleanup on change/rename/delete, history of chunked
  files, swapped or corrupted chunks, malformed chunk indexes, chunk uploads over the GitHub API.
* `features.test.ts` – deleted-file restore, repository verification (corrupted/missing/orphaned objects),
  activity reporting and log, conflict resolution safety, line diff.
* `fuzz.test.ts` – randomised two-device sessions (optionally with crashes, restarts and network drops;
  each also with 3-byte chunks)
  checking that local content is never lost and that devices converge (`FUZZ_SEEDS=400 npm test`).
