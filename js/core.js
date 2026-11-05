// core.js — the simulation. Pure functions, no DOM. Runs in the browser and in Node.
// This module is hot-swappable: the shell re-imports it when manifest.json's version
// changes, and the world (plain typed arrays) is handed over untouched.
// Contract: a new core must accept worlds created by older cores (same fields).

export const CORE_VERSION = 1;
export const W = 128, H = 80;

// ---------- deterministic randomness ----------
export function hash(...parts) {
  let h = 2166136261 >>> 0;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    h ^= 0x9e3779b9; h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
export function rng(seed) {
  let a = seed >>> 0;
  const f = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  f.int = (n) => Math.floor(f() * n);
  f.pick = (arr) => arr[Math.floor(f() * arr.length)];
  return f;
}

// ---------- genome ----------
// Everything that defines "the game" lives here. Evolutions transform it.
export function baseGenome() {
  return {
    birth: [3], survive: [2, 3],   // Conway B3/S23
    neigh: 'moore',                // moore | vn | hex
    trail: 0,                      // afterglow frames left by dead cells
    species: 1,                    // competing colours; newborns take the majority colour
    rps: 0,                        // predation: cell converts if >= rps neighbours of its predator species (0 = off)
    cosmic: 0,                     // chance per cell per tick of a spontaneous birth
    walls: null,                   // { pattern, seed }
    season: null,                  // { period, birth } alternative birth rule every other season
    maxAge: 0,                     // cells die of old age after this many ticks (0 = immortal)
    tickMs: 120,
    hue: 0,                        // palette rotation in degrees
    objective: null,               // id of the current player objective
    energy: false,                 // drawing costs energy that regenerates
    awake: false,                  // the self-evolution engine is running
  };
}
export function maxNeighbours(g) { return g.neigh === 'vn' ? 4 : g.neigh === 'hex' ? 6 : 8; }

// ---------- world ----------
export function makeWorld(seed, density = 0.28) {
  const r = rng(seed);
  const n = W * H;
  const world = { w: W, h: H, tick: 0, alive: new Uint8Array(n), species: new Uint8Array(n), age: new Uint8Array(n), trail: new Uint8Array(n), walls: new Uint8Array(n), wallsKey: '', energy: 100 };
  for (let i = 0; i < n; i++) if (r() < density) world.alive[i] = 1;
  return world;
}

const OFFS = {
  moore: [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]],
  vn: [[0, -1], [-1, 0], [1, 0], [0, 1]],
  // offset-row hex: even rows lean left, odd rows lean right
  hexE: [[-1, -1], [0, -1], [-1, 0], [1, 0], [-1, 1], [0, 1]],
  hexO: [[0, -1], [1, -1], [-1, 0], [1, 0], [0, 1], [1, 1]],
};

export function wallPattern(pattern, seed) {
  const r = rng(hash('walls', pattern, seed));
  const m = new Uint8Array(W * H);
  const set = (x, y) => { if (x >= 0 && y >= 0 && x < W && y < H) m[y * W + x] = 1; };
  if (pattern === 'grid') {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
      if ((x % 32 === 0 || y % 20 === 0) && (x + y) % 9 > 2) set(x, y);
  } else if (pattern === 'rings') {
    const cx = W / 2, cy = H / 2;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - cx, (y - cy) * 1.4); const a = Math.atan2(y - cy, x - cx);
      if (Math.abs(d % 18 - 9) < 0.6 && Math.sin(a * 3 + d) < 0.6) set(x, y);
    }
  } else if (pattern === 'maze') {
    for (let y = 4; y < H; y += 10) for (let x = 4; x < W; x += 10) {
      const horiz = r() < 0.5; for (let k = 0; k < 8; k++) horiz ? set(x + k, y) : set(x, y + k);
    }
  } else if (pattern === 'islands') {
    for (let k = 0; k < 9; k++) {
      const cx = r.int(W), cy = r.int(H), rad = 5 + r.int(7);
      for (let t = 0; t < 360; t += 4) { const a = t * Math.PI / 180; if (t % 60 > 12) set(Math.round(cx + Math.cos(a) * rad), Math.round(cy + Math.sin(a) * rad * 0.8)); }
    }
  } else if (pattern === 'spiral') {
    const cx = W / 2, cy = H / 2;
    for (let t = 0; t < 40; t += 0.01) { const rr = 2.2 * t; if ((t * 7 | 0) % 6) set(Math.round(cx + Math.cos(t) * rr), Math.round(cy + Math.sin(t) * rr * 0.7)); }
  }
  return m;
}

// Bring the world in line with a (possibly new) genome without resetting anything.
export function reconcile(world, g) {
  const key = g.walls ? g.walls.pattern + ':' + g.walls.seed : '';
  if (key !== world.wallsKey) {
    world.walls = key ? wallPattern(g.walls.pattern, g.walls.seed) : new Uint8Array(W * H);
    world.wallsKey = key;
    for (let i = 0; i < world.walls.length; i++) if (world.walls[i]) world.alive[i] = 0;
  }
  for (let i = 0; i < world.species.length; i++) if (world.species[i] >= g.species) world.species[i] = world.species[i] % g.species;
}

