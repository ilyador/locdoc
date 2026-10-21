# Locdoc

A small, self-hosted Markdown and Fountain editor over real files. Write in your browser or your desktop editor, and share documents or folders without accounts.

- Real nested folders and ordinary UTF-8 `.md` and `.fountain` files.
- A searchable sidebar with **By date** and **Folders** tabs; your selected view is remembered locally.
- Autosave, live Markdown formatting, task lists, tables, local images and videos.
- Live Fountain screenplay formatting: scene headings, dialogue, parentheticals, transitions, title pages, notes, and dual dialogue.
- Collaborative editing with visible cursors and inline comments.
- Document and folder links with **view & comment** or **edit & comment** access.
- Searchable document links, link previews, local fonts, automatic dark mode, and mobile layouts.
- Scroll positions remembered in each browser, separately for each document and reader.
- An authenticated MCP interface for ChatGPT and other MCP clients.
- A local owner key; no email, hosted database, or third-party collaboration service.

## Install

**Requires Linux, Node.js 24+, Rust 1.97+, and a C compiler** (`build-essential` on Debian/Ubuntu). Use a local filesystem such as ext4. Locdoc relies on Linux file leases to avoid importing unfinished desktop saves; network filesystems and macOS/Windows are currently unsupported.

Clone and build:

```sh
git clone https://github.com/ilyador/locdoc.git
cd locdoc
```

Then run:

```sh
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:3477**. In another terminal in the same directory:

```sh
npm run owner
```

This opens your browser as the owner using a one-use ticket. Your API key stays in `.locdoc/owner.key` on this computer. If the browser cannot open automatically, select **Open workspace** and enter the key locally.

By default, documents live in `./docs` and application state in `./.locdoc`. Both are created automatically and excluded from Git. The running server is one Rust process; Node is used to build the interface and open owner access.

### Use an existing folder

```sh
cp .env.example .env
```

Edit `.env` before starting:

```dotenv
LOCDOC_DOCS=/absolute/path/to/your/notes
LOCDOC_STATE=.locdoc
LOCDOC_BIND=127.0.0.1:3477
LOCDOC_PUBLIC_URL=http://127.0.0.1:3477
LOCDOC_OWNER_NAME=Your name
```

`npm start` and `npm run owner` load `.env`; environment variables override it. If you run the binary directly, export these variables yourself. Keep one server process per document/state directory. Files must be writable by the user running Locdoc.

### Start automatically

After building and configuring the app:

```sh
npm run install:service
npm run owner
```

This installs and starts a **user** systemd service using your actual checkout path and `.env`. No administrator access is required. An existing service is preserved unless you pass `-- --replace`; restart it after rebuilding.

```sh
systemctl --user status locdoc
systemctl --user restart locdoc
journalctl --user -u locdoc -n 50
```

To start before login, your administrator can optionally enable user lingering. For development use `npm run dev` (export environment variables first).

## Fountain screenplays

Choose **Fountain screenplay** when creating a document, or place a `.fountain`
file in your documents folder. Locdoc formats it as you type, using the
[Fountain syntax](https://fountain.io/syntax/). The current line reveals its
formatting markers while you edit; the file on disk stays plain text.
Courier Prime is bundled as the default Fountain font. Font, text size, line
height and page width preferences are saved separately for Markdown and Fountain
in each browser.
Both formats offer **Scroll past end**, leaving half a viewport of writing room
below the last line. Markdown also has a **Paragraph spacing** slider, initially
15% of line height, for paragraphs and list items.

Type `INT.`, `EXT.`, uppercase character names, dialogue and parentheticals
naturally. The **Element** menu can force a scene heading, action, character,
transition, centered text or lyrics. `_underscores_` underline text. Dual
dialogue uses `^` after the second character cue; this marker stays visible while
both speeches remain in normal editing flow. Comments, shared folders, simultaneous editing,
desktop file sync and raw-file downloads use the same system as Markdown.


Speaker names already used in a script appear as suggestions when typing a new character cue. **Tab** accepts a suggestion; **↑/↓** followed by **Enter** selects one, and **Esc** dismisses the list. Enter by itself still inserts a line break. Names in comments and omitted passages are excluded.

Paragraph spacing is available under **aA → Layout** for both Markdown and Fountain. Each format remembers its own value. Spacing follows explicit source lines; wrapped text, blank lines, speaker cues and parentheticals keep their existing layout.

## ChatGPT and MCP

Locdoc includes a Streamable HTTP MCP server in the same Rust process. No extra daemon, database or firewall port is needed. For ChatGPT, configure public HTTPS as described below and set `LOCDOC_PUBLIC_URL` to that exact origin.

1. Open [ChatGPT Plugins](https://chatgpt.com/plugins) and choose **Add custom MCP server**.
2. Enter your Locdoc URL followed by `/mcp`, for example `https://notes.example.com/mcp`.
3. Choose OAuth authentication and create the plugin. Locdoc supplies OAuth discovery and dynamic client registration.
4. In the Locdoc authorization page, check the application's return address and approve the requested read, edit and sharing permissions as the workspace owner. If that browser is locked, open the workspace as its owner first, then restart the connection.
5. Select the resulting plugin in a ChatGPT conversation.

