#!/usr/bin/env python3
"""Cut the Magic Wand replay clips out of the labelled gesture recordings.

    tools/extract-magic-wand-gestures.py [--survey] [--cache DIR]

The ADXL345 card's Wing / Ring / Slope buttons replay short recorded gestures
into the guest (src/virtio/devices/sensors/recordings/magicWand.json). This
script makes that file reproducible. It needs numpy and ai-edge-litert
(`pip install numpy ai-edge-litert`).

1. Fetch the labelled recordings from antmicro/zephelin at a pinned commit:
   one `x y z` line per 25 Hz sample, in g, every gesture of a class
   concatenated into one stream.
2. Load the model straight out of the guest app
   (zephyr-module/apps/magic_wand/src/magic_wand_model_data.cpp).
3. Stream each recording through a Python copy of the guest loop: a 128-sample
   window in milli-g, one inference per sample, the average of the last five
   samples' predictions against the 0.8 threshold, and the fork's one-window
   suppression.
4. Each detection of the right class marks a gesture the model saw. Cut the
   window it saw, bend its ends onto the card's resting pose (flat, +1 g on Z)
   so a replay starts and ends where the card sits, add a second of rest, and
   replay it through a fresh copy of the loop as the guest would read it:
   quantised to the 1/64 g the driver reads, framed by rest, with inference on
   every sample and on every other one. Keep the clip that is detected exactly
   once, as its own class, preferably while it plays, with the best score.
5. Check every order of the three buttons pressed back to back.

Rest matters. The model was trained on a hand-held wand, and a move between an
arbitrary pose and flat reads to it as a gesture, so a clip has to begin and
end at the pose the card rests in.

`--survey` instead reports how many detections each input scaling produces
across the whole recordings. It is how the guest's milli-g conversion was
chosen: fed g or m/s², the model never fires.
"""
import argparse
import json
import os
import re
import sys
import urllib.request

ZEPHELIN_COMMIT = '3801a8d73c9c4a75c00dd8e6f6932e6833309b3a'
DATA_URL = (
    'https://raw.githubusercontent.com/antmicro/zephelin/'
    f'{ZEPHELIN_COMMIT}/samples/common/data/magic_wand/{{name}}.data'
)
SOURCE_URL = (
    'https://github.com/antmicro/zephelin/tree/'
    f'{ZEPHELIN_COMMIT}/samples/common/data/magic_wand'
)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_CPP = os.path.join(ROOT, 'zephyr-module/apps/magic_wand/src/magic_wand_model_data.cpp')
OUT_JSON = os.path.join(ROOT, 'src/virtio/devices/sensors/recordings/magicWand.json')

# Mirrors zephyr-module/apps/magic_wand/src/constants.hpp and
# accelerometer_handler.cpp.
RATE_HZ = 25
WINDOW = 128
GESTURES = ['wing', 'ring', 'slope']
NO_GESTURE = 3
THRESHOLD = 0.8
HISTORY = 5
SUPPRESSION_SAMPLES = WINDOW
MILLI_G = 1000.0

# The ADXL345 card's resting pose, and the resolution adi,adxl345 reads it at:
# its devicetree default of ±8 g in 10-bit mode, 64 LSB/g
# (src/virtio/devices/sensors/adxl345.ts).
REST = (0.0, 0.0, 1.0)
LSB_PER_G = 64
FULL_SCALE = 512
REST_SAMPLES = 2 * WINDOW
STRIDES = (1, 2)
# Each clip ends with a second of rest, so a button stays pressed until the
# model has spoken and the next gesture starts clean.
TAIL_SAMPLES = RATE_HZ


def load_model_bytes():
    text = open(MODEL_CPP).read()
    body = text[text.index('{') + 1:text.index('};')]
    return bytes(int(tok, 16) for tok in re.findall(r'0x[0-9a-fA-F]{2}', body))


