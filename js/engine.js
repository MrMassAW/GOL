// engine.js — the kernel of Evolving Life.
// It runs plain Conway's Game of Life and nothing else. Every change to the game is an
// "evolution": a block of JavaScript written by Claude that plugs into the kernel through
// the `api` object below. Evolutions are loaded live, in order, without ever resetting
// the world. A misbehaving evolution is switched off automatically; play continues.
// Runs in the browser and in Node (the server test-runs every new evolution headless).

export const KERNEL_VERSION = 1;
export const W = 128, H = 80, N = W * H;

export function createGame() {
  return {
    W, H, N, tick: 0,
    alive: new Uint8Array(N),
    layers: {},                       // name -> typed array (persistent)
    data: {},                         // evolution id -> JSON state (persistent)
    params: { birth: [3], survive: [2, 3], tickMs: 120 },
    hooks: { before: [], after: [], rule: [], step: [], color: [], draw: [], pointer: [], hud: [] },
    mods: [],                         // { n, title, active, errors }
    notices: [],
    paused: false,
  };
}

export function seed(game, density = 0.25, rnd = Math.random) {
  for (let i = 0; i < game.N; i++) game.alive[i] = rnd() < density ? 1 : 0;
}

export const idx = (x, y) => ((y % H + H) % H) * W + ((x % W + W) % W);
const MOORE = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
const NEIGH = new Int32Array(N * 8);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let k = 0; k < 8; k++) NEIGH[(y * W + x) * 8 + k] = idx(x + MOORE[k][0], y + MOORE[k][1]);
export function neighbours(i) { const o = i * 8; return Array.from(NEIGH.subarray(o, o + 8)); }
export function countAlive(game, i, arr = game.alive) { let c = 0; const o = i * 8; for (let k = 0; k < 8; k++) c += arr[NEIGH[o + k]] ? 1 : 0; return c; }

// ---------- safe hook calls ----------
function guard(game, h, fn) {
  if (!h.mod.active) return undefined;
  try { return fn(); } catch (e) {
    h.mod.errors = (h.mod.errors || 0) + 1;
    h.mod.lastError = String(e && e.message || e);
    if (h.mod.errors >= 25) disableMod(game, h.mod.n, `switched off after repeated errors: ${h.mod.lastError}`);
    return undefined;
  }
}
export function disableMod(game, n, why) {
  const m = game.mods.find((x) => x.n === n); if (!m || !m.active) return;
  m.active = false;
  for (const k of Object.keys(game.hooks)) game.hooks[k] = game.hooks[k].filter((h) => h.mod.n !== n);
  game.notices.push(`Evolution ${n} (${m.title}) ${why}`);
}

// ---------- one tick ----------
function baseStep(game) {
  const { alive } = game, next = new Uint8Array(N);
  const B = new Uint8Array(9), S = new Uint8Array(9);
  for (const b of game.params.birth) B[b] = 1; for (const s of game.params.survive) S[s] = 1;
  const rules = game.hooks.rule;
  for (let i = 0; i < N; i++) {
    const o = i * 8; let c = 0;
    for (let k = 0; k < 8; k++) c += alive[NEIGH[o + k]] ? 1 : 0;
    let v = alive[i] ? S[c] : B[c];
    for (let r = rules.length - 1; r >= 0; r--) {
      const h = rules[r]; const out = guard(game, h, () => h.fn(game, i, c, alive[i]));
      if (out !== undefined && out !== null) { v = out ? 1 : 0; break; }
    }
    next[i] = v;
  }
  game.alive = next;
}
export function step(game) {
  if (game.paused) return;
  for (const h of game.hooks.before.slice()) guard(game, h, () => h.fn(game));
  // step hooks wrap each other: the newest evolution decides whether to call the older step
  let run = () => baseStep(game);
  for (const h of game.hooks.step) {
    const prev = run;
    run = () => {
      const errs = h.mod.errors; const tickBefore = game.alive;
      guard(game, h, () => h.fn(game, prev));
      if (h.mod.errors !== errs && game.alive === tickBefore) prev(); // a crashing step still lets life go on
    };
  }
  run();
  game.tick++;
  for (const h of game.hooks.after.slice()) guard(game, h, () => h.fn(game));
}

// ---------- appearance ----------
export function cellColor(game, i) {
  const c = game.hooks.color;
  for (let r = c.length - 1; r >= 0; r--) { const h = c[r]; const out = guard(game, h, () => h.fn(game, i)); if (out) return out; }
  return game.alive[i] ? [95, 211, 141] : [13, 15, 20];
}

