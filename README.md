# Evolving Life

It started as Conway's Game of Life. Every time someone presses **Evolve**, Claude looks at the game (a screenshot, live stats and the code of every earlier evolution) and writes the next evolution: a block of JavaScript that is hot-loaded into every open page. The game never stops or resets.

## How it fits together

* `js/engine.js`: the kernel. Plain Conway plus a plug-in `api` (rules, step wrappers, colours, drawing, input, HUD, persistent layers and state). Every hook is guarded; an evolution that keeps throwing is switched off automatically and play continues. It also has `trial()`, a headless test run.
* `js/app.js`: the page. Runs the world, draws it, polls `/api/state` every 15 s and hot-loads new evolutions from any player, saves the world to localStorage, and sends the game to Claude on Evolve.
* `api/evolve.js`: calls Claude (`claude-opus-5-5`) with the screenshot, stats and full history, test-runs the answer headless together with every earlier evolution, gives Claude one retry if it fails, then stores it. One evolution at a time (lock) and a 45 s cooldown.
* `api/state.js`: returns every evolution with its code.
* Storage: Vercel Blob (`evo/NNNNN.json`, `snap/NNNNN.png`), immutable, append-only.

## Configuration

Vercel environment variables: `ANTHROPIC_API_KEY` (set by the owner) and `BLOB_READ_WRITE_TOKEN` (set by the Blob store).
