#!/usr/bin/env python3
"""Turn `@annotate` comment blocks into data the browser can render.

An annotated sample carries its teaching prose in ordinary block comments, so
the source reads the way it would without the feature:

    /* @annotate led_from_devicetree [led]
     * The pin comes from devicetree
     *
     * `DT_ALIAS(led0)` resolves at compile time to whatever this board's
     * devicetree calls `led0` — the sample never names a pin or a port.
     */
    #define LED0_NODE DT_ALIAS(led0)

and fires them from statements, which is the only place a macro can run:

    SAMPLE_SHOW_PAUSE(led_from_devicetree);

This script reads those sources and writes three things:

  annotations.json   id/key/title/body/panel/file/line, for the browser. None
                     of this reaches the guest, which is the whole point — the
                     firmware pays for ids, not paragraphs.
  <header>           ids plus the linked-in table, for the guest.
  stripped sources   the same files with the `@annotate` blocks removed. These
                     are what ship to public/ and what the popup shows: the
                     prose is already in the popup, and leaving it in the code
                     would bury the sample it is explaining.

Stripping moves lines, so every line number recorded here is in *stripped*
coordinates. Get that wrong and every anchor silently points a line or two off.

Run from the app's CMakeLists so `west build` stays self-contained; Python is
guaranteed in the Zephyr build container, Node is not.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

# Mirrors PanelKind in src/boards.ts. Kept as a literal list rather than parsed
# out of the TypeScript: a typo here should fail the build, and a new panel
# kind is a deliberate change in both places.
PANELS = {
    "display", "gnss", "sensor", "gpio", "keys", "buzzer", "audio", "perf",
    "net", "i2c", "spi", "oled", "auxdisplay", "led", "pwm", "dac",
    "fuel-gauge", "trace",
}

HEADER_RE = re.compile(
    r"^[ \t]*/\*[ \t]*@annotate[ \t]+"
    r"(?P<key>[A-Za-z_][A-Za-z0-9_]*)"
    r"(?:[ \t]*\[(?P<panel>[a-z0-9-]+)\])?[ \t]*$"
)

# SAMPLE_VALUE takes further arguments; the key is always the first.
FIRE_RE = re.compile(r"\bSAMPLE_(?:SHOW_PAUSE|SHOW|VALUE)[ \t]*\([ \t]*([A-Za-z_][A-Za-z0-9_]*)")

REVEAL_RE = re.compile(r"\bSAMPLE_REVEAL[ \t]*\([ \t]*([a-z0-9-]+)[ \t]*\)")

# An anchor points at the code an annotation is about, so it skips the macro
# calls that fire it. Those usually sit right between the comment and the
# statement, and highlighting `SAMPLE_SHOW_PAUSE(...)` instead of the line it
# is talking about would be exactly backwards.
SCAFFOLD_RE = re.compile(r"^[ \t]*SAMPLE_[A-Z_]+[ \t]*\(")


class ExtractError(Exception):
    """A problem in the annotated source. Always fatal — a typo must not
    degrade to a popup that silently never fires."""


@dataclass
class FireSite:
    file: int
    line: int


@dataclass
class Annotation:
    key: str
    title: str
    body: str
    panel: str | None
    file: int
    line: int
    fire_sites: list[FireSite] = field(default_factory=list)


@dataclass
class ParsedFile:
    name: str
    stripped: str
    annotations: list[Annotation]
    fires: list[tuple[str, int]]


def _strip_comment_prefix(line: str) -> str:
    """Drop the leading ` * ` continuation marker from a block-comment line."""
    stripped = line.lstrip()
    if stripped.startswith("*"):
        rest = stripped[1:]
        # A single space after the star is the marker; anything more is the
        # author's own indentation (a Markdown code block, say) and is kept.
        return rest[1:] if rest.startswith(" ") else rest
    return line


def _split_title_body(lines: list[str], key: str) -> tuple[str, str]:
    """First non-blank line is the title; everything past the blank line that
    follows it is the Markdown body."""
    idx = 0
    while idx < len(lines) and not lines[idx].strip():
        idx += 1
    if idx >= len(lines):
        raise ExtractError(f"@annotate {key}: no title line")
    title = lines[idx].strip()
    body_lines = lines[idx + 1:]
    # Trim leading and trailing blank lines around the body.
    while body_lines and not body_lines[0].strip():
        body_lines.pop(0)
    while body_lines and not body_lines[-1].strip():
        body_lines.pop()
    return title, "\n".join(body_lines)


def _resolve_anchor(kept: list[str], start: int) -> int:
    """Return the 1-based line an annotation points at.

    Scans forward from where the comment block used to be for the first line
    that is actual code — skipping blanks and the SAMPLE_*() calls that fire
    the annotation, which sit between the comment and its subject and are not
    what the reader is being shown.
    """
    idx = start
    while idx < len(kept):
        line = kept[idx]
        if line.strip() and not SCAFFOLD_RE.match(line):
            return idx + 1
        idx += 1
    # A block with nothing after it: point at the last line rather than past
    # the end of the file.
    return max(1, len(kept))


def parse_file(path: Path, name: str, file_index: int) -> ParsedFile:
    """Pull annotations out of one source file and return it stripped.

    Line numbers come out in stripped coordinates: an annotation anchors to the
    first non-blank line *after* its comment block, which after stripping is
    where that block used to start.
    """
    src_lines = path.read_text(encoding="utf-8").splitlines()
    kept: list[str] = []
    annotations: list[Annotation] = []
    i = 0

    while i < len(src_lines):
        match = HEADER_RE.match(src_lines[i])
        if not match:
            kept.append(src_lines[i])
            i += 1
            continue

        key = match.group("key")
        panel = match.group("panel")
        if panel is not None and panel not in PANELS:
            raise ExtractError(
                f"{name}:{i + 1}: @annotate {key}: unknown panel '{panel}'. "
                f"Known: {', '.join(sorted(PANELS))}"
            )

        body_lines: list[str] = []
        i += 1
        closed = False
        while i < len(src_lines):
            line = src_lines[i]
            if "*/" in line:
                head = line[: line.index("*/")]
                text = _strip_comment_prefix(head)
                if text.strip():
                    body_lines.append(text)
                i += 1
                closed = True
                break
            body_lines.append(_strip_comment_prefix(line))
            i += 1
        if not closed:
            raise ExtractError(f"{name}: @annotate {key}: unterminated comment block")

        title, body = _split_title_body(body_lines, key)
        # The block is gone, so what followed it now starts at index len(kept).
        # Which line that resolves to depends on what comes next, so record the
        # position and settle it once the file is fully stripped.
        annotations.append(
            Annotation(key=key, title=title, body=body, panel=panel,
                       file=file_index, line=len(kept))
        )

    for ann in annotations:
        ann.line = _resolve_anchor(kept, ann.line)

    stripped = "\n".join(kept)
    if stripped and not stripped.endswith("\n"):
        stripped += "\n"

    # Fire sites are scanned from the stripped text so their line numbers match
    # everything else the browser is given.
    fires: list[tuple[str, int]] = []
    for lineno, line in enumerate(kept, start=1):
        for fire_key in FIRE_RE.findall(line):
            fires.append((fire_key, lineno))
        for panel in REVEAL_RE.findall(line):
            if panel not in PANELS:
                raise ExtractError(
                    f"{name}:{lineno}: SAMPLE_REVEAL: unknown panel '{panel}'"
                )

    return ParsedFile(name=name, stripped=stripped, annotations=annotations, fires=fires)


def extract(sources: list[tuple[Path, str]]) -> tuple[list[Annotation], list[str], dict[str, str]]:
    """Parse every source, cross-check keys, and assign ids.

    Ids are allocated in (file, line) order so the walkthrough outline reads
    top-to-bottom through the source, which is how the lesson is written.
    """
    names = [name for _, name in sources]
    parsed = [parse_file(path, name, idx) for idx, (path, name) in enumerate(sources)]

    annotations: list[Annotation] = []
    by_key: dict[str, Annotation] = {}
    for pf in parsed:
        for ann in pf.annotations:
            if ann.key in by_key:
                raise ExtractError(f"duplicate @annotate key '{ann.key}'")
            by_key[ann.key] = ann
            annotations.append(ann)

    for pf in parsed:
        file_index = names.index(pf.name)
        for key, lineno in pf.fires:
            ann = by_key.get(key)
            if ann is None:
                raise ExtractError(
                    f"{pf.name}:{lineno}: SAMPLE_SHOW references '{key}', "
                    f"which has no @annotate block"
                )
            ann.fire_sites.append(FireSite(file=file_index, line=lineno))

    unfired = [a.key for a in annotations if not a.fire_sites]
    if unfired:
        raise ExtractError(
            "these @annotate blocks are never fired, so they would never be "
            "shown: " + ", ".join(unfired)
        )

    annotations.sort(key=lambda a: (a.file, a.line))
    return annotations, names, {pf.name: pf.stripped for pf in parsed}


def render_header(annotations: list[Annotation]) -> str:
    out = [
        "/* Generated by tools/extract-annotations.py — do not edit. */",
        "",
        "#ifndef SAMPLE_ANNOTATIONS_GENERATED_H_",
        "#define SAMPLE_ANNOTATIONS_GENERATED_H_",
        "",
        f"#define SAMPLE_ANNOTATION_COUNT {len(annotations)}",
        "",
    ]
    for ident, ann in enumerate(annotations):
        out.append(f"#define SAMPLE_ANN_{ann.key} {ident}")
    out += [
        "",
        "/*",
        " * The linked-in table. Two bytes of id and two of line per annotation,",
        " * and not one byte of prose: the text lives in annotations.json, which",
        " * only the browser ever reads. The line is carried so the page can spot",
        " * an annotations.json that has drifted from the binary beside it.",
        " *",
        " * SAMPLE_ANNOTATION_ENTRY comes from <sample_annotation.h> and expands",
        " * to nothing when CONFIG_SAMPLE_ANNOTATIONS is off. Every file that",
        " * fires an annotation includes this header, but only the one that",
        " * defines SAMPLE_ANNOTATION_DEFINE_TABLE instantiates the table.",
        " */",
        "#ifdef SAMPLE_ANNOTATION_DEFINE_TABLE",
    ]
    for ident, ann in enumerate(annotations):
        out.append(f"SAMPLE_ANNOTATION_ENTRY({ident}, {ann.key}, {ann.line})")
    out += [
        "#endif /* SAMPLE_ANNOTATION_DEFINE_TABLE */",
        "",
        "#endif /* SAMPLE_ANNOTATIONS_GENERATED_H_ */",
        "",
    ]
    return "\n".join(out)


def render_json(app: str, annotations: list[Annotation], files: list[str]) -> str:
    payload = {
        "version": 1,
        "app": app,
        "files": files,
        "annotations": [
            {
                "id": ident,
                "key": ann.key,
                "title": ann.title,
                "body": ann.body,
                **({"panel": ann.panel} if ann.panel else {}),
                "file": ann.file,
                "line": ann.line,
                "fireSites": [{"file": f.file, "line": f.line} for f in ann.fire_sites],
            }
            for ident, ann in enumerate(annotations)
        ],
    }
    return json.dumps(payload, indent=2, ensure_ascii=False) + "\n"


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--app", required=True, help="app id, recorded in the JSON")
    ap.add_argument("--source", action="append", required=True, metavar="PATH",
                    help="a .c file to scan; repeat for several")
    ap.add_argument("--source-root", required=True, metavar="DIR",
                    help="paths in the output are relative to this")
    ap.add_argument("--out-header", required=True, metavar="PATH")
    ap.add_argument("--out-json", required=True, metavar="PATH")
    ap.add_argument("--out-src-dir", required=True, metavar="DIR",
                    help="where the stripped display copies are written")
    args = ap.parse_args(argv)

    root = Path(args.source_root).resolve()
    sources: list[tuple[Path, str]] = []
    for raw in args.source:
        path = Path(raw).resolve()
        try:
            name = str(path.relative_to(root))
        except ValueError:
            name = path.name
        sources.append((path, name))

    try:
        annotations, files, stripped = extract(sources)
    except ExtractError as err:
        print(f"error: {err}", file=sys.stderr)
        return 1

    header = Path(args.out_header)
    header.parent.mkdir(parents=True, exist_ok=True)
    header.write_text(render_header(annotations), encoding="utf-8")

    out_json = Path(args.out_json)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(render_json(args.app, annotations, files), encoding="utf-8")

    out_src = Path(args.out_src_dir)
    for name, text in stripped.items():
        dest = out_src / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(text, encoding="utf-8")

    print(f"extract-annotations: {len(annotations)} annotation(s) in {len(files)} file(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
