# Training the Magic Wand

The Magic Wand sample (`zephyr-module/apps/magic_wand`) recognizes three
gestures with a 21 KB TensorFlow Lite Micro model: **wing** (a W), **ring** (a
clockwise circle) and **slope** (an angle: down to the left, then right). It is
trained on TensorFlow's 2019 recordings of ten people waving a SparkFun Edge
board held flat, turned the ways a phone gets held. Recordings from phones are
what it needs next. This page covers recording them, training on them, and
shipping the result.

## Recording gestures

Open the capture page on a phone:
<https://kartben.github.io/zephyr-in-the-browser/capture/> (or `/capture/` on a
dev server). It has to be served over HTTPS (or from localhost), because phones
only give motion sensor readings to secure pages. That is also why it is a page
on the site and not a server on your laptop.

A round takes about three minutes: five of each gesture in random order, then
twenty seconds of free movement and ten seconds of holding still. Or pick one
motion (a gesture, free movement or holding still) and record it as many times
as you like, until **Done**. Each gesture take starts with a three-second
countdown, then three seconds to draw. After each take the page plots what it
recorded: **Keep** it, or **Redo** it if the move went wrong. The page asks for
a hold first:

- **Flat:** screen up, charging port on the left. This matches how the 2019
  board was held, so the current model can use it.
- **Your way:** however the person would naturally hold the phone. A model
  that works for everyone has to handle this one.

Takes are kept in the browser between rounds. **Export** shares the session as
one JSON file through the share sheet (AirDrop, Files, Drive, mail), or
downloads it. Send the file to whoever is collecting recordings; for this
repository, commit it to a branch, which GitHub's **Add file > Upload files**
can do from a phone. The page records motion readings, the
browser's user agent, the phone model where the browser reports it (Chromium
does), and the hand the person chose. Nothing else, and nothing leaves the
phone until it is exported.

Variety matters more than volume. One person's hour makes the model solid on
that phone. Making it work for everyone needs ten or more people on a mix of
iPhones and Android phones, in both holds.

## Training

`tools/train-magic-wand.py` trains a model for the guest:

```console
tools/train-magic-wand.py --captures path/to/captures
```

It needs `numpy`, `tensorflow` and `ai-edge-litert` (a venv with
`pip install tensorflow-cpu ai-edge-litert`). It fetches TensorFlow's original
recordings on the first run, adds every capture file found under the
`--captures` directories, and trains on 128-sample windows around each
gesture, stretched in time (0.8x to 1.25x), scaled, with noise added, and
turned the way phones get held:

| `--rotate`       | Turns each window by                                        |
| ---------------- | ----------------------------------------------------------- |
| `none`           | nothing: the hold the recordings were made in               |
| `yaw`            | any angle flat on the table: portrait, landscape, port left or right |
| `tilt` (default) | yaw, then tipped up to 30 degrees either way                 |

Free movement, idle takes, stillness in any orientation and slow turns of the
phone from one pose to another (screen up, or tipped up to 90 degrees any way)
train the "no gesture" class. The turns matter most: a model that recognizes
gestures however the phone is held otherwise also takes picking the phone up
for one.

`--arch` picks the network. Both use only ops the guest registers:

| `--arch`             | Network                                                     |
| -------------------- | ----------------------------------------------------------- |
| `temporal` (default) | Convolves over time with the three axes as channels, so every kernel sees every axis. 51k multiply-accumulates per inference |
| `cnn2019`            | The 2019 network, layer for layer: its first kernel spans the axes, then pools them away. 62k multiply-accumulates |

