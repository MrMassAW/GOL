// app.js — the shell. It never needs to change: it keeps the world alive, follows the
// evolution clock, and hot-swaps the game's modules (core, evolutions, ui) whenever the
// steward publishes a new version. The world is never reset; a broken module is rolled back.

const $ = (id) => document.getElementById(id);
const canvas = $('c'), ctx = canvas.getContext('2d');
const SAVE_KEY = 'evolving-life-world-v1';

let M = null;          // { version, core, evo, ui }
let manifest = null;
let chain = null;      // evolution history + reference world (deterministic, shared by all players)
let world = null;      // this player's world
let appliedN = 0;      // last evolution applied to this player's world
let catchingUp = false;

const fetchJSON = async (url) => { const r = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' }); if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); };
const nowN = () => Math.max(0, Math.floor((Date.now() - manifest.genesis) / manifest.periodMs));

async function loadModules(version) {
  // /r/<version>/x.js is rewritten to /js/x.js by vercel.json, so each version gets fresh
  // module URLs (including the modules' own relative imports) and nothing stale is reused.
  const base = '/r/' + encodeURIComponent(version) + '/';
  const [core, evo, ui] = await Promise.all([import(base + 'core.js'), import(base + 'evolutions.js'), import(base + 'ui.js')]);
  return { version, core, evo, ui };
}

async function loadChain(mods) {
  let json = null;
  try { json = await fetchJSON('chain.json'); } catch (e) { /* no checkpoint yet: start from genesis */ }
  return mods.evo.loadChain(json, manifest.seed);
}

// Advance the shared chain toward "now", one evolution per macrotask so play never stutters.
function catchUp() {
  if (catchingUp) return; catchingUp = true;
  const go = () => {
    try {
      const target = nowN();
      if (chain.upTo < target) { M.evo.advance(chain, manifest.seed); applyToWorld(); setTimeout(go, 0); return; }
    } catch (e) { console.error('evolution failed', e); }
    catchingUp = false;
  };
  go();
}

// Bring this player's world up to the chain, one evolution at a time.
function applyToWorld() {
  let last = null;
  while (appliedN < chain.upTo) {
    appliedN++;
    const e = chain.entries[appliedN - 1];
    try { M.evo.transition(world, appliedN, e.genome || genome(), manifest.seed); } catch (err) { console.error(err); }
    last = e;
  }
  if (last && Date.now() - startedAt > 3000) toast(`<b>Evolution ${last.n}: ${last.title}</b><br>${last.desc}`);
  refreshPanel();
}

function genome() { return chain.upTo ? chain.entries[chain.upTo - 1].genome : chain.genome; }

// ---------- player world persistence ----------
function save() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify({ n: appliedN, world: M.evo.packWorld(world), energy: world.energy, genesis: manifest.genesis })); } catch (e) {}
}
function restore() {
  try {
    const s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
    if (s && s.genesis === manifest.genesis) { const w = M.evo.unpackWorld(s.world); w.energy = s.energy ?? 100; return { world: w, n: s.n }; }
  } catch (e) {}
  return null;
}
function freshWorld() {
  const w = M.core.makeWorld((Math.random() * 2 ** 32) >>> 0);
  return w;
}

// ---------- the loop ----------
let lastTick = 0, failures = 0, previous = null;
function tick() {
  const g = genome();
  try {
    M.core.step(world, g, manifest.seed);
    failures = 0;
  } catch (e) {
    console.error('step failed', e);
    if (previous && ++failures > 2) { M = previous; previous = null; status('A new version misbehaved and was rolled back. Play continues.'); }
  }
  setTimeout(tick, g.tickMs || 120);
}
function frame() {
  try { M.ui.render(ctx, world, genome(), M.core); } catch (e) { console.error(e); }
  requestAnimationFrame(frame);
}

// ---------- hot reload ----------
async function checkManifest() {
  try {
    const m = await fetchJSON('manifest.json');
    if (m.version !== manifest.version) {
      const mods = await loadModules(m.version);
      const prevManifest = manifest;
      manifest = { ...m, genesis: prevManifest.genesis, seed: prevManifest.seed }; // the clock never moves
      const fresh = await loadChain(mods);
      // validate the new modules on a copy of the world before trusting them
      const test = mods.evo.unpackWorld(mods.evo.packWorld(world));
      mods.core.step(test, fresh.upTo ? fresh.entries[fresh.upTo - 1].genome : fresh.genome, manifest.seed);
      previous = M; M = mods;
      if (fresh.upTo >= chain.upTo) {
        chain = fresh;
        if (appliedN > chain.upTo) appliedN = chain.upTo;
      }
      status(`Game updated to ${m.version} without a restart.`);
      catchUp();
    }
  } catch (e) { console.warn('update check failed, staying on current version', e); }
}

