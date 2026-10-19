# Branding assets (internal)

The marks, where they live, and how every size is produced. One source of truth: `apps/web/public`.

| File | Use | Made from |
|---|---|---|
| `favicon.svg` | tab icon in modern browsers; follows `prefers-color-scheme` (navy square / sky anchor in light, sky square / white anchor in dark) | hand-drawn, 32-unit viewBox |
| `favicon.ico` | tab icon fallback: 16, 32 and 48 px PNG frames, each rendered at its own size (the 16 px frame uses the thicker strokes the SVG declares in `data-small-stroke` and drops the `data-small="hide"` details) | `favicon.svg` |
| `favicon-32.png` | the 32 px frame as a PNG (pinned tabs, bookmarks on some browsers) | `favicon.svg` |
| `apple-touch-icon.png` (180) | iOS home screen — the full captain's cap | `logo-512.png` |
| `icon-192.png`, `icon-512.png` + `manifest.webmanifest` | Android / PWA icons — the full cap | `logo-512.png` |
| `logo.png`, `logo-512.png` | the full cap in the app (sidebar, brand icons) and above the sign-in form | the original artwork |

The Keycloak login theme (`deploy/helm/secops-cell/files/theme/matelot/login/resources/img`, copied to
`deploy/compose/init/theme`) carries the same `favicon.svg`, `favicon.ico`, `favicon-32.png` and
`apple-touch-icon.png`; `scripts/chart-test.sh` fails when they differ from `apps/web/public`.

## Regenerating

```bash
pnpm icons:build          # tools/icons/build.mjs: every size from favicon.svg / logo-512.png, into apps/web/public and the theme
pnpm --filter @secops/icons test   # --check: CI fails when a committed icon is not what the sources render
```

Edit `favicon.svg` (or replace `logo-512.png`), run the build, look at the strip below, commit everything together.
Nobody resamples a PNG by hand: the check compares pixels, so a hand-edited file fails CI.

## The 16 px and 32 px frames

`docs/branding/favicon-review.png` is written by the build — 16 px and 32 px frames at 8× (nearest-neighbour, so
every pixel shows), on a light and a dark tab bar:

![favicon frames at 16 and 32 px, light and dark](branding/favicon-review.png)

Design rules the mark follows: a single strong shape (the anchor alone, no cap, no badge outline), two flat colours on
a filled rounded square so it reads on both tab-bar colours, strokes 3 px at 32 px and ≥ 2 px at 16 px (the ring
3 px, the shaft and arms 3.6 units ≈ 1.8 px plus anti-aliasing — the thinnest that still leaves the ring's hole
open at 16 px), fluke tips only from 32 px up.
