# Encrypted GitHub Sync – Design

Status: Manifest-formatVersion 2 (große Dateien als Chunks, §2.5); Config-formatVersion 1. Dieses Dokument deckt die Punkte 1–7 aus Abschnitt 65 des
Anforderungsprofils ab. Leitprinzip: **Ein Synchronisationsfehler darf unbequem sein. Ein Datenverlust
oder Klartext-Leak darf nicht passieren.**

---

## 1. Architekturübersicht

```
┌──────────────────────────── Obsidian (UI-Schicht, src/ui, src/main.ts) ─────────────────────────────┐
│ SettingsTab · SetupWizard · StatusBar · ConflictView · Commands · SyncController (Trigger/Debounce) │
└───────────────────────────────────────────────┬─────────────────────────────────────────────────────┘
                                                │ nur über Interfaces
┌───────────────────────────────────────────────▼─────────────────────────────────────────────────────┐
│ SyncEngine (src/sync)  ── deterministischer Ablauf, SyncMutex                                        │
│   ChangeDetector ─ SyncPlanner (3-Wege-Merge) ─ ConflictNaming ─ Journal/Recovery                   │
└───────┬───────────────────────┬───────────────────────────┬─────────────────────────┬───────────────┘
        │ LocalFileSystem       │ EncryptionEngine          │ RemoteRepository        │ StateRepository
┌───────▼─────────┐   ┌─────────▼──────────────┐   ┌────────▼──────────────┐  ┌───────▼────────────┐
│ src/vault       │   │ src/crypto             │   │ src/github            │  │ src/state          │
│ VaultScanner    │   │ WebCryptoProvider      │   │ GitHubRemoteRepository│  │ FileStateRepository│
│ VaultWriter     │   │ KeyDerivation(Argon2id)│   │ GitObjectsApi         │  │ SecretStore        │
│ IgnoreMatcher   │   │ KeyManager / Envelope  │   │ GitHubClient (HTTP)   │  │ (Obsidian keychain)│
│ ObsidianFS      │   │ → EncryptedBlob (brand)│   │ akzeptiert NUR        │  └────────────────────┘
└─────────────────┘   └────────────────────────┘   │ EncryptedBlob/Config  │
                                                   └───────────────────────┘
```

Grundregeln:

* Kein Modul außerhalb von `src/ui` und `src/main.ts` importiert `obsidian`. Obsidian-Adapter
  (`ObsidianFileSystem`, `ObsidianHttpClient`, `ObsidianSecretStore`, `FileStateRepository`) sind dünne
  Implementierungen der Interfaces. Die Sync-Engine ist komplett ohne Obsidian testbar.
* Keine Node-/Electron-APIs (`fs`, `child_process`, `crypto`, `Buffer`, …). esbuild baut mit
  `platform: browser`; ein versehentlicher Node-Import bricht den Build.
* Kryptographie ausschließlich über WebCrypto (AES-256-GCM, SHA-256, HKDF, HMAC, PBKDF2) und
  `@noble/hashes` (Argon2id). Keine eigene Crypto-Primitive.
* Upload-Pfad: `LocalFileSystem.read → EncryptionEngine.encryptObject → EncryptedBlob → RemoteRepository`.
  `RemoteRepository.createCommit` akzeptiert nur `EncryptedBlob` (Brand-Typ, nur im Crypto-Modul
  konstruierbar) und `PublicVaultConfig`. Zusätzlich prüft die Remote-Schicht zur Laufzeit jedes Byte-
  Objekt auf den Envelope-Header (Defense in Depth). Pfade auf GitHub werden ausschließlich aus
  validierten Object-IDs (32 Hex-Zeichen) berechnet – die Remote-Schicht kennt keine Vault-Pfade.

### Plattform-Abstraktionen

| Interface          | Produktion                          | Tests                     |
|--------------------|-------------------------------------|---------------------------|
| `CryptoProvider`   | `WebCryptoProvider`                 | derselbe (Node 24 WebCrypto) |
| `LocalFileSystem`  | `ObsidianFileSystem` (Vault/Adapter)| `MemoryFileSystem`        |
| `RemoteRepository` | `GitHubRemoteRepository`            | `FakeRemoteRepository`, GitHub-Emulator |
| `HttpClient`       | `ObsidianHttpClient` (`requestUrl`) | `FakeGitHubServer`        |
| `StateRepository`  | `FileStateRepository` (Plugin-Ordner)| `MemoryStateRepository`  |
| `SecretStore`      | `ObsidianSecretStore` (`app.secretStorage`) | `MemorySecretStore` |
| `AuthProvider`     | `PersonalAccessTokenAuth`           | –                         |

---

## 2. Remote-Dateiformat

### 2.1 Repository-Layout

```
.vaultsync/config          JSON, Klartext, NICHT geheim, MAC-geschützt
.vaultsync/manifest.enc    verschlüsseltes Manifest (Envelope, kind=manifest)
objects/<aa>/<id>          verschlüsselte Objekte; <id> = 32 Hex-Zeichen (128 bit zufällig), <aa> = erste 2
                           (auch Chunks großer Dateien: eigene zufällige IDs im selben Namensraum)
```