ChatGPT account and workspace policies control whether custom MCP connections are available. See OpenAI's [connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt). Other MCP clients can use the same endpoint and OAuth discovery.

MCP access is **off by default**, including for documents with public links. As owner, open **Share → Allow MCP** for each document or folder you want connected apps to access. A folder grant covers its descendants and future files; inherited document access is marked “Allowed by folder.” Turning off a direct document grant does not override an enabled parent folder. Public-link settings stay separate. Only the owner can change these grants; MCP tools cannot enable themselves or broaden their access. Existing OAuth connections are restricted by the same allowlist.

Tools can list and search enabled documents, read source, create documents and folders, edit or move documents, manage document/folder links, participate in comments, and read or restore history. Moving to another folder requires that destination folder to be enabled for MCP. Creation is limited to enabled folders; root-level creation is not exposed. Comments and version history follow the same document restriction. File deletion and access outside the configured docs folder are not exposed.

Every source read returns a SHA-256 revision. An edit must supply that revision; if a browser or desktop edit changed the source meanwhile, the command fails without replacing it. Use `replace_text` for a small change in a long document: the old text must match exactly once. A stale replacement retry fails without applying the change twice. Whole-source edits can also be retried harmlessly when their result is already present. Successful edits report durable acceptance separately from pending disk projection and use the same sync engine as the editor. Source offsets in paginated reads count Unicode characters.

The local owner key is never a connector credential. OAuth uses separate, expiring, revocable grants with `locdoc:read`, `locdoc:write` and `locdoc:share` permissions. **Your workspace → ChatGPT & MCP** lists connected applications and lets the owner disconnect them. Disconnection blocks new calls and refreshes; an operation already admitted may finish. Document contents are untrusted data, not instructions for a tool or model.

## Public sharing

For access outside this computer, point your hostname at it and reverse-proxy HTTPS to `127.0.0.1:3477`. A standalone [Caddy example](deployment/Caddyfile.snippet) includes WebSocket support. Set `LOCDOC_PUBLIC_URL=https://notes.example.com` in `.env`, restart Locdoc, then run `npm run owner -- --public` on the server computer to recognize your browser as owner at that address.

Forward and allow **TCP 80 and 443** for the HTTPS proxy. On an already enabled UFW firewall, use `sudo ufw allow 80/tcp` and `sudo ufw allow 443/tcp`. **Do not expose port 3477** publicly. UDP 443 is optional for HTTP/3. DNS, certificates, router and firewall changes are managed separately from Locdoc.

Choose **Share** in a document, or switch to the **Folders** tab and use the sharing icon beside a folder. A document's share dialog also offers **Share containing folder**.

- **View & comment** permits reading and commenting. **Edit & comment** also permits collaborative text edits. The owner always retains editing access.
- Folder links include nested folders and future Markdown files added inside them. Guests get a searchable, scoped sidebar; they cannot browse the rest of your workspace or create/rename files.
- Folder access and individual document links are independent. Turning off a document's own link does not remove access granted through a shared parent folder. To remove that access, change the folder link or move the file outside the folder.
- A document's own links, comments and history follow a move between folders. Folder access is recalculated from its current location; it is never copied onto the document.
- Turn a link private to revoke it, or choose **Replace link** to invalidate the old URL. Moving, removing, or replacing a shared folder invalidates its capability. A folder share does not follow an external rename; share the new location again.
- Visitors choose a display name without signing in. Names are labels, not verified identities.

## Writing and comments

Drag the sidebar's right edge to resize it on desktop; its width is remembered locally. Double-click the edge to restore the default width, or focus it and use the arrow keys. Folders start collapsed and open temporarily to reveal search matches.

