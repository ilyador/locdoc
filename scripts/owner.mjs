import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

try {
  const local = new URL(process.env.LOCDOC_LOCAL_URL || 'http://127.0.0.1:3477');
  if (local.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(local.hostname)) {
    throw new Error('LOCDOC_LOCAL_URL must point to a loopback HTTP address so the API key stays local');
  }
  const publicMode = process.argv.includes('--public');
  if (publicMode && !process.env.LOCDOC_PUBLIC_URL) throw new Error('Set LOCDOC_PUBLIC_URL in .env before opening public owner access');
  const target = publicMode ? new URL(process.env.LOCDOC_PUBLIC_URL) : local;
  if (publicMode && target.protocol !== 'https:') throw new Error('Public owner access requires HTTPS');
  const key = (await readFile(resolve(process.env.LOCDOC_STATE || '.locdoc', 'owner.key'), 'utf8')).trim();
  const response = await fetch(new URL('/api/ticket', local), { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${key}` } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error);
  target.pathname = '/'; target.search = ''; target.hash = `ticket=${body.ticket}`;
  console.log(`Opening ${publicMode ? 'public' : 'local'} owner access in your default browser. The API key stays local.`);
  const opener = spawn('xdg-open', [target.toString()], { stdio: 'ignore', detached: true });
  opener.unref();
  opener.on('error', () => console.error('Could not open a browser. Enter the key from .locdoc/owner.key in Locdoc’s Open workspace dialog.'));
} catch (error) {
  console.error(`Could not open Locdoc: ${error.message}. Check that the Locdoc service is running.`);
  process.exitCode = 1;
}
