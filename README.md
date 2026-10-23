# Locdoc

A small, self-hosted Markdown and Fountain editor over real files. Write in your browser or your desktop editor, and share documents or folders without accounts.

- Real nested folders and ordinary UTF-8 `.md`, `.fountain` and `.txt` files.
- A searchable sidebar with **By date** and **Folders** tabs; your selected view is remembered locally.
- File actions as in a code editor's explorer, with a trash: a deleted document or folder can always be put back.
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

`npm start` and `npm run owner` load `.env`; environment variables override it. If you run the binary directly, export these variables yourself. Keep one server process per document/state directory. Files must be writable by the user running Locdoc. `LOCDOC_OWNER_NAME` is your display name until you save another under **Your workspace → Your display name**; that name is stored in the state folder, so every device shows it, and comments already written keep the name they were written with.

### Start automatically

After building and configuring the app:

```sh
npm run install:service
npm run owner
```

This installs and starts a **user** systemd service using your actual checkout path and `.env`. No administrator access is required. An existing service is preserved unless you pass `-- --replace`. Update it with the deploy script below.

```sh
systemctl --user status locdoc
systemctl --user restart locdoc
journalctl --user -u locdoc -n 50
```

To start before login, your administrator can optionally enable user lingering. For development use `npm run dev` (export environment variables first).

### Deploy updates

Releases live outside the checkout and the state folder, in `~/.local/share/locdoc/releases/<UTC time>-<commit>/` with the binary, the web build and a `manifest.json`. A `current` symlink names the running release. Once, install the release drop-in:

```sh
scripts/deploy.sh install-unit
```

This copies the build the service runs now into a first release, installs `deployment/locdoc-release.conf` as `~/.config/systemd/user/locdoc.service.d/release.conf` and reloads systemd. Locdoc keeps running until the next deploy restarts it. Then deploy a committed checkout:

```sh
git pull && npm ci && npm run verify
scripts/deploy.sh             # add --rehearse to start it against copies of your data first
```