// ---------- the API an evolution receives ----------
export function makeApi(game, mod, env = {}) {
  const add = (kind) => (fn) => { if (typeof fn === 'function') game.hooks[kind].push({ mod, fn }); };
  game.data[mod.id] = game.data[mod.id] || {};
  return {
    W, H, N, idx, neighbours, count: (i, arr) => countAlive(game, i, arr),
    xy: (i) => [i % W, (i / W) | 0],
    params: game.params,
    state: game.data[mod.id],
    shared: game.data.__shared || (game.data.__shared = {}),
    layer(name, Type = Uint8Array) {
      const l = game.layers[name];
      if (l && l.length === N && l.constructor === Type) return l;
      return (game.layers[name] = new Type(N));
    },
    beforeTick: add('before'),
    afterTick: add('after'),
    rule: add('rule'),
    step: add('step'),
    color: add('color'),
    draw: add('draw'),
    pointer: add('pointer'),
    hud: add('hud'),
    setTickMs(ms) { game.params.tickMs = Math.max(30, Math.min(1000, ms | 0)); },
    toast(msg) { env.toast ? env.toast(String(msg)) : null; },
    random: Math.random,
    disable(n) { disableMod(game, n, `was retired by evolution ${mod.n}`); },
  };
}

// Apply one evolution { n, title, code, retire } to a running game.
export function applyMod(game, rec, env = {}) {
  if (game.mods.some((m) => m.n === rec.n)) return { ok: true, skipped: true };
  const mod = { n: rec.n, id: 'e' + rec.n, title: rec.title, active: true, errors: 0 };
  game.mods.push(mod);
  for (const r of rec.retire || []) disableMod(game, r, `was retired by evolution ${rec.n}`);
  try {
    const fn = new Function('game', 'api', '"use strict";\n' + rec.code);
    fn(game, makeApi(game, mod, env));
    return { ok: true };
  } catch (e) {
    disableMod(game, rec.n, `failed to start: ${e.message}`);
    return { ok: false, error: String(e && e.stack || e) };
  }
}

// ---------- persistence ----------
const enc = (a) => { const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); let s = ''; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); return typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64'); };
const dec = (b, Type) => { const s = typeof atob === 'function' ? atob(b) : Buffer.from(b, 'base64').toString('binary'); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return new Type(u.buffer); };
const TYPES = { Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array };
export function serialize(game) {
  const layers = {};
  for (const [k, v] of Object.entries(game.layers)) if (v && TYPES[v.constructor.name]) layers[k] = { t: v.constructor.name, d: enc(v) };
  return { tick: game.tick, alive: enc(game.alive), layers, data: game.data };
}
export function restore(game, s) {
  game.tick = s.tick || 0; game.alive = dec(s.alive, Uint8Array);
  for (const [k, v] of Object.entries(s.layers || {})) if (TYPES[v.t]) game.layers[k] = dec(v.d, TYPES[v.t]);
  game.data = s.data || {};
}

// ---------- headless trial (used by the server before accepting an evolution) ----------
export function trial(records, ticks = 60) {
  const game = createGame(); seed(game, 0.25);
  const noop = () => noop; const ctx = new Proxy(noop, { get: () => noop, set: () => true, apply: () => noop });
  const t0 = Date.now(); const results = [];
  for (const r of records) results.push({ n: r.n, ...applyMod(game, r) });
  for (let t = 0; t < ticks; t++) step(game);
  for (let i = 0; i < N; i += 7) cellColor(game, i);
  for (const h of game.hooks.draw) guard(game, h, () => h.fn(ctx, game, 6));
  for (const h of game.hooks.hud) guard(game, h, () => h.fn(game));
  for (const h of game.hooks.pointer) guard(game, h, () => h.fn(game, { x: 10, y: 10, i: idx(10, 10), type: 'down', buttons: 1 }));
  for (let t = 0; t < 20; t++) step(game);
  let pop = 0; for (let i = 0; i < N; i++) pop += game.alive[i] ? 1 : 0;
  return { ms: Date.now() - t0, results, mods: game.mods.map((m) => ({ n: m.n, active: m.active, errors: m.errors, lastError: m.lastError })), notices: game.notices, pop };
}

// ---------- guarded entry points for the page ----------
export function runDraw(game, ctx, cellPx) {
  for (const h of game.hooks.draw.slice()) { ctx.save(); guard(game, h, () => h.fn(ctx, game, cellPx)); ctx.restore(); }
}
export function runHud(game) {
  const out = [];
  for (const h of game.hooks.hud.slice()) { const html = guard(game, h, () => h.fn(game)); if (html) out.push({ n: h.mod.n, title: h.mod.title, html: String(html) }); }
  return out;
}
export function runPointer(game, ev) {
  let handled = false;
  for (let r = game.hooks.pointer.length - 1; r >= 0; r--) { const h = game.hooks.pointer[r]; if (guard(game, h, () => h.fn(game, ev)) === true) { handled = true; break; } }
  return handled;
}
