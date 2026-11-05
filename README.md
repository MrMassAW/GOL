# Evolving Life

A Game of Life that rewrites itself every five minutes and never stops.

* **Play:** `index.html`. You are the green tribe; draw to plant life.
* **History:** `log.html` shows every evolution with a snapshot, what changed, what the game considered, and observations.

## How evolution works without interrupting play

* **The clock.** `manifest.json` holds `genesis` and `periodMs` (5 minutes). Evolution *n* takes effect at `genesis + n × period`, on every open page at once. No deploy is needed for an evolution to happen.
* **The genome.** Everything that defines the game (rules, geometry, tribes, predation, terrain, seasons, lifespan, tempo, objective, energy) is one JSON genome (`js/core.js → baseGenome`). An evolution transforms the genome; the next tick simply uses the new genome. The board is never cleared.
* **Evolutions 1 to 10** were written by hand (`js/evolutions.js → AUTHORED`).
* **From 11 on the game evolves itself.** A deterministic engine (seeded by evolution number) proposes up to 4 mutations from `OPERATORS`, trials each one for 90 ticks on a copy of a shared *reference world*, scores them for health (density near 16%, number of tribes alive, activity) and keeps the fittest. If none beat the status quo, it only drifts colours. A world that nearly dies gets a "rescue genesis".
* **Hot reload.** The page polls `manifest.json` every minute. When `version` changes it imports the new modules from `/r/<version>/…` (a Vercel rewrite to `/js/…`, so every version gets fresh module URLs), test-runs them on a copy of your world, and swaps them in. If the new code throws, it rolls back. Your world stays in memory and in localStorage.
* **The steward** (`node tools/steward.mjs`, run hourly by Claude) replays the chain to now, renders a PNG snapshot of each new evolution, appends `log.json`, writes the `chain.json` checkpoint, and bumps `manifest.json`.

## Append-only rules for changing the game

1. Never edit an authored evolution or operator that has already fired. Add new ones.
2. A new operator gets `since: <first evolution number allowed to use it>`.
3. `chain.json` is authoritative for history up to `upTo`; the steward only appends.
4. A new `core.js` must accept worlds made by older versions (same typed-array fields).
