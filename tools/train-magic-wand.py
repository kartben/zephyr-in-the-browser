#!/usr/bin/env python3
"""Train the Magic Wand gesture model from recordings, and compare it with the shipped one.

    tools/train-magic-wand.py [--captures DIR ...] [--rotate none|yaw|tilt]
                              [--seeds N] [--write]

The guest app (zephyr-module/apps/magic_wand) runs a 20 KB CNN that TensorFlow
trained in 2019 on ten people waving a SparkFun Edge board. This script trains
the same network again, so new recordings can go in:

- The original recordings, fetched from TensorFlow's dataset at first run
  (one file per person and gesture, 25 Hz, milli-g, gestures separated by
  "-,-,-" lines).
- Capture files from the capture page (capture/index.html, src/capture/), in
  any directories given with --captures: phone motion in m/s² at the phone's
  own event rate, resampled here to 25 Hz.

Every gesture becomes 128-sample windows placed around it, stretched in time,
scaled and with noise added, and with --rotate turned the way phones get held:
`yaw` turns the phone flat on the table (portrait, landscape, port left or
right), `tilt` also tips it up to 30 degrees. Free movement and stillness in
any orientation train the "no gesture" class.

Training follows TensorFlow's 2019 person split: six people train, --seeds
models compete on the two --validate people, and the report scores the two
--holdout people (TensorFlow names, or capture session ids) for both the
shipped model and the new one: window accuracy as held and turned at random,
gestures streamed through tools/extract-magic-wand-gestures.py's copy of the
guest loop (the average of the last five samples' predictions, the 0.8
threshold, the hold-off) as recorded and half a sample later, and false
detections on free movement.

--write replaces zephyr-module/apps/magic_wand/src/magic_wand_model_data.cpp.
The network keeps the ops the guest registers, so nothing else changes; rerun
tools/extract-magic-wand-gestures.py afterwards, so the replay clips are ones
the new model recognizes.

Needs numpy, tensorflow and ai-edge-litert.
"""
import argparse
import glob
import importlib.util
import json
import os
import re
import sys
import tarfile
import urllib.request

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, '.zephyr-build/magic-wand-data/tf')
DATA_URL = 'https://storage.googleapis.com/download.tensorflow.org/models/tflite/magic_wand/data.tar.gz'
MODEL_CPP = os.path.join(ROOT, 'zephyr-module/apps/magic_wand/src/magic_wand_model_data.cpp')
EXTRACT = os.path.join(ROOT, 'tools/extract-magic-wand-gestures.py')

LABELS = ['wing', 'ring', 'slope', 'negative']
NEGATIVE = 3
WINDOW = 128
RATE_HZ = 25
G = 9.80665
# What the guest registers (main_functions.cpp); anything else would not run.
GUEST_OPS = {'CONV_2D', 'DEPTHWISE_CONV_2D', 'FULLY_CONNECTED', 'MAX_POOL_2D', 'RESHAPE', 'SOFTMAX'}
# TensorFlow's own person split (train/data_split_person.py): seeds compete on
# the validation people, the report scores the test people, so the shipped
# model is scored on people it most likely never saw.
DEFAULT_VALIDATE = ['lsj', 'pengxl', 'output_negative_2']
DEFAULT_HOLDOUT = ['liucx', 'zhangxy', 'output_negative_1']
# The guest feeds milli-g. Trained on milli-g as is, the first steps blow up
# and every ReLU dies; trained on g, the scale folds into the first kernel.
INPUT_SCALE = 1 / 1000.0

NUM = re.compile(r'^\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\s*$')


# --- data -------------------------------------------------------------------

def fetch_dataset(cache=CACHE):
    if glob.glob(os.path.join(cache, 'wing', '*.txt')):
        return
    os.makedirs(cache, exist_ok=True)
    path = os.path.join(cache, 'data.tar.gz')
    print(f'fetching {DATA_URL}')
    with urllib.request.urlopen(DATA_URL) as resp, open(path, 'wb') as out:
        out.write(resp.read())
    with tarfile.open(path) as tar:
        tar.extractall(cache, filter='data')