Keine weiteren Dateien. Commit-Messages: `Encrypted vault sync: <n> changes` mit Trailer
`Device: <deviceId>` (zufällige UUID, keine personenbezogenen Daten). Keine Pfade/Dateinamen.

### 2.2 Envelope (binär, alle verschlüsselten Daten)

| Offset | Länge | Feld                                               |
|-------:|------:|----------------------------------------------------|
| 0      | 4     | Magic `OVSE` (0x4F 0x56 0x53 0x45)                 |
| 4      | 1     | Envelope-Version = 1                               |
| 5      | 1     | Algorithmus: 1 = AES-256-GCM                       |
| 6      | 1     | Kind: 1 = Objekt/Chunk, 2 = Manifest, 3 = Key-Slot, 4 = Chunk-Index |
| 7      | 1     | reserviert = 0                                     |
| 8      | 12    | Nonce (96 bit, CSPRNG, pro Verschlüsselung neu)    |
| 20     | n     | Ciphertext                                         |
| 20+n   | 16    | GCM Authentication Tag                             |

AAD = `header[0..20) ‖ UTF-8(context)`. Der Kontext wird beim Entschlüsseln rekonstruiert und
nicht gespeichert:

* Objekt: `ovs/v1/object/<vaultId>/<objectId>` → verhindert das Vertauschen von Objekten.
* Chunk (großer Dateien): wie Objekt, mit der Chunk-ID.
* Chunk-Index: `ovs/v1/chunks/<vaultId>/<objectId>` (Kind 4).
* Manifest: `ovs/v1/manifest/<vaultId>`
* Key-Slot: `ovs/v1/keyslot/<vaultId>/<slotId>/<kanonisches KDF-JSON>` → Manipulation der
  KDF-Parameter führt zu Authentisierungsfehler.

Unbekannte Magic/Version/Algorithmus/Kind → `CryptoError(UnsupportedFormat)`; niemals Fallback.
Nach dem Entschlüsseln eines Objekts wird zusätzlich SHA-256 des Klartexts gegen `contentHash` aus dem
Manifest geprüft (bindet Objektversion an Manifestversion).

### 2.3 Armored-Form (nur GitHub-Transport)

GitHub begrenzt "content-creating requests" (sekundäres Rate-Limit ~80/min, ~500/h). Um nicht pro Datei
einen Blob-Request zu benötigen, werden Envelopes ≤ 512 KiB als ASCII-Text `OVSA1:<base64(envelope)>`
direkt im `POST /git/trees` (Feld `content`) gebündelt hochgeladen (bis ~8 MiB pro Request). Größere
Objekte gehen binär über `POST /git/blobs`. Beim Lesen erkennt die Remote-Schicht beide Formen und
liefert immer die binären Envelope-Bytes. Armoring ist reine Transportcodierung ohne Sicherheitsfunktion.

### 2.4 `.vaultsync/config` (öffentlich)

```json
{
  "type": "obsidian-encrypted-sync",
  "formatVersion": 2,
  "vaultId": "9f2c…(32 hex)",
  "encryption": { "algorithm": "AES-256-GCM", "version": 1 },
  "keyDerivation": { "algorithm": "HKDF-SHA256", "version": 1 },
  "keySlots": [
    { "id": "password", "type": "password",
      "kdf": { "algorithm": "argon2id", "version": 19, "salt": "<b64 16B>",
               "memoryKiB": 65536, "iterations": 3, "parallelism": 1 },
      "wrappedKey": "<b64 Envelope kind=3>" },
    { "id": "recovery", "type": "recovery",
      "kdf": { "algorithm": "hkdf-sha256", "salt": "<b64 16B>" },
      "wrappedKey": "<b64 Envelope kind=3>" }
  ],
  "mac": "<b64 HMAC-SHA256(configMacKey, kanonisches JSON ohne mac)>"
}
```

Unbekannte `formatVersion` (> unterstützt) → Sync stoppt, keine Schreibzugriffe (weder lokal noch remote).

---

### 2.5 Große Dateien: Chunks (Manifest-formatVersion 2)

Dateien > 4 MiB (`SyncLimits.chunkSize`) werden in Stücke fester Größe zerlegt. Jedes Stück ist ein normales
Objekt (Kind 1) mit eigener zufälliger ID; unter der Object-ID der Datei liegt ein verschlüsselter Chunk-Index
(Kind 4): kanonisches JSON `{"type":"obsidian-encrypted-sync-chunks","chunks":[{"id","size","hash"}…]}`
(hash = SHA-256 des Chunk-Klartexts). Das Manifest-Feld `chunks: n` markiert solche Einträge.

