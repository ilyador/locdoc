# Locdoc

A small, self-hosted Markdown and Fountain editor over real files. Write in your browser or your desktop editor, and share documents or folders without accounts.

- Real nested folders and ordinary UTF-8 `.md` and `.fountain` files.
- Autosave, live Markdown formatting, task lists, tables, local images and videos.
- Live Fountain screenplay formatting: scene headings, dialogue, parentheticals, transitions, title pages, notes, and dual dialogue.
- Collaborative editing with visible cursors and inline comments.
- Document and folder links with **view & comment** or **edit & comment** access.
- Searchable document links, link previews, local fonts, automatic dark mode, and mobile layouts.
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


## Public sharing

For access outside this computer, point your hostname at it and reverse-proxy HTTPS to `127.0.0.1:3477`. A standalone [Caddy example](deployment/Caddyfile.snippet) includes WebSocket support. Set `LOCDOC_PUBLIC_URL=https://notes.example.com` in `.env`, restart Locdoc, then run `npm run owner -- --public` on the server computer to recognize your browser as owner at that address.

Forward and allow **TCP 80 and 443** for the HTTPS proxy. On an already enabled UFW firewall, use `sudo ufw allow 80/tcp` and `sudo ufw allow 443/tcp`. **Do not expose port 3477** publicly. UDP 443 is optional for HTTP/3. DNS, certificates, router and firewall changes are managed separately from Locdoc.

Choose **Share** in a document, or expand **Folders** and use the sharing icon beside a folder. A document's share dialog also offers **Share containing folder**.

- **View & comment** permits reading and commenting. **Edit & comment** also permits collaborative text edits. The owner always retains editing access.
- Folder links include nested folders and future Markdown files added inside them. Guests get a searchable, scoped sidebar; they cannot browse the rest of your workspace or create/rename files.
- Folder access and individual document links are independent. Turning off a document's own link does not remove access granted through a shared parent folder. To remove that access, change the folder link or move the file outside the folder.
- Turn a link private to revoke it, or choose **Replace link** to invalidate the old URL. Moving, removing, or replacing a shared folder invalidates its capability. A folder share does not follow an external rename; share the new location again.
- Visitors choose a display name without signing in. Names are labels, not verified identities.

## Writing and comments

One live-preview editor styles Markdown and reveals syntax near the cursor. Use the toolbar for checkboxes, tables, links, media and comments. Font, size, line height, page width and light/dark appearance are browser preferences. Google Fonts can be searched and installed locally by the owner.

Select text to comment, then open the small inline marker to read or reply. Comments also live in the raw Markdown:

```md
The passage being discussed[[comment(alex): this is my comment]]
[[comment(ana): this is a response]]
```

Adjacent records separated by spaces or one newline are replies in one conversation; a blank line starts another. Records can follow a passage on their own line. Edit them from any desktop editor. Records inside code examples, HTML or Markdown link/image syntax remain literal.

Each record occupies one physical line. Escape backslashes as `\\`, literal `]` as `\]`, `)` in names as `\)`, and message line breaks as `\n` or `\r`. Names allow 1–60 characters; messages allow 1–4,000. Comment text belongs to the file; SQLite retains anchors, timestamps and resolved state. File-added comments have no invented timestamp.

Images up to **5 MB**, videos up to **20 MB**, and total embeds up to **50 MB per document** are stored locally in `.assets/` under the docs directory. PNG, JPEG, GIF, WebP, AVIF, MP4, WebM and MOV are supported; playback depends on browser codecs. Relative Markdown media links remain usable in desktop editors. Removed attachments are retained for undo/history but no longer reserve embedding capacity once unused.

Useful shortcuts: Ctrl/Cmd K to find a file or insert a link in the editor, Ctrl/Cmd F to search text, Ctrl/Cmd Alt M to comment, and Ctrl/Cmd Z to undo. Saves are automatic.

## Sync, recovery and backups

