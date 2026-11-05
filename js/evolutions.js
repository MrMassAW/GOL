// evolutions.js — the history of the game.
// Evolutions 1–10 were written by hand. From 11 on, the game mutates its own genome:
// it proposes changes with a seeded random generator, tests each candidate in a
// private simulation, and keeps the first one that stays alive and interesting.
// Everything is deterministic from (seed, evolution number), so every player sees
// the same history and the steward can replay it to take snapshots.
//
// Append-only rules (so history never rewrites itself):
//   * never edit an authored evolution or an operator once it has fired;
//   * new operators get `since: <first evolution allowed to use them>`;
//   * chain.json checkpoints are authoritative for everything up to `upTo`.

import { baseGenome, makeWorld, reconcile, step, stats, hash, rng, maxNeighbours, W, H } from './core.js';

export const EVOLUTIONS_VERSION = 1;
const clone = (g) => JSON.parse(JSON.stringify(g));

// ---------- objectives the game can set for its player (you are the green tribe) ----------
export const OBJECTIVES = {
  survive: { text: 'Keep the green tribe the largest on the board.', score: (s) => s.pop ? Math.round(100 * s.per[0] / s.pop) + '% of all life is green' : '—', win: (s) => s.per[0] === Math.max(...s.per) },
  territory: { text: 'Hold ground: get green above a third of all living cells.', score: (s) => s.pop ? Math.round(100 * s.per[0] / s.pop) + '% green' : '—', win: (s) => s.per[0] > s.pop / 3 },
  diversity: { text: 'Keep every tribe alive. Rescue whoever is fading.', score: (s) => s.per.filter((p) => p > 0).length + ' of ' + s.per.length + ' tribes alive', win: (s) => s.per.every((p) => p > 0) },
  balance: { text: 'Keep the world between 10% and 30% alive.', score: (s) => Math.round(100 * s.density) + '% alive', win: (s) => s.density >= 0.1 && s.density <= 0.3 },
  bloom: { text: 'Make the world bloom: push life above 25% of the board.', score: (s) => Math.round(100 * s.density) + '% alive', win: (s) => s.density > 0.25 },
  underdog: { text: 'Help the smallest tribe catch up with the largest.', score: (s) => { const mx = Math.max(...s.per), mn = Math.min(...s.per); return mx ? Math.round(100 * mn / mx) + '% parity' : '—'; }, win: (s) => Math.min(...s.per) > 0.6 * Math.max(...s.per) },
};

// ---------- evolutions 1–10, written by hand ----------
export const AUTHORED = {
  1: { title: 'Afterglow', desc: 'Dying cells leave a fading trail, so you can see where life has been, not just where it is.', apply: (g) => { g.trail = 6; } },
  2: { title: 'Two tribes', desc: 'Life splits into green and red. A newborn takes the colour of the majority of its parents. You draw green.', apply: (g) => { g.species = 2; },
    onApply: (w) => { for (let i = 0; i < w.alive.length; i++) w.species[i] = (i % W) < W / 2 ? 0 : 1; } },
  3: { title: 'A purpose', desc: 'The game gets its first objective: keep the green tribe the largest. The score is live in the side panel.', apply: (g) => { g.objective = 'survive'; } },
  4: { title: 'Cosmic rays', desc: 'Rare spontaneous births anywhere on the board. The world can no longer die out completely.', apply: (g) => { g.cosmic = 0.00015; } },
  5: { title: 'HighLife', desc: 'The birth rule becomes B36/S23: six neighbours can also give birth. This rule allows self-replicating patterns.', apply: (g) => { g.birth = [3, 6]; } },
  6: { title: 'Walls', desc: 'Grey walls rise in a broken grid. Nothing lives inside them and nothing counts them as neighbours, so the board becomes rooms.', apply: (g) => { g.walls = { pattern: 'grid', seed: 6 }; } },
  7: { title: 'Seasons', desc: 'Every 120 ticks the season turns. In winter only exactly three neighbours give birth; in summer HighLife returns.', apply: (g) => { g.season = { period: 120, birth: [3] }; } },
  8: { title: 'Predators', desc: 'A blue tribe appears and the tribes form a cycle: green is eaten by red, red by blue, blue by green. A living cell with 3 or more predator neighbours converts.', apply: (g) => { g.species = 3; g.rps = 3; },
    onApply: (w) => { for (let i = 0; i < w.alive.length; i++) if (w.species[i] === 1 && (i % W) > (2 * W) / 3) w.species[i] = 2; } },
  9: { title: 'Energy', desc: 'Drawing now costs energy, which slowly regenerates. The objective shifts to territory: hold a third of all life.', apply: (g) => { g.energy = true; g.objective = 'territory'; } },
  10: { title: 'Awakening', desc: 'The game takes over its own evolution. From now on, every 5 minutes it proposes mutations to its genome, tests them in a private simulation, and keeps one that survives.', apply: (g) => { g.awake = true; g.hue = 12; } },
};

