import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const base = 'http://127.0.0.1:3558';
const resource = `${base}/mcp`;
const callback = 'https://chatgpt.example.test/oauth/callback';
const protocol = '2025-06-18';
const ownerKey = randomBytes(32).toString('hex');
let directory, server, ownerSession, startupError;
let logs = '';
let sequence = 0;
let ownerConnection, readConnection, document;

async function waitFor(check, milliseconds = 6000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error(`MCP fixture timed out. Server log tail: ${logs.slice(-2000)}`);
}
async function request(path, options = {}) {
  const response = await fetch(base + path, {
    signal: AbortSignal.timeout(6000),
    redirect: 'manual',
    ...options,
  });
  const text = await response.text();
  assert.ok(text.length < 100_000, 'Fixture responses must remain bounded');
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { status: response.status, headers: response.headers, body };
}
function json(body, bearer) {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  };
}
function form(body) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  };
}
async function rpc(connection, method, params, headers = {}) {
  return request('/mcp', {
    ...json({ jsonrpc: '2.0', id: ++sequence, method, params }, connection?.access_token),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': protocol,
      ...(connection ? { Authorization: `Bearer ${connection.access_token}` } : {}),
      ...headers,
    },
  });
}
async function call(connection, name, args = {}) {
  const response = await rpc(connection, 'tools/call', { name, arguments: args });
  assert.equal(response.status, 200, `MCP ${name} HTTP status`);
  assert.equal(response.body.error, undefined, `MCP ${name} protocol error`);
  assert.ok(response.body.result, `MCP ${name} returns a result`);
  return response.body.result;
}
function value(result) {
  assert.notEqual(result.isError, true, 'Tool command must succeed');
  assert.ok(result.structuredContent, 'Tool command returns structured content');
  return result.structuredContent;
}
async function connect(scopes, clientName) {
  const registration = await request('/oauth/register', json({
    client_name: clientName,
    redirect_uris: [callback],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  }));
  assert.equal(registration.status, 201);
  const client = registration.body.client_id;
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('hex');
  const query = new URLSearchParams({
    client_id: client, redirect_uri: callback, response_type: 'code',
    scope: scopes, state, resource, code_challenge: challenge, code_challenge_method: 'S256',
  });
  const authorization = await request(`/oauth/authorize?${query}`);
  assert.ok([302, 303].includes(authorization.status), 'Authorization goes to owner consent');
  const consentUrl = new URL(authorization.headers.get('location'));
  assert.equal(consentUrl.origin, base);
  assert.equal(consentUrl.pathname, '/');
  assert.equal(consentUrl.searchParams.has('code'), false, 'Authorization is never auto-approved');
  const pending = consentUrl.searchParams.get('mcp_authorize');
  assert.ok(pending);
  const previewPath = `/api/mcp/authorize?${new URLSearchParams({ request: pending })}`;
  assert.equal((await request(previewPath)).status, 403, 'Only the owner may inspect consent');
  const preview = await request(previewPath, { headers: { Authorization: `Bearer ${ownerSession}` } });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.clientName, clientName);
  assert.equal(preview.body.redirectUri, callback);
  assert.deepEqual([...preview.body.scopes].sort(), scopes.split(' ').sort());
  assert.equal((await request('/api/mcp/authorize', json({ request: pending, allow: true }))).status, 403);
  const consent = await request('/api/mcp/authorize', json({ request: pending, allow: true }, ownerSession));
  assert.equal(consent.status, 200);
  const redirect = new URL(consent.body.redirect);
  assert.equal(redirect.origin + redirect.pathname, callback);
  assert.equal(redirect.searchParams.get('state'), state);
  const code = redirect.searchParams.get('code');
  assert.ok(code);
  const exchange = {
    grant_type: 'authorization_code', client_id: client, resource,
    redirect_uri: callback, code_verifier: verifier, code,
  };
  const token = await request('/oauth/token', form(exchange));
  assert.equal(token.status, 200);
  assert.match(token.body.access_token, /^mcp_a_[a-f0-9]{64}$/);
  assert.match(token.body.refresh_token, /^mcp_r_[a-f0-9]{64}$/);
  assert.equal(token.body.token_type, 'Bearer');
  assert.equal(token.body.scope, scopes);
  assert.equal((await request('/oauth/token', form(exchange))).status, 400, 'Codes cannot be replayed');
  assert.equal((await request('/api/mcp/authorize', json({ request: pending, allow: true }, ownerSession))).status, 400);
  return { ...token.body, client_id: client };
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'locdoc-mcp-integration-'));
  await mkdir(join(directory, 'state'));
  await mkdir(join(directory, 'docs'));
  await writeFile(join(directory, 'state', 'owner.key'), ownerKey, { mode: 0o600 });
  await writeFile(join(directory, 'docs', 'Seed.md'), '# Seed\n\nA private fixture note.\n');
  server = spawn('./target/debug/locdoc', [], {
    env: {
      ...process.env, LOCDOC_BIND: '127.0.0.1:3558',
      LOCDOC_STATE: join(directory, 'state'), LOCDOC_DOCS: join(directory, 'docs'),
      LOCDOC_PUBLIC_URL: base, LOCDOC_OWNER_NAME: 'Fixture owner',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = chunk => { logs = (logs + chunk.toString()).slice(-8192); };
  server.stdout.on('data', log);
  server.stderr.on('data', log);
  server.on('error', error => { startupError = error; });
  await waitFor(async () => {
    if (startupError) throw startupError;
    if (server.exitCode !== null) throw new Error(`MCP fixture exited: ${logs.slice(-2000)}`);
    try { return (await request('/api/config')).status === 200; } catch { return false; }
  }, 15_000);
  // Exercise the same origin-bound owner session used by the real consent UI.
  const ticket = await request('/api/ticket', json({}, ownerKey));
  assert.equal(ticket.status, 200);
  const login = await request('/api/redeem', json({ ticket: ticket.body.ticket }));
  assert.equal(login.status, 200);
  ownerSession = login.body.session;
  assert.match(ownerSession, /^[a-f0-9]{64}$/);
});
after(async () => {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit');
    server.kill('SIGINT');
    await Promise.race([exited, delay(5000, undefined, { ref: false })]);
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGKILL');
      await exited;
    }
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('MCP discovery advertises OAuth and unauthenticated requests receive its challenge', { timeout: 15_000 }, async () => {
  const metadata = await request('/.well-known/oauth-protected-resource/mcp');
  assert.equal(metadata.status, 200);
  assert.equal(metadata.body.resource, resource);
  assert.deepEqual(metadata.body.authorization_servers, [base]);
  const oauth = await request('/.well-known/oauth-authorization-server');
  assert.equal(oauth.status, 200);
  assert.equal(oauth.body.issuer, base);
  assert.equal(oauth.body.registration_endpoint, `${base}/oauth/register`);
  assert.deepEqual(oauth.body.code_challenge_methods_supported, ['S256']);
  const denied = await rpc(null, 'tools/list', {});
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get('www-authenticate'), /Bearer resource_metadata="http:\/\/127\.0\.0\.1:3558\/\.well-known\/oauth-protected-resource\/mcp"/);
  const keyAttempt = await rpc({ access_token: ownerKey }, 'tools/list', {});
  assert.equal(keyAttempt.status, 401, 'The local owner key is never a connector token');
  const sessionAttempt = await rpc({ access_token: ownerSession }, 'tools/list', {});
  assert.equal(sessionAttempt.status, 401, 'Browser owner sessions are not connector tokens');
});

test('owner-approved OAuth connects a real MCP client; reads and optimistic edits preserve source', { timeout: 30_000 }, async () => {
  ownerConnection = await connect('locdoc:read locdoc:write locdoc:share', 'Fixture MCP client');
  const initialize = await rpc(ownerConnection, 'initialize', {
    protocolVersion: protocol, capabilities: {}, clientInfo: { name: 'locdoc-http-test', version: '1.0' },
  });
  assert.equal(initialize.status, 200);
  assert.equal(initialize.body.result.serverInfo.name, 'locdoc');
  assert.equal(initialize.body.result.protocolVersion, protocol);
  assert.equal(initialize.headers.get('mcp-session-id'), null, 'Stateless HTTP does not allocate bearer sessions');
  const listing = await rpc(ownerConnection, 'tools/list', {});
  assert.equal(listing.status, 200);
  const names = listing.body.result.tools.map(tool => tool.name);
  for (const name of ['read_document', 'edit_document', 'create_document', 'share_folder', 'add_comment']) {
    assert.ok(names.includes(name), `Available tool: ${name}`);
  }
  const documents = value(await call(ownerConnection, 'list_documents'));
  const seed = documents.entries.find(entry => entry.path === 'Seed.md');
  assert.ok(seed?.id);
  const seedSource = value(await call(ownerConnection, 'read_document', { doc_id: seed.id }));
  assert.equal(seedSource.content, '# Seed\n\nA private fixture note.\n');
  document = value(await call(ownerConnection, 'create_document', { path: 'Ideas/Created.md', kind: 'file' }));
  assert.ok(document.id);
  assert.equal((await call(ownerConnection, 'create_document', { path: document.path, kind: 'file' })).isError, true);
  const initial = value(await call(ownerConnection, 'read_document', { doc_id: document.id }));
  const source = '# Created\n\nA collaboration note.\n';
  const command = { doc_id: document.id, expected_revision: initial.revision, source };
  const edited = value(await call(ownerConnection, 'edit_document', command));
  assert.equal(edited.accepted, true);
  assert.equal(edited.revision, createHash('sha256').update(source).digest('hex'));
  const duplicate = value(await call(ownerConnection, 'edit_document', command));
  assert.equal(duplicate.revision, edited.revision, 'A lost-response retry never repeats a mutation');
  const stale = await call(ownerConnection, 'edit_document', { ...command, source: '# Wrong stale overwrite\n' });
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent.status, 409);
  assert.equal(stale.structuredContent.retry_after_read, true);
  assert.equal(value(await call(ownerConnection, 'read_document', { doc_id: document.id })).content, source);
  await waitFor(async () => (await readFile(join(directory, 'docs', document.path), 'utf8')) === source);
  const search = value(await call(ownerConnection, 'search_documents', { query: 'collaboration note' }));
  assert.equal(search.matches[0].id, document.id);
  assert.ok(search.matches[0].excerpt.includes('A collaboration note.'), 'Search preserves source capitalization');
});