One live-preview editor styles Markdown and reveals syntax near the cursor. Markdown preview updates reuse unchanged parser blocks and mapped decorations, including offscreen media and tables. Structural changes refresh the affected blocks; partial background parsing retains offscreen layout until those blocks are parsed again. Use the toolbar for checkboxes, tables, links, media and comments. Font, size, line height, page width and light/dark appearance are browser preferences. Open aA for live controls in a bottom sheet on mobile or a column to the left of the document on desktop. The document stays visible and editable while you adjust Font, Layout and Theme. Google Fonts can be searched and installed locally by the owner.

Select text to comment, then open the small inline marker to read or reply. Comments also live in the raw Markdown:

```md
The passage being discussed[[comment(alex): this is my comment]]
[[comment(ana): this is a response]]
```

Adjacent records separated by spaces or one newline are replies in one conversation; a blank line starts another. Edit them from any desktop editor. The web editor inserts records after the complete paragraph, list, table or other containing block, keeping the selected passage anchored separately so comments do not split Markdown syntax. Records inside code examples, HTML or Markdown link/image syntax remain literal.

Each record occupies one physical line. Escape backslashes as `\\`, literal `]` as `\]`, `)` in names as `\)`, and message line breaks as `\n` or `\r`. Names allow 1–60 characters; messages allow 1–4,000. Comment text belongs to the file; SQLite retains anchors, timestamps and resolved state. File-added comments have no invented timestamp. Cutting and reinserting an unchanged conversation within the same document preserves its timestamps and resolved state when the entire conversation is unique and its original records were removed. Copies, altered conversations and ambiguous duplicates receive independent metadata; recreated raw text never inherits author permissions or posting receipts.

Images up to **5 MB**, videos up to **20 MB**, and total embeds up to **50 MB per document** are stored locally in `.assets/` under the docs directory. PNG, JPEG, GIF, WebP, AVIF, MP4, WebM and MOV are supported; playback depends on browser codecs. Relative Markdown media links remain usable in desktop editors. Removed attachments are retained for undo/history but no longer reserve embedding capacity once unused. Retained storage is separately limited to 200 MB per document and 10 GB per workspace; uploads leave at least 128 MB free. Existing files are never deleted automatically to enforce these limits.

To reclaim retained storage, the owner can delete unwanted files from `.assets/` locally. Uploads reconcile missing files before rejecting a retained storage limit; an upload still within its ten-minute insertion window remains reserved until that window ends.

Useful shortcuts: Ctrl/Cmd K to find a file or insert a link in the editor, Ctrl/Cmd F to search text, Ctrl/Cmd Alt M to comment, and Ctrl/Cmd Z to undo. Saves are automatic.

## Sync, recovery and backups

Yjs in the browser and Yrs on the server merge concurrent edits. One document engine owns acceptance, durable commits, file projection, publication and save receipts. Handlers submit commands; transaction buffers and projection bookkeeping stay private to the engine. Source updates, comment metadata and attachment permissions commit together in SQLite before publication to collaborators.

Filesystem events import completed desktop saves; kernel file leases exclude unfinished desktop writes. Small edits append small transactions; collaboration checkpoints are consolidated after 128 updates or 1 MB of queued updates. A bounded coordinator coalesces file projection at roughly 100 ms for small documents and once per second for large documents. Per-document admission precedes shared storage work. Cold document loading is also serialized per document, outside the global room-cache lock. Uploads release the document lock before writing attachment bytes. The coordinator skips busy rooms and retains their filesystem notices for a later pass. Persistent I/O or decoding errors back off to five seconds; filesystem changes trigger an immediate retry. A “Saved to disk” receipt follows an fsynced file and a committed causal baseline. Missing causal updates after a reconnect trigger resynchronization before their checkpoints can complete. Desktop reconciliation uses a bounded, line-first diff outside the network runtime. Ordinary text edits use incremental validation and indexed source; media syntax changes use an exact reference parse. Checkpoints and file projection still process the full document. Documents are limited to 5 MB.

