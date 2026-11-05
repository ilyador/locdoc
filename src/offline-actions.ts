// Durable form submissions. File contents still travel only as CRDT updates;
// comments use their existing request UUIDs and uploads use a fixed asset UUID.
import {
  enqueueOffline,
  offlineDelete,
  offlineGet,
  offlineList,
  offlinePut,
  resourcePath,
  scopedKey,
  type CachedResource,
} from "./offline-db.ts";
import {
  cachedRead,
  currentOfflineScope,
  offlineCacheEnabled,
} from "./offline-cache.ts";
import type { Anchor } from "./editor-types.ts";
import type { Comment, Document } from "./model.ts";
import { changedOfflineFiles, queuedFiles } from "./offline-files.ts";

export type CommentAction = {
  key: string;
  type: "comment";
  path: string;
  document: string;
  target: string;
  method: string;
  body: {
    body?: string;
    name?: string;
    resolved?: boolean;
    quote?: string;
    anchor?: Anchor;
    requestId: string;
  };
  created: number;
  result?: Comment;
  error?: string;
};
export type UploadAction = {
  key: string;
  type: "upload";
  document: string;
  path: string;
  reference: string;
  resource: string;
  name: string;
  bytes: number;
  typeHint: string;
  upload: string;
  result?: { path: string; usage: number };
  error?: string;
};
export type FormAction = CommentAction | UploadAction;
export const notifyOfflineActions = changedOfflineFiles;
export const pauseOfflineDocument = (id: string) => {
  if (typeof window !== "undefined")
    window.dispatchEvent(
      new window.CustomEvent("locdoc-offline-pause", { detail: id }),
    );
};
export async function offlineDocumentBusy(id: string) {
  return (
    (await queuedActions()).some(
      (item) => item.type === "upload" && item.document === id && !item.result,
    ) ||
    (await queuedFiles()).some(
      (item) =>
        !item.result &&
        (item.command.document === id || item.command.children.includes(id)),
    )
  );
}
export async function offlineDocumentPending(id: string) {
  return (
    (await queuedActions()).some(
      (item) => item.document === id && !item.result,
    ) ||
    (await queuedFiles()).some(
      (item) =>
        !item.result &&
        (item.command.document === id || item.command.children.includes(id)),
    )
  );
}
export async function queuedActions() {
  if (!offlineCacheEnabled()) return [];
  const scope = await currentOfflineScope();
  return scope
    ? (await offlineList<FormAction>("commands", `${scope.scope}|`)).filter(
        (item) => item.type === "comment" || item.type === "upload",
      )
    : [];
}

export async function queueComment(path: string, init?: RequestInit) {
  if (!offlineCacheEnabled()) return;
  if (
    !/^\/api\/docs\/[\da-f-]+\/comments(?:\/[^/?]+)?(?:\?|$)/.test(path) ||
    !["POST", "PATCH"].includes(init?.method || "GET") ||
    typeof init?.body !== "string"
  )
    return;
  const scope = await currentOfflineScope();
  if (!scope) return;
  const url = new URL(path, location.origin);
  const parts = url.pathname.split("/");
  const document = parts[3];
  const target = parts[5] || "";
  const body = JSON.parse(init.body) as CommentAction["body"];
  if (
    body.body !== undefined &&
    (!body.body.trim() ||
      body.body.length > 4000 ||
      !body.name?.trim() ||
      body.name.length > 60)
  )
    throw new Error("Enter a name and a comment of at most 4,000 characters.");
  body.requestId ||= crypto.randomUUID();
  const queue = await queuedActions();
  if (
    !queue.some(
      (item) =>
        item.type === "comment" && item.body.requestId === body.requestId,
    )
  )
    await enqueueOffline(scope.scope, {
      type: "comment" as const,
      path,
      document,
      target,
      method: init!.method!,
      body,
      created: Math.floor(Date.now() / 1000),
    });
  notifyOfflineActions();
  return {
    handled: true,
    result: {
      id: target || `offline.${body.requestId}`,
      body: body.body || "",
      name: body.name || "",
      quote: body.quote || null,
      anchor: body.anchor || null,
      created: Math.floor(Date.now() / 1000),
      canResolve: true,
      resolved: body.resolved || false,
      replies: [],
    } satisfies Comment,
  };
}