def load_recording(name, cache):
    path = os.path.join(cache, f'{name}.data')
    if not os.path.exists(path):
        os.makedirs(cache, exist_ok=True)
        with urllib.request.urlopen(DATA_URL.format(name=name)) as resp:
            open(path, 'wb').write(resp.read())
    rows = []
    for line in open(path):
        parts = line.split()
        if len(parts) == 3:
            rows.append(tuple(float(p) for p in parts))
    return rows


def as_read(sample_g):
    """What the guest reads back: stored to 3 decimals, then whole counts."""
    return tuple(
        max(-FULL_SCALE, min(FULL_SCALE - 1, round(round(v, 3) * LSB_PER_G))) / LSB_PER_G
        for v in sample_g
    )


class Guest:
    """The guest's sampling loop and gesture predictor, sample by sample."""

    def __init__(self, interpreter, scale, stride=1, quantise=False):
        import numpy as np

        self.np = np
        self.it = interpreter
        self.inp = interpreter.get_input_details()[0]['index']
        self.out = interpreter.get_output_details()[0]['index']
        self.scale = scale
        self.stride = stride
        self.quantise = quantise
        self.ring = []
        self.count = 0
        # Like gesture_predictor.cpp: (sample count, scores) of recent inferences.
        self.history = []
        # Like gesture_predictor.cpp: no detection before this sample count.
        self.suppressed_until = 0

    def step(self, sample_g):
        """Feed one sample. Returns (gesture or None, averaged scores or None)."""
        if self.quantise:
            sample_g = as_read(sample_g)
        self.ring.append([v * self.scale for v in sample_g])
        if len(self.ring) > WINDOW:
            self.ring.pop(0)
        self.count += 1
        # Like main_functions.cpp: the first full window, then every stride.
        if self.count < WINDOW or (self.count - WINDOW) % self.stride:
            return None, None
        tensor = self.np.array(self.ring, dtype=self.np.float32).reshape(1, WINDOW, 3, 1)
        self.it.set_tensor(self.inp, tensor)
        self.it.invoke()
        scores = self.it.get_tensor(self.out)[0]
        # The average of the predictions from the last HISTORY samples.
        self.history = [(c, s) for c, s in self.history[-(HISTORY - 1):] if self.count - c < HISTORY]
        self.history.append((self.count, [float(v) for v in scores]))
        averages = [sum(s[g] for _, s in self.history) / len(self.history) for g in range(4)]
        best = max(range(4), key=lambda g: averages[g])
        if best == NO_GESTURE or averages[best] < THRESHOLD or self.count < self.suppressed_until:
            return None, averages
        self.suppressed_until = self.count + SUPPRESSION_SAMPLES
        return best, averages


def make_interpreter(model):
    from ai_edge_litert.interpreter import Interpreter

    it = Interpreter(model_content=model)
    it.allocate_tensors()
    return it


def detections(model, rows, scale=MILLI_G, stride=1, quantise=False):
    guest = Guest(make_interpreter(model), scale, stride, quantise)
    found = []
    for i, row in enumerate(rows):
        gesture, averages = guest.step(row)
        if gesture is not None:
            found.append((i, gesture, averages[gesture]))
    return found


def anchored(clip):
    """Bend a clip's ends onto REST with a linear offset, keeping its shape."""
    n = len(clip) - 1
    head = [REST[k] - clip[0][k] for k in range(3)]
    tail = [REST[k] - clip[-1][k] for k in range(3)]
    return [
        tuple(clip[i][k] + head[k] + (tail[k] - head[k]) * i / n for k in range(3))
        for i in range(len(clip))
    ]


def replayed(clip):
    """The stream the guest reads: the card at rest, the clip, rest again."""
    return [REST] * REST_SAMPLES + list(clip) + [REST] * REST_SAMPLES