test('concurrent MCP edits serialize and reject an obsolete base instead of overwriting', { timeout: 15_000 }, async () => {
  const initial = value(await call(ownerConnection, 'read_document', { doc_id: document.id }));
  const sources = ['# First accepted contender\n', '# Second accepted contender\n'];
  const results = await Promise.all(sources.map(source => call(ownerConnection, 'edit_document', {
    doc_id: document.id, expected_revision: initial.revision, source,
  })));
  assert.equal(results.filter(result => !result.isError).length, 1);
  assert.equal(results.filter(result => result.structuredContent.status === 409).length, 1);
  const accepted = value(await call(ownerConnection, 'read_document', { doc_id: document.id }));
  const winner = results.findIndex(result => !result.isError);
  assert.equal(accepted.content, sources[winner]);
  await waitFor(async () => (await readFile(join(directory, 'docs', document.path), 'utf8')) === accepted.content);
});

test('read-only grants filter tools and cannot invoke writes or become owner HTTP sessions', { timeout: 20_000 }, async () => {
  readConnection = await connect('locdoc:read', 'Fixture read-only client');
  const list = await rpc(readConnection, 'tools/list', {});
  assert.equal(list.status, 200);
  const names = list.body.result.tools.map(tool => tool.name);
  assert.ok(names.includes('read_document'));
  assert.equal(names.includes('create_document'), false);
  assert.equal(names.includes('edit_document'), false);
  assert.equal(names.includes('share_document'), false);
  const write = await call(readConnection, 'create_document', { path: 'Forbidden.md', kind: 'file' });
  assert.equal(write.isError, true);
  assert.equal(write.structuredContent.status, 403);
  assert.equal((await request('/api/tree', { headers: { Authorization: `Bearer ${readConnection.access_token}` } })).status, 403);
  assert.equal(value(await call(readConnection, 'read_document', { doc_id: document.id })).id, document.id);
});

