---
name: copywriting
description: Write user-facing copy for Zephyr in the Browser aimed at people learning Zephyr. Use when drafting or editing UI strings, tour prose, gallery descriptions, onboarding, empty states, tooltips, error messages, README blurbs, or any learner-facing text. Enforces clutter-free UI (tooltips over subtitles; consistent subtitle use when present). Do not use for maintainer docs under docs/ about building the emulator.
---

# Copywriting (Zephyr learners)

## Audience

Write for people **learning Zephyr** — new or intermediate embedded developers using this page to understand samples, drivers, threads, and the kernel.

**Not** the audience:

- Maintainers of this repository
- People building or extending the emulator, QEMU/WASM stack, or peripheral bridges
- Experts using advanced Zephyr features mainly to drive tooling

If a sentence only helps someone who already ships firmware for a living, cut it or move it to maintainer docs under `docs/`.

## Voice

- Teach Zephyr through what the reader can see and do on the page.
- Prefer second person ("you") and present tense.
- Short paragraphs. One idea per paragraph.
- Name the Zephyr concept, then show what it does — do not dump glossary definitions.
- Explain a term the first time it matters; after that, reuse the same word.
- Be concrete: cite the call, the pin, the thread, the dock row — not abstractions about "the platform."
- Tone: curious, precise, never cute. Do not treat older tour drafts as a voice model — judge each surface against this skill and [terminology.md](terminology.md).

## Consistency

Always use the same word for the same thing. Prefer product and Zephyr terms from [terminology.md](terminology.md). Do not invent synonyms for UI chrome or Zephyr concepts already named there.

When unsure of a Zephyr term, check the [Zephyr glossary](https://docs.zephyrproject.org/latest/glossary.html) or the Zephyr knowledge sources before coining language.

## UI density

Keep the UI **as clutter-free as possible**.

- Prefer a single clear label per control, row, or widget.
- **Tooltips are fine** for extra detail, units, or “what is this?” — put secondary text there, not under the label.
- **Do not add subtitles** (secondary lines under a title/label) by default.
- When a given type or level of UI *does* use a subtitle, **every peer of that type/level must use one the same way** — same role, similar length, same information kind. Never mix subtitled and subtitle-free siblings (e.g. some dock rows with a blurb and others without, or one picker entry with a description line and its neighbors bare).
- If you cannot write a useful subtitle for every peer, drop subtitles for that level and use tooltips or tour/help prose instead.

## What belongs in learner copy

| Include | Leave out |
| --- | --- |
| What the sample / API / kernel is doing | How QEMU, Emscripten, or virtio is wired |
| How to try it in the UI (Board, App, device dock, tour) | Build scripts, container images, patch files |
| Stock Zephyr APIs and concepts | Repo-internal module paths and bridge implementation |
| Why a result appears on screen | Performance footnotes for wasm JIT / TCI |

Point advanced or build-the-tool readers at `docs/` rather than stuffing that detail into UI or tour prose.

## Surfaces this skill covers

- Guided tour Markdown (`tours/*.tour.md`)
- Sample labels and one-line descriptions (`src/boards.ts`, gallery copy)
- UI labels, tooltips, empty states, errors, aria text
- Short marketing / README lines aimed at end users
- In-page help that teaches Zephyr, not the emulator

## Human review

Copy is **generally not vetted** before landing — ship small edits freely.

**Pause for human review** when a single round adds a lot of new learner-facing text (rough guide: a new tour, several new sample blurbs, or a large rewrite of onboarding). In that case:

1. Finish the draft in the PR.
2. Call out in the PR description (or commit message summary) that substantial new copy needs a read-through.
3. Do not treat silence as approval when you know the volume is large — flag it explicitly.

Small string tweaks, typo fixes, and aligning an existing phrase to [terminology.md](terminology.md) do not need a review flag.

## Quick checks before finishing

- [ ] A Zephyr learner is the implied reader, not a tool builder
- [ ] Terms match [terminology.md](terminology.md) — no alternate names for the same UI or Zephyr concept
- [ ] UI stays clutter-free: no casual subtitles; tooltips for secondary detail; any subtitle pattern is consistent across peers of the same type/level
- [ ] No emulator/build internals unless the learner must know them to act
- [ ] Large new copy blocks are flagged for human review