| Entscheidung | Optionen | Umgesetzt / Begründung |
|---|---|---|
| Zerlegung | feste Größe · inhaltsdefiniert (FastCDC) | **feste Größe**: CDC-Grenzen hängen vom Inhalt ab und verraten über die Chunk-Größen etwas über ihn (Fingerprinting); feste Größen verraten nur die Gesamtgröße, die ohnehin sichtbar ist. Nachteil: Einfügen am Anfang ändert alle folgenden Chunks. |
| Chunk-IDs | zufällig · aus Inhalt abgeleitet (konvergent/HMAC) | **zufällig**: abgeleitete IDs würden gleiche Inhalte über Dateien hinweg für GitHub erkennbar machen. Wiederverwendung nur innerhalb derselben Datei: ein Chunk mit gleichem Hash an gleicher Position wird nicht erneut hochgeladen. |
| Format | Umstellung bei Bedarf · sofort | **sofort** (Entscheidung des Nutzers): jedes neue Manifest hat `formatVersion: 2`. Ältere Plugin-Versionen stoppen mit „UnknownFormatVersion“ statt Chunk-Indizes falsch zu lesen. formatVersion-1-Manifeste werden weiter gelesen. |
| Upload | alle Chunks im Commit-Aufruf · einzeln vorab | **einzeln vorab** (`RemoteRepository.uploadObject` → `POST /git/blobs`, danach `putUploadedObject` im Tree): höchstens ein Chunk zusätzlich im Speicher. Nie committete Uploads sind harmlos. |

Integrität: Chunk-Index per GCM an die Object-ID gebunden, jeder Chunk per GCM an seine Chunk-ID und per Hash
an den Index, die ganze Datei zusätzlich an `contentHash` im Manifest. Erst nach vollständiger Prüfung im
Speicher wird geschrieben (wie bisher). Nicht mehr referenzierte Chunks (geänderte Stücke, Datei gelöscht oder
wieder klein) werden im selben Commit aus dem Tree entfernt und bleiben nur in der Historie. Der
Versionsverlauf funktioniert unverändert, weil sich `objects/<aa>/<id>` (der Index) mit jeder Version ändert.

## 3. Manifest-Schema (entschlüsselt)

```json
{
  "type": "obsidian-encrypted-sync-manifest",
  "formatVersion": 2,
  "vaultId": "…",
  "version": 18,
  "parentCommit": "<sha des Parent-Commits oder null>",
  "device": "<deviceId>",
  "updatedAt": 1790428123000,
  "entries": {
    "13ac…": { "path": "Projekte/Projekt A.md", "size": 18372, "contentHash": "<sha256 hex>",
               "modified": 1790428123000, "updatedAtVersion": 17, "updatedBy": "<deviceId>" },
    "5b1e…": { "path": "Video.mp4", "size": 91226112, "contentHash": "<sha256 hex>", "modified": 1790428123000,
               "updatedAtVersion": 17, "updatedBy": "<deviceId>", "chunks": 22 },
    "77e0…": { "deleted": true, "deletedAtVersion": 52, "deletedBy": "<deviceId>" }
  }
}
```

* Schlüssel = stabile Object-ID (128 bit zufällig, hex). Rename ändert nur `path`.
* Tombstones (`deleted: true`) enthalten **keinen** Pfad und keinen Hash.
* `version` steigt pro Commit streng monoton (+1). Ein Remote-Manifest mit `version` kleiner als die
  lokal zuletzt gesehene → Rollback/Force-Push erkannt → Sync stoppt.
* Validierung beim Parsen: exakte Typen, Pfade relativ, ohne `..`, ohne führenden `/`, ohne
  Steuerzeichen, nicht im eigenen Plugin-Ordner, keine doppelten Pfade (NFC + case-insensitiv).
  Ein ungültiges Manifest wird verworfen → Sync stoppt.
* Content-Hashes stehen nur im verschlüsselten Manifest.
* `chunks` (optional, ab formatVersion 2): Objekt ist ein Chunk-Index mit so vielen Chunks (§2.5).

---

## 4. Crypto- und Key-Management

```
Passwort ──Argon2id(salt, 64 MiB, t=3, p=1)──► KEK_pw ──AES-GCM unwrap──┐
Recovery-Key (256 bit) ──HKDF-SHA256(salt)──► KEK_rk ──AES-GCM unwrap──┤
                                                                        ▼
                                                  Vault Master Key (256 bit, CSPRNG)
                                                                        │ HKDF-SHA256, salt = "ovs/v1/"+vaultId
                                  ┌─────────────────────────┬───────────┴──────────────┐
                           info "object-key"         info "manifest-key"       info "config-mac"
                             AES-256-GCM               AES-256-GCM              HMAC-SHA256
```