test('MCP exact replacement preserves surrounding source and rejects stale or ambiguous passages', { timeout: 15_000 }, async () => {
  const before = value(await call(ownerConnection, 'read_document', { doc_id: document.id }));
  const source = '# A unique title\n\nUnicode stays: 😀 café.\nOverlapping passage: aaa\n';
  const initial = value(await call(ownerConnection, 'edit_document', {
    doc_id: document.id, expected_revision: before.revision, source,
  }));
  for (const oldText of ['missing passage', 'aa']) {
    const ambiguous = await call(ownerConnection, 'replace_text', {
      doc_id: document.id, expected_revision: initial.revision, old_text: oldText, new_text: 'wrong',
    });
    assert.equal(ambiguous.isError, true);
    assert.equal(ambiguous.structuredContent.status, 409);
  }
  const command = {
    doc_id: document.id, expected_revision: initial.revision,
    old_text: 'A unique title', new_text: 'A revised 🌍 title',
  };
  const changed = value(await call(ownerConnection, 'replace_text', command));
  const expected = source.replace(command.old_text, command.new_text);
  assert.equal(changed.accepted, true);
  assert.equal(changed.revision, createHash('sha256').update(expected).digest('hex'));
  assert.equal(value(await call(ownerConnection, 'read_document', { doc_id: document.id })).content, expected);
  const stale = await call(ownerConnection, 'replace_text', command);
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent.status, 409, 'An uncertain replacement retry requires a fresh read');
  const denied = await call(readConnection, 'replace_text', { ...command, expected_revision: changed.revision });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.status, 403);
});

