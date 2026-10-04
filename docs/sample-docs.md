# Sample docs with a "Run in simulator" button

`/docs/` serves a mirrored copy of the official Zephyr documentation page for
every packaged sample, with a **Run in simulator** button injected next to
"Browse source code on GitHub". The button opens the emulator in a
near-fullscreen dialog, pre-selecting the right board and app — a prototype of
what the widget could look like embedded in the upstream docs.

The pages live in `public/docs/` (gitignored, not committed) and are
generated with:

```console
npm run docs:fetch   # re-mirrors from docs.zephyrproject.org/latest
```

Run it before `npm run dev`/`npm run build` locally; the deploy workflow
([.github/workflows/pages.yml](../.github/workflows/pages.yml)) runs it too, so
the live site always ships the current mirror.

The script ([tools/fetch-docs.mjs](../tools/fetch-docs.mjs)) reads
`tools/samples.manifest`, mirrors each sample's page plus its CSS/JS/font
requisites, rewrites links (pages inside the subset stay local, everything
else points at the live docs), and injects the widget
([tools/docs-widget/](../tools/docs-widget)) — deliberately framework-free JS/CSS
so it could later ship as a Sphinx extension. The pages also load
`coi-serviceworker.js`: the emulator needs `SharedArrayBuffer`, which only
exists when the *top-level* document is cross-origin isolated, so the docs
pages have to opt in themselves for the embedded emulator to boot on GitHub
Pages. Restart the dev server after regenerating — Vite caches the `public/`
file list at startup.

The widget reads its settings from a `window.ZEPHYR_SIM` object the script
writes into each page: the app id, the board to boot by default, and, for a
sample with a guided tour, `tour`, the tour id to start. The run link carries
it as `&tour=`. The script passes each sample's default tour
(`tours/<app>.tour.md`); a page could name another tour of the same sample
instead (`basic_button.msgq`), or `none` for a run with no tour. Tour ids and
the query string are in
[tours.md](tours.md#several-tours-per-sample-and-links-into-one).

The script also writes `public/docs/manifest.json` — per-sample title,
description and links (mirrored page, canonical docs, GitHub source), keyed by
sample path. The app's sample gallery ([src/sampleDocs.ts](../src/sampleDocs.ts))
fetches it lazily and prefers those upstream titles and descriptions for its
list; when the mirror has not run (any dev checkout), the gallery falls back to
the curated metadata in `src/boards.ts` and the links it can compute from the
sample path alone.
