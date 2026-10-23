import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";
import * as Y from "yjs";
import React from "react";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  location: dom.window.location,
  localStorage: dom.window.localStorage,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  React,
});
const { render, fireEvent, waitFor, act, cleanup } =
  await import("@testing-library/react");
const { RemovedDocumentRecovery } =
  await import("../src/removed-document-recovery");
const { DraftJournal, archiveOwnerDrafts } = await import("../src/drafts");
const originalFetch = globalThis.fetch;
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
const originalClick = dom.window.HTMLAnchorElement.prototype.click;
const downloads: { name: string; blob: Blob }[] = [];
const blobs = new Map<string, Blob>();
URL.createObjectURL = (blob) => {
  const id = `blob:${crypto.randomUUID()}`;
  blobs.set(id, blob);
  return id;
};
URL.revokeObjectURL = (url) => {
  blobs.delete(url);
};
dom.window.HTMLAnchorElement.prototype.click = function () {
  downloads.push({ name: this.download, blob: blobs.get(this.href)! });
};
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  downloads.length = 0;
});
after(() => {
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  dom.window.HTMLAnchorElement.prototype.click = originalClick;
  dom.window.close();
});
function fixture() {
  const accepted = new Y.Doc();
  accepted.getText("content").insert(0, "Accepted source\n");
  const id = crypto.randomUUID();
  return {
    accepted,
    entry: { id, path: "folder/removed.md", removed: 123 },
    bundle: {
      document: id,
      path: "folder/removed.md",
      state: Buffer.from(Y.encodeStateAsUpdate(accepted)).toString("base64"),
      liveState: null,
      updates: [],
      collaborationEpoch: "",
      versions: [{ content: "Older source" }],
    },
  };
}
const response = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });

test("removed recovery opens on demand and downloads readable text while retaining the local outbox", async () => {
  const { accepted, entry, bundle } = fixture();
  const edited = new Y.Doc();
  Y.applyUpdate(edited, Y.encodeStateAsUpdate(accepted));
  const journal = new DraftJournal(edited, `owner/${entry.id}`);
  journal.bind("server");
  edited.getText("content").insert(0, "Offline addition. ");
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    return response(
      url === "/api/recovery/removed"
        ? [entry]
        : url.endsWith("?history=false")
          ? { ...bundle, versions: [] }
          : bundle,
    );
  };
  try {
    const page = render(<RemovedDocumentRecovery />);
    assert.equal(requests.length, 0);
    fireEvent.click(page.getByText("Removed document recovery"));
    await waitFor(() => assert.ok(page.queryByText(entry.path)));
    fireEvent.click(page.getByRole("button", { name: "Text" }));
    await waitFor(() => assert.equal(downloads.length, 1));
    assert.equal(downloads[0].name, "removed.md");
    assert.equal(requests[1], `/api/docs/${entry.id}/recovery?history=false`);
    assert.equal(
      await downloads[0].blob.text(),
      "Offline addition. Accepted source\n",
    );
    assert.equal((await archiveOwnerDrafts(entry.id)).length, 1);
    assert.equal(journal.pending, true);
    fireEvent.click(
      page.getByRole("button", {
        name: `Download recovery archive for ${entry.path}`,
      }),
    );
    await waitFor(() => assert.equal(downloads.length, 2));
    assert.equal(requests[2], `/api/docs/${entry.id}/recovery?history=true`);
    const archive = JSON.parse(await downloads[1].blob.text());
    assert.equal(archive.versions[0].content, "Older source");
    assert.equal(archive.browserDrafts.length, 1);
    assert.ok(Array.isArray(archive.browserDrafts[0].state));
  } finally {
    await journal.flush();
    await journal.acknowledge(journal.checkpoint());
    journal.dispose();
    accepted.destroy();
    edited.destroy();
  }
});

test("a text decoding failure offers the explicit complete archive without downloading a partial recovery bundle", async () => {
  const { accepted, entry, bundle } = fixture();
  const corrupt = { ...bundle, state: Buffer.from([255]).toString("base64") };
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    return response(
      url === "/api/recovery/removed"
        ? [entry]
        : url.endsWith("?history=false")
          ? { ...corrupt, versions: [] }
          : corrupt,
    );
  };
  try {
    const page = render(<RemovedDocumentRecovery />);
    fireEvent.click(page.getByText("Removed document recovery"));
    await waitFor(() => assert.ok(page.queryByText(entry.path)));
    fireEvent.click(page.getByRole("button", { name: "Text" }));
    await waitFor(() =>
      assert.match(page.getByRole("alert").textContent || "", /Choose Archive/),
    );
    assert.equal(downloads.length, 0);
    assert.equal(requests[1], `/api/docs/${entry.id}/recovery?history=false`);
    fireEvent.click(
      page.getByRole("button", {
        name: `Download recovery archive for ${entry.path}`,
      }),
    );
    await waitFor(() => assert.equal(downloads.length, 1));
    const archive = JSON.parse(await downloads[0].blob.text());
    assert.equal(archive.state, corrupt.state);
    assert.equal(archive.versions[0].content, "Older source");
    assert.equal(requests[2], `/api/docs/${entry.id}/recovery?history=true`);
  } finally {
    accepted.destroy();
  }
});

for (const action of ["collapse", "navigate"])
  test(`${action} cancels a late response and cannot download a closed recovery document`, async () => {
    const { accepted, entry, bundle } = fixture();
    let finish: ((response: Response) => void) | undefined;
    globalThis.fetch = async (input) =>
      String(input) === "/api/recovery/removed"
        ? response([entry])
        : new Promise<Response>((resolve) => {
            finish = resolve;
          });
    const page = render(<RemovedDocumentRecovery />);
    fireEvent.click(page.getByText("Removed document recovery"));
    await waitFor(() => assert.ok(page.queryByText(entry.path)));
    fireEvent.click(page.getByRole("button", { name: "Text" }));
    await waitFor(() => assert.ok(finish));
    if (action === "navigate") page.unmount();
    else {
      fireEvent.click(page.getByText("Removed document recovery"));
      await waitFor(() =>
        assert.equal(
          page.getByText("Removed document recovery").closest("details")!.open,
          false,
        ),
      );
    }
    await act(async () => {
      finish!(response(bundle));
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
    assert.equal(downloads.length, 0);
    accepted.destroy();
  });
