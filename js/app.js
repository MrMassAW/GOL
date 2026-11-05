// app.js — the page shell. Keeps the world running, draws it, loads every evolution Claude
// has written (and new ones as they appear, from any player), and sends the game to Claude
// when someone presses Evolve. The world is never reset.
import * as K from './engine.js';

const $ = (id) => document.getElementById(id);
const canvas = $('c'), ctx = canvas.getContext('2d');
const CELL = canvas.width / K.W;
const SAVE_KEY = 'evolving-life-ai-v1';
const off = document.createElement('canvas'); off.width = K.W; off.height = K.H;
const offCtx = off.getContext('2d'); const img = offCtx.createImageData(K.W, K.H);

const game = K.createGame();
let evolutions = [];                 // records from the server, in order
let evolving = false;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const env = { toast: (m) => toast(esc(m)) };

// ---------- world ----------
try { const s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); if (s) K.restore(game, s); else K.seed(game, 0.25); } catch (e) { K.seed(game, 0.25); }
function save() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(K.serialize(game))); } catch (e) {} }

function loop() {
  const t0 = performance.now();
  try { K.step(game); } catch (e) { console.error(e); }
  const ms = game.params.tickMs || 120;
  setTimeout(loop, Math.max(0, ms - (performance.now() - t0)));
}
function frame() {
  try {
    const d = img.data;
    for (let i = 0; i < K.N; i++) { const c = K.cellColor(game, i); const o = i * 4; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255; }
    offCtx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
    K.runDraw(game, ctx, CELL);
  } catch (e) { console.error(e); }
  requestAnimationFrame(frame);
}

// ---------- evolutions ----------
function applyNew(list, announce) {
  const retired = new Set(list.flatMap((r) => r.retire || []));
  let latest = null;
  for (const rec of list) {
    if (game.mods.some((m) => m.n === rec.n)) continue;
    if (retired.has(rec.n)) { game.mods.push({ n: rec.n, id: 'e' + rec.n, title: rec.title, active: false }); continue; }
    K.applyMod(game, rec, env);
    latest = rec;
  }
  for (const n of retired) K.disableMod(game, n, 'was retired');
  evolutions = list;
  if (latest && announce) toast(`<b>Evolution ${latest.n}: ${esc(latest.title)}</b><br>${esc(latest.description)}`);
  renderLog();
}
async function poll(announce = true) {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    const s = await r.json();
    if (!r.ok) throw new Error(s.error || r.status);
    applyNew(s.evolutions || [], announce);
    if (!evolving && s.evolving) setStatus('<span class="spin"></span>Someone pressed Evolve. Claude is working on it…');
    $('evolve').disabled = evolving || !!s.evolving;
  } catch (e) { console.warn('state poll failed', e); }
}

function snapshotPNG() {
  const c = document.createElement('canvas'); c.width = 384; c.height = 240;
  c.getContext('2d').drawImage(canvas, 0, 0, 384, 240);
  return c.toDataURL('image/png');
}
function stats() {
  let pop = 0; for (let i = 0; i < K.N; i++) pop += game.alive[i] ? 1 : 0;
  const layers = Object.fromEntries(Object.entries(game.layers).map(([k, v]) => { let nz = 0, sum = 0; for (let i = 0; i < v.length; i++) if (v[i]) { nz++; sum += v[i]; } return [k, { nonZero: nz, mean: nz ? +(sum / nz).toFixed(2) : 0 }]; }));
  return {
    tick: game.tick, livingCells: pop, density: +(pop / K.N).toFixed(3), params: game.params, layers,
    shared: JSON.stringify(game.data.__shared || {}).slice(0, 1500),
    evolutions: game.mods.map((m) => ({ n: m.n, active: m.active, errors: m.errors || 0, lastError: m.lastError })),
    hud: K.runHud(game).map((h) => h.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300)),
    notices: game.notices.slice(-5),
  };
}

