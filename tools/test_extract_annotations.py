#!/usr/bin/env python3
"""Tests for tools/extract-annotations.py.

Stdlib unittest, so CI needs a Python step and nothing else:

    python3 -m unittest discover -s tools -p 'test_*.py'

The line-number cases carry the most weight. Stripping the `@annotate` blocks
moves every line after them, so an off-by-one here would point every popup at
the wrong statement while looking perfectly healthy.
"""

from __future__ import annotations

import importlib.util
import sys
import textwrap
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

# The script has a hyphen in its name, so it cannot be imported normally.
# It must be registered in sys.modules before exec_module: @dataclass resolves
# its own module to read annotations, and blows up if it is not there yet.
_spec = importlib.util.spec_from_file_location(
    "extract_annotations", Path(__file__).with_name("extract-annotations.py")
)
assert _spec and _spec.loader
ea = importlib.util.module_from_spec(_spec)
sys.modules["extract_annotations"] = ea
_spec.loader.exec_module(ea)


def parse(source: str, name: str = "src/main.c"):
    """Run the extractor over one in-memory source file."""
    with TemporaryDirectory() as tmp:
        path = Path(tmp) / "main.c"
        path.write_text(textwrap.dedent(source).lstrip("\n"), encoding="utf-8")
        return ea.extract([(path, name)])


SIMPLE = """
    #include <zephyr/kernel.h>

    /* @annotate led_alias [led]
     * The pin comes from devicetree
     *
     * `DT_ALIAS(led0)` resolves at compile time.
     */
    #define LED0_NODE DT_ALIAS(led0)

    int main(void)
    {
            SAMPLE_SHOW_PAUSE(led_alias);
            return 0;
    }
"""


class TestParsing(unittest.TestCase):
    def test_extracts_title_body_and_panel(self):
        annotations, files, _ = parse(SIMPLE)
        self.assertEqual(len(annotations), 1)
        ann = annotations[0]
        self.assertEqual(ann.key, "led_alias")
        self.assertEqual(ann.title, "The pin comes from devicetree")
        self.assertEqual(ann.body, "`DT_ALIAS(led0)` resolves at compile time.")
        self.assertEqual(ann.panel, "led")
        self.assertEqual(files, ["src/main.c"])

    def test_panel_is_optional(self):
        annotations, _, _ = parse(
            """
            /* @annotate solo
             * Title
             *
             * Body.
             */
            int x;
            void f(void) { SAMPLE_SHOW(solo); }
            """
        )
        self.assertIsNone(annotations[0].panel)

    def test_multi_paragraph_body_keeps_blank_lines(self):
        annotations, _, _ = parse(
            """
            /* @annotate two_paras
             * Title
             *
             * First paragraph.
             *
             * Second paragraph.
             */
            int x;
            void f(void) { SAMPLE_SHOW(two_paras); }
            """
        )
        self.assertEqual(
            annotations[0].body, "First paragraph.\n\nSecond paragraph."
        )

    def test_indented_markdown_survives_prefix_stripping(self):
        # Only a single space after the `*` is the continuation marker; deeper
        # indentation is the author's own, and a fenced code block depends on it.
        annotations, _, _ = parse(
            """
            /* @annotate code
             * Title
             *
             * ```c
             *     indented
             * ```
             */
            int x;
            void f(void) { SAMPLE_SHOW(code); }
            """
        )
        self.assertEqual(annotations[0].body, "```c\n    indented\n```")


