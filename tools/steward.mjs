// steward.mjs — run by Claude every hour (and by hand). Replays the evolution chain up to
// "now", takes a snapshot of every new evolution, appends it to log.json, writes the
// chain.json checkpoint, and bumps manifest.json so open pages hot-reload.
// Usage: node tools/steward.mjs [--to N] [--no-bump]
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import * as C from '../js/core.js';
import * as E from '../js/evolutions.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const P = (f) => path.join(root, f);
const readJSON = (f, d) => (fs.existsSync(P(f)) ? JSON.parse(fs.readFileSync(P(f), 'utf8')) : d);
const args = process.argv.slice(2);
const argTo = args.includes('--to') ? +args[args.indexOf('--to') + 1] : null;

const manifest = readJSON('manifest.json');
const log = readJSON('log.json', { entries: [] });
const chain = E.loadChain(readJSON('chain.json', null), manifest.seed);
const target = argTo ?? Math.max(0, Math.floor((Date.now() - manifest.genesis) / manifest.periodMs));

// ---------- PNG ----------
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function png(world, g, scale = 3) {
  const w = world.w * scale, h = world.h * scale, pal = C.palette(g);
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const c = C.cellRGB(world, g, ((y / scale) | 0) * world.w + ((x / scale) | 0), pal);
      const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2];
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- advance ----------
fs.mkdirSync(P('snapshots'), { recursive: true });
const t0 = Date.now(); let added = 0;
while (chain.upTo < target) {
  const entry = E.advance(chain, manifest.seed);
  // snapshot: the reference world 120 ticks into the new evolution
  const view = E.cloneWorld(chain.ref);
  for (let t = 0; t < 120; t++) C.step(view, entry.genome, C.hash('snapshot', manifest.seed, entry.n));
  const file = `snapshots/${String(entry.n).padStart(5, '0')}.png`;
  fs.writeFileSync(P(file), png(view, entry.genome));
  const s = C.stats(view, entry.genome);
  log.entries.push({
    n: entry.n, at: new Date(manifest.genesis + entry.n * manifest.periodMs).toISOString(), kind: entry.kind,
    title: entry.title, desc: entry.desc, op: entry.op, considered: entry.considered, fitness: entry.fitness, rescue: entry.rescue || undefined,
    rule: `B${entry.genome.birth.join('')}/S${entry.genome.survive.join('')}`, genome: entry.genome,
    snapshot: file, stats: { density: +s.density.toFixed(4), tribes: s.per },
  });
  added++;
}

// ---------- write ----------
const saved = E.saveChain(chain);
// keep chain.json light: clients only need recent genomes
saved.entries = saved.entries.map((e, i) => {
  const { considered, ...rest } = e;
  if (i < saved.entries.length - 60) delete rest.genome;
  return rest;
});
fs.writeFileSync(P('chain.json'), JSON.stringify(saved));
log.updatedAt = new Date().toISOString();
fs.writeFileSync(P('log.json'), JSON.stringify(log));
if (!args.includes('--no-bump')) {
  manifest.version = new Date().toISOString().slice(0, 16).replace(/[:]/g, '');
  fs.writeFileSync(P('manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
console.log(`steward: +${added} evolutions (now ${chain.upTo}) in ${Date.now() - t0} ms; version ${manifest.version}`);
