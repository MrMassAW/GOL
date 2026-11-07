// POST /api/evolve — a player asks Claude to evolve the game.
// Body: { snapshot: <PNG base64 of the board>, stats: {...} }
// Claude sees the screenshot, the stats and every earlier evolution's code, and writes the next one.
// The new code is test-run headless with the whole history before it is stored and served.
import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM, userContent, parseAnswer } from './_prompt.js';
import { loadState, saveEvolution, takeLock, releaseLock } from './_store.js';
import { trial } from '../js/engine.js';

const MODEL = 'claude-opus-5-5';
const COOLDOWN_MS = 45 * 1000;

let fallbacksOK = true;
async function askClaude(client, messages) {
  const base = { model: MODEL, max_tokens: 32000, output_config: { effort: 'medium' }, system: SYSTEM, messages };
  let msg;
  try {
    msg = fallbacksOK
      ? await client.beta.messages.stream({ ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }).finalMessage()
      : await client.messages.stream(base).finalMessage();
  } catch (e) {
    if (!(fallbacksOK && e instanceof Anthropic.BadRequestError)) throw e;
    fallbacksOK = false; // refusal fallbacks not available on this account: plain request
    msg = await client.messages.stream(base).finalMessage();
  }
  if (msg.stop_reason === 'refusal') throw new Error('Claude declined this request');
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { text, usage: msg.usage, model: msg.model };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  // The key comes from the server environment, or from the player's own browser (sent per
  // request over HTTPS, used for this one call, never stored or logged).
  const headerKey = String(req.headers['x-anthropic-key'] || '').trim();
  const apiKey = process.env.ANTHROPIC_API_KEY || headerKey;
  if (!apiKey) return res.status(401).json({ error: 'No Anthropic API key yet. Open the key panel and paste one.', needKey: true });
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const snapshot = typeof body.snapshot === 'string' ? body.snapshot.replace(/^data:image\/png;base64,/, '') : null;
  if (snapshot && snapshot.length > 3_000_000) return res.status(413).json({ error: 'snapshot too large' });

  const st = await loadState(true);
  if (!st.storageOk) return res.status(503).json({ error: 'Evolving is paused: the storage that keeps new evolutions is unavailable right now (' + st.storageError + '). The game keeps running with every evolution so far.' });
  if (st.lock) return res.status(409).json({ error: 'Claude is already evolving the game. The result will appear for everyone shortly.' });
  const history = st.evolutions;
  const last = history[history.length - 1];
  if (last && Date.now() - last.createdAt < COOLDOWN_MS) return res.status(429).json({ error: 'The game just evolved. Give it a moment to play out before evolving again.' });
  let lock;
  try { lock = await takeLock(); } catch (e) { return res.status(503).json({ error: 'Evolving is paused: storage refused the write (' + String(e.message || e) + '). The game keeps running.' }); }
  if (!lock) return res.status(409).json({ error: 'Claude is already evolving the game.' });

  try {
    const client = new Anthropic({ apiKey });
    const n = history.length + 1;
    const messages = [{ role: 'user', content: userContent({ history, snapshot, stats: body.stats }) }];
    let answer, out, t, attempt = 0;
    while (true) {
      attempt++;
      out = await askClaude(client, messages);
      answer = parseAnswer(out.text);
      const problems = [];
      if (!answer.code) problems.push('No <code> block was found.');
      else {
        try { new Function('game', 'api', '"use strict";\n' + answer.code); } catch (e) { problems.push('Syntax error: ' + e.message); }
        if (!problems.length) {
          const records = history.filter((h) => !h.retired && !answer.retire.includes(h.n)).concat([{ n, title: answer.title, code: answer.code, retire: answer.retire }]);
          t = trial(records, 60);
          const mine = t.mods.find((m) => m.n === n);
          const start = t.results.find((r) => r.n === n);
          if (start && !start.ok) problems.push('Your code threw at startup: ' + start.error);
          else if (mine && (!mine.active || mine.errors)) problems.push(`Your hooks threw ${mine.errors} time(s) during the headless trial. Last error: ${mine.lastError}`);
          if (t.ms > 6000) problems.push(`80 ticks took ${t.ms} ms headless; that is too slow. Make it much cheaper.`);
        }
      }
      if (!problems.length) break;
      if (attempt >= 2) return res.status(422).json({ error: 'Claude\'s evolution failed its safety test, so nothing changed. Try again.', details: problems });
      messages.push({ role: 'assistant', content: out.text });
      messages.push({ role: 'user', content: `Your evolution was rejected by the headless test:\n- ${problems.join('\n- ')}\nFix it and answer again in the same five-tag format.` });
    }
    const rec = { n, title: answer.title || `Evolution ${n}`, description: answer.description, observation: answer.observation, retire: answer.retire, code: answer.code, createdAt: Date.now(), model: out.model, trial: { ms: t.ms, pop: t.pop }, attempts: attempt };
    await saveEvolution(rec, snapshot);
    res.status(200).json({ evolution: rec });
  } catch (e) {
    const status = e instanceof Anthropic.APIError ? (e.status || 502) : 500;
    const msg = e instanceof Anthropic.AuthenticationError ? 'That API key was rejected by Anthropic. Check it in the key panel.' : String(e.message || e);
    res.status(status).json({ error: msg, needKey: e instanceof Anthropic.AuthenticationError });
  } finally {
    await releaseLock(lock);
  }
}