The script refuses uncommitted changes, a commit that is already current (unless `--force`) and a unit that does not run `current/locdoc` with `LOCDOC_WEB` set to `current/web`. It builds the backend and frontend into `target/stage` and `target/stage-web` while the service keeps running, then smoke tests them on a free loopback port with temporary folders. `--rehearse` also starts the build against copies of the state database and documents folder. Before switching, it backs up the database (through SQLite's backup API), `owner.key`, `root.identity` and fonts into the release's `backup/` folder. After switching `current` and restarting, it checks the unit, `/api/config`, the served bundle, error-level journal lines, `PRAGMA integrity_check` and document, revision and comment counts. Any failure points `current` back at the previous release and restarts it. The newest five releases, the current one and its previous release are kept.

```sh
scripts/deploy.sh status
scripts/deploy.sh rollback                                 # the previous release
scripts/deploy.sh rollback 20261021T180516Z-0123456789ab   # a named release
```

Rollback runs the same checks but leaves the state folder as it is. The release `install-unit` adopted predates signed MCP client registrations: after rolling back to it, MCP connections approved since keep working only until their access token expires, within an hour, and must then be connected again, or roll forward. Rollback warns when this applies, and `restore` refuses to run while the adopted release is current, since it has no restore pass. That release, and any build of a commit from before the trash, can neither list nor restore **Recently deleted** items: they stay in `.locdoc-trash` until you roll forward, and rollback warns with their number when there are any. `LOCDOC_RELEASES`, `LOCDOC_SERVICE` and `LOCDOC_HEALTH_URL` override the defaults; `--no-restart` with `LOCDOC_STATE`, `LOCDOC_DOCS` and a non-default `LOCDOC_RELEASES` runs the flow against temporary folders without systemctl. See `scripts/deploy.sh --help`.

### Restore from a backup

A restore takes a snapshot folder holding `state/` (`locdoc.sqlite` taken through SQLite's backup API, `owner.key`, `root.identity` and `fonts`) and `docs/`, a copy of the documents folder made after the database, such as the `hourly.N` folders of an rsnapshot job. Back up in that order: files that changed after the database backup then win when restoring, and the accepted text they replace stays in **Version history**. Choose the newest snapshot from before the problem; the database time shows when each was taken:

```sh
ls -l --time-style=long-iso /backups/locdoc/hourly.*/state/locdoc.sqlite
scripts/deploy.sh restore /backups/locdoc/hourly.3
```

The script checks that the snapshot has an owner key, a documents folder and a database that passes `PRAGMA integrity_check` on a copy, and that there is room to copy them. It never changes the snapshot. It stops the service and copies the snapshot next to the live data, which stays untouched until the copies are complete. It then moves the documents folder to `DOCS.before-restore-TIME` and the state files (database and journals, `owner.key`, `root.identity`, `fonts`, an earlier `restore-report.json`) into `STATE/before-restore-TIME`, puts the copies in their place, runs `current/locdoc --restored` with the service's environment, starts the service and runs the deploy checks. A failure or interruption before the restored service passes those checks stops it, moves the previous data back, keeps the restored copies as `DOCS.failed-restore-TIME` and `STATE/failed-restore-TIME` and starts the service again. Nothing is deleted. A `root.identity` stays in the state folder throughout, so if the script itself is killed, as by a power cut, the service starts on the untouched live data or refuses to start; then the previous data is in the `before-restore-TIME` folders, to move back or to restore again. Pause backup jobs while restoring so they do not copy half-moved folders. The documents folder must be an ordinary folder that can be renamed, not a mount point.

The manual equivalent, with the service stopped and the service's `LOCDOC_STATE` and `LOCDOC_DOCS`:

```sh
systemctl --user stop locdoc
mv "$LOCDOC_DOCS" "$LOCDOC_DOCS.before-restore"
mkdir "$LOCDOC_STATE/before-restore"
mv "$LOCDOC_STATE"/{locdoc.sqlite*,owner.key,root.identity,fonts} "$LOCDOC_STATE/before-restore/"
cp -a SNAPSHOT/docs "$LOCDOC_DOCS"
cp -a SNAPSHOT/state/{locdoc.sqlite,owner.key,root.identity,fonts} "$LOCDOC_STATE/"   # those it has
LOCDOC_STATE="$LOCDOC_STATE" LOCDOC_DOCS="$LOCDOC_DOCS" ~/.local/share/locdoc/releases/current/locdoc --restored
systemctl --user start locdoc
```

Restored files all have new inodes and the copied documents folder is a new folder, so normal startup refuses it. `locdoc --restored` is a one-shot owner command for exactly this: it binds no port, refuses to run while another Locdoc process uses the state folder and, unlike the service, never falls back to folders relative to the working folder, so `LOCDOC_STATE` and `LOCDOC_DOCS` must both be set. It matches files to documents once. A recorded file identity comes first. A document whose file is found nowhere, not even under another name, then follows its last known text from the database, when exactly one restored file holds that text and no other document had it; this follows files moved between the two backup steps. Empty and whitespace-only texts match nothing, and a document never opened in Locdoc has no text in the database, so both can only keep their own path. Otherwise a document keeps the file at its own path, and one whose file is absent retires, with its text in **Removed document recovery**. Retiring revokes links, so a pass that would retire every document changes nothing: that copy is empty or the wrong one. Approved images are matched by their paths beside each document's recorded path; for a document that changed folders they stay approved where they were, as for any move. A rename the database backup caught half-done ends too, and its document is placed the same way. So does a folder move, delete or restore it caught half-done, and the pass moves no file for it: one the copy holds at its destination and not at its source completes. Edits the database backup still had to write to a file are applied once: unless the restored file holds the text from before them, it wins as any newer file does, and the accepted text stays in **Version history**. Only a pass that read every file accepts the restored folder; otherwise it exits non-zero, and normal startup keeps refusing the folder until a later pass completes, also for a backup without `root.identity`. `find "$LOCDOC_DOCS" ! -readable` lists what it could not read. The trash is evidence too, since a delete or a restore between the two backup steps leaves the database and the copy disagreeing. A document whose text the pass finds only in `.locdoc-trash` goes back into the trash under the item holding that text, with its original path, so **Recently deleted** can put it back; a folder deleted then is one item again. A trashed document whose text it finds outside the trash is restored there, and an item left with nothing in it leaves the trash. Other trashed documents stay in the trash, and one whose file the copy lacks retires once the service runs, its text kept for **Removed document recovery**. Normal operation never matches files by content.

The pass prints a summary and writes `STATE/restore-report.json`. For each document, active or in the trash, it lists `recordedPath`, where the database had it; `restoredPath`, where it is now (`null` once retired or in the trash); and `evidence`: `identity`, `content` (found by its text, usually because it moved, or came back from the trash, between the two backup steps), `path` (kept its own path; newer text in that file is imported when the service opens it), `retired` (absent from the snapshot), `trashed` (in Locdoc's trash) or `undecided` (not placed; the pass did not complete). `unclaimedFiles` are restored files no document claims; they open as new private documents. Folder links and folder MCP grants belong to the original folders, so `folderLinks` and `mcpFolders` list the ones that no longer open their folder: share or allow those folders again.

After checking the restored workspace, delete the previous data, and after a failed attempt the restored copies:

```sh
rm -rf -- "$LOCDOC_DOCS".before-restore-* "$LOCDOC_STATE"/before-restore-*
rm -rf -- "$LOCDOC_DOCS".failed-restore-* "$LOCDOC_STATE"/failed-restore-*
```

A release's `backup/` folder holds only the state from before that deploy. To return to it, stop the service, move the state files aside as above, copy the backup's files into the state folder, run `locdoc --restored` as above with a release this script built and start the service. The documents folder stays as it is, but the backup was taken while the service ran: the pass applies edits the backup still had to write to their files only once.

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

## Plain text

Name a document `.txt`, or place a `.txt` file in your documents folder, for
plain text. It edits as text, without Markdown formatting, the format bar, the
link picker or media: image syntax such as `![x](y.png)` is text in a `.txt`
file, so it never approves, serves or uploads an image. Comments use the same
`[[comment(...)]]` records as Markdown and Fountain, without Markdown rules: a
record in backticks, a fence, an indented line, HTML or a link is a comment too,
and only an escaped `\[[` stays text. Every line is a paragraph, so a new
comment goes at the end of the line where its passage ends; another one on that
line starts after a blank line the editor hides with the records. Adding a
comment never shows an empty line. A rename can change a document between `.md`,
`.fountain` and `.txt`; it keeps its links, comments and history. A plain text
document renamed to Markdown shows its image syntax as images to you, and to
link visitors only once you approve them.

## ChatGPT and MCP

Locdoc includes a Streamable HTTP MCP server in the same Rust process. No extra daemon, database or firewall port is needed. For ChatGPT, configure public HTTPS as described below and set `LOCDOC_PUBLIC_URL` to that exact origin.

1. Open [ChatGPT Plugins](https://chatgpt.com/plugins) and choose **Add custom MCP server**.
2. Enter your Locdoc URL followed by `/mcp`, for example `https://notes.example.com/mcp`.
3. Choose OAuth authentication and create the plugin. Locdoc supplies OAuth discovery and dynamic client registration.
4. In the Locdoc authorization page, check the application's return address and approve the requested read, edit and sharing permissions as the workspace owner. If that browser is locked, open the workspace as its owner first, then restart the connection.
5. Select the resulting plugin in a ChatGPT conversation.

Registration and the authorization page store nothing until the owner decides. Client IDs and pending requests are signed with a key derived from the owner key, so unauthenticated requests cannot fill or evict pending connections. A client must begin authorization within an hour of registering; once approved, it stays registered while its connection lasts. An authorization page expires after 10 minutes and accepts one decision. Replacing `owner.key` invalidates unapproved registrations and open authorization pages, not existing connections. Restart any authorization page opened before this upgrade.

ChatGPT account and workspace policies control whether custom MCP connections are available. See OpenAI's [connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt). Other MCP clients can use the same endpoint and OAuth discovery.

MCP access is **off by default**, including for documents with public links. As owner, open **Share → Allow MCP** for each document or folder you want connected apps to access. A folder grant covers its descendants and future files; inherited document access is marked “Allowed by folder.” Turning off a direct document grant does not override an enabled parent folder. Public-link settings stay separate. Only the owner can change these grants; MCP tools cannot enable themselves or broaden their access. Existing OAuth connections are restricted by the same allowlist.

Tools can list and search enabled documents, read source, create documents and folders, edit or move documents, manage document/folder links, participate in comments, and read or restore history. Moving to another folder requires that destination folder to be enabled for MCP. Creation is limited to enabled folders; root-level creation is not exposed. Comments and version history follow the same document restriction. File deletion, the trash and access outside the configured docs folder are not exposed; a document in the trash is refused like a removed one.

Every source read returns a SHA-256 revision. An edit must supply that revision; if a browser or desktop edit changed the source meanwhile, the command fails without replacing it. Use `replace_text` for a small change in a long document: the old text must match exactly once. A stale replacement retry fails without applying the change twice. Whole-source edits can also be retried harmlessly when their result is already present. Successful edits report durable acceptance separately from pending disk projection and use the same sync engine as the editor. Source offsets in paginated reads count Unicode characters.

The local owner key is never a connector credential. OAuth uses separate, expiring, revocable grants with `locdoc:read`, `locdoc:write` and `locdoc:share` permissions. **Your workspace → ChatGPT & MCP** lists connected applications and lets the owner disconnect them. Disconnection blocks new calls and refreshes; an operation already admitted may finish. Document contents are untrusted data, not instructions for a tool or model.

## Public sharing

For access outside this computer, point your hostname at it and reverse-proxy HTTPS to `127.0.0.1:3477`. A standalone [Caddy example](deployment/Caddyfile.snippet) includes WebSocket support. Set `LOCDOC_PUBLIC_URL=https://notes.example.com` in `.env`, restart Locdoc, then run `npm run owner -- --public` on the server computer to recognize your browser as owner at that address.

Locdoc compresses JSON, styles and scripts itself with Brotli or gzip, so the proxy does not need to. Images, videos and fonts are sent unchanged, so byte ranges and video seeking keep working, and pages too, whole for the crawlers that preview links. An open workspace asks for its document list every 4 seconds; when nothing changed, the server answers 304 with no body, so a phone that keeps a document open uses a few kilobytes a minute. The owner's tree and each folder link's view have separate tags, and a tag never stands in for access.

Forward and allow **TCP 80 and 443** for the HTTPS proxy. On an already enabled UFW firewall, use `sudo ufw allow 80/tcp` and `sudo ufw allow 443/tcp`. **Do not expose port 3477** publicly. UDP 443 is optional for HTTP/3. DNS, certificates, router and firewall changes are managed separately from Locdoc.

Choose **Share** in a document, or switch to the **Folders** tab and use the sharing icon beside a folder. A document's share dialog also offers **Share containing folder**.

- **View & comment** permits reading and commenting. **Edit & comment** also permits collaborative text edits. The owner always retains editing access.
- Folder links include nested folders and future documents added inside them. Guests get a searchable, scoped sidebar; they cannot browse the rest of your workspace or create/rename files.
- Folder access and individual document links are independent. Turning off a document's own link does not remove access granted through a shared parent folder. To remove that access, change the folder link or move the file outside the folder; access ends as soon as Locdoc finds the file outside, even while its new name is still being recorded.
- A document's own links, comments and history follow a move between folders. Folder access is recalculated from its current location; it is never copied onto the document.
- Turn a link private to revoke it, or choose **Replace link** to invalidate the old URL. Removing or replacing a shared folder invalidates its capability. A folder renamed or moved in Locdoc keeps its link, as do its subfolders' links; deleting it suspends them until it is restored. A folder share does not follow a rename made by another application; share the new location again.
- Visitors choose a display name without signing in and can change it under **Your workspace**; their browser remembers it. Names are labels, not verified identities.

## Writing and comments

Drag the sidebar's right edge to resize it on desktop; its width is remembered locally. Double-click the edge to restore the default width, or focus it and use the arrow keys. Folders start collapsed and open temporarily to reveal search matches.

One live-preview editor styles Markdown and reveals syntax near the cursor. Markdown preview updates reuse unchanged parser blocks and mapped decorations, including offscreen media and tables. Structural changes refresh the affected blocks; partial background parsing retains offscreen layout until those blocks are parsed again. The footer's word count and reading time catch up half a second after typing pauses, and every two seconds during longer typing, so counting a long document never runs on each keystroke. Use the toolbar for checkboxes, tables, links, media and comments. Font, size, line height, page width and light/dark appearance are browser preferences. Open aA for live controls in a bottom sheet on mobile or a column to the left of the document on desktop. The document stays visible and editable while you adjust Font, Layout and Theme. Google Fonts can be searched and installed locally by the owner.

Select text to comment, then open the small inline marker to read or reply. Comments also live in the raw Markdown:

```md
The passage being discussed[[comment(alex): this is my comment]]
[[comment(ana): this is a response]]
```

Adjacent records separated by spaces or one newline are replies in one conversation; a blank line starts another. Edit them from any desktop editor. In Markdown and Fountain, the web editor writes a new comment at the end of the text of the paragraph, heading or list item where its passage ends, before a heading's closing marks, so it adds no line; another conversation there starts after a blank line that the editor hides with the records, or, on a list item, goes to the end of the list. A passage selected with the line break after it gets its record after the passage. A table, fenced code or HTML block takes the record on the line after it, behind the blank line Markdown needs after a table or HTML block, which the editor hides too: adding a comment never shows an empty line. A record never makes another block of the line it joins, the selected passage stays anchored separately, and records inside code examples, HTML or Markdown link/image syntax remain literal. Plain text has its own rules; see [Plain text](#plain-text).

Each record occupies one physical line. Escape backslashes as `\\`, literal `]` as `\]`, `)` in names as `\)`, and message line breaks as `\n` or `\r`. Names allow 1–60 characters; messages allow 1–4,000. Comment text belongs to the file; SQLite retains anchors, timestamps and resolved state. File-added comments have no invented timestamp. Cutting and reinserting an unchanged conversation within the same document preserves its timestamps and resolved state when the entire conversation is unique and its original records were removed. Copies, altered conversations and ambiguous duplicates receive independent metadata; recreated raw text never inherits author permissions or posting receipts.

Images up to **5 MB**, videos up to **20 MB**, and total embeds up to **50 MB per document** are stored locally in `.assets/` under the docs directory. PNG, JPEG, GIF, WebP, AVIF, MP4, WebM and MOV are supported; playback depends on browser codecs. Relative Markdown media links remain usable in desktop editors. Removed attachments are retained for undo/history but no longer reserve embedding capacity once unused. Retained storage is separately limited to 200 MB per document and 10 GB per workspace; uploads leave at least 128 MB free. Existing files are never deleted automatically to enforce these limits.

To reclaim retained storage, the owner can delete unwanted files from `.assets/` locally. Uploads reconcile missing files before rejecting a retained storage limit; an upload still within its ten-minute insertion window remains reserved until that window ends.

Useful shortcuts: Ctrl/Cmd K to find a file or insert a link in the editor, Ctrl/Cmd F to find and replace (Enter and Shift+Enter step through matches, Escape closes), Alt G to select the word at the cursor and then each next occurrence, Ctrl/Cmd Alt M to comment, and Ctrl/Cmd Z to undo. Saves are automatic.

## Files, folders and the trash

The **Folders** tab offers file actions as in a code editor's explorer: **New File** and **New Folder** with an inline name, **Rename**, **Delete**, **Duplicate**, **Copy Path** and **Copy Relative Path**, and dragging documents and folders onto a folder or the root to move them. The **By date** tab offers the document actions that need no folder.

The sidebar works from the keyboard: the arrow keys, Home and End move between rows, Right and Left open and close folders, Enter opens a document, F2 renames, Delete deletes, and Shift+F10 or a row's **⋯** button opens its menu. On touch screens, where dragging is not available, the menu's **Move to…** moves an item into another folder. Every row stays in the page, so find in page reaches the whole list and the keyboard moves through it as before, but the rows are laid out in chunks of a few dozen: a chunk away from the screen is laid out only as it comes near it, and keeps the height its rows have when shown. A workspace of a thousand documents opens without laying out a thousand rows. Browsers without `content-visibility` lay out every row.

- **Rename or move a folder**, also into another folder. Its documents keep their ids, links, comments and history, and open documents stay open: edits still waiting for their file are written at the new path. Folder links and MCP folder grants follow the folder and its subfolders, and approved images inside it stay approved. A folder never moves into itself or one of its own folders, and a move never replaces anything at its destination. A state folder kept inside the documents folder is no part of the workspace, like the trash: walks, listings, folder links, MCP and media never enter it, no document or folder is created, renamed, moved, restored or duplicated into it, and neither it nor a folder holding it ever moves or goes to the trash. A documents folder kept inside the state folder works as any other.
- **Duplicate** creates a new private document without links. It holds the document's current accepted text, the collaboration state everyone sees rather than the file, which may not have caught up, without its comment records: a record on a line of its own leaves with its line. The copy keeps the original's line endings and only the image approvals the original had for files its references reach from the copy's folder.
- **Delete** never discards data. A deleted document or folder moves, by renaming, into `.locdoc-trash/<item>/<name>` at the root of the documents folder. Walks, listings, folder links, MCP and media never enter that hidden folder. Its documents keep their ids, comments, history, link settings and MCP grants; while they are in the trash their links, the folder's links and MCP folder grants are suspended and refuse visitors exactly as a removed document's do, and their open documents close. **Undo** or **Restore** in **Your workspace → Recently deleted** puts an item back at its original path, recreating missing folders on the way, with every link and grant working again. When something else has taken that path, restoring reports a conflict and changes nothing; move it aside and restore again. Edits accepted but not yet written when a document was deleted are written once it is back. Items stay in the trash until they are restored; there is no permanent delete. A document whose file another application removes from the trash retires like any removed document: its links end and **Removed document recovery** keeps its last accepted text, under its original path. Removing `.locdoc-trash` by hand empties the trash the same way.

Locdoc changes every filename through `server/namespace.rs`. Before a folder move, a delete or a restore touches the filesystem, it journals in SQLite the identity of the file or folder (device, inode and birth time) and its final path, after rehearsing the database change; it then renames without replacing anything, syncs both folders and commits the new paths, trash records, links and grants in one transaction. Startup, and every pass, settles a journaled move from where its entry is: found at its destination it commits, still only at its source it is carried out again, and anywhere else, or with its destination taken, it ends and passes place its documents by file identity. A delete's rename that carried a desktop save made in the meantime puts that save back. A folder delete trashes the documents whose files the moved folder holds: one a desktop application moved out of the folder before the rename stays where it went, and one moved in goes to the trash with the folder, its image approvals staying with the images it left behind. While a move is unsettled its documents are neither moved nor retired by passes, and their paths are neither listed nor reused. A trashed document's file stays its own: moved back into the documents folder by hand, it is listed only once its document has retired, as a new private document. Restores need no content matching: the file in the trash is the document's file.

## Sync, recovery and backups

Yjs in the browser and Yrs on the server merge concurrent edits. One document engine owns acceptance, durable commits, file projection, publication and save receipts. Handlers submit commands; transaction buffers and projection bookkeeping stay private to the engine. Source updates, comment metadata and attachment permissions commit together in SQLite before publication to collaborators.

Filesystem events import completed desktop saves; kernel file leases exclude unfinished desktop writes. Small edits append small transactions; collaboration checkpoints are consolidated after 128 updates or 1 MB of queued updates. A bounded coordinator coalesces file projection at roughly 100 ms for small documents and once per second for large documents. Per-document admission precedes shared storage work. Cold document loading is also serialized per document, outside the global room-cache lock. Uploads release the document lock before writing attachment bytes. The coordinator skips busy rooms and retains their filesystem notices for a later pass. Persistent I/O or decoding errors back off to five seconds; filesystem changes trigger an immediate retry. A “Saved to disk” receipt follows an fsynced file and a committed causal baseline. Missing causal updates after a reconnect trigger resynchronization before their checkpoints can complete. Desktop reconciliation uses a bounded, line-first diff outside the network runtime. Ordinary text edits use incremental validation and indexed source; media syntax changes use an exact reference parse. Checkpoints and file projection still process the full document. Documents are limited to 5 MB.

The editor uses LF positions internally; file writes preserve LF, CRLF and CR separators individually, including mixed-ending files and unchanged newline identities. File projection has explicit pending, blocked, interrupted, conflict and synced phases. Its durable intent freezes the target bytes, the exact CRDT state that produced them and the pre-write hash independently of newer accepted edits. Exceptional torn preimages are retained for repeated-crash recovery. Startup retries pending projections. If an interrupted write is followed by a different completed file save whose causal base is unknown, Locdoc archives the observed bytes and preserves the accepted state in a durable conflict. The document becomes read-only with **Recovery needed**; pending browser drafts stay intact and no save receipt completes. The owner chooses **Accepted document** or **File on disk** through **Your workspace → Collaboration recovery**, which archives both versions before rebuilding. Locdoc does not guess a merge in this case. Normal snapshots retain 50 versions; up to 20 separate recovery versions protect browser generations from stale desktop overwrites.

Unsynced browser changes are stored in IndexedDB and merged on reconnect. Read-only documents also open when that storage is blocked. Editable documents warn when offline recovery is unavailable and protect pending changes with an unload warning. Rejected or undecodable drafts are kept as downloadable recovery records instead of replaying on every reload; valid edits can continue from the accepted document. Older drafts affected by a line-ending migration are preserved for manual recovery. “Waiting for desktop file” means another program keeps the file open; long-lived read handles can also prevent the exclusive write lease. File opens return promptly when busy, so another program’s lease cannot stall saves on other documents. Whole-file desktop replacements do not identify a causal base, so Locdoc also retains the preceding accepted version in **Document options → Version history**. A desktop application replacing an old file wholesale can intentionally remove newer text; version history is the recovery path for that case.

Back up **both your docs directory (including `.assets` and `.locdoc-trash`) and the state directory**. The latter contains the owner key, SQLite database, share links, history and collaboration metadata. Browser storage is a recovery aid, not a backup. For an online database backup use SQLite's backup API, rather than copying only its main file while WAL writes are active. Back up the database first and the documents folder after it; [Restore from a backup](#restore-from-a-backup) describes restoring both.

The state folder has an exclusive process lock. Its `root.identity` records the configured docs folder’s physical identity: a missing mount, unavailable root or unreadable subfolder cannot silently retire the workspace. Startup refuses a missing or replaced established root, including a documents folder copied back from a backup until `locdoc --restored` has accepted it. When an established root is available but its files cannot be matched to documents yet, Locdoc starts anyway and keeps matching them in the background. To deliberately relocate a workspace, stop Locdoc, back up both folders, update the configuration, and remove only `root.identity` before restarting. Never remove the state database to reconnect a folder.

The sidebar, folder links and MCP listings show everything they can read, except a folder named `_attachments` that holds no document at any depth: like `.assets`, it is a document's image folder. Passes still walk it, its images keep working, and it is listed again once a document is in it. An unreadable subfolder appears empty, and the server logs it once until it can be read again. Listings never search the tree for moved files themselves: a file that is still being matched to its document appears once the background pass has matched it, and that pass backs off while an unreadable folder keeps a missing document waiting. Desktop saves do not bring it forward meanwhile, and saves of a new file at the waiting document's name do not search the tree either.

For damaged or oversized collaboration state, use **Your workspace → Collaboration recovery**. Download an owner-only recovery bundle, close other document tabs, then choose the accepted document or explicitly choose the file on disk. Rebuilding archives original state, updates, comments and file bytes before creating a fresh collaboration generation. Valid comment anchors and metadata are carried forward; undecodable or ambiguous metadata stays in the archive. Older offline drafts are offered for download rather than merged into a new generation automatically.

Removing a file or moving it out of the documents root retires its identity and revokes its links. Retirement waits until the folder has been quiet for a moment, since editors briefly remove or swap files while saving, and until a scan cannot find the file. A subfolder that cannot be listed postpones it until the subfolder can be read: for documents recorded inside that subfolder, and for every document while the user running Locdoc can enter it, since a subfolder inside could take files. Until then a postponed document keeps its path: creating or duplicating a document there, renaming one onto it, or moving a folder or restoring an item from the trash onto it is refused with a conflict that names the folder Locdoc cannot read. An MCP connection learns that folder's name only when it may use the folder. A document whose file had no recorded identity that a scan could find never waits, and a `lost+found` at the top of the documents folder that cannot be read postpones nothing. Once a scan has seen a document's name without its file, a file that appears there more than a second later, whether created or moved in, is not that document: while retirement waits, the old links keep serving the last accepted text and the new file stays unlisted, and afterwards it is a new private document. Saves that replace a file in place, or remove it and write it again at once, keep the document. **Your workspace → Removed document recovery** lets the owner download the last accepted text together with compatible unsynced drafts from this browser. The archive option preserves original collaboration data, versions, comments and local draft bytes when text cannot be reconstructed safely. Recovery only downloads a copy; it does not recreate files or reactivate sharing.

Use **Rename or move document** to change the filename or enter a path in another existing folder. Renames preserve document identity through a durable journal. An interrupted rename resumes from the recorded file identity; it is abandoned when another file took its destination or its file is under neither name, and the document is then found from its file identity. If a desktop save replaces the file during a rename, Locdoc puts the file back and reports that it changed; try again. Desktop moves within the docs root also preserve identity when the same device, inode and file birth time can be confirmed, including moves made while Locdoc is stopped. A recorded file identity outranks a path: when files are swapped or one is moved onto another document's old name, each document follows its own file, and a document whose file is gone retires instead of adopting another document's file. Until a pass has matched a file to its document, Locdoc neither reads nor saves it, whether it is another document's file or a new file at a moved document's name; accepted edits wait in Locdoc. A desktop save that replaces a document's file at the same path keeps that document. Copies and moves implemented as copy-then-delete are separate files; Locdoc never guesses identity from names or text. A hard link is another name for the same file, not another document: Locdoc does not list a second name for a document's file, and a document whose name becomes a link to another document's file retires instead of sharing it.

Approved local images and videos follow their files the same way. When a document moves together with them, as when you rename or move the folder holding both, its relative media links keep working for link visitors, also when the move happened while Locdoc was stopped. An image that stays behind remains approved only at its old location, even when a hard link or symlink in the new folder reaches it, so update its link. When that image later moves where the document names it, as when its folder follows the document, its approval follows it there; a second name for an image still at its old location does not. A different file with the same relative name at the new location stays private, even with identical bytes. An image that a desktop save replaced in place stays approved. Uploads in `.assets/` stay approved after any move; a move to a different folder depth needs their `../` links updated, as in desktop editors.

A document's **Share** dialog lists the images and videos your editor shows that link visitors cannot see, and why: the file is missing, outside the documents folder, in a hidden file or folder or in the state folder, over the 5 MB image or 20 MB video limit, not an image or video Locdoc can show, or named by a path Locdoc does not open, such as one with backslashes; or it was never approved for them, as with one typed in the browser or an approval an older version lost when its folder was renamed outside Locdoc. Reference-style images, linked images and images in table cells stay text in the editor, so the dialog leaves them out. Media that Locdoc serves to nobody, you included, says why in your editor too; link visitors see only its alt text. **Show to link visitors**, offered only for an image that was never approved, approves the ones you choose as adding them from your desktop editor would. Every open view of the document, link visitors' included, then requests once more the media it could not load, without a reload, as it does when a desktop edit approves media.

No approval lets link visitors see a file outside the documents folder, in the state folder or under a dot-named file or folder other than Locdoc's own `.assets` uploads at the top of the documents folder: neither **Show to link visitors**, nor a desktop edit, nor Locdoc's first load of a desktop file. An approval an older version recorded for such a file no longer serves it.

## Security

Markdown, filenames and comments are inert text. Locdoc does not run commands, evaluate code, render executable HTML, accept SVG uploads or load arbitrary remote media. CSP, CSRF/origin checks, hostname validation, bounded uploads/requests, connection-bound presence, per-address visitor limits (IPv6 grouped by /64), ping/pong timeouts, and server-side permissions protect HTTP and WebSocket operations. Link previews fetch bounded metadata with public-address checks and DNS pinning; no cookies, remote images or executable HTML are imported.

Random share links are bearer capabilities: anyone possessing an edit link can rewrite the shared content. Revocation cannot retract downloaded copies. Files outside the authorized document or folder remain private; media also requires a current reference and active per-document authorization. Uploads, trusted desktop imports and the owner's **Show to link visitors** can authorize local media inside the documents folder, outside the state folder and every hidden file or folder but Locdoc's `.assets` uploads. Arbitrary browser text edits, including completing or undoing pasted markup, cannot publish a previously removed local file; use Upload or add the reference from the trusted local file. Retained history permissions do not become new guest permissions. Owner keys are stored with mode 0600 inside a 0700 state directory. External local-file edits are trusted owner actions. Public HTTPS owner sessions use an HttpOnly, Secure host cookie; local HTTP sessions use origin-bound browser storage to avoid sharing credentials with unrelated localhost ports. Inert document rendering and a script policy without inline or evaluated code are required security boundaries. Keep dependencies updated and use HTTPS for public access.

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

Update a running service with `scripts/deploy.sh` (see [Deploy updates](#deploy-updates)); it deploys matching backend and frontend builds together. Do not run a build into a directory that a running service serves.

Architecture stays small: one Axum process, one SQLite database, ordinary Markdown files. `server/engine.rs` owns document commands and their transaction, publication, projection and receipt boundaries; `server/save.rs` defines its private projection phases. `server/namespace.rs` decides which file is which document and owns journaled moves, including folder moves, the trash and restores; `server/actions.rs` serves the owner's file actions; `server/documents.rs` owns document records, path normalization and creation; `server/folders.rs` owns folder capabilities; `server/disk.rs` owns file leases; `server/comments.rs` plans source comments; `server/links.rs` owns safe previews; `server/security.rs` validates wire data and media authorization; `server/maintenance.rs` owns explicit archival recovery. The browser keeps document state below a keyed React boundary, so late async results cannot overwrite a different open document.

Shared-document links automatically preview the first heading (or filename), opening text, and app icon. The image keeps headings, line breaks, nested lists and checkboxes in a short, readable excerpt. Hidden comments, front matter, media paths, code blocks and raw HTML are excluded. Folder links preview their selected document. Rust generates the 1200×630 PNG with bundled fonts, a bounded cache and a small render queue; every request checks the current sharing permission, including cached images. Root and private document URLs use the generic app card. Set `LOCDOC_PUBLIC_URL` for correct absolute URLs. `npm run social:build` regenerates the generic app image with ImageMagick; document previews need no external renderer at runtime.

The Origami Hash icon, alternate Shell Cat draft and generation prompts are in `design/icon-options/`. `npm run icons:build` regenerates the icons with ImageMagick. `npm run fonts:update` refreshes the font catalog before a web build. Bundled fonts retain their upstream licenses in the dependency packages.
