/*
 * CPU-bound guest benchmark for emulator A/B measurements. Not a packaged
 * sample: build it by hand and drop it over a sample's ELF, the way
 * tools/ab-boot-bench.mjs describes.
 *
 *   west build -b qemu_cortex_m3 -d build zephyr-module/apps/cpu_bench
 *
 * Three fixed workloads, each run three times and timed with the kernel
 * clock: integer arithmetic with dependent loads and stores, soft-float
 * (every operation is a library call on a Cortex-M3), and libc memset and
 * memcpy over 8 KB. Without -icount the virtual clock follows wall time, so
 * the printed milliseconds are wall milliseconds. Cycles come from the
 * board's 12 MHz SysTick-based counter and give sub-tick resolution.
 */
#include <zephyr/kernel.h>
#include <zephyr/sys/printk.h>
#include <string.h>

#define INT_ITER 8000000u
#define FLT_ITER 400000u
#define MEM_ITER 4000u

static uint32_t buf[1024];
static uint8_t src8[8192], dst8[8192];

/* Integer arithmetic plus dependent loads and stores: the LCG picks the index. */
static uint32_t __noinline int_work(uint32_t seed)
{
	uint32_t x = seed, acc = 0;

	for (uint32_t i = 0; i < INT_ITER; i++) {
		x = x * 1664525u + 1013904223u;
		uint32_t idx = (x >> 20) & 1023u;

		acc += buf[idx] ^ (x >> 7);
		buf[(idx * 7u) & 1023u] = acc;
		if ((x & 0xffu) == 0u) {
			acc = (acc << 3) | (acc >> 29);
		}
	}
	return acc;
}

/* Soft-float on a Cortex-M3: every operation is a library call. */
static uint32_t __noinline flt_work(uint32_t seed)
{
	float x = (float)seed * 0.001f + 1.0f, acc = 0.0f;
	uint32_t bits;

	for (uint32_t i = 0; i < FLT_ITER; i++) {
		x = x * 1.000001f + 0.25f;
		if (x > 1000.0f) {
			x -= 999.0f;
		}
		acc += x / 3.0f;
	}
	memcpy(&bits, &acc, sizeof(bits));
	return bits;
}

/* Bulk memory: memset and memcpy over 8 KB, the libc word loops. */
static uint32_t __noinline mem_work(uint32_t seed)
{
	uint32_t chk = seed;

	for (uint32_t i = 0; i < MEM_ITER; i++) {
		memset(src8, (int)(i + seed), sizeof(src8));
		memcpy(dst8, src8, sizeof(src8));
		chk += dst8[(i * 13u) & 8191u] + dst8[8191];
	}
	return chk;
}

static void run(const char *name, uint32_t (*fn)(uint32_t))
{
	for (int r = 0; r < 3; r++) {
		int64_t t0 = k_uptime_get();
		uint32_t c0 = k_cycle_get_32();
		uint32_t chk = fn((uint32_t)r + 1u);
		uint32_t dc = k_cycle_get_32() - c0;
		int64_t dt = k_uptime_get() - t0;

		printk("BENCH %s run=%d ms=%lld cycles=%u chk=%08x\n", name, r, dt, dc, chk);
	}
}

int main(void)
{
	run("int", int_work);
	run("float", flt_work);
	run("mem", mem_work);
	printk("BENCH done\n");
	return 0;
}