* **KDF-Entscheidung** (sicherheitsrelevant, dokumentierte Optionen):

  | Option | Vorteil | Nachteil |
  |---|---|---|
  | Argon2id via `@noble/hashes` (pure JS) | memory-hard, bevorzugt laut Anforderung, keine WASM-Abhängigkeit, identisch auf allen Plattformen, Library aus auditierter Familie | langsamer (Desktop ~0,6 s, Mobile geschätzt 2–4 s), Argon2-Modul selbst nicht separat auditiert |
  | Argon2id via `hash-wasm` (WASM) | ~3× schneller | WASM-Blob im Bundle, nicht auditiert, WASM-Verfügbarkeit in allen Mobile-Webviews |
  | PBKDF2-SHA256 (WebCrypto) | nativ, auditiert, schnell | nicht memory-hard → GPU-Angriffe billiger |

  **Umgesetzt:** Default Argon2id (`@noble/hashes`, async-Variante, UI bleibt responsiv), Parameter
  m = 64 MiB, t = 3, p = 1. PBKDF2-SHA256 (600 000 Iterationen) ist als zweiter, versionierter
  Algorithmus implementiert und kann bei Problemen gewählt werden. Algorithmus + Parameter stehen im Slot.
  Parameter außerhalb sicherer Grenzen (z. B. m < 19 MiB, PBKDF2 < 310 000) werden beim Lesen abgelehnt
  (Downgrade-Schutz).
* **Nonces:** 96 bit zufällig je Verschlüsselung. Bei ≤ 2³² Verschlüsselungen pro Schlüssel ist die
  Kollisionswahrscheinlichkeit < 2⁻³²; Object- und Manifest-Key sind getrennt.
* **Recovery-Key:** 256 bit zufällig, angezeigt als Crockford-Base32 in 4er-Gruppen mit Prüfsumme
  (`VSRK-XXXX-…`). Hohe Entropie → HKDF statt langsamer KDF. Wird nur einmal angezeigt, nie gespeichert.
* **Passwortänderung:** alten Slot entschlüsseln (bzw. MK aus entsperrter Sitzung), neues Salt, neuer
  KEK, gleicher MK neu gewrappt, neuer Config-Commit (über Mutex + CAS). Objekte bleiben unverändert.
  Hinweis: Geräte, die den MK bereits kennen, behalten Zugriff (keine Revocation in V1 – dafür wäre
  eine MK-Rotation mit Neuverschlüsselung aller Objekte nötig, als spätere Migration vorgesehen).
* **Config-MAC:** schützt vaultId, Slot-Liste und Versionen gegen unbemerkte Manipulation und erkennt
  "Repository gehört zu anderem Vault" (MAC schlägt mit lokalem MK fehl).
* **Speicherung lokal:** GitHub-Token und (optional, "auf diesem Gerät merken") der MK liegen
  ausschließlich in `app.secretStorage` (OS-Keychain). Nie in `data.json`, nie in Logs/Fehlermeldungen.
  Ohne SecretStorage: nur im Arbeitsspeicher.
* **Lock:** MK aus dem Speicher entfernen (Bytes überschreiben, best effort) **und** aus SecretStorage
  löschen. Nächster Sync verlangt Passwort.
* Verlust von Passwort **und** Recovery-Key = Daten unwiederbringlich verloren. Keine Backdoor.

---

## 5. Sync-State-Machine

Lokaler Zustand (`state-<deviceId>.json` im Plugin-Ordner, doppelt geschrieben mit Prüfsumme; die
Device-ID liegt in `localStorage` und wird gegen die State-Datei geprüft – eine von anderen Tools
kopierte State-Datei wird verworfen):

```
vaultId, deviceId, lastRemoteCommit, lastManifestVersion, lastSyncTime,
remote   : Manifest bei lastRemoteCommit (zuletzt gesehener Remote-Stand)
base     : pro Object-ID die gemeinsame Basis (Merge-Base) – normalerweise == remote
localMap : Pfad → Object-ID (Zuordnung lokaler Dateien)
hashCache: Pfad → {size, mtime, sha256}  (reiner Cache)
pendingRenames, journal, pendingCommit, conflicts
```

Ablauf eines Syncs (`SyncEngine.sync`), unter `SyncMutex` (weitere Anfragen setzen `syncRequested`):

```
 0 RECOVER     journal vorhanden? → idempotent fertigstellen (Vor-/Nachbedingung je Op per Hash)
               pendingCommit vorhanden? → HEAD == commit oder Vorfahre von HEAD → finalisieren, sonst verwerfen
 1 FETCH HEAD  Branch fehlt (obwohl bekannt) → STOP; Repo fehlt → STOP
 2 FETCH REMOTE falls HEAD ≠ lastRemoteCommit: config (+MAC, vaultId, formatVersion), manifest
               entschlüsseln+validieren; version < lastManifestVersion oder lastRemoteCommit kein
               Vorfahre von HEAD → STOP (History manipuliert)
 3 SCAN        lokale Dateien (Ignore-Regeln, Limits), Hash nur bei geänderter size/mtime
 4 PLAN        3-Wege-Merge (base, local, remote) → lokale Ops + Konflikte
 5 APPLY       benötigte Objekte laden → entschlüsseln → Hash prüfen (alles im Speicher);
               journal persistieren; Ops ausführen (jede prüft ihre Vorbedingung erneut);
               base := remote für erfolgreich angewendete IDs; State persistieren
 6 RESCAN+DIFF lokale Änderungen ggü. remote (nur IDs mit base == remote)
 7 COMMIT      verschlüsseln → createCommit(parent = HEAD) → pendingCommit persistieren
               → updateHead(expected = HEAD, new) (fast-forward-only, kein Force)
               ConcurrentRemoteUpdate → zurück zu 1 (max. 3 Runden)
 8 FINALIZE    erst NACH erfolgreichem Ref-Update: remote := base := neues Manifest, State persistieren
 9 LOOP        falls mehr als maxFilesPerSync Uploads offen → nächste Runde; danach syncRequested prüfen
```

