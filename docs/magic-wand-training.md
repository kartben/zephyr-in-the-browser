# Training the Magic Wand

The Magic Wand sample (`zephyr-module/apps/magic_wand`) recognizes three
gestures with a 20 KB TensorFlow Lite Micro model: **wing** (a W), **ring** (a
clockwise circle) and **slope** (an angle: down to the left, then right).
TensorFlow trained it in 2019 on ten people waving a SparkFun Edge board held
flat. A phone is held in other ways, so the model needs recordings from phones.
This page covers recording them, training on them, and shipping the result.

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

`tools/train-magic-wand.py` trains the same network as 2019, layer for layer:

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

Free movement, idle takes and stillness in any orientation train the "no
gesture" class.

It follows TensorFlow's own 2019 person split: six people train, three models
(`--seeds`) compete on the two `--validate` people, and the report scores the
two `--holdout` people (TensorFlow's names, or capture session ids), for the
shipped model and the new one, in three ways:

- **windows:** held-out gestures classified as recorded, and turned at random.
- **streamed:** each held-out gesture fed through the guest's own detection
  loop (the copy in `tools/extract-magic-wand-gestures.py`: the average of the
  last five samples' predictions, 0.8 threshold, one-window hold-off) at the
  resolution the guest reads, counted right, wrong or missed, as recorded and
  sampled half a sample later.
- **free movement:** false detections in held-out free movement.

Trained models land in `.zephyr-build/magic-wand-data/`. Compare them before
shipping one.

What to expect, from the 2019 recordings alone (October 2026, default
options): on TensorFlow's two test people the shipped model streams 100 of 127
gestures right, 95 when the same motion is sampled half a sample later, and
18% of windows once the phone is turned. A `tilt` model streams 114 either way
and keeps 94% turned, but fires 5 times in 1.9 minutes of held-out free
movement where the shipped model fires once: turned gestures cover more of
what random waving looks like. Recordings of free movement from phones are
what the next model needs most, so every round ends with some.

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
   again.

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
inference runs every sample or every sixth. What still goes wrong is the
shipped model: depending on where the samples fall, Ring can score just under
the threshold and read as Slope, at full speed too, which the next model has
to fix. The replay buttons hid all of this, because they hand out the recorded
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