async function evolve() {
  if (evolving) return;
  evolving = true; $('evolve').disabled = true;
  const t0 = Date.now();
  const tick = () => { if (evolving) { setStatus(`<span class="spin"></span>Claude is looking at the game and writing evolution ${evolutions.length + 1}… ${Math.round((Date.now() - t0) / 1000)}s`); setTimeout(tick, 1000); } };
  tick();
  try {
    const r = await fetch('/api/evolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshot: snapshotPNG(), stats: stats() }) });
    const out = await r.json().catch(() => ({ error: 'The server returned an unreadable answer (' + r.status + ').' }));
    if (!r.ok) throw new Error(out.error + (out.details ? ' ' + out.details.join(' ') : ''));
    evolving = false;
    applyNew(evolutions.concat([out.evolution]), true);
    setStatus(`Done in ${Math.round((Date.now() - t0) / 1000)}s.`);
  } catch (e) {
    evolving = false;
    setStatus(esc(e.message), true);
  }
  $('evolve').disabled = false;
  poll(false);
}

// ---------- input ----------
let down = false;
function pointer(e, type) {
  const r = canvas.getBoundingClientRect();
  const x = Math.floor((e.clientX - r.left) / r.width * K.W), y = Math.floor((e.clientY - r.top) / r.height * K.H);
  if (x < 0 || y < 0 || x >= K.W || y >= K.H) return;
  const ev = { x, y, i: K.idx(x, y), type, buttons: e.buttons };
  if (K.runPointer(game, ev)) return;
  if (type !== 'up' && down) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (Math.random() < 0.55) game.alive[K.idx(x + dx, y + dy)] = 1;
}
canvas.addEventListener('pointerdown', (e) => { down = true; canvas.setPointerCapture(e.pointerId); pointer(e, 'down'); });
canvas.addEventListener('pointermove', (e) => pointer(e, 'move'));
canvas.addEventListener('pointerup', (e) => { pointer(e, 'up'); down = false; });
canvas.addEventListener('pointercancel', () => { down = false; });

// ---------- panels ----------
let toastTimer = 0;
function toast(html) { const t = $('toast'); t.innerHTML = html; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 9000); }
function setStatus(html, err) { $('status').innerHTML = html; $('status').classList.toggle('err', !!err); }

function renderLog() {
  $('count').textContent = evolutions.length;
  const active = evolutions.filter((e) => game.mods.find((m) => m.n === e.n && m.active));
  const cur = evolutions[evolutions.length - 1];
  if (cur) { $('evoN').textContent = `Evolution ${cur.n} · written by Claude`; $('evoTitle').textContent = cur.title; $('evoDesc').textContent = cur.description; }
  $('active').textContent = active.length;
  const list = evolutions.slice().reverse();
  $('log').innerHTML = list.length ? list.map((e) => {
    const m = game.mods.find((x) => x.n === e.n);
    return `<div class="entry ${m && !m.active ? 'retired' : ''}">
      ${e.snapshot ? `<img loading="lazy" src="${esc(e.snapshot)}" alt="The game just before evolution ${e.n}">` : '<div></div>'}
      <div><div class="evo-n">Evolution ${e.n} · ${new Date(e.createdAt).toLocaleString()}${m && !m.active ? ' · off' : ''}</div>
      <div class="t">${esc(e.title)}</div><div class="desc">${esc(e.description)}</div>
      <details><summary>Code Claude wrote</summary><pre>${esc(e.code)}</pre></details></div></div>`;
  }).join('') : '<p class="hint">No evolutions yet. Each entry will show the game just before the change, what changed, and the code Claude wrote. Press Evolve to start.</p>';
  $('obsList').innerHTML = list.length ? list.map((e) => `<div class="entry" style="grid-template-columns:1fr"><div><div class="evo-n">Before evolution ${e.n} · ${new Date(e.createdAt).toLocaleString()}</div><div class="obs">“${esc(e.observation)}”</div></div></div>`).join('') : '<p class="hint">Claude writes down what it sees each time it evolves the game.</p>';
}
for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => {
  for (const x of document.querySelectorAll('[data-tab]')) x.classList.toggle('on', x === b);
  $('log').hidden = b.dataset.tab !== 'log'; $('obsList').hidden = b.dataset.tab !== 'obs';
});

function hud() {
  let pop = 0; for (let i = 0; i < K.N; i++) pop += game.alive[i] ? 1 : 0;
  $('pop').textContent = `${pop.toLocaleString()} (${(100 * pop / K.N).toFixed(1)}%)`;
  $('tick').textContent = game.tick.toLocaleString();
  $('rule').textContent = `B${game.params.birth.join('')}/S${game.params.survive.join('')}`;
  const items = K.runHud(game);
  $('hudPanel').hidden = !items.length;
  $('hud').innerHTML = items.map((h) => `<div class="hudItem"><div class="src">${esc(h.title)}</div>${h.html}</div>`).join('');
  $('notices').textContent = game.notices.slice(-2).join(' · ');
}

// ---------- boot ----------
$('evolve').addEventListener('click', evolve);
renderLog();
loop(); frame();
await poll(false);
setInterval(() => poll(true), 15000);
setInterval(hud, 500); hud();
setInterval(save, 5000);
addEventListener('pagehide', save);