Fehlerzustände: `Offline` (Netz), `AuthError`, `RateLimited(bis)`, `Blocked(Grund)` (Manipulation,
fremder Vault, unbekanntes Format – erfordert Benutzeraktion), `Locked`. In keinem Fehlerzustand werden
lokale Dateien verändert.

---

## 6. Konfliktsemantik

Pro Object-ID werden Änderungen lokal (L ggü. base) und remote (R ggü. base) bestimmt:
`none | create | modify(content) | move(path) | modify+move | delete`.

| lokal \ remote | none           | modify/move                                   | delete |
|----------------|----------------|-----------------------------------------------|--------|
| none           | –              | Remote anwenden                               | lokal in Papierkorb (nur wenn lokaler Hash == base-Hash) |
| modify/move    | pushen         | Inhalt beidseitig verschieden → **Konflikt**; sonst Felder mergen (Pfad: remote gewinnt) | **Konflikt**: lokale Datei bleibt, wird wiederbelebt und gepusht |
| delete         | Tombstone pushen | **Konflikt**: Remote-Version wird lokal wiederhergestellt | – |

**Inhaltskonflikt:** Die Remote-Version behält den kanonischen Pfad. Die lokale Version wird
(atomar per Rename, ohne Inhaltsänderung) nach `Name (conflict YYYY-MM-DD <device8>).ext` verschoben
und als neues Objekt gepusht. Beide Versionen bleiben erhalten; Konflikt wird in der Konfliktansicht
gelistet und per Notice gemeldet.

**Pfadkollisionen** (NFC + case-insensitiv, da Windows/macOS/iOS): Remote-Ansprüche haben Vorrang.
Kollidiert eine lokal neu erstellte Datei mit einer remote neu erstellten gleichen Inhalts → Identitäten
werden zusammengeführt (keine Kopie). Bei unterschiedlichem Inhalt → lokale Datei wird Konfliktkopie.

**Tombstones** bleiben im Manifest (GC später). Ein Gerät mit veralteter Basis, das die Datei
unverändert hat, löscht sie (Papierkorb); hat es sie geändert → Konflikt (Wiederbelebung).

**Ausgeschlossene Pfade** (Ignore-Regeln, Größenlimit, gerätespezifische `.obsidian`-Einstellungen)
werden nie als lokale Löschung interpretiert; ihre Remote-Einträge bleiben unverändert.

---

## 7. Stellen mit möglichem Datenverlust und Gegenmaßnahmen

