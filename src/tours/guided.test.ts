import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BOARDS, type GuestSample } from '@/boards'
import { isKnownFormat } from '@/tours/expr'
import { patternFile, resolveShow } from '@/tours/anchors'
import { parseTour } from '@/tours/parse'
import { tourIds } from '@/tours/catalog'
import { whenFires } from '@/tours/when'

/**
 * The tours in `tours/` are shipped content, and a broken one fails quietly at
 * runtime — a step whose anchor is malformed just never appears. So they are
 * parsed here, where a mistake is a failing test instead of a lesson nobody
 * notices is missing.
 *
 * Anchors cannot be *resolved* without a built ELF, which this test does not
 * have. What it can check is everything up to that: the file parses, the page
 * bundle can see it, and the sample each tour claims to be about is the one the
 * gallery will run it against.
 */

const TOURS_DIR = resolve(process.cwd(), 'tours')

function tourFiles(): string[] {
  return readdirSync(TOURS_DIR)
    .filter((f) => f.endsWith('.tour.md'))
    .sort()
}

function sampleById(id: string): GuestSample | undefined {
  for (const board of BOARDS) {
    const found = board.samples.find((s) => s.id === id)
    if (found) return found
  }
  return undefined
}

describe('tours/', () => {
  it('is discovered from the files themselves', () => {
    // No hand-kept list to drift: dropping a file in `tours/` is the whole
    // wiring, and this is what proves the glob sees it.
    expect(tourIds()).toEqual(tourFiles().map((f) => f.replace('.tour.md', '')))
  })

  it.each(tourFiles())('%s parses with no authoring errors', (file) => {
    const doc = parseTour(readFileSync(resolve(TOURS_DIR, file), 'utf8'))
    expect(doc.problems).toEqual([])
    expect(doc.steps.length).toBeGreaterThan(0)
    expect(doc.title).not.toBe('Guided tour') // i.e. the front matter named one
  })

  it.each(tourFiles())('%s is about a sample the gallery offers', (file) => {
    const id = file.replace('.tour.md', '')
    const doc = parseTour(readFileSync(resolve(TOURS_DIR, file), 'utf8'))
    const sample = sampleById(id)
    expect(sample, `no sample with id '${id}' in boards.ts`).toBeDefined()
    expect(doc.sample).toBe(sample!.zephyrSample)
  })

  it.each(tourFiles())('%s has usable stage directions on every step', (file) => {
    const doc = parseTour(readFileSync(resolve(TOURS_DIR, file), 'utf8'))
    for (const step of doc.steps) {
      expect(step.at, `step ${step.index + 1} has no anchor`).toBeTruthy()
      // A pattern anchor needs the sample's sources, which arrive with the
      // guest images and can be older than the tour. Every one carries a
      // fallback so the step still resolves on a build without them.
      if (patternFile(step.at) !== null) {
        expect(
          step.at.includes('|'),
          `step ${step.index + 1}: a pattern anchor wants a \`|\` fallback`,
        ).toBe(true)
      }
      expect(step.body.trim(), `step ${step.index + 1} has no prose`).not.toBe('')
      // The page fetches an excerpt by basename (sampleSourceAsset), so a
      // `show: file:` carrying a path would ask for a URL nothing serves.
      if (step.show?.file) {
        expect(
          step.show.file,
          `step ${step.index + 1}: \`show: file:\` wants a bare basename`,
        ).not.toContain('/')
      }
      for (const watch of step.watch) {
        expect(isKnownFormat(watch.format)).toBe(true)
      }
      if (step.when !== null) {
        expect(whenFires(step.when, 1).invalid, `step ${step.index + 1}: bad \`when\``).toBe(false)
      }
      // A step that neither stops nor repeats fires once and is gone before
      // the reader can act on it — almost always a typo for `stop: no`.
      expect(step.stop || step.repeat || step.when !== null).toBe(true)
    }
  })
})

/**
 * The `show:` blocks in the shipped tours, resolved against the real thing.
 *
 * Everything else here stops at parsing, because anchors need a built ELF. A
 * `show:` does not: it is resolved against source text, and source text can be
 * a fixture. So this is the one part of a shipped tour that can be checked
 * end-to-end here — and it earns its place, since a `show:` that resolves to
 * nothing degrades to "no excerpt", which is exactly the kind of silent failure
 * that never gets noticed.
 */
const STOCK_BLINKY = `/*
 * Copyright (c) 2016 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <stdio.h>
#include <zephyr/kernel.h>
#include <zephyr/drivers/gpio.h>

/* 1000 msec = 1 sec */
#define SLEEP_TIME_MS   1000

/* The devicetree node identifier for the "led0" alias. */
#define LED0_NODE DT_ALIAS(led0)

/*
 * A build error on this line means your board is unsupported.
 */
static const struct gpio_dt_spec led = GPIO_DT_SPEC_GET(LED0_NODE, gpios);

int main(void)
{
	int ret;
	bool led_state = true;

	if (!gpio_is_ready_dt(&led)) {
		return 0;
	}

	ret = gpio_pin_configure_dt(&led, GPIO_OUTPUT_ACTIVE);
	if (ret < 0) {
		return 0;
	}

	while (1) {
		ret = gpio_pin_toggle_dt(&led);
		if (ret < 0) {
			return 0;
		}

		led_state = !led_state;
		printf("LED state: %s\\n", led_state ? "ON" : "OFF");
		k_msleep(SLEEP_TIME_MS);
	}
	return 0;
}
`

describe('blinky show: blocks, against stock upstream blinky', () => {
  const doc = parseTour(readFileSync(resolve(TOURS_DIR, 'blinky.tour.md'), 'utf8'))
  const sources = new Map([['main.c', STOCK_BLINKY.split('\n')]])
  // Stands in for `at: main` having landed on the first statement of main().
  const inMain = { addr: 0, via: 'symbol' as const, file: 'main.c', line: 27, symbol: 'main' }

  it('points the first step at the two lines of file scope it talks about', () => {
    const show = resolveShow(doc.steps[0]!.show!, inMain, sources)
    expect(show?.file).toBe('main.c')
    // The #define through the spec initialiser — neither of which is code, and
    // neither of which `at:` could ever have reached.
    expect(STOCK_BLINKY.split('\n')[show!.start - 1]).toContain('#define LED0_NODE')
    expect(STOCK_BLINKY.split('\n')[show!.end - 1]).toContain('GPIO_DT_SPEC_GET')
  })

  it('points the k_msleep step back at the sample, from inside the kernel', () => {
    const step = doc.steps.find((s) => s.at === 'z_impl_k_sleep')
    const inKernel = { addr: 0, via: 'symbol' as const, file: 'kernel/timeout.c', line: 100, symbol: 'z_impl_k_sleep' }
    const show = resolveShow(step!.show!, inKernel, sources)
    expect(show?.file).toBe('main.c')
    expect(STOCK_BLINKY.split('\n')[show!.start - 1]).toContain('k_msleep(SLEEP_TIME_MS)')
    expect(show!.end).toBe(show!.start)
  })
})
