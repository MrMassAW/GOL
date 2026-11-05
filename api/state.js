// GET /api/state — every evolution so far (code included), for pages to load and hot-swap.
import { loadEvolutions, currentLock } from './_store.js';

export default async function handler(req, res) {
  try {
    const [evolutions, lock] = await Promise.all([loadEvolutions(), currentLock()]);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ evolutions, evolving: lock ? new Date(lock.uploadedAt).getTime() : null, now: Date.now() });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