// ---------- mutation operators the game uses on itself ----------
const fmt = (a) => a.join('');
const ruleName = (g) => `B${fmt(g.birth)}/S${fmt(g.survive)}`;
const toggleIn = (arr, v) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v].sort((a, b) => a - b));
const PATTERNS = ['grid', 'rings', 'maze', 'islands', 'spiral'];

export const OPERATORS = [
  { id: 'birth', since: 11, weight: 3, apply(g, r) {
    const v = 1 + r.int(maxNeighbours(g)); const next = toggleIn(g.birth, v);
    if (!next.length || next.includes(1) || next.includes(2) && next.includes(3) && next.length > 3) return null;
    g.birth = next; return { title: `Birth on ${v} ${next.includes(v) ? 'enabled' : 'disabled'}`, desc: `The birth rule now reads ${ruleName(g)}.` }; } },
  { id: 'survive', since: 11, weight: 3, apply(g, r) {
    const v = r.int(maxNeighbours(g) + 1); const next = toggleIn(g.survive, v);
    if (!next.length) return null; g.survive = next;
    return { title: `Survival on ${v} ${next.includes(v) ? 'enabled' : 'disabled'}`, desc: `The survival rule now reads ${ruleName(g)}.` }; } },
  { id: 'geometry', since: 11, weight: 1, apply(g, r) {
    const opts = ['moore', 'vn', 'hex'].filter((x) => x !== g.neigh); g.neigh = r.pick(opts);
    const m = maxNeighbours(g); g.birth = g.birth.filter((x) => x <= m); g.survive = g.survive.filter((x) => x <= m);
    if (!g.birth.length) g.birth = [g.neigh === 'vn' ? 2 : 3]; if (!g.survive.length) g.survive = [2];
    const name = { moore: 'eight neighbours (square)', vn: 'four neighbours (cross)', hex: 'six neighbours (hexagonal)' }[g.neigh];
    return { title: `New geometry: ${g.neigh}`, desc: `Space itself changes. Each cell now sees ${name}. Rule is ${ruleName(g)}.` }; } },
  { id: 'speciate', since: 11, weight: 2, apply(g, r) {
    if (g.species >= 6) return null; g.species++;
    return { title: `A new tribe (${g.species} total)`, desc: `Tribe ${g.species} is born from a mutation and joins the predator cycle.`,
      onApply: 'speciate' }; } },
  { id: 'extinction', since: 11, weight: 1, apply(g, r) {
    if (g.species <= 2) return null; g.species--;
    return { title: `Tribes merge (${g.species} left)`, desc: 'The last tribe in the cycle is absorbed by the first.' }; } },
  { id: 'predation', since: 11, weight: 2, apply(g, r) {
    const v = r.pick([0, 2, 3, 4, 5].filter((x) => x !== g.rps)); g.rps = v;
    return { title: v ? `Predation threshold ${v}` : 'Truce', desc: v ? `A living cell converts when ${v} or more neighbours belong to its predator tribe.` : 'Tribes stop converting each other. Only births decide colours now.' }; } },
  { id: 'cosmic', since: 11, weight: 2, apply(g, r) {
    const v = r.pick([0, 0.00005, 0.0002, 0.0006, 0.0015]); if (v === g.cosmic) return null; g.cosmic = v;
    return { title: v ? `Radiation ×${Math.round(v / 0.00005)}` : 'Silence', desc: v ? `Spontaneous births at ${(v * 100).toFixed(3)}% per cell per tick.` : 'No more spontaneous births. Life must sustain itself.' }; } },
  { id: 'walls', since: 11, weight: 2, apply(g, r) {
    if (g.walls && r() < 0.25) { g.walls = null; return { title: 'Walls fall', desc: 'Every wall crumbles. The board is open again.' }; }
    const p = r.pick(PATTERNS); g.walls = { pattern: p, seed: r.int(1e6) };
    return { title: `Terrain: ${p}`, desc: `The walls rearrange into ${p}. Cells caught inside new walls die.` }; } },
  { id: 'seasons', since: 11, weight: 2, apply(g, r) {
    if (g.season && r() < 0.3) { g.season = null; return { title: 'Endless summer', desc: 'Seasons stop. The main birth rule holds all year.' }; }
    const period = r.pick([40, 80, 120, 200, 300]); const birth = [3, ...(r() < 0.5 ? [r.pick([2, 4, 5, 7, 8])] : [])].filter((x) => x <= maxNeighbours(g)).sort();
    g.season = { period, birth };
    return { title: `Seasons of ${period} ticks`, desc: `Every other ${period} ticks, birth follows B${fmt(birth)} instead of B${fmt(g.birth)}.` }; } },
  { id: 'tempo', since: 11, weight: 1, apply(g, r) {
    const v = r.pick([60, 80, 100, 120, 160, 220]); if (v === g.tickMs) return null; const faster = v < g.tickMs; g.tickMs = v;
    return { title: faster ? 'Time speeds up' : 'Time slows down', desc: `One tick now lasts ${v} ms.` }; } },
  { id: 'aging', since: 11, weight: 2, apply(g, r) {
    const v = r.pick([0, 12, 20, 35, 60]); if (v === g.maxAge) return null; g.maxAge = v;
    return { title: v ? `Lifespan ${v}` : 'Immortality', desc: v ? `Cells die of old age after ${v} ticks, and fade as they age.` : 'Cells no longer age.' }; } },
  { id: 'objective', since: 11, weight: 2, apply(g, r) {
    const ids = Object.keys(OBJECTIVES).filter((k) => k !== g.objective && (g.species > 1 || !['diversity', 'underdog', 'survive', 'territory'].includes(k)));
    g.objective = r.pick(ids); return { title: 'New objective', desc: OBJECTIVES[g.objective].text }; } },
  { id: 'afterglow', since: 11, weight: 1, apply(g, r) {
    const v = r.pick([0, 3, 6, 12, 20]); if (v === g.trail) return null; g.trail = v;
    return { title: v ? `Afterglow ${v}` : 'No afterglow', desc: v ? `Dead cells glow for ${v} ticks.` : 'Dead cells vanish instantly.' }; } },
  { id: 'hue', since: 11, weight: 1, apply(g, r) {
    g.hue = (g.hue + 30 + r.int(300)) % 360; return { title: 'The colours shift', desc: `The whole palette rotates to ${g.hue}°. Tribes keep their roles.` }; } },
];