| # | Risiko | Gegenmaßnahme |
|---|--------|---------------|
| 1 | Remote-Version überschreibt lokale Änderung | Vor jedem Überschreiben/Löschen wird der aktuelle lokale Hash erneut geprüft (== base-Hash). Sonst Op übersprungen, base der ID bleibt alt → nächster Merge erkennt Konflikt. |
| 2 | Teilweise geschriebene Datei | Entschlüsselung + GCM-Prüfung + Hash-Prüfung vollständig im Speicher, erst dann ein einziger Schreibaufruf. Journal erlaubt Wiederaufnahme; Nachbedingung per Hash. |
| 3 | Absturz zwischen lokalen Ops | Journal mit idempotenten, selbstprüfenden Ops; Fallback-Merge-Regeln (identischer Hash ⇒ kein Konflikt, Identitätszusammenführung) erzeugen höchstens Duplikate, nie Verlust. |
| 4 | Remote-Löschung löscht lokale Änderung | Delete nur bei unverändertem lokalen Inhalt; Löschung über Obsidian-Papierkorb (wiederherstellbar). |
| 5 | Delete-vs-Modify | Immer Konflikt, Inhalt bleibt erhalten. |
| 6 | Paralleler Push zweier Geräte | Ref-Update fast-forward-only (`force: false`) = Compare-and-Swap; Verlierer pullt/mergt neu. |
| 7 | Commit erstellt, Ref nicht aktualisiert | Verwaister Commit ist harmlos; State wird erst nach Ref-Update geschrieben. |
| 8 | Ref aktualisiert, State nicht persistiert | `pendingCommit` + Vorfahren-Prüfung; Fallback: Merge erkennt identische Inhalte. |
| 9 | Force-Push / Rollback / gelöschter Branch | Versionsmonotonie + Vorfahren-Prüfung + Branch-Existenz → Sync stoppt, lokale Dateien unangetastet. |
| 10 | Kaputtes/fremdes Manifest oder Config | GCM + MAC + Schema-Validierung → Sync stoppt. |
| 11 | Neues Gerät / verlorener State | Keine Basis ⇒ niemals löschen; unterschiedliche Inhalte ⇒ Konfliktkopie. |
| 12 | Lokale State-Datei korrupt | Zwei Generationen mit SHA-256-Prüfsumme; sonst wie #11. |
| 13 | Ignore-/Limit-Unterschiede zwischen Geräten | Ausgeschlossene Pfade sind nie „gelöscht“. |
| 14 | Rename-Kaskaden/Swaps | Zyklen über temporäre Namen; Kollisionen → Konfliktkopie. |
| 15 | Link-Updates durch Rename | Konflikt-Renames über `Vault.rename` (kein Link-Rewrite durch FileManager). |
| 17 | Datei lokal vorhanden, aber gerade nicht verwaltet (zu groß, unlesbar, veralteter Index) | Merge-Basis dieser ID bleibt stehen (`heldBack`), bis die Datei wieder verwaltet wird – sonst würde der alte lokale Inhalt später eine Remote-Änderung überschreiben. |
| 18 | Lokal gelöscht, remote in nicht verwaltbare Form geändert (zu groß / ausgeschlossener Pfad) | Konflikt, Löschung wird verworfen (`untrack`), nie Tombstone. |
| 19 | Editor schreibt direkt nach dem Download | Kein zweiter Schreibversuch; ID bleibt divergiert → nächster Merge bewahrt beide Versionen. Hash-Cache nur bei stabilem Stat. |
| 20 | Angreifer mit Schreibzugriff hängt altes Manifest an (Replay) | Jeder Manifest-Commit muss direkter Kind-Commit von `manifest.parentCommit` sein; Config-Commits schreiben ebenfalls ein neues Manifest. |
| 21 | Nicht-portable Namen (`a:b`, `CON`, Endpunkt/-leerzeichen), Plugin-Ordner in anderer Schreibweise | Werden nie synchronisiert (und nie als gelöscht gewertet); eigener Plugin-Ordner case-insensitiv ausgeschlossen. |
| 16 | Klartext-Upload | Brand-Typ `EncryptedBlob`, Laufzeit-Header-Prüfung, Pfade nur aus Object-IDs, Security-Test durchsucht gesamten Remote-Inhalt inkl. Commit-Messages. |
| 22 | Wiederherstellen einer Version / „Kopie behalten“ bei Konflikt überschreibt ungesicherten Inhalt | Ersetzen nur, wenn der aktuelle Inhalt dem Remote-Manifest entspricht (also in der Historie liegt); sonst erst Sync, sonst Abbruch (`UnsyncedChanges`). Unter Mutex; Hash-Prüfung des verglichenen Inhalts direkt vor dem Schreiben. Verworfene Konfliktkopie → Papierkorb. |
| 23 | Gelöschte Datei wiederherstellen überschreibt eine neue Datei gleichen Namens | Nie: belegter Name → `Name (restored).ext`. Inhalt gegen `contentHash` des Manifests vor der Löschung geprüft. |
| 24 | Chunk fehlt/vertauscht/manipuliert | Chunk-Hash aus dem authentisierten Index + GCM je Chunk + Gesamt-Hash; erst nach vollständiger Prüfung im Speicher wird geschrieben. Fuzz-Tests laufen zusätzlich mit 3-Byte-Chunks. |

### Bekannte, akzeptierte Metadaten-Leaks

GitHub sieht: Anzahl der Objekte, ungefähre Größen (Ciphertext ≈ Klartext + 36 Byte), Zeitpunkte und
Häufigkeit von Änderungen pro Objekt, Anzahl Änderungen pro Commit, Device-IDs (zufällig).
Padding ist für eine spätere Formatversion vorgesehen. Chunks fester Größe verraten nichts über die Gesamtgröße
hinaus; zufällige Chunk-IDs verraten keine gleichen Inhalte (§2.5). Sichtbar wird, welche Chunks einer großen
Datei sich ändern (grob: welcher Bereich der Datei).

## 7a. Versionsverlauf (Markdown-Notizen)

Jeder Push schreibt `objects/<aa>/<objectId>` neu; die Object-ID bleibt über Änderungen und Renames stabil.
Die Commits, die diesen Pfad ändern, sind damit genau die Versionen der Datei – verschlüsselt, von allen
Geräten, ohne zusätzlichen Speicher.

| Option | Vorteil | Nachteil |
|---|---|---|
| **Git-Historie (umgesetzt)** | keine Formatänderung, nichts zusätzlich gespeichert, geräteübergreifend, verschlüsselt | braucht Netz; Granularität = Syncs; Historie wird nie gekürzt (kein Force-Push) → Einstellung begrenzt nur die Anzeige |
| Lokale Snapshots im Plugin-Ordner | offline, erfasst auch Stände zwischen Syncs, echte Aufbewahrungsgrenze | Klartext-Kopien außerhalb des Vaults, pro Gerät, doppelt zu Obsidians Kern-Plugin „Dateiwiederherstellung“ |
| Versionsobjekte im Manifest | explizite Aufbewahrung | neue `formatVersion`, Migration, redundant zur Git-Historie |