export async function projectComments<T>(path: string, value: T): Promise<T> {
  const id = path.match(/^\/api\/docs\/([\da-f-]+)\/comments(?:\?|$)/)?.[1];
  if (!id) return value;
  let comments = [...(value as { comments: Comment[] }).comments];
  const queue = await queuedActions();
  const roots = new Map(
    queue
      .filter(
        (item): item is CommentAction =>
          item.type === "comment" && !item.target,
      )
      .map((item) => [
        `offline.${item.body.requestId}`,
        item.result?.id || `offline.${item.body.requestId}`,
      ]),
  );
  for (const action of queue) {
    if (action.type !== "comment" || action.document !== id || action.result)
      continue;
    const target = roots.get(action.target) || action.target;
    if (!target) {
      const item: Comment = {
        id: `offline.${action.body.requestId}`,
        body: action.body.body || "",
        name: action.body.name || "Guest",
        quote: action.body.quote || null,
        anchor: action.body.anchor || null,
        created: action.created,
        canResolve: true,
        resolved: false,
        replies: [],
      };
      if (!comments.some((comment) => comment.id === item.id))
        comments.push(item);
    } else
      comments = comments.map((comment) =>
        comment.id !== target
          ? comment
          : {
              ...comment,
              ...(action.body.resolved !== undefined
                ? { resolved: action.body.resolved }
                : {}),
              ...(action.body.body !== undefined
                ? {
                    replies: [
                      ...comment.replies,
                      {
                        body: action.body.body,
                        name: action.body.name || "Guest",
                        created: action.created,
                      },
                    ],
                  }
                : {}),
            },
      );
  }
  return { ...value, comments };
}

const extensions: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};
async function attachmentType(file: Blob) {
  const bytes = new Uint8Array(await file.slice(0, 512).arrayBuffer());
  const at = (start: number, length: number) =>
    String.fromCharCode(...bytes.subarray(start, start + length));
  if (
    [137, 80, 78, 71, 13, 10, 26, 10].every(
      (byte, index) => bytes[index] === byte,
    )
  )
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if (/^GIF8[79]a$/.test(at(0, 6))) return "image/gif";
  if (at(0, 4) === "RIFF" && at(8, 4) === "WEBP") return "image/webp";
  if (at(4, 4) === "ftyp") {
    const brands = at(8, 56);
    if (/avif|avis/.test(brands)) return "image/avif";
    if (brands.startsWith("qt  ")) return "video/quicktime";
    if (/^(isom|iso[2-9]|mp4[12]|avc1|M4[AV] |dash|MSNV)/.test(brands))
      return "video/mp4";
  }
  if (
    bytes[0] === 26 &&
    bytes[1] === 69 &&
    bytes[2] === 223 &&
    bytes[3] === 163 &&
    at(0, 512).includes("webm")
  )
    return "video/webm";
  throw new Error("Use PNG, JPEG, GIF, WebP, AVIF, MP4, WebM or MOV.");
}
export async function queueUpload(path: string, init: RequestInit | undefined) {
  if (!offlineCacheEnabled()) return;
  const id = path.match(/^\/api\/docs\/([\da-f-]+)\/upload(?:\?|$)/)?.[1];
  if (!id || init?.method !== "POST" || !(init.body instanceof FormData))
    return;
  const scope = await currentOfflineScope();
  if (!scope) return;
  const file = init.body.get("file");
  if (!(file instanceof Blob)) throw new Error("Choose an image or video.");
  if (file.size > 20_000_000)
    throw new Error("Images must be 5 MB or smaller; videos 20 MB or smaller.");
  const type = await attachmentType(file);
  const extension = extensions[type];
  const video = type.startsWith("video/");
  if (!file.size || file.size > (video ? 20 : 5) * 1_000_000)
    throw new Error(
      video
        ? "Videos must be 20 MB or smaller."
        : "Images must be 5 MB or smaller.",
    );
  const url = new URL(path, location.origin);
  const read = `/api/docs/${id}${url.search}`;
  const document = await cachedRead<Document>(read);
  if (!document?.body.edit)
    throw new Error("Open an editable document before adding media offline.");
  const liveUsage = Number(new Headers(init.headers).get("X-Locdoc-Usage"));
  const usage = Math.max(
    document.body.usage,
    Number.isFinite(liveUsage) ? liveUsage : 0,
  );
  const upload = crypto.randomUUID();
  const depth = document.body.path.split("/").length - 1;
  const reference = `${"../".repeat(depth)}.assets/${id}/${upload}.${extension}`;
  const media = `/api/docs/${id}/media?${new URLSearchParams({ path: reference })}`;
  const key = scopedKey(
    scope.scope,
    resourcePath(new URL(media, location.origin)),
  );
  // Store the blob before accepting its reference. A failed transaction keeps
  // the upload form and editor source unchanged.
  await offlinePut("resources", key, {
    blob: file,
    type,
    version: upload,
    pending: true,
  } satisfies CachedResource);
  let action: UploadAction & { reservedUsage?: number };
  try {
    action = await enqueueOffline(
      scope.scope,
      {
        type: "upload" as const,
        document: id,
        path: `/api/docs/${id}/upload/${upload}${url.search}`,
        reference,
        resource: key,
        name: "name" in file ? String(file.name) : "attachment",
        bytes: file.size,
        typeHint: type,
        upload,
      },
      { document: id, usage, bytes: file.size },
    );
  } catch (error) {
    await offlineDelete("resources", key);
    throw error;
  }
  pauseOfflineDocument(id);
  notifyOfflineActions();
  return {
    handled: true,
    result: { path: reference, usage: action.reservedUsage!, queued: true },
  };
}

