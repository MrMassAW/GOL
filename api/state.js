// GET /api/state — every evolution so far (code included), for pages to load and hot-swap.
// Cached at the edge for 20 s so many open pages cost one storage read, not one each.
import { loadState } from './_store.js';

export default async function handler(req, res) {
  const s = await loadState();
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=20, stale-while-revalidate=120');
  res.status(200).json({
    serverKey: !!process.env.ANTHROPIC_API_KEY, evolutions: s.evolutions,
    evolving: s.lock ? new Date(s.lock.uploadedAt).getTime() : null,
    storageOk: s.storageOk, now: Date.now(),
  });
}