Ablauf (`src/sync/VersionHistory.ts`):

* **Liste:** `RemoteRepository.listObjectRevisions(lastRemoteCommit, objectId, n)` → GitHub
  `GET /commits?sha=…&path=objects/<aa>/<id>&per_page=n` (Einstellung *Versions per note*, 1–100, Default 20).
  Die Anfrage enthält nur die Object-ID. Datum und Device-ID stammen aus Commit-Metadaten und sind **nicht**
  authentisiert (nur Anzeige).
* **Laden:** erst bei Vorschau/Wiederherstellung; `EncryptionEngine.decryptObjectRevision` prüft AES-GCM mit
  `ovs/v1/object/<vaultId>/<objectId>` als AAD. Ein Manifest-Hash liegt für alte Versionen nicht vor; die AAD
  garantiert trotzdem, dass der Inhalt mit dem Vault-Schlüssel für genau dieses Objekt verschlüsselt wurde
  (ein unter den Pfad gelegtes fremdes Objekt schlägt fehl). Commit, der die Datei entfernt hat → „nicht verfügbar“.
* **Wiederherstellen (ersetzen):** nur wenn der aktuelle lokale Inhalt dem Remote-Manifest (`state.remote`)
  entspricht, also selbst in der Historie liegt. Sonst zuerst ein Sync; gelingt der nicht (offline, blockiert,
  Konflikt) → `SyncError("UnsyncedChanges")`, nichts wird geschrieben. Unter `SyncMutex`, Object-ID wird erneut
  geprüft. Der wiederhergestellte Inhalt ist danach eine normale lokale Änderung und wird als neue Version gepusht.
* **Als Kopie wiederherstellen:** neue Datei `Name (version YYYY-MM-DD HHmm).md` neben dem Original; das Original
  bleibt unberührt (auch mit nicht synchronisierten Änderungen).
* Konfliktkopien und neu verschlüsselte Objekte erhalten neue Object-IDs; ihre Historie beginnt neu.

## 7b. Gelöschte Dateien, Konfliktauflösung, Aktivitätsprotokoll, Repository-Prüfung

* **Gelöschte Dateien** (`src/sync/DeletedFiles.ts`): Liste aus den Tombstones des letzten Manifests (ohne Netz).
  Pfad und Hash stehen nicht im Tombstone; aufgelöst über `listObjectRevisions(…, 1)` → Lösch-Commit →
  dessen Parent → Manifest dort (pro Commit gecacht, seitenweise 20 Dateien). Inhalt voll verifiziert
  (`contentHash`). Wiederherstellen legt eine neue Datei an (neue Object-ID beim nächsten Sync), nie überschreibend.
