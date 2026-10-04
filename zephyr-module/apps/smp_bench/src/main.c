/*
 * Copyright (c) 2026
 * SPDX-License-Identifier: Apache-2.0
 *
 * How much is a second core worth in a browser tab?
 *
 * The same fixed amount of integer work is run first on one CPU, then split
 * two ways, three ways, four ways, with one worker pinned per CPU. Each pass
 * is timed on the cycle counter and printed next to its speedup against the
 * single-CPU pass, so the table is a measurement rather than a claim.
 *
 * The board runs without -icount, so the virtual clock follows the host's and
 * the printed milliseconds are wall milliseconds: the same ones a stopwatch
 * held to the screen would show.
 *
 * The work itself is a linear congruential generator folded into an
 * accumulator: a dependent chain with no memory traffic to speak of and
 * nothing to synchronise on, so what it measures is how many guest
 * instructions per second the emulator can retire, in parallel, and nothing
 * else. Zephyr's scheduler, the timer interrupt and the console are shared;
 * everything else in the pass is private to its worker.
 */
#include <zephyr/kernel.h>
#include <zephyr/sys/printk.h>

/* Matches the -smp on the board's QEMU argv (src/boards.ts). */
#define NCPUS CONFIG_MP_MAX_NUM_CPUS

#define STACK_SIZE 2048

/*
 * Iterations per pass, split across the workers. Sized so a single-CPU pass
 * takes roughly a quarter of a second under the wasm JIT: long enough that the
 * four-way pass is still tens of milliseconds, short enough that a whole round
 * finishes while you are still looking at it.
 */
#define WORK 40000000u

static K_THREAD_STACK_ARRAY_DEFINE(stacks, NCPUS, STACK_SIZE);
static struct k_thread workers[NCPUS];
static struct k_sem finished;

/* Where each worker actually ran, read inside the worker itself. */
static uint8_t ran_on[NCPUS];

/* Keeps the compiler from deciding the arithmetic below is unobservable. */
static volatile uint32_t sink;

static uint32_t burn(uint32_t seed, uint32_t iterations)
{
	uint32_t x = seed;
	uint32_t acc = 0;

	for (uint32_t i = 0; i < iterations; i++) {
		x = x * 1664525u + 1013904223u;
		acc += x ^ (acc >> 7);
	}
	return acc;
}

static void worker(void *index, void *iterations, void *unused)
{
	int i = (int)(uintptr_t)index;

	ARG_UNUSED(unused);

	sink += burn(i + 1u, (uint32_t)(uintptr_t)iterations);
	ran_on[i] = arch_curr_cpu()->id;
	k_sem_give(&finished);
}

/*
 * Runs WORK iterations split over `n` pinned workers; returns the elapsed
 * hardware cycles. Cycles rather than k_uptime_get(), because the millisecond
 * tick is 10 ms here and a four-way pass is under a hundred of them: the
 * quantisation alone was enough to print speedups above the core count.
 */
static uint32_t pass(int n)
{
	uint32_t start, elapsed;

	k_sem_init(&finished, 0, n);

	for (int i = 0; i < n; i++) {
		ran_on[i] = 0xff;
		k_thread_create(&workers[i], stacks[i], STACK_SIZE, worker,
				(void *)(uintptr_t)i, (void *)(uintptr_t)(WORK / n), NULL,
				K_PRIO_PREEMPT(5), 0, K_FOREVER);
		k_thread_cpu_pin(&workers[i], i);
		k_thread_name_set(&workers[i], "worker");
	}

	start = k_cycle_get_32();
	for (int i = 0; i < n; i++) {
		k_thread_start(&workers[i]);
	}
	for (int i = 0; i < n; i++) {
		k_sem_take(&finished, K_FOREVER);
	}
	/* Unsigned arithmetic, so a counter wrap mid-pass still subtracts right. */
	elapsed = k_cycle_get_32() - start;

	/*
	 * The semaphore says the work is done, not that the thread is gone, and
	 * the next pass reuses these k_thread objects. Joining is what makes
	 * that safe; without it the second pass creates a thread over one that
	 * is still unwinding, and the run dies in the scheduler.
	 */
	for (int i = 0; i < n; i++) {
		k_thread_join(&workers[i], K_FOREVER);
	}

	return elapsed;
}

static void print_row(int n, uint32_t cycles, uint32_t baseline)
{
	/* Tenths of a millisecond, so the shortest pass still shows a fraction. */
	uint64_t tenths = k_cyc_to_ms_floor64((uint64_t)cycles * 10u);
	uint32_t hundredths = cycles > 0 ? (uint32_t)(((uint64_t)baseline * 100u) / cycles) : 0;

	printk("  %7d %6llu.%llu  %5u.%02ux   ", n, tenths / 10, tenths % 10, hundredths / 100,
	       hundredths % 100);
	for (int i = 0; i < n; i++) {
		printk("%d ", ran_on[i]);
	}
	printk("\n");
}

int main(void)
{
	printk("\nParallel speedup on %s: %d CPUs, %u iterations per pass\n", CONFIG_BOARD,
	       (int)arch_num_cpus(), WORK);
	/*
	 * Worth saying, because the first rounds look bad: the emulator compiles
	 * guest code to WebAssembly the first time it runs it, so early rounds
	 * pay for translation as well as execution and land well under the
	 * steady-state speedup. Give it a few rounds.
	 */
	printk("The first rounds are slow while the emulator translates the loop.\n");

	for (int round = 1;; round++) {
		uint32_t baseline = 0;

		printk("\nround %d\n", round);
		printk("  threads       ms   speedup   ran on CPU\n");

		for (int n = 1; n <= NCPUS; n++) {
			uint32_t cycles = pass(n);

			if (n == 1) {
				baseline = cycles;
			}
			print_row(n, cycles, baseline);
		}

		/* Idle long enough that the dock's thread view settles between rounds. */
		k_sleep(K_SECONDS(2));
	}

	return 0;
}