def clean_score(model, clip, want):
    """(lowest score, latest detection index into the clip) across strides,
    or None if any run misfires."""
    scores, late = [], 0
    for stride in STRIDES:
        found = detections(model, replayed(clip), stride=stride, quantise=True)
        if [g for _, g, _ in found] != [want]:
            return None
        scores.append(found[0][2])
        late = max(late, found[0][0] - REST_SAMPLES)
    return min(scores), late


def survey(model, recordings):
    print('detections per class across the whole recordings')
    for label, scale in (('g', 1.0), ('m/s2', 9.80665), ('milli-g', MILLI_G)):
        counts = {}
        for name, rows in recordings.items():
            hits = [0, 0, 0]
            for _, gesture, _ in detections(model, rows, scale):
                hits[gesture] += 1
            counts[name] = hits
        cells = '  '.join(f'{n}: w{c[0]} r{c[1]} s{c[2]}' for n, c in counts.items())
        print(f'  {label:8} {cells}')


def pick_clip(model, name, rows):
    want = GESTURES.index(name)
    best = None
    for end, gesture, _ in detections(model, rows):
        if gesture != want:
            continue
        start = max(0, end - WINDOW + 1)
        clip = anchored(rows[start:end + 1]) + [REST] * TAIL_SAMPLES
        result = clean_score(model, clip, want)
        if result is None:
            continue
        score, late = result
        # Detected while the clip plays beats detected afterwards; then the
        # more confident.
        key = (late < len(clip), round(score, 3))
        if best is None or key > best[0]:
            best = (key, score, late, start, end, clip)
    if best is None:
        sys.exit(f'no clean {name} clip found')
    return best[1:]


def check_back_to_back(model, clips):
    """Every order of the three buttons, pressed as soon as the last is done."""
    from itertools import permutations

    for order in permutations(range(len(clips))):
        stream = [REST] * REST_SAMPLES
        for i in order:
            stream += clips[i]
        stream += [REST] * REST_SAMPLES
        for stride in STRIDES:
            found = [g for _, g, _ in detections(model, stream, stride=stride, quantise=True)]
            if found != list(order):
                names = [GESTURES[i] for i in order]
                sys.exit(f'back-to-back {names} at stride {stride} detected {[GESTURES[g] for g in found]}')


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--survey', action='store_true', help='compare input scalings and stop')
    parser.add_argument('--cache', default=os.path.join(ROOT, '.zephyr-build/magic-wand-data'))
    args = parser.parse_args()

    model = load_model_bytes()
    names = GESTURES + ['negative']
    recordings = {n: load_recording(n, args.cache) for n in names}

    if args.survey:
        survey(model, recordings)
        return

    idle = detections(model, [REST] * (4 * WINDOW), quantise=True)
    if idle:
        sys.exit(f'the resting pose alone fires: {idle}')

    picked = [pick_clip(model, name, recordings[name]) for name in GESTURES]
    check_back_to_back(model, [clip for *_, clip in picked])

    clips = []
    for name, (score, late, start, end, clip) in zip(GESTURES, picked):
        print(
            f'{name}: from lines {start + 1}-{end + 1}, {len(clip)} samples, '
            f'detected at sample {late}, worst score {score:.3f}'
        )
        clips.append({
            'id': name,
            'label': name.capitalize(),
            'file': f'{name}.data',
            'lines': [start + 1, end + 1],
            'samples': [[round(v, 3) for v in row] for row in clip],
        })

    doc = {
        'source': SOURCE_URL,
        'license': 'Apache-2.0',
        'credit': 'TensorFlow Lite Micro magic wand gesture recordings, as packaged in Antmicro Zephelin',
        'rateHz': RATE_HZ,
        'unit': 'g',
        'rest': list(REST),
        'clips': clips,
    }
    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, 'w') as f:
        json.dump(doc, f, separators=(',', ':'))
        f.write('\n')
    print(f'wrote {os.path.relpath(OUT_JSON, ROOT)}')


if __name__ == '__main__':
    main()