def load_tensorflow_recordings(cache=CACHE):
    """Each gesture between "-,-,-" lines, as (label, person, samples in milli-g)."""
    items = []
    for label in LABELS:
        for path in sorted(glob.glob(os.path.join(cache, label, '*.txt'))):
            name = os.path.basename(path)[:-4]
            person = name.split('_', 2)[2] if label != 'negative' else name
            segment = []
            for raw in open(path, 'rb'):
                line = raw.decode('latin-1').strip()
                if '-,-,-' in line:
                    if segment:
                        items.append({'label': LABELS.index(label), 'person': person, 'samples': np.array(segment)})
                    segment = []
                    continue
                m = NUM.match(line)
                if m:
                    segment.append([float(v) for v in m.groups()])
            if segment:
                items.append({'label': LABELS.index(label), 'person': person, 'samples': np.array(segment)})
    return items


def resample(rows, hz=RATE_HZ):
    """Motion rows [t ms, x, y, z] at any rate, to `hz` by linear interpolation."""
    rows = np.asarray(rows, dtype=float)
    t = rows[:, 0]
    grid = np.arange(t[0], t[-1], 1000.0 / hz)
    return np.stack([np.interp(grid, t, rows[:, k]) for k in (1, 2, 3)], axis=1), grid


def load_captures(dirs):
    """Takes from capture-page files, as 25 Hz milli-g, the cue as an index."""
    items = []
    for d in dirs:
        for path in sorted(glob.glob(os.path.join(d, '**', '*.json'), recursive=True)):
            session = json.load(open(path))
            if session.get('format') != 'zitb-magic-wand-capture':
                continue
            if session.get('version') != 1:
                sys.exit(f'{path}: unsupported capture version {session.get("version")}')
            for take in session['takes']:
                if len(take['samples']) < 20:
                    continue
                values, grid = resample(take['samples'])
                cue = None
                if take.get('cueMs') is not None:
                    cue = int(np.searchsorted(grid, take['cueMs']))
                label = take['label']
                items.append({
                    'label': LABELS.index(label) if label in LABELS[:3] else NEGATIVE,
                    'person': session['id'],
                    'samples': values / G * 1000.0,
                    'cue': cue,
                    'hold': take.get('hold'),
                })
    return items


# --- windows ----------------------------------------------------------------

def stretch(samples, factor):
    n = max(8, int(round(len(samples) * factor)))
    src = np.linspace(0, len(samples) - 1, n)
    idx = np.arange(len(samples))
    return np.stack([np.interp(src, idx, samples[:, k]) for k in range(3)], axis=1)


def window_at(samples, start):
    """WINDOW samples from `start`, holding the first or last reading past either end."""
    idx = np.clip(np.arange(start, start + WINDOW), 0, len(samples) - 1)
    return samples[idx]


def gesture_window(item, rng, warp=True):
    """A window that contains the whole gesture, at a random place in it."""
    samples = item['samples']
    factor = rng.uniform(0.8, 1.25) if warp else 1.0
    samples = stretch(samples, factor)
    if item.get('cue') is not None:
        # A capture take: the move starts at the cue and is over 3 s later.
        core = (int(item['cue'] * factor), int((item['cue'] + 3 * RATE_HZ) * factor))
    else:
        core = (0, len(samples))
    lo, hi = core[1] - WINDOW, core[0]
    if lo > hi:  # longer than a window: any WINDOW-long stretch of it
        lo, hi = core[0], core[1] - WINDOW
    start = int(rng.integers(lo, hi + 1)) if warp else (lo + hi) // 2
    return window_at(samples, start)


def negative_windows(item, rng, step):
    samples = item['samples']
    if len(samples) <= WINDOW:
        return [window_at(samples, int(rng.integers(len(samples) - WINDOW, 1)))]
    return [samples[s:s + WINDOW] for s in range(0, len(samples) - WINDOW + 1, step)]


def rotation(rng, mode):
    yaw = rng.uniform(-np.pi, np.pi)
    c, s = np.cos(yaw), np.sin(yaw)
    r = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])
    if mode == 'tilt':
        for axis in (0, 1):
            a = rng.uniform(-np.pi / 6, np.pi / 6)
            c, s = np.cos(a), np.sin(a)
            t = np.eye(3)
            i, j = [k for k in range(3) if k != axis]
            t[i, i], t[i, j], t[j, i], t[j, j] = c, -s, s, c
            r = t @ r
    return r