Yjs in the browser and Yrs on the server merge concurrent edits. Filesystem events import completed desktop saves; kernel file leases prevent partial-save imports and prevent overwriting a desktop writer's unfinished file. Accepted CRDT state, disk baselines and write intent are durable in SQLite. A “Saved to disk” receipt follows an fsynced Markdown projection.

Unsynced browser changes are stored in IndexedDB and merged on reconnect. “Waiting for desktop file” means another program still holds a write handle. Whole-file desktop replacements do not identify a causal base, so Locdoc also retains the preceding accepted version in **Document options → Version history**. A desktop application replacing an old file wholesale can intentionally remove newer text; version history is the recovery path for that case.

Back up **both your docs directory (including `.assets`) and the state directory**. The latter contains the owner key, SQLite database, share links, history and collaboration metadata. Browser storage is a recovery aid, not a backup. For an online database backup use SQLite's backup API, rather than copying only its main file while WAL writes are active.

Renaming from the app preserves document identity. External moves are discovered as new paths and do not carry individual sharing links. Update relative media links when moving files or folders.

## Security

Markdown, filenames and comments are inert text. Locdoc does not run commands, evaluate code, render executable HTML, accept SVG uploads or load arbitrary remote media. CSP, CSRF/origin checks, hostname validation, bounded uploads/requests, validated presence, and server-side permissions protect HTTP and WebSocket operations. Link previews fetch bounded metadata with public-address checks and DNS pinning; no cookies, remote images or executable HTML are imported.

Random share links are bearer capabilities: anyone possessing an edit link can rewrite the shared content. Revocation cannot retract downloaded copies. Files outside the authorized document or folder remain private; media also requires a current reference and a per-document grant. Owner keys are stored with mode 0600 inside a 0700 state directory. External local-file edits are trusted owner actions. Keep dependencies updated and use HTTPS for public access.

Locdoc is a single-user-owned server, not an untrusted multi-tenant platform. It has no malware scanner, encrypted storage, or protection against a compromised operating system.

## Development and updates

```sh
npm run verify  # TypeScript, formatting, strict Clippy, Rust/HTTP/WS/UI tests, staged web build
npm test
```

Verification writes its web build to `.locdoc/verified-web`, leaving the running `dist` untouched. Tests use temporary directories, never your documents or owner key. The suite covers concurrent clients, comments, desktop writers, server restarts, permission changes, folder boundaries, request races and durable browser drafts.

Before updating, back up state and stop the service. Pull changes, run `npm ci`, `npm run verify`, `npm run build`, then start the service again. Deploy matching backend and frontend builds. Do not run a build into a live `dist` directory.

Architecture stays small: one Axum process, one SQLite database, ordinary Markdown files. `server/documents.rs` owns file identity; `server/folders.rs` owns folder capabilities; `server/disk.rs` owns file leases; `server/comments.rs` owns source comments; `server/links.rs` owns safe previews. The browser keeps document state below a keyed React boundary, so late async results cannot overwrite a different open document.

Shared-document links automatically preview the first heading (or filename), opening text, and app icon. The image keeps headings, line breaks, nested lists and checkboxes in a short, readable excerpt. Hidden comments, front matter, media paths, code blocks and raw HTML are excluded. Folder links preview their selected document. Rust generates the 1200×630 PNG with bundled fonts, a bounded cache and a small render queue; every request checks the current sharing permission, including cached images. Root and private document URLs use the generic app card. Set `LOCDOC_PUBLIC_URL` for correct absolute URLs. `npm run social:build` regenerates the generic app image with ImageMagick; document previews need no external renderer at runtime.

The Origami Hash icon, alternate Shell Cat draft and generation prompts are in `design/icon-options/`. `npm run icons:build` regenerates the icons with ImageMagick. `npm run fonts:update` refreshes the font catalog before a web build. Bundled fonts retain their upstream licenses in the dependency packages.