// ---------- the self-evolution engine ----------
// The chain carries a canonical "reference world" that lives through every evolution
// (REF_TICKS ticks between each). Candidate mutations are trialled on copies of that
// world, scored for health, and the fittest one wins. Players' own worlds diverge
// (they draw on them), but they all share the genome that the reference world selected.
export const REF_TICKS = 300, TRIAL_TICKS = 90, CANDIDATES = 4;

export function cloneWorld(w) {
  return { ...w, alive: w.alive.slice(), species: w.species.slice(), age: w.age.slice(), trail: w.trail.slice(), walls: w.walls.slice() };
}

// Health of a world: lively but not overgrown, many tribes, and still changing.
export function fitness(before, after, g) {
  const s = stats(after, g);
  let changed = 0; for (let i = 0; i < after.alive.length; i++) if (after.alive[i] !== before.alive[i]) changed++;
  const activity = changed / after.alive.length;
  const dens = s.density;
  const densityScore = dens < 0.005 ? -2 : -Math.abs(Math.log((dens + 1e-4) / 0.16));
  const tribes = s.per.filter((p) => p > 3).length;
  const diversity = g.species > 1 ? tribes / g.species : 0.6;
  return { score: densityScore + 1.5 * diversity + 4 * Math.min(activity, 0.1), density: dens, tribes, activity };
}

function trial(g, n, seed, ref, k) {
  const w = cloneWorld(ref); const before = cloneWorld(ref);
  reconcile(w, g);
  for (let t = 0; t < TRIAL_TICKS; t++) step(w, g, hash('trial', seed, n, k));
  return fitness(before, w, g);
}

