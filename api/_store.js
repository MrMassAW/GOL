// Evolutions live in Vercel Blob as immutable files: evo/00001.json, evo/00002.json, ...
// Snapshots: snap/00001.png. A lock file prevents two evolutions from being written at once.
import { put, list, del } from '@vercel/blob';

const cache = new Map(); // pathname -> record (records never change)
const pad = (n) => String(n).padStart(5, '0');

async function listAll(prefix) {
  const out = []; let cursor;
  do { const r = await list({ prefix, cursor, limit: 1000 }); out.push(...r.blobs); cursor = r.hasMore ? r.cursor : undefined; } while (cursor);
  return out;
}

export async function loadEvolutions() {
  const blobs = (await listAll('evo/')).filter((b) => b.pathname.endsWith('.json'));
  const recs = await Promise.all(blobs.map(async (b) => {
    if (cache.has(b.pathname)) return cache.get(b.pathname);
    const r = await fetch(b.url); if (!r.ok) throw new Error('blob fetch ' + r.status);
    const rec = await r.json(); cache.set(b.pathname, rec); return rec;
  }));
  recs.sort((a, b) => a.n - b.n);
  const retired = new Set(recs.flatMap((r) => r.retire || []));
  return recs.map((r) => ({ ...r, retired: retired.has(r.n) }));
}

export async function saveEvolution(rec, pngBase64) {
  if (pngBase64) {
    const img = await put(`snap/${pad(rec.n)}.png`, Buffer.from(pngBase64, 'base64'), { access: 'public', contentType: 'image/png', addRandomSuffix: false });
    rec.snapshot = img.url;
  }
  await put(`evo/${pad(rec.n)}.json`, JSON.stringify(rec), { access: 'public', contentType: 'application/json', addRandomSuffix: false });
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
