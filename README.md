# Pipe Fitter

A single-page web app for designing 3D-printable **pipe adapters** and exporting them
as STL or 3MF. You describe a pipe as a chain of straight **sections** joined by optional
**bends**, set each end's treatment, and the app builds a live, watertight 3D model
plus an annotated 2D cross-section — all in the browser, with no server, no accounts,
and no build step.

It's meant for makers who need a transition between two tubes (a hose to a pipe, one
diameter to another, a bent run between fixed ports) and want a printable part in a
minute rather than a CAD session.

## What it can do

- **Any number of sections**, each with its own inner diameter, wall thickness, and
  length, joined by planar bends of any signed angle (alternating signs make S-curves).
- **End treatments** on the first and last sections: plain, chamfer, flange (with bolt
  holes), hose barb, teeth, and a **slip joint** (telescoping) for sliding two pipes
  together.
- **Live 3D preview** (orbit / pan / zoom, multiple render styles) and a **live 2D
  cross-section** with dimensions.
- **Export** to binary STL or 3MF, optionally oriented to sit flat on an end face.
- **Everything lives in the URL** — the full design, display units (mm/in), render
  style, camera pose, and panel state — so "Copy link" reproduces exactly what you see.

For how to use each control, open the in-app help (the **?** button); the same text
lives in [`HELP.md`](HELP.md).

## Running it

There is **no build step and nothing to install** — it's plain HTML, CSS, and ES
modules, and three.js is vendored. You only need to serve the folder over HTTP, because
ES-module imports don't work from `file://`.

Requirements:

- A **modern browser with WebGL2** (recent Chrome, Firefox, Safari, or Edge).
- Any **static file server**. No internet connection is needed at runtime — three.js and
  the fonts are bundled locally.

From the project root:

```bash
python3 -m http.server 8817
```

then open <http://localhost:8817/>. (Any equivalent static server works, e.g.
`npx serve`, `php -S localhost:8817`, or a hosting provider's static bucket.)

## Files

These must all be served together, with their relative paths preserved:

| Path | Purpose |
| --- | --- |
| `index.html` | Entry point; wires up the layout and loads `app.js` as a module. |
| `app.js` | Application: UI, panel, camera, exports, URL state. |
| `pipe-geometry.js` | All CAD math + the binary STL / 3MF writers. Dependency-free ES module. |
| `pipe-diagram.js` | The 2D cross-section schematic (Canvas 2D). |
| `app.css` | Application styles. |
| `dark.css` | Design-system stylesheet (tokens + components). |
| `HELP.md` | In-app help text, fetched at runtime for the **?** dialog. |
| `vendor/three.module.js` | three.js r160 (MIT), the only third-party runtime dependency. |
| `fonts/fonts.css` | `@font-face` rules. |
| `fonts/*.woff2` | Inter and JetBrains Mono (latin / latin-ext subsets). |
| `fonts/*-OFL.txt` | Font licenses (SIL OFL 1.1). |
| `assets/buymeacoffee.png` | Support-link logo. |

Repo extras — **not needed to run the app**:

| Path | Purpose |
| --- | --- |
| `LICENSE.md` | Project license (MIT). |
| `CREDITS.md` | Third-party attributions (three.js, fonts, trademarks). |

## How it works (briefly)

- `pipe-geometry.js` sweeps a per-station inner/outer profile along a planar centerline
  and triangulates a closed mesh; `build(params, segments)` returns positions, indices,
  a bounding box, a 2D silhouette, and clamp notes. It's pure, with no DOM or three.js
  dependency.
- `app.js` memoizes the geometry on the parameter signature, renders it with three.js
  (a hand-rolled orbit camera), draws the schematic via `pipe-diagram.js`, and mirrors
  the whole state into the URL hash. Every input is **clamped, never rejected**, so the
  model is always valid and exportable.

## License

MIT — see [`LICENSE.md`](LICENSE.md). Third-party components retain their own licenses;
see [`CREDITS.md`](CREDITS.md).