It follows TensorFlow's own 2019 person split: six people train, three models
(`--seeds`) compete on the two `--validate` people, and the report scores the
two `--holdout` people (TensorFlow's names, or capture session ids), for the
shipped model and the new one, in four ways:

- **windows:** held-out gestures classified as recorded, and turned at random.
- **streamed:** each held-out gesture fed through the guest's own detection
  loop (the copy in `tools/extract-magic-wand-gestures.py`: the average of the
  last five samples' predictions, 0.8 threshold, one-window hold-off) at the
  resolution the guest reads, counted right, wrong or missed, as recorded and
  sampled half a sample later.
- **free movement:** false detections in held-out free movement.
- **turning:** false detections while the phone is turned 200 times, each time
  from one random pose to the next, with a few seconds still between.

Trained models land in `.zephyr-build/magic-wand-data/`. Compare them before
shipping one.

## Choosing the network

Measured in October 2026 with default options, on TensorFlow's recordings
alone. Inference is the "inference takes N ms" line in headless Chromium on a
four-core machine. The rest runs the guest's detection loop on people the
models did not train on: 127 gestures streamed at four sampling phases (as
recorded, and a quarter, half and three quarters of a sample later) and turned
at random, 1.9 minutes of free movement, and 600 slow turns between poses a
phone is held in.

| Model                   | Inference   | Gestures right | Turned | False alarms: free movement | False alarms: turns |
| ----------------------- | ----------- | -------------- | ------ | --------------------------- | ------------------- |
| TensorFlow's 2019 model | 28 to 33 ms | 95 to 102      | 31     | 1                           | 52                  |
| `cnn2019`               | the same    | 102 to 104     | 92     | 4                           | 2                   |
| `temporal` (ships)      | 28 to 29 ms | 122            | 113    | 3                           | 10                  |

`temporal` ships: it recognizes the most gestures, at every sampling phase and
held any way, and fires on a fifth as many turns as the 2019 model. Trained the
same way, the 2019 network turns cautious, with almost no false alarms on turns
but about 20 fewer gestures. Both fire more than the 2019 model in free movement,
though 1.9 minutes of it is too little to be sure. Free movement recorded on
phones is what the next model needs most.

What did not help:

- **A wider network.** `temporal` with 16, 24 and 32 filters (285k
  multiply-accumulates) was no more accurate and took 123 to 134 ms: in the
  emulator a model takes time in proportion to its arithmetic.
- **int8.** Quantized weights and activations were no faster in the emulator:
  33 to 38 ms for the 2019 network, 128 to 169 ms for the wide one.
- **Taking gravity out.** Turning each window so its mean points along +Z
  before inference (the guest would do the same) recognized more turned
  gestures, but fired on 114 of 200 turns between random poses.
- **Turns between random poses.** Trained on turns between any two poses,
  half of them upside down, `temporal` fired on more than half of the turns
  that start or end near screen up, which is how a phone gets picked up.

## Shipping a model

1. `tools/train-magic-wand.py ... --write` replaces
   `zephyr-module/apps/magic_wand/src/magic_wand_model_data.cpp`. The converter
   keeps the network to ops the guest registers (it checks).
2. `tools/extract-magic-wand-gestures.py` re-picks the Wing, Ring and Slope
   replay clips so the new model recognizes each one, alone and back to back.
3. `npm test`, then rebuild the images
   (`tools/build-zephyr-image.sh qemu_cortex_a53 magic_wand`) and run
   `node tools/smoke-boot.mjs magic-wand magic-wand-trace`.
4. Publish an images release; the deploy's smoke test replays every gesture
   again. It replays the new clips on the published images, which carry the
   old model until the release is out, so build the images from the branch
   (the Build guest images workflow, with publish on and deploy off) and merge
   it once they are published. Merged first, the merge's own deploy fails its
   Magic Wand cases until the release.

## Slow devices

A phone following tilt feeds the sensor in real time, so the guest has to keep
up with real time. Two things in the app make it work on a slow browser, where
an inference takes longer than the 40 ms between samples:

- **Sampling has its own thread.** It used to read the accelerometer between
  inferences, so when an inference ran long, samples were lost and a gesture
  reached the model squeezed into fewer of them. A sampler thread now reads at
  25 Hz whatever inference is doing, and inference runs on the newest window.
- **Time is counted in samples.** The predictor averages the predictions from
  the last five samples (five inferences at full speed), and holds off a repeat
  for 128 samples. Counted in inferences, both stretched on a slow host:
  averaging five inferences four samples apart smeared a Ring over 800 ms.

Measured in the browser with inference slowed to about 90 ms: the old loop
read the sensor at 12.5 Hz and a phone-paced Wing, Ring, Slope came out as
"SLOPE SLOPE". The sampler keeps reads 40 ms apart, and the guest's detection
loop, run on exactly what the guest read, recognizes all three whether
inference runs every sample or every sixth. TensorFlow's 2019 model still
depended on where the samples fell: Ring could score just under the threshold
and read as Slope, at full speed too. The `temporal` model gets the same
gestures right at every sampling phase. The replay buttons hid all of this,
because they hand out the recorded
samples exactly as the guest reads them. The "Magic Wand ready: inference takes
N ms" line in the terminal says how fast this browser is.

## Capture file format

One JSON object per session, `format: "zitb-magic-wand-capture"`, `version: 1`
(`src/capture/session.ts`):

| Field              | Meaning                                                        |
| ------------------ | -------------------------------------------------------------- |
| `id`, `createdAt`  | Session id (start time plus a random suffix) and start time    |
| `device`           | User agent, platform, model and `mobile` from client hints where available, screen size, pixel ratio |
| `contributor`      | `handedness`: `right`, `left` or null                          |
| `normalization`    | How readings became samples: `inverted` (Safari's signs), `scaledFromG` (readings in g) |
| `motionIntervalMs` | Median time between motion events                              |
| `takes[]`          | `label` (`wing`, `ring`, `slope`, `negative`, `idle`), `hold` (`recommended` or `natural`), `startedAt`, `cueMs` (when "go" sounded, gestures only), `samples`, and `rotation` when the browser reports it |

`samples` rows are `[ms since the take started, x, y, z]` in m/s², gravity
included, in the frame the page feeds the guest's ADXL345 (+Z out of the
screen; flat and face up reads about +9.8 on Z). `rotation` rows are
`[ms, alpha, beta, gamma]` in degrees per second.
