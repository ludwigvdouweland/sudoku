# Deployment

This app is published on the web via **GitHub Pages**.

- **Live URL**: https://ludwigvdouweland.github.io/sudoku/
- **Source repo**: https://github.com/ludwigvdouweland/sudoku (public)
- **Hosting**: GitHub Pages, serving static files from the `master` branch, root path (`/`)
- **Cost**: free (GitHub Pages, public repo)

## How it was set up

1. Installed GitHub CLI (`gh`) via `winget install --id GitHub.cli`.
2. Authenticated with `gh auth login` (web/device-code flow).
3. Initialized a git repo in this folder (`git init`), added a `.gitignore` excluding
   Claude Code's internal `.claude/` state directory, and made an initial commit.
4. Created the GitHub repo and pushed in one step:
   ```
   gh repo create sudoku --public --source=. --remote=origin --push
   ```
5. Enabled GitHub Pages via the API:
   ```
   gh api -X POST repos/ludwigvdouweland/sudoku/pages -f "source[branch]=master" -f "source[path]=/"
   ```

## Updating the live site

Day-to-day work happens on `develop` and `feature/*` branches, not directly
on `master` — see [BRANCHING.md](BRANCHING.md) for the full model. Once a
change has been tested locally on `develop`:

```powershell
git checkout master
git merge develop
git push
```

GitHub Pages rebuilds automatically; changes go live within ~1–2 minutes.

## Notes / caveats

- The repo is **public** — required for free GitHub Pages on a personal GitHub account.
  Anyone with the link can view the source code, not just play the game.
- No backend was added. Per-player history/stats still live only in each visitor's own
  browser `localStorage` (see [README.md](README.md#data--privacy)) — nothing is shared
  between players.
- To make the repo private, GitHub Pages requires a paid GitHub plan; alternatively, a
  different static host (Netlify, Cloudflare Pages, Vercel) can serve a private repo's
  Pages-equivalent on free tiers — ask if you'd like to switch.