export async function runAction(
  action: FormAction,
  send: <T>(path: string, init: RequestInit) => Promise<T>,
) {
  if (action.type === "upload") {
    const resource = await offlineGet<CachedResource>(
      "resources",
      action.resource,
    );
    if (!resource)
      throw new Error(
        `The offline attachment ${action.name} is unavailable. Add it again.`,
      );
    const data = new FormData();
    data.append("file", resource.blob, action.name);
    const result = await send<{ path: string; usage: number }>(action.path, {
      method: "POST",
      body: data,
    });
    if (result.path !== action.reference)
      throw new Error(
        "The attachment's detected format differs from its file type. Download it and add it again with the correct type.",
      );
    await offlinePut("resources", action.resource, {
      ...resource,
      pending: false,
    });
    await offlinePut("commands", action.key, {
      ...action,
      result,
      error: undefined,
    });
  } else {
    let target = action.target;
    if (target.startsWith("offline.")) {
      const requestId = target.slice(8);
      const root = (await queuedActions()).find(
        (entry): entry is CommentAction =>
          entry.type === "comment" && entry.body.requestId === requestId,
      );
      const scope = await currentOfflineScope();
      const mapped = scope
        ? await offlineGet<string>(
            "access",
            scopedKey(scope.scope, `comment:${requestId}`),
          )
        : undefined;
      if (!root?.result?.id && !mapped)
        throw new Error("The first comment must sync before its reply.");
      target = root?.result?.id || mapped!;
    }
    const url = new URL(action.path, location.origin);
    const path = `/api/docs/${action.document}/comments${target ? `/${encodeURIComponent(target)}` : ""}${url.search}`;
    const result = await send<Comment>(path, {
      method: action.method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(action.body),
    });
    if (!action.target) {
      const scope = await currentOfflineScope();
      if (scope)
        await offlinePut(
          "access",
          scopedKey(scope.scope, `comment:${action.body.requestId}`),
          result.id,
        );
    }
    await offlinePut("commands", action.key, {
      ...action,
      result,
      error: undefined,
    });
  }
  notifyOfflineActions();
}