class TestLineNumbers(unittest.TestCase):
    def test_anchor_is_in_stripped_coordinates(self):
        annotations, _, stripped = parse(SIMPLE)
        text = stripped["src/main.c"].splitlines()
        # The anchor must land on the construct the comment sat above.
        self.assertEqual(text[annotations[0].line - 1], "#define LED0_NODE DT_ALIAS(led0)")

    def test_stripped_output_has_no_annotate_blocks(self):
        _, _, stripped = parse(SIMPLE)
        self.assertNotIn("@annotate", stripped["src/main.c"])
        self.assertNotIn("resolves at compile time", stripped["src/main.c"])

    def test_records_which_sites_stop_the_machine(self):
        # The mock backend replays a walkthrough from the catalog alone, so it
        # needs to know a SHOW_PAUSE from a SHOW rather than inferring one.
        annotations, _, _ = parse(
            """
            /* @annotate a
             * A
             *
             * Body.
             */
            int alpha;
            /* @annotate b
             * B
             *
             * Body.
             */
            int beta;
            void f(void)
            {
                    SAMPLE_SHOW_PAUSE(a);
                    SAMPLE_SHOW(b);
                    SAMPLE_VALUE(b, "%d", 1);
            }
            """
        )
        by_key = {a.key: a for a in annotations}
        self.assertEqual([s.pause for s in by_key["a"].fire_sites], [True])
        self.assertEqual([s.pause for s in by_key["b"].fire_sites], [False, False])

    def test_fire_sites_are_in_stripped_coordinates(self):
        annotations, _, stripped = parse(SIMPLE)
        text = stripped["src/main.c"].splitlines()
        sites = annotations[0].fire_sites
        self.assertEqual(len(sites), 1)
        self.assertIn("SAMPLE_SHOW_PAUSE(led_alias)", text[sites[0].line - 1])

    def test_anchor_skips_the_macro_that_fires_it(self):
        # The natural way to write this puts the fire call between the comment
        # and the statement. Highlighting SAMPLE_SHOW_PAUSE(...) instead of the
        # line it is talking about would be exactly backwards.
        annotations, _, stripped = parse(
            """
            void f(void)
            {
                    /* @annotate configure [led]
                     * Title
                     *
                     * Body.
                     */
                    SAMPLE_SHOW_PAUSE(configure);
                    ret = gpio_pin_configure_dt(&led, GPIO_OUTPUT_ACTIVE);
            }
            """
        )
        text = stripped["src/main.c"].splitlines()
        self.assertEqual(
            text[annotations[0].line - 1].strip(),
            "ret = gpio_pin_configure_dt(&led, GPIO_OUTPUT_ACTIVE);",
        )

    def test_anchor_skips_a_nested_fire_macro(self):
        annotations, _, stripped = parse(
            """
            void f(void)
            {
                    /* @annotate toggle [led]
                     * Title
                     *
                     * Body.
                     */
                    SAMPLE_ONCE(SAMPLE_SHOW_PAUSE(toggle));
                    gpio_pin_toggle_dt(&led);
            }
            """
        )
        text = stripped["src/main.c"].splitlines()
        self.assertEqual(text[annotations[0].line - 1].strip(), "gpio_pin_toggle_dt(&led);")

    def test_anchor_skips_blank_lines(self):
        annotations, _, stripped = parse(
            """
            /* @annotate spaced
             * Title
             *
             * Body.
             */

            int alpha;
            void f(void) { SAMPLE_SHOW(spaced); }
            """
        )
        text = stripped["src/main.c"].splitlines()
        self.assertEqual(text[annotations[0].line - 1], "int alpha;")

    def test_several_blocks_each_anchor_correctly(self):
        annotations, _, stripped = parse(
            """
            /* @annotate first
             * One
             *
             * Body one.
             */
            int alpha;

            /* @annotate second
             * Two
             *
             * Body two.
             */
            int beta;

            void f(void)
            {
                    SAMPLE_SHOW(first);
                    SAMPLE_SHOW(second);
            }
            """
        )
        text = stripped["src/main.c"].splitlines()
        anchors = {a.key: text[a.line - 1] for a in annotations}
        self.assertEqual(anchors["first"], "int alpha;")
        self.assertEqual(anchors["second"], "int beta;")

    def test_ids_follow_source_order(self):
        annotations, _, _ = parse(
            """
            /* @annotate first
             * One
             *
             * Body.
             */
            int alpha;

            /* @annotate second
             * Two
             *
             * Body.
             */
            int beta;

            void f(void) { SAMPLE_SHOW(second); SAMPLE_SHOW(first); }
            """
        )
        self.assertEqual([a.key for a in annotations], ["first", "second"])


