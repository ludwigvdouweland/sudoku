# Branching model

Three tiers, promoted in one direction: `feature/*` → `develop` → `master`.

## master

- **Production.** GitHub Pages serves the live site straight from this branch
  (see [DEPLOYMENT.md](DEPLOYMENT.md)) — there's no build step and no server
  process to restart; a push to `master` is picked up automatically and is
  live within ~1–2 minutes.
- Only ever updated by merging `develop` in, once that's been tested locally.
- Treat it as always-deployable: don't commit experimental or half-finished
  work here.

## develop

- The leading branch for ongoing work. Feature branches are cut from here
  and merged back here.
- Test locally against `develop` before promoting anything to `master`.
- When `develop` is in a good, tested state:
  ```powershell
  git checkout master
  git merge develop
  git push
  ```
  GitHub Pages redeploys automatically from the new `master`.

## feature/\<short-name\>

- One branch per feature or fix, cut from `develop`:
  ```powershell
  git checkout develop
  git checkout -b feature/my-change
  ```
- Merge back into `develop` when done — either locally
  (`git checkout develop && git merge feature/my-change`) or via a GitHub
  pull request, whichever you prefer for the change at hand. Delete the
  feature branch afterwards.

## Guardrail

This repo (like others on this machine) is covered by a local Claude Code
hook (`protect-branches.ps1`) that blocks Claude from committing, merging,
rebasing, resetting, pushing, or deleting `develop`, `master`, or
`support(/*)` directly. Claude only ever works on `feature/*` (or `bug/*`)
branches and hands off a branch or PR for you to merge into `develop` /
`master` yourself.