The editor uses LF positions internally; file writes preserve LF, CRLF and CR separators individually, including mixed-ending files and unchanged newline identities. File projection has explicit pending, blocked, interrupted, conflict and synced phases. Its durable intent freezes the target bytes, the exact CRDT state that produced them and the pre-write hash independently of newer accepted edits. Exceptional torn preimages are retained for repeated-crash recovery. Startup retries pending projections. If an interrupted write is followed by a different completed file save whose causal base is unknown, Locdoc archives the observed bytes and preserves the accepted state in a durable conflict. The document becomes read-only with **Recovery needed**; pending browser drafts stay intact and no save receipt completes. The owner chooses **Accepted document** or **File on disk** through **Your workspace → Collaboration recovery**, which archives both versions before rebuilding. Locdoc does not guess a merge in this case. Normal snapshots retain 50 versions; up to 20 separate recovery versions protect browser generations from stale desktop overwrites.

Unsynced browser changes are stored in IndexedDB and merged on reconnect. Read-only documents also open when that storage is blocked. Editable documents warn when offline recovery is unavailable and protect pending changes with an unload warning. Rejected or undecodable drafts are kept as downloadable recovery records instead of replaying on every reload; valid edits can continue from the accepted document. Older drafts affected by a line-ending migration are preserved for manual recovery. “Waiting for desktop file” means another program keeps the file open; long-lived read handles can also prevent the exclusive write lease. File opens return promptly when busy, so another program’s lease cannot stall saves on other documents. Whole-file desktop replacements do not identify a causal base, so Locdoc also retains the preceding accepted version in **Document options → Version history**. A desktop application replacing an old file wholesale can intentionally remove newer text; version history is the recovery path for that case.

Back up **both your docs directory (including `.assets`) and the state directory**. The latter contains the owner key, SQLite database, share links, history and collaboration metadata. Browser storage is a recovery aid, not a backup. For an online database backup use SQLite's backup API, rather than copying only its main file while WAL writes are active.

The state folder has an exclusive process lock. Its `root.identity` records the configured docs folder’s physical identity: a missing mount, unavailable root or unreadable subfolder cannot silently retire the workspace. Startup refuses a missing or replaced established root. To deliberately relocate a workspace, stop Locdoc, back up both folders, update the configuration, and remove only `root.identity` before restarting. Never remove the state database to reconnect a folder.

For damaged or oversized collaboration state, use **Your workspace → Collaboration recovery**. Download an owner-only recovery bundle, close other document tabs, then choose the accepted document or explicitly choose the file on disk. Rebuilding archives original state, updates, comments and file bytes before creating a fresh collaboration generation. Valid comment anchors and metadata are carried forward; undecodable or ambiguous metadata stays in the archive. Older offline drafts are offered for download rather than merged into a new generation automatically.

Removing a file or moving it out of the documents root retires its identity and revokes its links. **Your workspace → Removed document recovery** lets the owner download the last accepted text together with compatible unsynced drafts from this browser. The archive option preserves original collaboration data, versions, comments and local draft bytes when text cannot be reconstructed safely. Recovery only downloads a copy; it does not recreate files or reactivate sharing.

Use **Rename or move document** to change the filename or enter a path in another existing folder. Moves preserve document identity through a durable journal. Interrupted moves retry using the recorded file identity; conflicting files remain in place for owner recovery. Desktop moves within the docs root also preserve identity when the same device, inode and file birth time can be confirmed, including moves made while Locdoc is stopped. Copies, hardlink aliases and moves implemented as copy-then-delete are separate files; Locdoc never guesses identity from names or text. Update relative media links when moving files or folders. A move never grants access to a different private attachment merely because it has the same relative filename.

## Security

Markdown, filenames and comments are inert text. Locdoc does not run commands, evaluate code, render executable HTML, accept SVG uploads or load arbitrary remote media. CSP, CSRF/origin checks, hostname validation, bounded uploads/requests, connection-bound presence, per-address visitor limits (IPv6 grouped by /64), ping/pong timeouts, and server-side permissions protect HTTP and WebSocket operations. Link previews fetch bounded metadata with public-address checks and DNS pinning; no cookies, remote images or executable HTML are imported.

Random share links are bearer capabilities: anyone possessing an edit link can rewrite the shared content. Revocation cannot retract downloaded copies. Files outside the authorized document or folder remain private; media also requires a current reference and active per-document authorization. Uploads and trusted desktop imports can authorize local media. Arbitrary browser text edits, including completing or undoing pasted markup, cannot publish a previously removed local file; use Upload or add the reference from the trusted local file. Retained history permissions do not become new guest permissions. Owner keys are stored with mode 0600 inside a 0700 state directory. External local-file edits are trusted owner actions. Public HTTPS owner sessions use an HttpOnly, Secure host cookie; local HTTP sessions use origin-bound browser storage to avoid sharing credentials with unrelated localhost ports. Inert document rendering and a script policy without inline or evaluated code are required security boundaries. Keep dependencies updated and use HTTPS for public access.

