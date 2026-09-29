<div align="center">

# 🔐 Encrypted GitHub Sync for Obsidian

**End-to-end encrypted sync of your Obsidian vault – your notes never leave your device unencrypted.**

[![Release](https://img.shields.io/github/v/release/sebfischer83/ObsidianCrypt?label=release)](https://github.com/sebfischer83/ObsidianCrypt/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20iOS%20%7C%20Android-6c5ce7)
![Encryption](https://img.shields.io/badge/encryption-AES--256--GCM%20%2B%20Argon2id-2d9d5b)
![Tests](https://img.shields.io/badge/tests-2%2C200%2B%20incl.%20fuzzing-2d9d5b)

</div>

Your vault stays a normal Obsidian vault on every device. Before anything is uploaded, contents, **file names and
folder names** are encrypted on your device. GitHub only ever stores encrypted objects with random names – it never
sees what you write, what your notes are called or how your vault is organised.

> **Status: beta.** Everything below is implemented and covered by automated tests (unit, integration, a GitHub API
> emulator, security scans and randomised multi-device sessions). Manual testing on real iOS/Android devices is still
> in progress – keep a backup of your vault while trying it out.

---

## Contents

- [Highlights](#-highlights)
- [How it works](#-how-it-works)
- [What GitHub can and cannot see](#-what-github-can-and-cannot-see)
- [Installation](#-installation)
- [Setup](#-setup)
- [Everyday use](#-everyday-use)
- [Features in detail](#-features-in-detail)
- [Security](#-security)
- [Limits](#-limits)
- [Roadmap: more storage backends](#-roadmap-more-storage-backends)
- [FAQ](#-faq)
- [Development](#-development)

---

## ✨ Highlights

- 🔒 **Zero-knowledge encryption** – AES-256-GCM for every file and the file list, keys derived with Argon2id.
- 🙈 **Names are hidden too** – no file names, folder names or paths ever reach GitHub.
- 🛟 **Data-loss-first design** – nothing is ever overwritten or deleted without the previous state being recoverable;
  conflicts keep both versions; remote deletions go to the trash.
- 🕰️ **Version history** – restore any earlier version of a note, from any device.
- 🗑️ **Restore deleted files** – even ones deleted on another device, weeks ago.
- ⚔️ **Conflict resolution with diff** – compare both versions side by side and decide.
- 📦 **Large files** – up to 256 MB, uploaded as encrypted chunks; only changed chunks are re-uploaded.
- 🧭 **Sync status in the file explorer** – see at a glance what is pending, conflicting or excluded.
- 🔍 **Verify repository** – check that every file on GitHub decrypts correctly.
- 🚚 **Move to a fresh repository** – shrink an ever-growing history without deleting anything.
- 📱 **Desktop and mobile** – Windows, macOS, Linux, iOS and Android, no external tools, no git installation.
- 🚫 **No servers, no telemetry** – the plugin talks only to the GitHub API of the repository you choose.

---

## ⚙️ How it works

```
 Your device                                             GitHub (private repository)
┌──────────────────────────────┐                        ┌──────────────────────────────────┐
│ Notes/Projects/Plan.md       │   encrypt locally      │ .vaultsync/config   (public      │
│ Journal/2026-09-28.md        │  ───────────────────►  │                      parameters) │
│ Attachments/photo.jpg        │   AES-256-GCM          │ .vaultsync/manifest.enc          │
│                              │                        │ objects/3a/3a9f…c1   (encrypted) │
│ your password ─► Argon2id    │  ◄───────────────────  │ objects/b7/b70e…42   (encrypted) │
│             ─► vault key     │   verify + decrypt     │ …                                │
└──────────────────────────────┘                        └──────────────────────────────────┘
```

- A random **256-bit vault key** encrypts everything. Your **password** (via Argon2id) and an optional
  **recovery key** unlock it; the vault key itself never leaves your devices unencrypted.
- The **manifest** (the encrypted list of files) maps random object ids to paths and content hashes.
- Every sync is a **git commit** made through the GitHub API. The branch is only ever fast-forwarded (never
  force-pushed), so two devices pushing at once can never overwrite each other – the second one merges and retries.
- A **three-way merge** (common base, local, remote) decides what changed where. When both sides changed the same
  note, both versions are kept.

---

## 👀 What GitHub can and cannot see

| GitHub **cannot** see | GitHub **can** see |
|---|---|
| File contents | That this repository holds an encrypted vault |
| File names, folder names, folder structure | How many encrypted objects there are and their approximate sizes |
| Content hashes, timestamps inside the vault | When and how often objects change (commit times) |
| Your password, vault key or recovery key | Random device ids in commit messages |

Repository layout:

```
.vaultsync/config         public parameters (vault id, key-derivation parameters, wrapped keys, MAC)
.vaultsync/manifest.enc   encrypted mapping: object id → path, size, content hash
objects/<aa>/<id>         encrypted files (and encrypted chunks of large files)
```

---

## 📥 Installation

**Beta via BRAT (recommended):**

1. Install the community plugin **BRAT**.
2. Run *“BRAT: Add a beta plugin for testing”* and enter `sebfischer83/ObsidianCrypt`.
3. Enable **Encrypted GitHub Sync** under *Settings → Community plugins*.

**Manually:** download `main.js`, `manifest.json` and `styles.css` from the
[latest release](https://github.com/sebfischer83/ObsidianCrypt/releases/latest) into
`<vault>/.obsidian/plugins/encrypted-github-sync/` and enable the plugin.

Requires **Obsidian 1.11.4** or newer. Don't sync the same vault with a second sync tool at the same time.

---

## 🚀 Setup

1. **Create an empty private repository** on GitHub.
2. **Create a fine-grained personal access token:** *Repository access → Only select repositories →* your repository;
   *Permissions → Contents: Read and write* (Metadata: read is added automatically).
3. In Obsidian open *Settings → Encrypted GitHub Sync → Set up* and enter owner, repository, branch and token.
4. **Choose a vault password** (at least 12 characters – a long passphrase is best). Review the summary
   (“2,381 files · 1.7 GB will be encrypted and uploaded”) and **store the recovery key** somewhere safe.
5. **On every further device:** install the plugin, enter the same repository and a token, then the vault password.
   Existing local files are merged – nothing is deleted during the first sync.

> ⚠️ **If you lose both the password and the recovery key, your data cannot be recovered – by anyone.** There is no
> backdoor, by design.

---

## 🗓️ Everyday use

Sync runs on its own: on startup, about 30 seconds after your last change, when the app comes back to the foreground
and – if you like – every 1–60 minutes.

| Status bar | Meaning |
|---|---|
| `☁ Synced` | Everything is up to date |
| `☁ 4 pending` | Local changes waiting for the next sync |
| `↻ Syncing` | A sync is running |
| `☁ Offline · 37 pending` | No connection; changes are kept and synced later |
| `⚠ 2 conflicts` | Two devices changed the same note – both versions are kept |

On mobile, where Obsidian has no status bar, the ribbon icon shows the state and opens the status dialog.

**Commands** (command palette): *Sync now* · *Pull remote changes* · *Push local changes* (always merges first) · *Show status* · *Show conflicts* · *Show sync activity* ·
*Show version history of current note* · *Restore deleted files* · *Verify repository* ·
*Move vault to a new repository* · *Lock vault* · *Unlock vault* · *Change password* · *Set up / connect repository*

---

## 🧩 Features in detail

<details>
<summary><b>⚔️ Conflicts – never lose a version</b></summary>

- If a note was changed on two devices, the remote version keeps the name and yours is saved as
  `Note (conflict 2026-09-26 1a2b3c4d).md`.
- Changed on one device, deleted on the other? The changed version always survives.
- **Compare** in the conflict list shows a line diff. Keep the synced version, keep your copy, or open both side by
  side and merge by hand. A discarded copy goes to the vault trash; a replaced version stays in the history.
</details>

<details>
<summary><b>🕰️ Version history</b></summary>

- *Version history* in a note's file menu (or the command) lists earlier versions – one per sync that changed the note,
  from every device. Configurable: 1–100 versions (default 20).
- Preview with a diff against the current note, **Restore** or **Restore as copy**.
- Versions come straight from the encrypted repository history – nothing extra is stored anywhere.
- Restoring never loses the current content: unsynced changes are synced first, otherwise the restore is refused.
</details>

<details>
<summary><b>🗑️ Deleted files</b></summary>

- *Restore deleted files* lists files deleted on any device, most recent first, with preview and filter.
- A file comes back at its old path, or as `Name (restored).ext` if that name is taken – nothing is overwritten.
</details>

<details>
<summary><b>📦 Large files</b></summary>

- Files over 4 MB are split into encrypted 4 MB chunks with random ids; after a change only the changed chunks are
  uploaded.
- The maximum file size is configurable up to 256 MB (default 50 MB). Larger files are skipped and reported – never
  treated as deleted.
</details>

<details>
<summary><b>🧭 Sync status in the file explorer</b></summary>

`●` not synchronised yet · `⚠` conflict · `⊘` too large or unreadable · `◌` excluded by ignore rules.
Folders show the most important mark of their contents. Can be turned off in the settings.
</details>

<details>
<summary><b>📜 Sync activity</b></summary>

A local log of what each sync did – which files were downloaded, uploaded, moved or deleted, plus restores and errors.
Stored only on this device (status dialog → *Activity*).
</details>

<details>
<summary><b>🔍 Verify repository</b></summary>

Downloads and decrypts every file in the repository and checks it against the encrypted manifest. Read-only; reports
missing or corrupted files by name. Needs about one GitHub request per file.
</details>

<details>
<summary><b>🚚 Repository size &amp; moving to a new repository</b></summary>

- Git keeps every version forever, so a repository only grows. The settings show its size and hint above 1 GB.
- *Move vault to a new repository* copies the current state of all files – verified and re-encrypted – into a new,
  empty private repository (it can be created for you) and continues there.
- Nothing is deleted: the old repository stays as an archive, and version history and deleted files still reach into it.
- Other devices stop syncing with the old repository and offer *Switch to new repository*; their unsynchronised
  changes are kept. An interrupted move continues where it stopped.
</details>

<details>
<summary><b>🙈 Ignore rules &amp; <code>.obsidian</code></b></summary>

- `.vaultsyncignore` (gitignore-like syntax) excludes files before anything is encrypted. The file itself is synced.
- Syncing the `.obsidian` folder is configurable: core settings (on by default), community plugins, themes & snippets
  and the workspace layout separately. The plugin never syncs its own folder.
</details>

---

## 🛡️ Security

- **Cryptography:** AES-256-GCM with a fresh random nonce per encryption; every ciphertext is bound (as associated data)
  to its kind, the vault and its object id, so objects can't be swapped or replayed. Keys are separated with HKDF.
- **Password:** Argon2id (64 MiB, 3 iterations) – PBKDF2-SHA256 (600 000 iterations) as an alternative. Weakened
  parameters in a manipulated repository are rejected.
- **Integrity:** every download is authenticated and checked against the encrypted manifest before a single byte is
  written. Chunks are verified individually and as a whole file.
- **Rollback protection:** each manifest is bound to its parent commit and to the public config, versions must
  increase, and history is followed through the encrypted parent links rather than by trusting GitHub's answers. A
  force-push, deleted branch or replayed old state stops the sync – your local files stay untouched.
- **Secrets:** the GitHub token and (optionally, “remember on this device”) the vault key live in Obsidian's
  SecretStorage (OS keychain) – never in `data.json`, never in the vault, never in logs.
- **Password changes do not revoke old secrets:** older commits still contain the old key slots. Keep the repository
  private; after a leak, move the vault to a new repository and delete the old one.
- **Reviewed:** a four-part security review (cryptography, malicious repository, secret leaks, local data integrity)
  and the resulting fixes are documented in [docs/DESIGN.md §12](docs/DESIGN.md).

**Disclosures:** network access only to `https://api.github.com` for the repository you configure · a GitHub account
is required · no telemetry, analytics, ads or crash reports · no files outside the vault (local sync state lives in the
plugin folder).

Full design, threat model and data-loss analysis: **[docs/DESIGN.md](docs/DESIGN.md)**.

---

## 📏 Limits

- Files larger than the configured maximum (hard limit 256 MB) are skipped and reported. Large files are held in memory
  once while syncing.
- Every version stays in the repository history forever – keep an eye on the size (GitHub recommends staying below a
  few GB) and move to a fresh repository when needed.
- Empty folders are not synchronised.
- Two files whose names differ only in upper/lower case cannot both be synchronised (case-insensitive file systems on
  Windows, macOS and iOS); the second one is reported and stays local.
- All devices should run the same plugin version; an older version stops with “please update the plugin” and leaves
  its files untouched.

---

## 🗺️ Roadmap: more storage backends

Next up: **S3-compatible storage** (AWS S3, Cloudflare R2, MinIO, …) and **WebDAV** (Nextcloud, NAS, …) with the same
features as GitHub – including version history, deleted files and moving between backends. The groundwork (a
backend-neutral storage layer and a shared conformance test suite) is in place; the plan is in
[docs/DESIGN.md §13](docs/DESIGN.md).

---

## ❓ FAQ

<details>
<summary><b>I forgot my password.</b></summary>

Unlock with your recovery key and set a new password. Without password *and* recovery key the data is gone – that's
the point of end-to-end encryption.
</details>

<details>
<summary><b>Can I use it together with Obsidian Sync, iCloud or Dropbox?</b></summary>

Not for the same vault at the same time – two sync tools fighting over the same files is the classic way to create
duplicates. Pick one.
</details>

<details>
<summary><b>Is a public repository OK?</b></summary>

Contents and names stay encrypted, but anyone could download the encrypted data and see metadata (number of files,
approximate sizes, change times). Use a private repository.
</details>

<details>
<summary><b>What happens if someone manipulates the repository?</b></summary>

Tampered or replayed data fails authentication and the sync stops with an explanation. Nothing is written into your
vault. Someone with write access but without your key can at most block syncing – not read or change your notes.
</details>

<details>
<summary><b>What if a sync is interrupted – app closed, phone offline, battery dead?</b></summary>

Every step is crash-safe: local changes are applied from a write-ahead journal, commits only count once the branch has
moved, and the next sync finishes or repeats whatever was interrupted.
</details>

---

## 🛠️ Development

```bash
npm install
npm test               # unit, integration, security and randomised tests
FUZZ_SEEDS=400 npm test  # longer randomised multi-device sessions
npm run build          # strict typecheck + bundle to main.js
```

The sync engine is independent of Obsidian and runs completely in tests against an in-memory file system and fake
remotes. Highlights of the test suite:

| Suite | Covers |
|---|---|
| `crypto` | AES-GCM round trips, tampering, nonce uniqueness, Argon2id RFC 9106 vector, KDF downgrade, key wrapping, recovery key |
| `sync` | Create/modify/delete/rename on both sides, conflicts, concurrent pushes, crashes at every commit step, replay and rollback attacks, key updates |
| `conformance` | The contract every storage backend must fulfil (snapshots, compare-and-swap, history) |
| `security` / `github` | Scans everything stored remotely and every request sent for plaintext (UTF-8, UTF-16, Base64, …) |
| `history` · `chunks` · `features` · `migration` | Version history, large files, deleted files, verification, activity log, conflict resolution, vault moves |
| `fuzz` | Randomised two-device sessions with crashes, restarts, network drops, tiny chunks, key updates and vault moves – no content may ever be lost and devices must converge |

Architecture, formats and every data-loss scenario with its countermeasure: [docs/DESIGN.md](docs/DESIGN.md).

---

<div align="center">

MIT License · made by [Sebastian Fischer](https://github.com/sebfischer83)

</div>
