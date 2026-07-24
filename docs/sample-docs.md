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
