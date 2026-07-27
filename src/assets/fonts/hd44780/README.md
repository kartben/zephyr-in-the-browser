# HD44780U A00 CGROM (Display Module 2)

Bitmap glyphs for character auxdisplay canvases (JHD1313 LCD and PT6314 VFD),
derived from the **Display Module 2** BDF in
[dse/display-module-fonts](https://github.com/dse/display-module-fonts)
(HD44780U character ROM code A00 — Latin + Katakana).

The PT6314-001 English/Japanese font table (PT6314.pdf §12.1) matches A00 for
ASCII `0x20..0x7f`, so both panels share these bitmaps.

Canvases paint discrete 5×8 dots (`src/components/hd44780Glyphs.ts`) so
characters stay crisp (no TrueType antialiasing).

License: SIL Open Font License 1.1 — see `LICENSE.md`.
