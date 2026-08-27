# Sudoku

A self-contained Sudoku app: pick a difficulty, play on a polished grid with
mouse or keyboard, and track your own solving history and performance over
time. No build step, no Node.js, no account — plain HTML/CSS/JS that runs
entirely on your machine.

## Running it

Browsers block ES modules (`<script type="module">`) from loading over a bare
`file://` URL, so don't just double-click `index.html`. Serve the folder with
any static file server instead — Python (already on this machine) is the
easiest:

```powershell
cd c:\Claude\Sudoko
python -m http.server 8000
```

Then open **http://localhost:8000** in your browser.

Once the page has loaded once, it keeps working fully offline (refresh, kill
your Wi-Fi, whatever) — the only thing that ever needs a network connection
is the optional "Online source" toggle described below. `localhost` counts as
a secure context, so everything (including `crypto.randomUUID`) works without
HTTPS.

## Features

- **Difficulty select** — Easy / Normal / Hard, each mapped to a target clue
  count (see `js/sudoku-engine.js`).
- **Puzzle source** — by default, **New Game** generates a puzzle locally
  (instant, always works offline) using a backtracking generator that
  guarantees a unique solution. Turn on **Online source** to have it try
  fetching a puzzle from a public Sudoku API first, falling back to local
  generation automatically if that fails or you're offline.
- **Grid UI** — click a cell or navigate with arrow keys; fill values with
  the keyboard (1–9), the on-screen number pad, or notes/pencil-marks mode
  (`N` to toggle). Selected cell, its row/column/box, and matching values are
  all highlighted; rule violations and wrong entries are flagged in red.
- **Hint**, **Solve**, and **Reset Board** actions.
- **Solver comparison panel** (🧮 button) — every *new* puzzle (not
  resume/retry, since that's the same puzzle) is automatically solved by all
  5 solvers in the background — the app's own backtracking solver, a
  constraint-propagation (CP) solver, a Dancing Links (Algorithm X) solver,
  and two MILP formulations solved by HiGHS — and the panel shows each one's
  status, run time, and whether it agrees with the known solution. See
  [SOLVERS.md](SOLVERS.md) for how each solver works and a full
  performance/quality comparison.
- **History & stats panel** (📜 button) — every generated/loaded puzzle is
  saved locally with a unique ID. Resume an in-progress puzzle, replay a
  finished one, or delete old entries. Progress (board, notes, timer,
  mistakes) is saved continuously, and the app resumes your last unfinished
  puzzle automatically on reload.
- **Performance tracking** — a per-puzzle timer (pauses while the tab is
  hidden) and mistake counter. On completion you get:
  - your time and mistake count,
  - comparison against your own best time *on that exact puzzle*,
  - comparison against your own average time for that difficulty,
  - an estimated percentile ("faster than ~X% of players").

## About the "vs other players" estimate

This app has **no server and talks to no shared backend**, so there is no
real data from other users to compare against. The percentile shown is
computed from a **modeled** log-normal distribution of typical human solving
times per difficulty (see `js/estimate.js`) — a statistical estimate for fun
context, not a measurement. The win screen always labels it as such. Using
**Solve** to auto-fill the board is excluded from all stats/comparisons so it
can't fake a personal best.

If you later want a *real* worldwide leaderboard, that requires standing up
a shared backend (self-hosted or a cloud service) — intentionally left out
of this local-first build; ask and it can be added.

## Data & privacy

All history and stats live in your browser's `localStorage`, scoped to
whatever origin you serve the app from (e.g. `http://localhost:8000`). Only
this browser, on this machine, ever sees it. Clearing site data / browser
storage removes it. Nothing is ever sent anywhere except the optional
puzzle-fetch request when "Online source" is enabled.

## File structure

```
index.html            Page structure
css/styles.css         Styling (light/dark themes via CSS variables)
js/sudoku-engine.js    Pure Sudoku logic: generate, solve, validate
js/cp-solver.js        A constraint-propagation (CP) solver -- domain filtering
                        (naked/hidden singles) plus MRV-guided backtracking search.
                        Powers the solver comparison panel; see SOLVERS.md for the
                        write-up and cp-test.html for a standalone demo.
js/dlx-solver.js       A Dancing Links (Algorithm X) exact-cover solver. Powers the
                        solver comparison panel; see SOLVERS.md for the write-up and
                        dlx-test.html for a standalone demo.
js/milp-solver.js      Two MILP (mixed-integer programming) formulations of Sudoku,
                        solved by the vendored HiGHS solver. Powers the solver
                        comparison panel; see SOLVERS.md for the write-up and
                        milp-test.html for a standalone demo.
js/vendor/highs/        Vendored HiGHS solver (WebAssembly, MIT license)
js/api.js              Optional web puzzle source (opt-in, fails gracefully)
js/storage.js          Local history/attempts persistence (localStorage)
js/estimate.js         Modeled solve-time distribution for the percentile estimate
js/app.js              UI wiring / event handling — the entry point
```

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| Arrow keys | Move selection |
| 1–9 | Fill selected cell (or toggle a pencil mark in notes mode) |
| Backspace / Delete / 0 | Clear selected cell |
| N | Toggle notes mode |
