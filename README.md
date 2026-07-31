# Simple Kanban

A local-first Kanban board: WIP limits, flow metrics, multi-user profiles, and a card
workflow that refuses to let work start before it's actually ready.

**Live:** https://barknard.github.io/kanban/

Your data never leaves your browser. There is no account, no server, and no telemetry.
Boards are stored in the browser (OPFS or IndexedDB, falling back to localStorage), and
you can point the app at a folder on disk to keep versioned JSON backups.

## Running it

It's one HTML file — open `index.html` and it works, including from `file://`.

For the service worker (offline install) you need a real origin:

```bash
npm install
npm run serve      # http://127.0.0.1:8791
```

## What's in the box

- **Lanes** — add, rename, reorder, delete, per-lane WIP limits with over-limit warnings
- **Cards** — problem/outcome/impact framing, effort points, risk, SLA, due dates,
  epics, sprints, tags, acceptance criteria, definition of done, attachments, blockers
- **Quality gates** — a card can't start without its planning fields, and can't be
  marked done without acceptance criteria and a definition of done
- **Flow metrics** — lead/cycle time percentiles, flow efficiency, throughput, work age
- **Multi-user** — profiles, per-user icons, presence, card edit locks, cross-tab sync
- **Backups** — grandfather-father-son retention when a save folder is set

## Testing

```bash
npm test                 # Playwright, Chromium
npx playwright test --project=mobile
```

The suite covers boot, lane and card CRUD, the validation gates, filters, keyboard
accessibility, quota handling and the PWA manifest.

Note for anyone writing new tests: the startup modal calls `showDirectoryPicker()` when
the browser has it, which opens a native OS dialog Playwright cannot drive. `openBoard()`
in `tests/helpers.ts` deletes that API before load to force the IndexedDB path — the same
path Firefox and mobile browsers take.

## Regenerating assets

```bash
npm run icons     # PWA icons from simple-kanban-logo.gif (needs Python + Pillow)
```

## Deploying

Push to `main`. The workflow runs the e2e suite and only publishes to Pages if it passes.

If you change `index.html` or any shell asset, bump `CACHE` in `sw.js` — otherwise
installed copies keep serving the old page.