class TestValidation(unittest.TestCase):
    def test_annotation_with_no_fire_site_fails(self):
        with self.assertRaises(ea.ExtractError) as ctx:
            parse(
                """
                /* @annotate orphan
                 * Title
                 *
                 * Body.
                 */
                int x;
                """
            )
        self.assertIn("orphan", str(ctx.exception))

    def test_fire_site_with_no_annotation_fails(self):
        with self.assertRaises(ea.ExtractError) as ctx:
            parse("void f(void) { SAMPLE_SHOW(missing); }\n")
        self.assertIn("missing", str(ctx.exception))

    def test_unknown_panel_fails(self):
        with self.assertRaises(ea.ExtractError) as ctx:
            parse(
                """
                /* @annotate bad [teapot]
                 * Title
                 *
                 * Body.
                 */
                int x;
                void f(void) { SAMPLE_SHOW(bad); }
                """
            )
        self.assertIn("teapot", str(ctx.exception))

    def test_unknown_reveal_panel_fails(self):
        with self.assertRaises(ea.ExtractError):
            parse("void f(void) { SAMPLE_REVEAL(teapot); }\n")

    def test_duplicate_key_fails(self):
        with self.assertRaises(ea.ExtractError):
            parse(
                """
                /* @annotate dup
                 * A
                 *
                 * Body.
                 */
                int x;
                /* @annotate dup
                 * B
                 *
                 * Body.
                 */
                int y;
                void f(void) { SAMPLE_SHOW(dup); }
                """
            )

    def test_unterminated_block_fails(self):
        with self.assertRaises(ea.ExtractError):
            parse("/* @annotate broken\n * Title\n * Body.\n")

    def test_missing_title_fails(self):
        with self.assertRaises(ea.ExtractError):
            parse("/* @annotate empty\n */\nint x;\n")


class TestRendering(unittest.TestCase):
    def test_header_defines_ids_and_table(self):
        annotations, _, _ = parse(SIMPLE)
        header = ea.render_header(annotations)
        self.assertIn("#define SAMPLE_ANN_led_alias 0", header)
        self.assertIn("#define SAMPLE_ANNOTATION_COUNT 1", header)
        self.assertIn(
            f"SAMPLE_ANNOTATION_ENTRY(0, led_alias, {annotations[0].line})", header
        )

    def test_header_carries_no_prose(self):
        # The headline claim of the whole design: no annotation text reaches
        # the firmware.
        annotations, _, _ = parse(SIMPLE)
        header = ea.render_header(annotations)
        self.assertNotIn("The pin comes from devicetree", header)
        self.assertNotIn("resolves at compile time", header)

    def test_json_carries_prose_and_fire_sites(self):
        import json

        annotations, files, _ = parse(SIMPLE)
        payload = json.loads(ea.render_json("guided", annotations, files))
        self.assertEqual(payload["version"], 1)
        self.assertEqual(payload["app"], "guided")
        entry = payload["annotations"][0]
        self.assertEqual(entry["id"], 0)
        self.assertEqual(entry["title"], "The pin comes from devicetree")
        self.assertEqual(entry["panel"], "led")
        self.assertEqual(len(entry["fireSites"]), 1)
        # SIMPLE fires with SAMPLE_SHOW_PAUSE, so the site is flagged.
        self.assertTrue(entry["fireSites"][0]["pause"])

    def test_json_omits_panel_when_absent(self):
        import json

        annotations, files, _ = parse(
            """
            /* @annotate solo
             * Title
             *
             * Body.
             */
            int x;
            void f(void) { SAMPLE_SHOW(solo); }
            """
        )
        payload = json.loads(ea.render_json("app", annotations, files))
        self.assertNotIn("panel", payload["annotations"][0])
        # A plain SAMPLE_SHOW site carries no pause flag at all, rather than
        # an explicit false on every entry.
        self.assertNotIn("pause", payload["annotations"][0]["fireSites"][0])


if __name__ == "__main__":
    unittest.main()
