import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React from "react";

let dom, render, screen, fireEvent, waitFor, act, cleanup;
let McpAccessControl, ShareControls, FolderShare;
const originalFetch = globalThis.fetch;
const access = (allowed = false, inherited = false) => ({
  mcpAllowed: allowed,
  mcpDirect: allowed && !inherited,
  mcpInherited: inherited,
});
const response = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

before(async () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
  });
  for (const key of [
    "window",
    "document",
    "location",
    "localStorage",
    "navigator",
    "Node",
    "Element",
    "HTMLElement",
    "HTMLInputElement",
    "MutationObserver",
  ]) {
    Object.defineProperty(globalThis, key, {
      value: dom.window[key],
      configurable: true,
      writable: true,
    });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  ({ render, screen, fireEvent, waitFor, act, cleanup } =
    await import("@testing-library/react"));
  ({ McpAccessControl, ShareControls, FolderShare } =
    await import("../src/sharing.tsx"));
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
after(() => dom.window.close());

test("MCP access is separate from a private document's public link", async () => {
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return response(access(true));
  };
  render(
    <ShareControls
      value={{ permission: "private", shareUrl: null }}
      name="Owner"
      mcpTarget={{ kind: "document", id: "private-note" }}
      onChange={async () => assert.fail("MCP must not change public sharing")}
    />,
  );
  await waitFor(() =>
    assert.equal(
      screen.getByRole("switch", { name: "Allow MCP" }).checked,
      true,
    ),
  );
  assert.equal(screen.getByLabelText("Link access").value, "private");
  assert.deepEqual(requests, ["/api/docs/private-note/mcp"]);
});

test("MCP grants wait for success, preserve failures and can be retried", async () => {
  let finish,
    fail = true;
  const mutations = [];
  globalThis.fetch = async (_url, init = {}) => {
    if (init.method !== "POST") return response(access());
    mutations.push(JSON.parse(init.body));
    if (fail) return response({ error: "Could not save access" }, 503);
    return await new Promise((resolve) => {
      finish = () => resolve(response(access(true)));
    });
  };
  render(<McpAccessControl target={{ kind: "document", id: "note" }} />);
  const control = screen.getByRole("switch", { name: "Allow MCP" });
  await waitFor(() => assert.equal(control.disabled, false));
  assert.equal(control.checked, false);
  fireEvent.click(control);
  await waitFor(() =>
    assert.equal(
      screen.getByRole("alert").textContent,
      "Could not save access",
    ),
  );
  assert.equal(control.checked, false);
  assert.equal(control.disabled, false);
  fail = false;
  fireEvent.click(control);
  await waitFor(() => assert.ok(finish));
  assert.equal(control.checked, false);
  assert.equal(control.disabled, true);
  await act(async () => finish());
  assert.equal(control.checked, true);
  assert.equal(control.disabled, false);
  assert.deepEqual(mutations, [{ allowed: true }, { allowed: true }]);
});

test("inherited MCP access is visibly enabled and cannot pretend to revoke the folder", async () => {
  globalThis.fetch = async (_url, init = {}) => {
    assert.notEqual(init.method, "POST");
    return response(access(true, true));
  };
  render(<McpAccessControl target={{ kind: "document", id: "nested" }} />);
  const control = screen.getByRole("switch", { name: "Allow MCP" });
  await waitFor(() => assert.equal(control.checked, true));
  assert.equal(control.disabled, true);
  assert.match(
    document.getElementById(control.getAttribute("aria-describedby"))
      .textContent,
    /Allowed by folder/,
  );
});

test("MCP access explains when a direct grant will remain after folder access ends", async () => {
  globalThis.fetch = async () =>
    response({ mcpAllowed: true, mcpDirect: true, mcpInherited: true });
  render(<McpAccessControl target={{ kind: "document", id: "nested" }} />);
  const control = screen.getByRole("switch", { name: "Allow MCP" });
  await waitFor(() => assert.equal(control.checked, true));
  assert.equal(control.disabled, true);
  assert.equal(
    document.getElementById(control.getAttribute("aria-describedby")).textContent,
    "Allowed here and by a folder. Turn off folder access first.",
  );
});

test("late MCP reads cannot expose an earlier document's grant", async () => {
  let release;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/first/"))
      return await new Promise((resolve) => {
        release = () => resolve(response(access(true)));
      });
    return response(access());
  };
  const view = render(
    <McpAccessControl target={{ kind: "document", id: "first" }} />,
  );
  await waitFor(() => assert.ok(release));
  view.rerender(
    <McpAccessControl target={{ kind: "document", id: "second" }} />,
  );
  await waitFor(() => assert.equal(screen.getByRole("switch").disabled, false));
  await act(async () => release());
  assert.equal(screen.getByRole("switch").checked, false);
});

test("a pending MCP change cannot mutate the next document's access control", async () => {
  let release;
  globalThis.fetch = async (_url, init = {}) => {
    if (init.method === "POST")
      return await new Promise((resolve) => {
        release = () => resolve(response(access(true)));
      });
    return response(access());
  };
  const view = render(
    <McpAccessControl target={{ kind: "document", id: "first" }} />,
  );
  await waitFor(() => assert.equal(screen.getByRole("switch").disabled, false));
  fireEvent.click(screen.getByRole("switch"));
  await waitFor(() => assert.ok(release));
  view.rerender(
    <McpAccessControl target={{ kind: "document", id: "second" }} />,
  );
  await waitFor(() => assert.equal(screen.getByRole("switch").disabled, false));
  await act(async () => release());
  assert.equal(screen.getByRole("switch").checked, false);
});

test("folder MCP grants use the folder path without enabling its public link", async () => {
  const mutations = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("/mcp")) {
      if (init.method === "POST") {
        mutations.push({ url: String(url), body: JSON.parse(init.body) });
        return response(access(true));
      }
      assert.equal(String(url), "/api/folders/mcp?path=Drafts%2FScreenplays");
      return response(access());
    }
    assert.notEqual(init.method, "POST");
    return response({ permission: "private", shareUrl: null });
  };
  render(
    <FolderShare
      path="Drafts/Screenplays"
      name="Owner"
      onChanged={async () => {}}
    />,
  );
  await waitFor(() => assert.equal(screen.getByRole("switch").disabled, false));
  fireEvent.click(screen.getByRole("switch"));
  await waitFor(() => assert.equal(screen.getByRole("switch").checked, true));
  assert.equal(screen.getByLabelText("Link access").value, "private");
  assert.deepEqual(mutations, [
    {
      url: "/api/folders/mcp",
      body: { path: "Drafts/Screenplays", allowed: true },
    },
  ]);
});

test("share controls without an owner target do not expose MCP settings", () => {
  globalThis.fetch = async () =>
    assert.fail("No owner access request expected");
  render(
    <ShareControls
      value={{ permission: "view", shareUrl: "http://localhost/s/example" }}
      name="Owner"
      onChange={async () => {}}
    />,
  );
  assert.equal(screen.queryByRole("switch"), null);
});
