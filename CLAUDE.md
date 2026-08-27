# Sudoku app — project notes

A static, client-side Sudoku game (vanilla HTML/CSS/JS, no build step)
hosted on GitHub Pages. See [README.md](README.md) for app structure and
[DEPLOYMENT.md](DEPLOYMENT.md) for hosting details.

## Branching

See [BRANCHING.md](BRANCHING.md). Short version: `feature/*` branches off
`develop`; `develop` is the integration branch; `master` is production and
deploys automatically via GitHub Pages on push. A local Claude Code hook
enforces that Claude only commits on `feature/*`/`bug/*` branches — merges
into `develop` or `master` are done by hand.