export function autoEvolve(g, n, seed, ref) {
  const r = rng(hash('evolve', seed, n));
  const pool = OPERATORS.filter((o) => o.since <= n);
  const total = pool.reduce((a, o) => a + o.weight, 0);
  const cands = [];
  for (let attempt = 0; attempt < CANDIDATES * 3 && cands.length < CANDIDATES; attempt++) {
    let x = r() * total, op = pool[0];
    for (const o of pool) { x -= o.weight; if (x <= 0) { op = o; break; } }
    const cand = clone(g); const out = op.apply(cand, r);
    if (!out) continue;
    const fit = trial(cand, n, seed, ref, cands.length);
    cands.push({ genome: cand, out, op: op.id, fit });
  }
  const status = trial(g, n, seed, ref, 'status-quo');
  cands.sort((a, b) => b.fit.score - a.fit.score);
  const best = cands[0];
  const considered = cands.map((c) => ({ op: c.op, title: c.out.title, score: +c.fit.score.toFixed(2) }));
  if (!best || best.fit.score < status.score - 0.5) {
    const cand = clone(g); cand.hue = (cand.hue + 20) % 360;
    return { genome: cand, title: 'A quiet drift', desc: `None of the ${cands.length} mutations it tried beat the world as it is, so only the colours drifted.`, op: 'drift', considered, fit: status };
  }
  return { genome: best.genome, title: best.out.title, desc: best.out.desc, op: best.op, considered, fit: best.fit };
}

// Apply evolution n to genome g. Returns the new genome and its log entry.
export function evolve(g, n, seed, ref) {
  const a = AUTHORED[n];
  if (a) { const ng = clone(g); a.apply(ng); return { genome: ng, entry: { n, kind: 'authored', title: a.title, desc: a.desc, genome: ng } }; }
  const out = autoEvolve(g, n, seed, ref);
  const fit = { score: +out.fit.score.toFixed(2), density: +out.fit.density.toFixed(4), tribes: out.fit.tribes, activity: +out.fit.activity.toFixed(4) };
  return { genome: out.genome, entry: { n, kind: 'self', title: out.title, desc: out.desc, op: out.op, considered: out.considered, fitness: fit, genome: out.genome } };
}

// World-level transition for evolution n (gentle: recolours, never clears).
export function transition(world, n, g, seed) {
  const a = AUTHORED[n];
  if (a && a.onApply) a.onApply(world, g);
  // any tribe with no members gets a patch of living cells, so new and dying tribes have a chance
  if (g.species > 1) {
    const s = stats(world, g); const r = rng(hash('transition', seed, n));
    for (let sp = 0; sp < g.species; sp++) if (s.per[sp] === 0) {
      const cx = r.int(W), cy = r.int(H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x; if (world.alive[i] && Math.hypot(x - cx, y - cy) < 14) world.species[i] = sp;
      }
    }
  }
  // rescue: a world that has almost died gets a spontaneous genesis, so play never stalls
  const s2 = stats(world, g);
  if (s2.density < 0.005) {
    const r = rng(hash('genesis', seed, n));
    const cx = r.int(W), cy = r.int(H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; if (Math.hypot(x - cx, (y - cy) * 1.3) < 16 && r() < 0.4) { world.alive[i] = 1; world.species[i] = r.int(g.species); }
    }
    world.rescued = n;
  }
  reconcile(world, g);
}

// ---------- the chain: evolution history + reference world ----------
const enc = (a) => { let s = ''; for (let i = 0; i < a.length; i += 8192) s += String.fromCharCode.apply(null, a.subarray(i, i + 8192)); return typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64'); };
const dec = (b) => { const s = typeof atob === 'function' ? atob(b) : Buffer.from(b, 'base64').toString('binary'); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; };
export function packWorld(w) { return { tick: w.tick, wallsKey: w.wallsKey, alive: enc(w.alive), species: enc(w.species), age: enc(w.age), trail: enc(w.trail), walls: enc(w.walls) }; }
export function unpackWorld(p) { return { w: W, h: H, energy: 100, tick: p.tick, wallsKey: p.wallsKey, alive: dec(p.alive), species: dec(p.species), age: dec(p.age), trail: dec(p.trail), walls: dec(p.walls) }; }

export function genesisChain(seed) {
  return { upTo: 0, genome: baseGenome(), entries: [], ref: makeWorld(hash('reference', seed)) };
}
export function loadChain(json, seed) {
  if (!json) return genesisChain(seed);
  return { upTo: json.upTo, genome: json.genome, entries: json.entries, ref: unpackWorld(json.ref) };
}
export function saveChain(c) { return { upTo: c.upTo, genome: c.genome, entries: c.entries, ref: packWorld(c.ref) }; }

// Advance the chain by one evolution (mutates and returns it).
export function advance(chain, seed) {
  const g0 = chain.genome;
  for (let t = 0; t < REF_TICKS; t++) step(chain.ref, g0, hash('reference', seed));
  const n = chain.upTo + 1;
  const out = evolve(g0, n, seed, chain.ref);
  transition(chain.ref, n, out.genome, seed);
  if (chain.ref.rescued === n) out.entry.rescue = true;
  chain.genome = out.genome; chain.entries.push(out.entry); chain.upTo = n;
  return out.entry;
}
