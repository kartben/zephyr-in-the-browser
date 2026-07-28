/* Thin WASM exports over google/libsbc for browser A2DP SBC → PCM. */
#include <sbc.h>
#include <stdint.h>
#include <string.h>
#include <emscripten/emscripten.h>

static sbc_t g_sbc;
static int g_inited = 0;

EMSCRIPTEN_KEEPALIVE
void sbc_wasm_reset(void) {
  sbc_reset(&g_sbc);
  g_inited = 1;
}

/* Probe first 4 bytes; returns frame size in bytes, or 0 on error.
 * Out params written as ints: freq_hz, nchannels, nsamples (per channel). */
EMSCRIPTEN_KEEPALIVE
int sbc_wasm_probe(const uint8_t *data, int *freq_hz, int *nchannels, int *nsamples) {
  struct sbc_frame frame;
  if (sbc_probe(data, &frame) != 0) return 0;
  if (freq_hz) *freq_hz = sbc_get_freq_hz(frame.freq);
  if (nchannels) *nchannels = (frame.mode == SBC_MODE_MONO) ? 1 : 2;
  if (nsamples) *nsamples = frame.nblocks * frame.nsubbands;
  return (int)sbc_get_frame_size(&frame);
}

/* Decode one SBC frame into interleaved s16le PCM.
 * Returns number of interleaved samples written, or -1 on error.
 * pcm must hold nsamples * nchannels int16s. */
EMSCRIPTEN_KEEPALIVE
int sbc_wasm_decode_frame(const uint8_t *data, unsigned size, int16_t *pcm) {
  struct sbc_frame frame;
  int16_t left[SBC_MAX_SAMPLES];
  int16_t right[SBC_MAX_SAMPLES];
  if (!g_inited) sbc_wasm_reset();
  if (sbc_probe(data, &frame) != 0) return -1;
  int ns = frame.nblocks * frame.nsubbands;
  int ch = (frame.mode == SBC_MODE_MONO) ? 1 : 2;
  if (sbc_decode(&g_sbc, data, size, &frame, left, 1, right, 1) != 0) return -1;
  if (ch == 1) {
    memcpy(pcm, left, (size_t)ns * sizeof(int16_t));
    return ns;
  }
  for (int i = 0; i < ns; i++) {
    pcm[2 * i] = left[i];
    pcm[2 * i + 1] = right[i];
  }
  return ns * 2;
}

EMSCRIPTEN_KEEPALIVE
int sbc_wasm_max_pcm_samples(void) {
  return SBC_MAX_SAMPLES * 2;
}