// ---------- one tick ----------
const NB = {};
function neighbourTable(kind, w, h) {
  const key = kind + w + 'x' + h; if (NB[key]) return NB[key];
  const k = kind === 'vn' ? 4 : kind === 'hex' ? 6 : 8; const t = new Int32Array(w * h * k);
  for (let y = 0; y < h; y++) {
    const offs = kind === 'hex' ? (y & 1 ? OFFS.hexO : OFFS.hexE) : OFFS[kind] || OFFS.moore;
    for (let x = 0; x < w; x++) for (let j = 0; j < k; j++)
      t[(y * w + x) * k + j] = ((y + offs[j][1] + h) % h) * w + ((x + offs[j][0] + w) % w);
  }
  return (NB[key] = { t, k });
}

export function step(world, g, seed = 0) {
  const { w, h, alive, species, age, trail, walls } = world;
  const n = w * h;
  const r = rng(hash('tick', seed, world.tick));
  const nextAlive = new Uint8Array(n), nextSpecies = new Uint8Array(n), nextAge = new Uint8Array(n);
  const S = g.species;
  const counts = new Uint8Array(8);
  let birthSet = g.birth;
  if (g.season && Math.floor(world.tick / g.season.period) % 2 === 1) birthSet = g.season.birth;
  const B = new Uint8Array(9), Sv = new Uint8Array(9);
  for (const b of birthSet) B[b] = 1;
  for (const s of g.survive) Sv[s] = 1;
  const { t, k } = neighbourTable(g.neigh, w, h);
  const multi = S > 1;
  for (let i = 0; i < n; i++) {
    if (walls[i]) continue;
    let c = 0; const base = i * k;
    if (multi) { counts.fill(0); for (let j = 0; j < k; j++) { const q = t[base + j]; if (alive[q]) { c++; counts[species[q]]++; } } }
    else for (let j = 0; j < k; j++) c += alive[t[base + j]];
    if (alive[i]) {
      let sp = species[i];
      let lives = Sv[c] === 1;
      if (g.maxAge && age[i] >= g.maxAge) lives = false;
      if (lives) {
        if (multi && g.rps) { const pred = (sp + 1) % S; if (counts[pred] >= g.rps) sp = pred; }
        nextAlive[i] = 1; nextSpecies[i] = sp; nextAge[i] = age[i] < 255 ? age[i] + 1 : 255;
      } else nextSpecies[i] = sp; // remember colour for the afterglow
    } else {
      let born = B[c] === 1, sp = 0;
      if (born) {
        if (multi) { let best = -1; for (let s = 0; s < S; s++) if (counts[s] > best || (counts[s] === best && r() < 0.5)) { best = counts[s]; sp = s; } }
      } else if (g.cosmic && r() < g.cosmic) { born = true; sp = r.int(S); }
      if (born) { nextAlive[i] = 1; nextSpecies[i] = sp; }
      else if (trail[i]) nextSpecies[i] = species[i];
    }
  }
  for (let i = 0; i < n; i++) {
    if (alive[i] && !nextAlive[i]) trail[i] = g.trail; else if (trail[i]) trail[i]--;
    if (nextAlive[i]) trail[i] = 0;
  }
  world.alive = nextAlive; world.species = nextSpecies; world.age = nextAge; world.tick++;
  if (g.energy) world.energy = Math.min(100, world.energy + 0.35);
  return world;
}

// ---------- appearance (shared by browser canvas and Node PNG snapshots) ----------
export const SPECIES_HUES = [140, 0, 210, 45, 285, 175];
function hsl(h, s, l) {
  s /= 100; l /= 100; const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
export function palette(g) {
  const hue = (x) => ((x + g.hue) % 360 + 360) % 360;
  const winter = false;
  return {
    bg: hsl(hue(230), 25, 7),
    wall: hsl(hue(230), 12, 32),
    cell: (sp, ag) => hsl(hue(SPECIES_HUES[sp % 6]), g.species > 1 ? 80 : 70, g.maxAge ? 72 - Math.min(30, ag * 30 / g.maxAge) : 62),
    trail: (sp, t) => hsl(hue(SPECIES_HUES[sp % 6]), 50, 7 + 22 * t / Math.max(1, g.trail)),
    winter,
  };
}
export function cellRGB(world, g, i, pal) {
  if (world.walls[i]) return pal.wall;
  if (world.alive[i]) return pal.cell(world.species[i], world.age[i]);
  if (world.trail[i]) return pal.trail(world.species[i], world.trail[i]);
  return pal.bg;
}

export function stats(world, g) {
  const per = new Array(Math.max(1, g.species)).fill(0); let pop = 0;
  for (let i = 0; i < world.alive.length; i++) if (world.alive[i]) { pop++; per[world.species[i] % per.length]++; }
  return { pop, per, density: pop / (world.w * world.h) };
}