Public HTTPS owner sessions use host-only secure cookies. Local HTTP sessions stay in origin-bound browser storage and authenticate HTTP and WebSocket requests without putting the session in a URL; another localhost port cannot replace or receive that credential. Existing local installations must sign in once again after this upgrade. Owner sessions are loaded into memory at startup and updated only after durable SQLite writes; unknown credentials do not enter the storage queue. Sockets reuse permission checks until sharing, identity or logout changes invalidate them, with a live heartbeat check for session expiry and missed filesystem events. Private local media uses a document-only capability that expires with the owner session and is revoked on logout. Comment responses expose whether the visitor may resolve a thread, without exposing stable guest identifiers or posting receipts.

Locdoc is a single-user-owned server, not an untrusted multi-tenant platform. It has no malware scanner, encrypted storage, or protection against a compromised operating system.

## Development and updates

```sh
npm run verify  # TypeScript, formatting, strict Clippy, staged web build, Rust/HTTP/WS/UI tests
npm test
```

The JavaScript test entry point builds its frontend once in `node_modules/.cache/locdoc-verified-web`; its server fixtures use that exact folder through `LOCDOC_WEB`, leaving the running `dist` and the state folder untouched. This also works for `npm test` and `npm run test:js` in a fresh checkout. Production defaults to `dist`. Tests use temporary directories, never your documents or owner key. The suite covers concurrent clients, comments, desktop writers, server restarts, permission changes, folder boundaries, request races and durable browser drafts.

Rust tests use four workers so parallel SQLite fsync and lease tests do not saturate the host. Node test files run serially through `scripts/test-node.sh`, with a 256 MiB V8 old-space limit, a 2 GiB Linux data-allocation limit per process (including native buffers), no core dumps and a ten-minute suite timeout. The allocation limit is not a combined process-tree or RSS limit. Explicit sync soaks up to thirty minutes extend the timeout. Use the same wrapper for focused tests:

```sh
bash scripts/test-node.sh --import tsx --test --test-name-pattern="sidebar refreshes" test/ui.test.tsx
```

Compare parser, editor and DOM object identities with `assert.ok(actual === expected, "short explanation")`; formatting these object graphs in an equality failure can consume enormous amounts of memory. For value assertions, compare small scalar projections.

The GitHub Actions workflow repeats verification in a clean environment on each push. It is optional; running Locdoc does not require GitHub or a runner.

Before updating, back up state and stop the service. Pull changes, run `npm ci`, `npm run verify`, `npm run build`, then start the service again. Deploy matching backend and frontend builds. Do not run a build into a live `dist` directory.

Architecture stays small: one Axum process, one SQLite database, ordinary Markdown files. `server/engine.rs` owns document commands and their transaction, publication, projection and receipt boundaries; `server/save.rs` defines its private projection phases. `server/documents.rs` owns file identity and journaled moves; `server/folders.rs` owns folder capabilities; `server/disk.rs` owns file leases; `server/comments.rs` plans source comments; `server/links.rs` owns safe previews; `server/security.rs` validates wire data and media authorization; `server/maintenance.rs` owns explicit archival recovery. The browser keeps document state below a keyed React boundary, so late async results cannot overwrite a different open document.

Shared-document links automatically preview the first heading (or filename), opening text, and app icon. The image keeps headings, line breaks, nested lists and checkboxes in a short, readable excerpt. Hidden comments, front matter, media paths, code blocks and raw HTML are excluded. Folder links preview their selected document. Rust generates the 1200×630 PNG with bundled fonts, a bounded cache and a small render queue; every request checks the current sharing permission, including cached images. Root and private document URLs use the generic app card. Set `LOCDOC_PUBLIC_URL` for correct absolute URLs. `npm run social:build` regenerates the generic app image with ImageMagick; document previews need no external renderer at runtime.

The Origami Hash icon, alternate Shell Cat draft and generation prompts are in `design/icon-options/`. `npm run icons:build` regenerates the icons with ImageMagick. `npm run fonts:update` refreshes the font catalog before a web build. Bundled fonts retain their upstream licenses in the dependency packages.
