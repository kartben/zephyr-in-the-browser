# Recorded sensor motion

Clips a sensor card replays into the guest when the running sample asks for
them (`recordings` on its entry in `src/boards.ts`).

## magicWand.json

Wing, Ring and Slope gestures for the Magic Wand TinyML sample
(`zephyr-module/apps/magic_wand`), replayed through the ADXL345 card.

- **Source:** the TensorFlow Lite Micro magic wand gesture recordings, as
  packaged in [Antmicro Zephelin](https://github.com/antmicro/zephelin)
  (`samples/common/data/magic_wand/`, at the commit pinned in the JSON's
  `source`).
- **License:** Apache-2.0.
- **Format:** x/y/z in g at 25 Hz. Each clip is one 128-sample window the model
  recognised, offset so it starts and ends flat (the card's resting pose),
  followed by a second of rest.

Regenerate with:

```console
pip install numpy ai-edge-litert
tools/extract-magic-wand-gestures.py
```

The script replays every candidate through a Python copy of the guest's loop
and the real model, at the resolution the guest reads, and keeps a clip only if
it is recognised exactly once as its own gesture, alone and pressed back to
back with the others.