test('MCP comments preserve raw source and idempotent replies; read-only connections cannot mutate them', { timeout: 20_000 }, async () => {
  const initial = value(await call(ownerConnection, 'read_document', { doc_id: document.id }));
  const command = {
    doc_id: document.id, expected_revision: initial.revision,
    body: 'A useful MCP comment.', request_id: randomUUID(),
  };
  const comment = value(await call(ownerConnection, 'add_comment', command));
  assert.equal(comment.name, 'Fixture owner');
  assert.equal(comment.body, command.body);
  assert.equal(value(await call(ownerConnection, 'add_comment', command)).id, comment.id);
  const replyCommand = {
    doc_id: document.id, comment_id: comment.id,
    body: 'A response from MCP.', request_id: randomUUID(),
  };
  const reply = value(await call(ownerConnection, 'reply_comment', replyCommand));
  assert.equal(reply.replies.length, 1);
  assert.equal(reply.replies[0].body, replyCommand.body);
  assert.equal(value(await call(ownerConnection, 'reply_comment', replyCommand)).replies.length, 1);
  const resolved = value(await call(ownerConnection, 'resolve_comment', {
    doc_id: document.id, comment_id: comment.id, resolved: true,
  }));
  assert.equal(resolved.resolved, true);
  const comments = value(await call(readConnection, 'list_comments', { doc_id: document.id }));
  assert.equal(comments.comments.length, 1);
  assert.equal(comments.comments[0].id, comment.id);
  assert.equal(comments.comments[0].resolved, true);
  const raw = value(await call(ownerConnection, 'read_document', { doc_id: document.id }));
  assert.equal((raw.content.match(/\[\[comment\(/g) || []).length, 2);
  assert.ok(raw.content.includes('[[comment(Fixture owner): A useful MCP comment.]]'));
  assert.ok(raw.content.includes('[[comment(Fixture owner): A response from MCP.]]'));
  for (const [name, args] of [
    ['add_comment', { ...command, expected_revision: raw.revision, request_id: randomUUID() }],
    ['reply_comment', { ...replyCommand, request_id: randomUUID() }],
    ['resolve_comment', { doc_id: document.id, comment_id: comment.id, resolved: false }],
  ]) {
    const denied = await call(readConnection, name, args);
    assert.equal(denied.isError, true);
    assert.equal(denied.structuredContent.status, 403);
  }
  assert.equal(value(await call(ownerConnection, 'read_document', { doc_id: document.id })).content, raw.content);
});

test('MCP shares real folders and documents, preserves identity on rename, and keeps share tokens out of MCP', { timeout: 20_000 }, async () => {
  const folder = value(await call(ownerConnection, 'share_folder', { path: 'Ideas', permission: 'view' }));
  const folderToken = new URL(folder.shareUrl).pathname.split('/').pop();
  const folderOpen = await request(`/api/open/${folderToken}`);
  assert.equal(folderOpen.status, 200);
  assert.equal(folderOpen.body.document.id, document.id);
  assert.equal(folderOpen.body.document.edit, false);
  const shared = value(await call(ownerConnection, 'share_document', { doc_id: document.id, permission: 'edit' }));
  const shareToken = new URL(shared.shareUrl).pathname.split('/').pop();
  assert.equal((await request(`/api/open/${shareToken}`)).body.document.edit, true);
  assert.equal((await rpc({ access_token: shareToken }, 'tools/list', {})).status, 401);
  const before = value(await call(ownerConnection, 'read_document', { doc_id: document.id }));
  const renamed = 'Ideas/Renamed.md';
  assert.equal(value(await call(ownerConnection, 'rename_document', { doc_id: document.id, path: renamed })).ok, true);
  document.path = renamed;
  const after = value(await call(ownerConnection, 'read_document', { doc_id: document.id }));
  assert.equal(after.id, document.id);
  assert.equal(after.path, renamed);
  assert.equal(after.content, before.content);
  assert.equal((await request(`/api/open/${shareToken}`)).body.document.id, document.id);
  assert.equal((await request(`/api/open/${folderToken}`)).body.document.id, document.id);
  for (const [name, args] of [
    ['share_folder', { path: 'Ideas', permission: 'edit' }],
    ['share_document', { doc_id: document.id, permission: 'edit' }],
    ['rename_document', { doc_id: document.id, path: 'Ideas/Forbidden.md' }],
  ]) {
    const denied = await call(readConnection, name, args);
    assert.equal(denied.isError, true);
    assert.equal(denied.structuredContent.status, 403);
  }
  value(await call(ownerConnection, 'share_folder', { path: 'Ideas', permission: 'private' }));
  value(await call(ownerConnection, 'share_document', { doc_id: document.id, permission: 'private' }));
  assert.equal((await request(`/api/open/${folderToken}`)).status, 404);
  assert.equal((await request(`/api/open/${shareToken}`)).status, 404);
});

test('MCP reads history and restores only against the current revision without losing the previous source', { timeout: 20_000 }, async () => {
  const versions = value(await call(readConnection, 'list_versions', { doc_id: document.id }));
  assert.ok(versions.versions.length > 0, 'Projection records restorable history');
  const historical = versions.versions.at(-1);
  const target = { doc_id: document.id, version_id: historical.id };
  const old = value(await call(readConnection, 'read_version', target));
  assert.equal(typeof old.content, 'string');
  assert.match(old.revision, /^[a-f0-9]{64}$/);
  const current = value(await call(ownerConnection, 'read_document', { doc_id: document.id }));
  const denied = await call(readConnection, 'restore_version', { ...target, expected_revision: current.revision });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.status, 403);
  const stale = await call(ownerConnection, 'restore_version', { ...target, expected_revision: '0'.repeat(64) });
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent.status, 409);
  assert.equal(value(await call(ownerConnection, 'read_document', { doc_id: document.id })).content, current.content);
  const restored = value(await call(ownerConnection, 'restore_version', { ...target, expected_revision: current.revision }));
  assert.equal(restored.ok, true);
  assert.equal(value(await call(ownerConnection, 'read_document', { doc_id: document.id })).content, old.content);
  await waitFor(async () => (await readFile(join(directory, 'docs', document.path), 'utf8')) === old.content);
  const preserved = value(await call(ownerConnection, 'list_versions', { doc_id: document.id }));
  const recovery = value(await call(ownerConnection, 'read_version', { doc_id: document.id, version_id: preserved.versions[0].id }));
  assert.equal(recovery.content, current.content, 'Restore keeps the replaced accepted source in history');
});

test('MCP rejects hostile origins while allowing ChatGPT and its CORS preflight', { timeout: 15_000 }, async () => {
  const hostile = await rpc(ownerConnection, 'tools/list', {}, { Origin: 'https://evil.example.test' });
  assert.equal(hostile.status, 403);
  const allowed = await rpc(ownerConnection, 'tools/list', {}, { Origin: 'https://chatgpt.com' });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://chatgpt.com');
  const preflight = await request('/mcp', {
    method: 'OPTIONS', headers: {
      Origin: 'https://chatgpt.com', 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type,mcp-protocol-version',
    },
  });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-headers'), /authorization/i);
});

test('refresh rotates bearer credentials and both OAuth and owner revocation stop new calls', { timeout: 20_000 }, async () => {
  const rotated = await request('/oauth/token', form({
    grant_type: 'refresh_token', client_id: ownerConnection.client_id,
    refresh_token: ownerConnection.refresh_token, resource,
  }));
  assert.equal(rotated.status, 200);
  const refreshed = { ...rotated.body, client_id: ownerConnection.client_id };
  assert.notEqual(refreshed.access_token, ownerConnection.access_token);
  assert.notEqual(refreshed.refresh_token, ownerConnection.refresh_token);
  assert.equal((await rpc(ownerConnection, 'tools/list', {})).status, 401);
  assert.equal((await rpc(refreshed, 'tools/list', {})).status, 200);
  const revoked = await request('/oauth/revoke', form({ client_id: refreshed.client_id, token: refreshed.refresh_token }));
  assert.equal(revoked.status, 200);
  assert.equal((await rpc(refreshed, 'tools/list', {})).status, 401);
  assert.equal((await request('/oauth/token', form({
    grant_type: 'refresh_token', client_id: refreshed.client_id, refresh_token: refreshed.refresh_token, resource,
  }))).status, 400);
  const connections = await request('/api/mcp/connections', { headers: { Authorization: `Bearer ${ownerSession}` } });
  assert.equal(connections.status, 200);
  assert.equal(connections.body.connections.length, 1);
  assert.equal(connections.body.connections[0].clientName, 'Fixture read-only client');
  const id = connections.body.connections[0].id;
  assert.equal((await request(`/api/mcp/connections/${id}/revoke`, json({}))).status, 403);
  assert.equal((await request(`/api/mcp/connections/${id}/revoke`, json({}, ownerSession))).status, 200);
  assert.equal((await rpc(readConnection, 'tools/list', {})).status, 401);
});