* **Konfliktauflösung** (`src/sync/ConflictResolver.ts`, `src/util/diff.ts`): Zeilen-Diff (Myers, begrenzt auf
  4000 Änderungen) zwischen kanonischer Datei und Konfliktkopie. „Synchronisierte behalten“ → Kopie in den
  Papierkorb; „Kopie behalten“ → Inhalt ersetzt die kanonische Datei (Regeln wie beim Wiederherstellen, #22),
  Kopie in den Papierkorb; „Manuell zusammenführen“ öffnet beide nebeneinander. Beide Aktionen prüfen, dass die
  Kopie seit dem Vergleich unverändert ist.
* **Aktivitätsprotokoll** (`src/state/ActivityLog.ts`): `SyncReport.changes` listet jede Datei (↓, ↑, verschoben,
  gelöscht, Konflikt) sowie Wiederherstellungen und Fehler. Nur lokal im Plugin-Ordner
  (`activity-<deviceId>.json`), höchstens 200 Einträge × 500 Dateien, gleiche Fehler hintereinander einmal.
  Enthält Pfade wie die State-Datei, nie Inhalte; wird nie hochgeladen.
* **Repository prüfen** (`src/sync/RepositoryVerifier.ts`): rein lesend. Config-MAC, Manifest (GCM, Schema,
  Parent-Bindung, Vorfahre von `lastRemoteCommit`), dann jede Datei herunterladen, entschlüsseln, gegen
  `contentHash`/Größe prüfen; Ergebnis pro Pfad „fehlt“/„beschädigt“, dazu nicht referenzierte Objekte.
  Ca. eine Anfrage pro Datei; Abbruch und Rate-Limit liefern einen Teilbericht.

## 8. Grenzen von Version 1

* Leere Ordner werden nicht synchronisiert.
* Dateien > `maxFileSize` (Default 50 MB, hartes Maximum 256 MiB) werden übersprungen und im Status gemeldet –
  niemals als gelöscht gewertet. Dateien > 4 MiB werden als Chunks übertragen (§2.5); die Grenze setzt der
  Arbeitsspeicher (Obsidian liest/schreibt nur ganze Dateien) und die Repository-Größe (jede Version bleibt in
  der Historie).
* Speicher: pro Commit höchstens `maxBytesPerCommit` (64 MiB) Klartext bzw. `maxFilesPerCommit` (500)
  Objekte; Chunks werden einzeln verschlüsselt und vorab hochgeladen. Downloads werden einzeln entschlüsselt
  und geschrieben (höchstens eine Datei plus ein Chunk gleichzeitig im Speicher).
* Keine Schlüssel-Revocation einzelner Geräte.
* Zwei Dateien, die sich nur in Groß-/Kleinschreibung unterscheiden (nur auf Linux möglich), können nicht
  beide synchronisiert werden; die zweite bleibt lokal und wird gemeldet (`nameCollisions`).
* Atomares Ersetzen: Obsidians API bietet kein „rename over existing“. Umgesetzt ist: vollständige
  Entschlüsselung + GCM- + Hash-Prüfung im Speicher → erneute Prüfung des lokalen Hashes → ein einziger
  Schreibaufruf → Nachprüfung per Hash. Der vorige Inhalt ist in diesem Fall immer identisch mit der
  Merge-Basis und damit aus der Git-Historie wiederherstellbar; das Journal setzt unterbrochene Anwendungen fort.

## 9. Umsetzung – Modulstruktur

```
src/crypto     CryptoProvider, WebCryptoProvider, KeyDerivation (Argon2id/PBKDF2), KeyManager,
               EncryptionFormat (Envelope + EncryptedBlob-Brand), EncryptionEngine, RecoveryKey
src/manifest   Manifest, ManifestCodec (strikte Validierung), VaultConfig (öffentliche Config + MAC-Input)
src/remote     RemoteRepository (Interface), RemoteLayout (Pfade, Armor, Commit-Messages)
src/github     HttpClient, GitHubAuth (PAT), GitHubClient (Retry/Backoff/Rate-Limit), GitObjectsApi,
               GitHubRemoteRepository
src/sync       SyncEngine, ChangeDetector, SyncPlanner (3-Wege-Merge), ConflictNaming, SyncMutex, ChunkedContent,
               VersionHistory, DeletedFiles, ConflictResolver, RepositoryVerifier, HistoryReader, LocalContent,
               SyncController (Trigger), VaultSetup (Init/Connect/Passwort/Recovery)
src/vault      LocalFileSystem, VaultScanner, VaultWriter (Journal-Ops), IgnoreMatcher, SyncFilter, PathUtils
src/state      LocalState, StateRepository (2-Generationen + Prüfsumme), SyncStateStore, SecretStore, ActivityLog
src/platform   Obsidian-Adapter (FileSystem, requestUrl, SecretStorage, Plugin-Ordner, localStorage)
src/ui         SettingsTab, SetupWizard, StatusBar, ConflictView, Modals, VersionHistoryModal, DeletedFilesModal,
               VerifyModal, ActivityModal, DiffView
src/util       bytes, canonicalJson, validate, Logger, diff (Myers)
src/errors     VaultSyncError, CryptoError, GitHubError, SyncError
```

Nur `src/platform`, `src/ui` und `src/main.ts` importieren `obsidian`.

## 10. Teststrategie

* Unit-Tests für Crypto, Formate, Manifest, Ignore-Regeln, State-Persistenz, Mutex, Controller-Trigger.
* Integrationstests der Sync-Engine mit `FakeRemoteRepository` und `MemoryFileSystem` (case-insensitiv wie
  Windows/macOS/iOS) für alle Szenarien aus §53 inkl. Failure-Injection an jedem Commit-Schritt, während der
  lokalen Anwendung und vor dem State-Persist.
* Ende-zu-Ende-Tests über `GitHubRemoteRepository` gegen einen GitHub-API-Emulator (Git-Objektmodell,
  Fast-Forward-Prüfung, 409 bei leerem Repo, Rate-Limit-Header).
* Security-Tests durchsuchen den gesamten Remote-Inhalt, alle Commit-Messages und jeden je gesendeten Request
  nach Klartext (UTF-8, NFC/NFD, UTF-16, JSON-escaped, Base64 in allen Ausrichtungen).
* Randomisierte Zwei-Geräte-Sitzungen (mit/ohne Crashes, Neustarts, Netzabbrüche) prüfen die Invariante
  „lokaler Inhalt bleibt im Vault, im Papierkorb oder in der Remote-Historie“ sowie Konvergenz. Diese Tests
  haben zwei Fehler bei case-insensitiven Dateisystemen gefunden (behoben, siehe `ChangeDetector`). Beide
  Fuzz-Suiten laufen zusätzlich mit 3-Byte-Chunks, sodass fast jede Datei als Chunk-Index übertragen wird.

## 11. Offen / Phase 7

* Manuelle Tests auf iOS und Android (Speicherverbrauch großer Anhänge, Suspend/Resume, Keychain-Verfügbarkeit).
* Optional: automatische Repository-Erstellung, GitHub-App/OAuth-Device-Flow (Interface `AuthProvider`
  vorhanden), Tombstone-Garbage-Collection, Größen-Padding, Schlüsselrotation (Geräte-Widerruf).
