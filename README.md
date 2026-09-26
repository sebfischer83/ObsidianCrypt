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
  *Show conflicts*, *Lock vault*, *Unlock vault*, *Change password*.
* Status bar: `☁ Synced`, `☁ 4 pending`, `↻ Syncing`, `☁ Offline · 37 pending`, `⚠ 2 conflicts`, `⚠ Sync error`.
* **Conflicts** never lose data: if a note was changed on two devices, the remote version keeps the name and
  your version is saved as `Note (conflict 2026-09-26 1a2b3c4d).md`. Delete-vs-modify always keeps the
  modified version. Remote deletions move files to the vault’s `.trash` folder.
* `.vaultsyncignore` (gitignore-like) excludes files before encryption. `.obsidian` sync is configurable
  (core settings on by default; plugins, themes/snippets and workspace separately).
* If the repository was manipulated (force-push, deleted branch, corrupted manifest, foreign vault, newer
  format) synchronisation stops and your local files are left untouched.

## Limits (v1)

* Files larger than the configured maximum (default 50 MB, hard limit 72 MB because of GitHub’s API limits)
  are skipped and reported.
* Empty folders are not synchronised.
* Two files whose names differ only by upper/lower case cannot both be synchronised (case-insensitive
  file systems on Windows/macOS/iOS); the second one is reported and stays local.
* GitHub limits content-creating requests; a very large first upload is split into several commits and may
  take a while.

## Development

```bash
npm install
npm test          # 200+ unit, integration, security and randomised tests
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
* `fuzz.test.ts` – randomised two-device sessions (optionally with crashes, restarts and network drops)
  checking that local content is never lost and that devices converge (`FUZZ_SEEDS=400 npm test`).