// ---------- input ----------
let drawing = false;
function plant(ev) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((ev.clientX - rect.left) / rect.width * world.w), y = Math.floor((ev.clientY - rect.top) / rect.height * world.h);
  const g = genome();
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (Math.random() < 0.45) continue;
    const xx = (x + dx + world.w) % world.w, yy = (y + dy + world.h) % world.h, i = yy * world.w + xx;
    if (world.walls[i] || world.alive[i]) continue;
    if (g.energy) { if (world.energy < 1) return; world.energy -= 1; }
    world.alive[i] = 1; world.species[i] = 0; world.age[i] = 0;
  }
}
canvas.addEventListener('pointerdown', (e) => { drawing = true; canvas.setPointerCapture(e.pointerId); plant(e); });
canvas.addEventListener('pointermove', (e) => { if (drawing) plant(e); });
canvas.addEventListener('pointerup', () => { drawing = false; });
canvas.addEventListener('pointercancel', () => { drawing = false; });

// ---------- panel ----------
let toastTimer = 0;
function toast(html) { const t = $('toast'); t.innerHTML = html; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 9000); }
function status(s) { $('status').textContent = s; }
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function refreshPanel() {
  const n = chain.upTo, e = chain.entries[n - 1];
  $('evoN').textContent = `Evolution ${n}` + (e ? (e.kind === 'self' ? ' · chosen by the game' : ' · written by Claude') : '');
  if (e) { $('evoTitle').textContent = e.title; $('evoDesc').textContent = e.desc; }
  $('history').innerHTML = chain.entries.slice(-6).reverse().map((x) => `<li value="${x.n}"><b>${esc(x.title)}</b>${x.kind === 'self' ? '<span class="tag">self</span>' : ''}</li>`).join('');
}

function hud() {
  const g = genome();
  const s = M.core.stats(world, g);
  $('pop').textContent = s.pop.toLocaleString() + ` (${(s.density * 100).toFixed(1)}%)`;
  $('tick').textContent = world.tick.toLocaleString();
  $('genome').innerHTML = M.ui.describe(g, world).map(([k, v]) => `<div class="row"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('');
  const ms = manifest.genesis + (nowN() + 1) * manifest.periodMs - Date.now();
  $('next').textContent = `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
  const obj = g.objective && M.evo.OBJECTIVES[g.objective];
  $('objPanel').hidden = !obj;
  if (obj) {
    $('objText').textContent = obj.text;
    const won = obj.win(s);
    $('objScore').innerHTML = `<span class="${won ? 'win' : 'lose'}">${esc(obj.score(s))}</span>`;
    $('tribes').innerHTML = s.per.map((p, i) => { const c = M.core.palette(g).cell(i, 0); return `<span class="tribe"><span class="dot" style="background:rgb(${c})"></span>${p}</span>`; }).join('');
  }
  $('energyPanel').hidden = !g.energy;
  if (g.energy) $('energy').style.width = world.energy + '%';
}

// ---------- boot ----------
const startedAt = Date.now();
(async function boot() {
  manifest = await fetchJSON('manifest.json');
  M = await loadModules(manifest.version);
  chain = await loadChain(M);
  const saved = restore();
  if (saved) { world = saved.world; appliedN = Math.min(saved.n, chain.upTo); }
  else {
    world = freshWorld(); appliedN = chain.upTo;
    const g = genome();
    if (g.species > 1) for (let i = 0; i < world.alive.length; i++) { const x = i % world.w, y = (i / world.w) | 0; world.species[i] = Math.floor(((Math.atan2(y - world.h / 2, x - world.w / 2) + Math.PI) / (2 * Math.PI)) * g.species) % g.species; }
    M.core.reconcile(world, g);
  }
  applyToWorld();
  catchUp();
  tick(); frame();
  setInterval(hud, 500); hud();
  setInterval(catchUp, 5000);
  setInterval(checkManifest, 60000);
  setInterval(save, 10000);
  addEventListener('pagehide', save);
})();
