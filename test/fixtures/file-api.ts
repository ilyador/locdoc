import { createHash } from "node:crypto";
import * as Y from "yjs";

// An in-memory owner API for the sidebar's file actions, following this
// wave's contract: tree, create, rename and move, folder moves, duplicate,
// trash and restore. A listing captures the tree when it is requested, so a
// held listing answers with the tree as it was, like a slow real request.

type Item = {
  path: string;
  kind: "file" | "folder";
  id: string | null;
  shared: boolean;
  modified: number;
  title: string;
  format?: string;
};
type Trashed = {
  id: string;
  kind: "document" | "folder";
  path: string;
  deleted: number;
  documents: number;
  items: Item[];
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const name = (path: string) => path.split("/").pop() || "";
const parent = (path: string) => path.split("/").slice(0, -1).join("/");
const within = (path: string, folder: string) =>
  path === folder || path.startsWith(`${folder}/`);
const format = (path: string) =>
  /\.fountain$/i.test(path)
    ? "fountain"
    : /\.txt$/i.test(path)
      ? "text"
      : "markdown";
const item = (path: string, id: string | null, modified: number): Item => ({
  path,
  kind: id === null ? "folder" : "file",
  id,
  shared: false,
  modified,
  title:
    id === null ? name(path) : name(path).replace(/\.(md|fountain|txt)$/i, ""),
  ...(id === null ? {} : { format: format(path) }),
});

export function fileApi(
  paths: string[],
  { root = "/srv/docs" }: { root?: string } = {},
) {
  let created = 0;
  let trashed = 0;
  let time = 1_000_000;
  const items: Item[] = paths.map((path, index) =>
    path.endsWith("/")
      ? item(path.slice(0, -1), null, 0)
      : item(path, path.replace(/\W+/g, "-").toLowerCase(), 1_000 + index),
  );
  const texts = new Map<string, string>();
  const trash: Trashed[] = [];
  const calls: {
    method: string;
    path: string;
    body?: any;
    // A listing's request: the tag it named, and whether it was answered
    // 304, or 226 with only what changed since the listing it named.
    held?: string | null;
    unchanged?: boolean;
    spliced?: boolean;
  }[] = [];
  // The listings sent, by tag, as a server keeps the last few it sent.
  const sent = new Map<string, Item[]>();
  const holds = new Map<string, () => Promise<void>>();
  const failures = new Map<string, { status: number; error: string }>();
  const exists = (path: string) => items.some((other) => other.path === path);
  const taken = () =>
    json(409, { error: "A file or folder with this name already exists." });
  const trashItem = ({ items: _, ...rest }: Trashed) => rest;
  const payload = (doc: Item) => {
    const ydoc = new Y.Doc();
    const content = texts.get(doc.id!) ?? `${doc.title} text`;
    ydoc.getText("content").insert(0, content);
    const state = Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString("base64");
    ydoc.destroy();
    return {
      id: doc.id,
      path: doc.path,
      owner: true,
      edit: true,
      permission: "private",
      shareUrl: null,
      usage: 0,
      content,
      modified: doc.modified,
      state,
    };
  };
  async function fetch(input: RequestInfo | URL, init: RequestInit = {}) {
    const url = new URL(String(input), "http://localhost");
    const method = (init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const route = url.pathname;
    const call: (typeof calls)[number] = { method, path: route, body };
    calls.push(call);
    const key = `${method} ${route}`;
    const listing = structuredClone(items);
    const hold = holds.get(key);
    if (hold) {
      holds.delete(key);
      await hold();
    }
    const failure = failures.get(key);
    if (failure) {
      failures.delete(key);
      return json(failure.status, { error: failure.error });
    }
    if (route === "/api/config")
      return json(200, {
        owner: true,
        root,
        guest: "guest",
        publicUrl: "http://localhost",
        ownerName: "Owner",
      });
    if (route === "/api/tree") {
      // As the server does: the listing a request names by its tag is
      // answered 304, without a body, and a caller that holds one sent
      // earlier and accepts splices is sent only what changed since.
      const tag = `W/"${createHash("sha256").update(JSON.stringify(listing)).digest("hex").slice(0, 32)}"`;
      const headers = new Headers(init.headers);
      call.held = headers.get("If-None-Match");
      call.unchanged = call.held === tag;
      if (call.unchanged)
        return new Response(null, { status: 304, headers: { etag: tag } });
      const base =
        headers.get("A-IM") === "splice" && call.held
          ? sent.get(call.held)
          : undefined;
      sent.set(tag, listing);
      call.spliced = !!base;
      if (base) {
        // One edit, from the first entry that differs to the last.
        const same = (a?: Item, b?: Item) =>
          JSON.stringify(a) === JSON.stringify(b);
        let start = 0;
        while (start < base.length && same(base[start], listing[start]))
          start++;
        let end = 0;
        while (
          end < base.length - start &&
          end < listing.length - start &&
          same(base[base.length - 1 - end], listing[listing.length - 1 - end])
        )
          end++;
        const edits = [
          [
            start,
            base.length - start - end,
            listing.slice(start, listing.length - end),
          ],
        ];
        return new Response(JSON.stringify({ edits }), {
          status: 226,
          headers: {
            "content-type": "application/json",
            etag: tag,
            im: "splice",
            "delta-base": call.held!,
          },
        });
      }
      return new Response(JSON.stringify({ entries: listing }), {
        status: 200,
        headers: { "content-type": "application/json", etag: tag },
      });
    }
    if (route === "/api/files" && method === "POST") {
      if (exists(body.path)) return taken();
      if (body.kind === "file" && !/\.(md|fountain|txt)$/i.test(body.path))
        return json(400, { error: "Document names must end with .md, .fountain or .txt." });
      const id = body.kind === "file" ? `new-${++created}` : null;
      items.push(item(body.path, id, ++time));
      return json(200, id ? { id, path: body.path } : { ok: true });
    }
    if (route === "/api/folders" && method === "PATCH") {
      if (exists(body.to)) return taken();
      if (within(body.to, body.from))
        return json(400, { error: "A folder cannot move into itself." });
      for (const other of items)
        if (within(other.path, body.from)) {
          other.path = body.to + other.path.slice(body.from.length);
          if (other.path === body.to) other.title = name(body.to);
        }
      return json(200, { ok: true, path: body.to });
    }
    if (route === "/api/folders" && method === "DELETE")
      return remove(items.find((other) => other.path === body.path));
    if (route === "/api/trash") {
      return json(200, {
        items: [...trash].sort((a, b) => b.deleted - a.deleted).map(trashItem),
      });
    }
    const restore = /^\/api\/trash\/([^/]+)\/restore$/.exec(route);
    if (restore && method === "POST") {
      const entry = trash.find((other) => other.id === restore[1]);
      if (!entry) return json(404, { error: "Not in the trash." });
      if (exists(entry.path))
        return json(409, {
          error: `${entry.path} is taken. Rename or move that item, then restore again.`,
        });
      trash.splice(trash.indexOf(entry), 1);
      items.push(...entry.items);
      return json(200, { ok: true, path: entry.path });
    }
    const document = /^\/api\/docs\/([^/]+)(\/duplicate)?$/.exec(route);
    if (document) {
      const id = decodeURIComponent(document[1]);
      const doc = items.find((other) => other.id === id);
      const trashed = trash.find((other) =>
        other.items.some((entry) => entry.id === id),
      );
      if (!doc)
        return trashed
          ? json(410, {
              error: "trashed",
              trash: trashItem(trashed),
              // The document's own former path; a folder item names the folder.
              path: trashed.items.find((entry) => entry.id === id)!.path,
            })
          : json(404, { error: "Document not found." });
      if (document[2] && method === "POST") {
        if (exists(body.path)) return taken();
        const copy = item(body.path, `copy-${++created}`, ++time);
        items.push(copy);
        return json(200, { id: copy.id, path: copy.path });
      }
      if (method === "PATCH") {
        if (exists(body.path)) return taken();
        doc.path = body.path;
        doc.title = name(body.path).replace(/\.(md|fountain|txt)$/i, "");
        doc.format = format(body.path);
        return json(200, { ok: true });
      }
      if (method === "DELETE") return remove(doc);
      return json(200, payload(doc));
    }
    if (route.startsWith("/api/docs/")) return json(200, { comments: [] });
    return json(200, {});
  }
  function remove(target: Item | undefined) {
    if (!target) return json(404, { error: "Not found." });
    const removed = items.filter((other) => within(other.path, target.path));
    for (const entry of removed) items.splice(items.indexOf(entry), 1);
    const entry: Trashed = {
      id: `trash-${++trashed}`,
      kind: target.kind === "folder" ? "folder" : "document",
      path: target.path,
      deleted: ++time,
      documents: removed.filter((other) => other.kind === "file").length,
      items: removed,
    };
    trash.push(entry);
    return json(200, { ok: true, trash: trashItem(entry) });
  }
  return {
    fetch,
    items,
    trash,
    calls,
    texts,
    paths: () => items.map((other) => other.path).sort(),
    // The next matching request waits until the returned function runs.
    hold(key: string) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      holds.set(key, () => gate);
      return release;
    },
    fail(key: string, status: number, error: string) {
      failures.set(key, { status, error });
    },
    // A desktop app or another tab renamed a document.
    rename(from: string, to: string) {
      const doc = items.find((other) => other.path === from)!;
      doc.path = to;
      doc.title = name(to).replace(/\.(md|fountain|txt)$/i, "");
      doc.format = format(to);
    },
    parent,
  };
}
