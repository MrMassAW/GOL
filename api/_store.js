// Evolutions live in Vercel Blob as immutable files: evo/00001.json, evo/00002.json, ...
// Snapshots: snap/00001.png. A lock file prevents two evolutions from being written at once.
import { put, list, del } from '@vercel/blob';
import { readFile } from 'node:fs/promises';

// Free-plan Blob storage allows only a few thousand list() calls a month, so every read is
// cached here and done with ONE list() call, and the evolutions already written are also kept
// in the repo (data/evolutions.json) so the game keeps working even if Blob is unreachable.
let seed = null;
export async function seedEvolutions() {
  if (!seed) { try { seed = JSON.parse(await readFile(new URL('../data/evolutions.json', import.meta.url), 'utf8')); } catch (e) { seed = []; } }
  return seed;
}
let snap = { at: 0, blobs: null, err: null };
const SNAP_MS = 60 * 1000;
async function allBlobs(force) {
  if (!force && snap.blobs && Date.now() - snap.at < SNAP_MS) return snap.blobs;
  snap = { at: Date.now(), blobs: await listAll(''), err: null };
  return snap.blobs;
}
export function invalidate() { snap.at = 0; }

const cache = new Map(); // pathname -> record (records never change)
const pad = (n) => String(n).padStart(5, '0');

async function listAll(prefix) {
  const out = []; let cursor;
  do { const r = await list({ prefix, cursor, limit: 1000 }); out.push(...r.blobs); cursor = r.hasMore ? r.cursor : undefined; } while (cursor);
  return out;
}

// Returns { evolutions, lock, storageOk, storageError }. Never throws.
export async function loadState(force = false) {
  const byN = new Map((await seedEvolutions()).map((r) => [r.n, r]));
  let lock = null, storageOk = true, storageError = null;
  try {
    const blobs = await allBlobs(force);
    const live = blobs.filter((b) => b.pathname.startsWith('lock/') && Date.now() - new Date(b.uploadedAt).getTime() < LOCK_MS);
    lock = live[0] || null;
    await Promise.all(blobs.filter((b) => b.pathname.startsWith('evo/') && b.pathname.endsWith('.json')).map(async (b) => {
      try {
        let rec = cache.get(b.pathname);
        if (!rec) { const r = await fetch(b.url); if (!r.ok) throw new Error('blob fetch ' + r.status); rec = await r.json(); cache.set(b.pathname, rec); }
        byN.set(rec.n, rec);
      } catch (e) { storageOk = false; storageError = String(e.message || e); }
    }));
  } catch (e) { storageOk = false; storageError = String(e.message || e); }
  const recs = [...byN.values()].sort((a, b) => a.n - b.n);
  const retired = new Set(recs.flatMap((r) => r.retire || []));
  return { evolutions: recs.map((r) => ({ ...r, retired: retired.has(r.n) })), lock, storageOk, storageError };
}
export async function loadEvolutions() { return (await loadState(true)).evolutions; }

export async function saveEvolution(rec, pngBase64) {
  if (pngBase64) {
    const img = await put(`snap/${pad(rec.n)}.png`, Buffer.from(pngBase64, 'base64'), { access: 'public', contentType: 'image/png', addRandomSuffix: false });
    rec.snapshot = img.url;
  }
  await put(`evo/${pad(rec.n)}.json`, JSON.stringify(rec), { access: 'public', contentType: 'application/json', addRandomSuffix: false });
  cache.set(`evo/${pad(rec.n)}.json`, rec); invalidate();
  return rec;
}

// ---------- lock ----------
const LOCK_MS = 6 * 60 * 1000;
export async function currentLock() {
  const locks = await listAll('lock/');
  const live = locks.filter((b) => Date.now() - new Date(b.uploadedAt).getTime() < LOCK_MS);
  const stale = locks.filter((b) => !live.includes(b));
  if (stale.length) await del(stale.map((b) => b.url)).catch(() => {});
  return live[0] || null;
}
export async function takeLock() {
  const b = await put(`lock/${Date.now()}.json`, '{}', { access: 'public', contentType: 'application/json', addRandomSuffix: true });
  const locks = (await listAll('lock/')).filter((x) => Date.now() - new Date(x.uploadedAt).getTime() < LOCK_MS).sort((a, b) => a.pathname.localeCompare(b.pathname));
  if (locks[0] && locks[0].url !== b.url) { await del(b.url).catch(() => {}); return null; } // someone else got there first
  return b;
}
export async function releaseLock(b) { if (b) await del(b.url).catch(() => {}); }