def augment(window, rng, rotate):
    window = window * rng.uniform(0.9, 1.1) + rng.normal(0, 15, window.shape)
    if rotate != 'none':
        window = window @ rotation(rng, rotate).T
    return window


def stillness(rng, n, rotate):
    """Windows of a phone held still, which must never read as a gesture."""
    out = []
    for _ in range(n):
        g = np.array([0, 0, 1000.0])
        if rotate != 'none':
            g = rotation(rng, rotate) @ g
        else:
            g = rotation(rng, 'tilt') @ g
        out.append(np.tile(g, (WINDOW, 1)) + rng.normal(0, 10, (WINDOW, 3)))
    return out


def build_set(items, rng, copies, rotate):
    xs, ys = [], []
    for item in items:
        if item['label'] == NEGATIVE:
            for w in negative_windows(item, rng, 16):
                for _ in range(max(1, copies // 4)):
                    xs.append(augment(w, rng, rotate))
                    ys.append(NEGATIVE)
        else:
            for _ in range(copies):
                xs.append(augment(gesture_window(item, rng), rng, rotate))
                ys.append(item['label'])
    for w in stillness(rng, len(xs) // 10, rotate):
        xs.append(w)
        ys.append(NEGATIVE)
    return np.array(xs, dtype=np.float32)[..., None], np.array(ys)


# --- model ------------------------------------------------------------------

def build_model():
    """The 2019 network, layer for layer (tflite-micro's magic_wand train.py)."""
    import tensorflow as tf

    return tf.keras.Sequential([
        tf.keras.Input(shape=(WINDOW, 3, 1)),
        tf.keras.layers.Conv2D(8, (4, 3), padding='same', activation='relu'),
        tf.keras.layers.MaxPool2D((3, 3)),
        tf.keras.layers.Dropout(0.1),
        tf.keras.layers.Conv2D(16, (4, 1), padding='same', activation='relu'),
        tf.keras.layers.MaxPool2D((3, 1), padding='same'),
        tf.keras.layers.Dropout(0.1),
        tf.keras.layers.Flatten(),
        tf.keras.layers.Dense(16, activation='relu'),
        tf.keras.layers.Dropout(0.1),
        tf.keras.layers.Dense(4, activation='softmax'),
    ])


def fold_input_scale(model):
    """Make a model trained on g take milli-g, by scaling the first kernel."""
    first = model.layers[0]
    kernel, bias = first.get_weights()
    first.set_weights([kernel * INPUT_SCALE, bias])


def to_tflite(model):
    import tensorflow as tf
    from tensorflow.python.framework.convert_to_constants import convert_variables_to_constants_v2

    # A fixed batch of one, as the guest runs it, and the weights frozen into
    # constants. With a free batch dimension the converter computes Flatten's
    # shape at run time (SHAPE, STRIDED_SLICE, PACK); with live variables the
    # dense layers stay BATCH_MATMUL. Flatten itself stays a RESHAPE, which the
    # guest registers for this.
    @tf.function(autograph=False)
    def run(x):
        return model(x, training=False)

    concrete = run.get_concrete_function(tf.TensorSpec([1, WINDOW, 3, 1], tf.float32))
    frozen = convert_variables_to_constants_v2(concrete)
    data = tf.lite.TFLiteConverter.from_concrete_functions([frozen]).convert()
    it = interpreter(data)
    ops = {o['op_name'] for o in it._get_ops_details()} - {'DELEGATE'}
    if not ops <= GUEST_OPS:
        sys.exit(f'the converted model uses {sorted(ops - GUEST_OPS)}, which the guest does not register')
    inp, out = it.get_input_details()[0], it.get_output_details()[0]
    if list(inp['shape']) != [1, WINDOW, 3, 1] or list(out['shape']) != [1, 4] or inp['dtype'] != np.float32:
        sys.exit(f'unexpected model signature {inp["shape"]} -> {out["shape"]}')
    return data


def interpreter(model_bytes):
    from ai_edge_litert.interpreter import Interpreter

    it = Interpreter(model_content=model_bytes)
    it.allocate_tensors()
    return it


def predict(model_bytes, xs):
    it = interpreter(model_bytes)
    inp = it.get_input_details()[0]['index']
    out = it.get_output_details()[0]['index']
    preds = []
    for x in xs:
        it.set_tensor(inp, x[None].astype(np.float32))
        it.invoke()
        preds.append(it.get_tensor(out)[0])
    return np.array(preds)


def shipped_model():
    text = open(MODEL_CPP).read()
    body = text[text.index('{') + 1:text.index('};')]
    return bytes(int(tok, 16) for tok in re.findall(r'0x[0-9a-fA-F]{2}', body))


def write_model_cpp(model_bytes, note):
    rows = []
    for i in range(0, len(model_bytes), 12):
        rows.append('\t' + ' '.join(f'0x{b:02x},' for b in model_bytes[i:i + 12]))
    text = f"""/*
 * Copyright 2019 The TensorFlow Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* Written by tools/train-magic-wand.py ({note}).
 * The network is TensorFlow's magic wand model, retrained for
 * zephyr-in-the-browser. Do not edit by hand.
 */

#include "magic_wand_model_data.hpp"

/* Keep model aligned to 8 bytes to guarantee aligned 64-bit accesses. */
alignas(8) const unsigned char g_magic_wand_model_data[] = {{
{chr(10).join(rows)}
}};
const int g_magic_wand_model_data_len = {len(model_bytes)};
"""
    open(MODEL_CPP, 'w').write(text)


# --- evaluation -------------------------------------------------------------

def load_guest_sim():
    spec = importlib.util.spec_from_file_location('extract_magic_wand_gestures', EXTRACT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def shift(samples, phase):
    """The same motion sampled `phase` of a sample later, as a phone samples it."""
    idx = np.arange(len(samples) - 1) + phase
    return np.stack([np.interp(idx, np.arange(len(samples)), samples[:, k]) for k in range(3)], axis=1)


def stream_scores(model_bytes, items, sim, phase=0.0):
    """Each held-out gesture streamed through the guest's loop between stillness."""
    tally = {'right': 0, 'wrong': 0, 'missed': 0}
    for item in items:
        samples = item['samples'] / 1000.0  # the sim takes g
        if phase:
            samples = shift(samples, phase)
        stream = [tuple(samples[0])] * (3 * RATE_HZ) + [tuple(r) for r in samples] + [tuple(samples[-1])] * (5 * RATE_HZ)
        found = [g for _, g, _ in sim.detections(model_bytes, stream, quantise=True)]
        if not found:
            tally['missed'] += 1
        elif found == [item['label']]:
            tally['right'] += 1
        else:
            tally['wrong'] += 1
    return tally


def false_detections(model_bytes, items, sim):
    total, minutes = 0, 0.0
    for item in items:
        samples = item['samples'] / 1000.0
        found = sim.detections(model_bytes, [tuple(r) for r in samples], quantise=True)
        total += len(found)
        minutes += len(samples) / RATE_HZ / 60
    return total, minutes


def validation_score(model_bytes, items, sim, rng):
    """Gestures right as recorded, half a sample later and turned, less false alarms."""
    gestures = [i for i in items if i['label'] != NEGATIVE]
    turned = [dict(i, samples=i['samples'] @ rotation(rng, 'yaw').T) for i in gestures]
    stream = [tuple(r / 1000.0) for i in items if i['label'] == NEGATIVE for r in i['samples']]
    right = sum(stream_scores(model_bytes, g, sim, phase=p)['right'] for g, p in ((gestures, 0.0), (gestures, 0.5), (turned, 0.0)))
    return right - 2 * len(sim.detections(model_bytes, stream, quantise=True))


def report(name, model_bytes, test_items, rng, sim):
    gestures = [i for i in test_items if i['label'] != NEGATIVE]
    negatives = [i for i in test_items if i['label'] == NEGATIVE]
    xs = np.array([gesture_window(i, rng, warp=False) for i in gestures], dtype=np.float32)[..., None]
    ys = np.array([i['label'] for i in gestures])
    acc = float(np.mean(predict(model_bytes, xs).argmax(1) == ys)) if len(xs) else float('nan')
    turned = np.array([x[..., 0] @ rotation(rng, 'yaw').T for x in xs], dtype=np.float32)[..., None]
    acc_turned = float(np.mean(predict(model_bytes, turned).argmax(1) == ys)) if len(xs) else float('nan')
    tally = stream_scores(model_bytes, gestures, sim)
    shifted = stream_scores(model_bytes, gestures, sim, phase=0.5)
    false, minutes = false_detections(model_bytes, negatives, sim)
    print(
        f'  {name:8} windows {acc:6.1%}  turned {acc_turned:6.1%}  '
        f'streamed right {tally["right"]}/{len(gestures)} (wrong {tally["wrong"]}, missed {tally["missed"]})  '
        f'half a sample later {shifted["right"]}/{len(gestures)}  '
        f'free movement: {false} false in {minutes:.1f} min'
    )


# --- main -------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--captures', nargs='*', default=[], help='directories of capture-page files')
    parser.add_argument('--rotate', choices=['none', 'yaw', 'tilt'], default='tilt')
    parser.add_argument('--validate', nargs='*', default=DEFAULT_VALIDATE, help='people the seeds compete on')
    parser.add_argument('--holdout', nargs='*', default=DEFAULT_HOLDOUT, help='people the report scores')
    parser.add_argument('--epochs', type=int, default=40)
    parser.add_argument('--copies', type=int, default=12, help='augmented windows per gesture')
    parser.add_argument('--seed', type=int, default=1, help='first seed')
    parser.add_argument('--seeds', type=int, default=3, help='models to train; the best on --validate wins')
    parser.add_argument('--write', action='store_true', help='replace the guest model')
    args = parser.parse_args()

    import tensorflow as tf

    fetch_dataset()
    items = load_tensorflow_recordings() + load_captures(args.captures)
    test = [i for i in items if i['person'] in args.holdout]
    valid = [i for i in items if i['person'] in args.validate]
    train = [i for i in items if i['person'] not in args.holdout + args.validate]
    counts = {LABELS[k]: sum(1 for i in train if i['label'] == k) for k in range(4)}
    print(f'training on {len(train)} recordings {counts}; seeds compete on {len(valid)}, the report scores {len(test)}')

    sim = load_guest_sim()
    best = None
    for seed in range(args.seed, args.seed + args.seeds):
        rng = np.random.default_rng(seed)
        tf.keras.utils.set_random_seed(seed)
        x, y = build_set(train, rng, args.copies, args.rotate)
        order = rng.permutation(len(x))
        x, y = x[order], y[order]
        weights = {k: len(y) / (4 * max(1, np.sum(y == k))) for k in range(4)}
        model = build_model()
        model.compile(optimizer=tf.keras.optimizers.Adam(1e-3), loss='sparse_categorical_crossentropy', metrics=['accuracy'])
        model.fit(
            x * INPUT_SCALE, y, epochs=args.epochs, batch_size=64, validation_split=0.1, class_weight=weights, verbose=0,
            callbacks=[tf.keras.callbacks.EarlyStopping(patience=6, restore_best_weights=True)],
        )
        fold_input_scale(model)
        candidate = to_tflite(model)
        score = validation_score(candidate, valid, sim, np.random.default_rng(7))
        print(f'seed {seed}: {len(x)} windows, rotate={args.rotate}, validation score {score}')
        if best is None or score > best[0]:
            best = (score, seed, candidate)
    _, seed, trained = best
    print(f'keeping seed {seed}')

    print('held-out people:')
    report('shipped', shipped_model(), test, np.random.default_rng(99), sim)
    report('new', trained, test, np.random.default_rng(99), sim)
    still = sim.detections(trained, [(0.0, 0.0, 1.0)] * (4 * WINDOW), quantise=True)
    print(f'  resting flat, screen up: {len(still)} detections')

    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    out = os.path.join(os.path.dirname(CACHE), f'magic_wand_{args.rotate}.tflite')
    open(out, 'wb').write(trained)
    print(f'wrote {os.path.relpath(out, ROOT)} ({len(trained)} bytes)')
    if args.write:
        note = f'rotate={args.rotate}, {len(train)} recordings, seed {seed}'
        write_model_cpp(trained, note)
        print(f'wrote {os.path.relpath(MODEL_CPP, ROOT)}')


if __name__ == '__main__':
    main()
