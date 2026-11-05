// ui.js — drawing and genome description. Hot-swappable like core.js.
export const UI_VERSION = 1;

let img = null, imgW = 0, imgH = 0;
export function render(ctx, world, g, core) {
  const { w, h } = world;
  if (!img || imgW !== w || imgH !== h) { img = ctx.createImageData(w, h); imgW = w; imgH = h; }
  const pal = core.palette(g); const d = img.data;
  for (let i = 0; i < w * h; i++) {
    const c = core.cellRGB(world, g, i, pal); const o = i * 4;
    d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

const NEIGH = { moore: 'square, 8 neighbours', vn: 'cross, 4 neighbours', hex: 'hexagonal, 6 neighbours' };
export function describe(g, world) {
  const rows = [
    ['Rule', `B${g.birth.join('')}/S${g.survive.join('')}`],
    ['Geometry', NEIGH[g.neigh]],
    ['Tribes', String(g.species)],
  ];
  if (g.rps) rows.push(['Predation', `convert at ${g.rps} predators`]);
  if (g.season) { const winter = Math.floor(world.tick / g.season.period) % 2 === 1; rows.push(['Season', `${winter ? 'winter' : 'summer'} (B${(winter ? g.season.birth : g.birth).join('')}), every ${g.season.period} ticks`]); }
  if (g.cosmic) rows.push(['Radiation', `${(g.cosmic * 100).toFixed(3)}% per cell/tick`]);
  if (g.maxAge) rows.push(['Lifespan', `${g.maxAge} ticks`]);
  if (g.walls) rows.push(['Terrain', g.walls.pattern]);
  if (g.trail) rows.push(['Afterglow', `${g.trail} ticks`]);
  rows.push(['Tempo', `${g.tickMs} ms per tick`]);
  return rows;
}
