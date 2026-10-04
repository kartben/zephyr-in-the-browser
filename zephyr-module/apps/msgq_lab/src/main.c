/*
 * Copyright (c) 2026 Benjamin Cabé <benjamin@zephyrproject.org>
 *
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * A message queue lab: one k_msgq, three producers, one consumer, and a shell
 * command that changes how each of them behaves.
 *
 *   sensor    a thread (priority 6) that makes a reading every period_ms and
 *             puts it with whatever timeout `msgq timeout` chose
 *   tick      a k_timer that expires every second; its handler runs in
 *             interrupt context, where K_NO_WAIT is the only timeout allowed
 *   alarm     SW0's interrupt handler, which puts an alarm at the front of
 *             the queue with k_msgq_put_front()
 *   consumer  a thread (priority 7) that takes readings out and spends
 *             work_ms on each one
 *
 * Type `msgq` to see what you can change. The counters record what
 * happened: `msgq stat` prints them, and the guided tour reads them straight
 * out of memory (tours/msgq_lab.tour.md in Zephyr in the Browser).
 */

#include <errno.h>
#include <string.h>

#include <zephyr/drivers/gpio.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/shell/shell.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/sys/printk.h>

LOG_MODULE_REGISTER(msgq_lab, LOG_LEVEL_INF);

#define QUEUE_LEN     8
#define SENSOR_PRIO   6
#define CONSUMER_PRIO 7
#define STACK_SIZE    2048

#define DEFAULT_PERIOD_MS 500
#define DEFAULT_WORK_MS   100

enum source {
	FROM_SENSOR,
	FROM_TICK,
	FROM_ALARM,
};

/* One message. The kernel copies all 16 bytes on every put and every get. */
struct reading {
	uint32_t seq;     /* the order it was made in, across all three producers */
	uint32_t made_ms; /* uptime when it was made */
	int32_t value;    /* hundredths of a degree, or seconds of uptime for a tick */
	uint32_t source;  /* enum source */
};

/* Room for eight readings, in a ring buffer the kernel manages. */
K_MSGQ_DEFINE(readings, sizeof(struct reading), QUEUE_LEN, 4);

/* What the `msgq` shell command changes. */
static int32_t put_timeout_ms; /* the sensor's put: 0 is K_NO_WAIT, -1 is K_FOREVER */
static uint32_t period_ms = DEFAULT_PERIOD_MS;
static uint32_t work_ms = DEFAULT_WORK_MS;
static bool drop_oldest; /* what an alarm does about a full queue */
static bool verbose;

/* What happened. Interrupt handlers, threads and the shell all touch these. */
static atomic_t next_seq;
static atomic_t delivered;      /* readings the consumer took out */
static atomic_t handoffs;       /* ...after finding the queue empty: handed over */
static atomic_t dropped;        /* sensor readings a full queue refused */
static atomic_t waited_puts;    /* sensor puts that waited for room */
static atomic_t waited_ms;      /* ...and for how long, all told */
static atomic_t purged_waiters; /* sensor puts that k_msgq_purge() cut short */
static atomic_t ticks_lost;     /* ticks a full queue refused */
static atomic_t alarms_seen;    /* alarms raised */
static atomic_t alarms_lost;    /* ...that a full queue refused */
static atomic_t evicted;        /* readings drop-oldest threw away for an alarm */
static atomic_t peak_used;      /* the most readings the queue has held */
static bool alarm_in_isr;       /* the last alarm came from SW0's interrupt */
static int alarm_err;           /* what k_msgq_put_front() returned for it */

/* The consumer's buffer: k_msgq_get() copies each reading into it. */
static struct reading latest;

static const char *source_name(uint32_t source)
{
	switch (source) {
	case FROM_SENSOR:
		return "sensor";
	case FROM_TICK:
		return "tick";
	case FROM_ALARM:
		return "alarm";
	default:
		return "?";
	}
}

static struct reading new_reading(enum source from, int32_t value)
{
	return (struct reading){
		.seq = (uint32_t)atomic_inc(&next_seq) + 1U,
		.made_ms = k_uptime_get_32(),
		.value = value,
		.source = from,
	};
}

/* Remember how deep the queue got. Threads and interrupts both call this. */
static void track_peak(void)
{
	atomic_val_t used = k_msgq_num_used_get(&readings);
	atomic_val_t peak = atomic_get(&peak_used);

	while (used > peak && !atomic_cas(&peak_used, peak, used)) {
		peak = atomic_get(&peak_used);
	}
}

/* A pretend temperature: a slow drift between 21.00 and 21.99 degrees. */
static int32_t measure(void)
{
	return 2100 + (int32_t)(k_uptime_get_32() / 100U % 100U);
}

static k_timeout_t sensor_timeout(void)
{
	if (put_timeout_ms == 0) {
		return K_NO_WAIT;
	}
	if (put_timeout_ms < 0) {
		return K_FOREVER;
	}
	return K_MSEC(put_timeout_ms);
}

static void sensor_thread(void *p1, void *p2, void *p3)
{
	ARG_UNUSED(p1);
	ARG_UNUSED(p2);
	ARG_UNUSED(p3);

	for (;;) {
		k_msleep(period_ms);

		struct reading reading = new_reading(FROM_SENSOR, measure());
		k_timeout_t timeout = sensor_timeout();
		uint32_t asked_ms = k_uptime_get_32();

		int err = k_msgq_put(&readings, &reading, timeout);
		uint32_t waited = k_uptime_get_32() - asked_ms;

		if (err == 0) {
			track_peak();
			if (waited > 0) {
				/* No room at first: the put waited until the consumer made some. */
				atomic_inc(&waited_puts);
				atomic_add(&waited_ms, waited);
			}
		} else if (err == -ENOMSG && !K_TIMEOUT_EQ(timeout, K_NO_WAIT)) {
			/* It was waiting for room when k_msgq_purge() emptied the queue. */
			atomic_inc(&purged_waiters);
		} else {
			/* Full and told not to wait (-ENOMSG), or it waited too long (-EAGAIN). */
			atomic_inc(&dropped);
		}
	}
}

static void consumer_thread(void *p1, void *p2, void *p3)
{
	ARG_UNUSED(p1);
	ARG_UNUSED(p2);
	ARG_UNUSED(p3);

	for (;;) {
		/* An empty queue means waiting, and then a put hands its reading over. */
		bool empty = k_msgq_num_used_get(&readings) == 0;
		int err = k_msgq_get(&readings, &latest, K_FOREVER);

		if (err != 0) {
			/* -ENOMSG: k_msgq_purge() woke us up with nothing to take. */
			continue;
		}

		atomic_inc(&delivered);
		if (empty) {
			atomic_inc(&handoffs);
		}

		if (latest.source == FROM_ALARM) {
			LOG_WRN("Alarm %u handled, %u ms after it was raised", latest.seq,
				k_uptime_get_32() - latest.made_ms);
		} else if (verbose) {
			LOG_INF("Took %s reading %u, made %u ms ago", source_name(latest.source),
				latest.seq, k_uptime_get_32() - latest.made_ms);
		}

		/* Pretend to work on it. Sleeping leaves the CPU to everyone else. */
		k_msleep(work_ms);
	}
}

K_THREAD_DEFINE(sensor, STACK_SIZE, sensor_thread, NULL, NULL, NULL, SENSOR_PRIO, 0, 0);
K_THREAD_DEFINE(consumer, STACK_SIZE, consumer_thread, NULL, NULL, NULL, CONSUMER_PRIO, 0, 0);

/* Runs in the timer interrupt, once a second. */
static void tick_expired(struct k_timer *timer)
{
	ARG_UNUSED(timer);

	struct reading tick = new_reading(FROM_TICK, (int32_t)(k_uptime_get_32() / 1000U));

	/* An interrupt handler cannot wait, so K_NO_WAIT is the only choice. */
	if (k_msgq_put(&readings, &tick, K_NO_WAIT) == 0) {
		track_peak();
	} else {
		atomic_inc(&ticks_lost);
	}
}

K_TIMER_DEFINE(tick_timer, tick_expired, NULL);

/*
 * Raise an alarm, from SW0's interrupt or from `msgq alarm` in the shell.
 * Never inlined, so a tour has exactly one place to stop in it.
 */
static __noinline void raise_alarm(void)
{
	struct reading alarm = new_reading(FROM_ALARM, 0);
	struct reading oldest;

	alarm_in_isr = k_is_in_isr();

	/* The drop-oldest policy makes room by throwing the oldest reading away. */
	if (drop_oldest && k_msgq_num_free_get(&readings) == 0 &&
	    k_msgq_get(&readings, &oldest, K_NO_WAIT) == 0) {
		atomic_inc(&evicted);
	}

	/* An alarm jumps the line: put_front() makes it the next reading out. */
	alarm_err = k_msgq_put_front(&readings, &alarm);
	if (alarm_err != 0) {
		atomic_inc(&alarms_lost);
	} else {
		track_peak();
	}
	atomic_inc(&alarms_seen);
}

static const struct gpio_dt_spec sw0 = GPIO_DT_SPEC_GET_OR(DT_ALIAS(sw0), gpios, {0});
static struct gpio_callback sw0_cb;

/* SW0's interrupt handler. */
static void sw0_pressed(const struct device *port, struct gpio_callback *cb,
			gpio_port_pins_t pins)
{
	ARG_UNUSED(port);
	ARG_UNUSED(cb);
	ARG_UNUSED(pins);

	raise_alarm();
	if (alarm_err != 0) {
		LOG_WRN("SW0: alarm lost, the queue is full");
	}
}

static int setup_sw0(void)
{
	int err;

	if (!gpio_is_ready_dt(&sw0)) {
		return -ENODEV;
	}

	err = gpio_pin_configure_dt(&sw0, GPIO_INPUT);
	if (err == 0) {
		err = gpio_pin_interrupt_configure_dt(&sw0, GPIO_INT_EDGE_TO_ACTIVE);
	}
	if (err == 0) {
		gpio_init_callback(&sw0_cb, sw0_pressed, BIT(sw0.pin));
		err = gpio_add_callback(sw0.port, &sw0_cb);
	}
	return err;
}

int main(void)
{
	k_timer_start(&tick_timer, K_SECONDS(1), K_SECONDS(1));

	if (setup_sw0() != 0) {
		LOG_WRN("No SW0 on this board: raise alarms with 'msgq alarm' instead");
	}

	LOG_INF("A sensor reading every %u ms, a tick every second, an alarm on SW0. "
		"Type 'msgq' to change them.", period_ms);
	return 0;
}

/* The `msgq` shell command. */

static const char *timeout_name(char *buf, size_t len)
{
	if (put_timeout_ms == 0) {
		return "K_NO_WAIT";
	}
	if (put_timeout_ms < 0) {
		return "K_FOREVER";
	}
	snprintk(buf, len, "K_MSEC(%d)", put_timeout_ms);
	return buf;
}

static int cmd_stat(const struct shell *sh, size_t argc, char **argv)
{
	char timeout[24];
	char state[32];

	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	shell_print(sh, "queue      %u of %d used, %ld at most, %u bytes a reading",
		    k_msgq_num_used_get(&readings), QUEUE_LEN, atomic_get(&peak_used),
		    (unsigned int)sizeof(struct reading));
	shell_print(sh, "sensor     priority %d, every %u ms, puts with %s, %s",
		    k_thread_priority_get(sensor), period_ms,
		    timeout_name(timeout, sizeof(timeout)),
		    k_thread_state_str(sensor, state, sizeof(state)));
	shell_print(sh, "consumer   priority %d, %u ms a reading, %s",
		    k_thread_priority_get(consumer), work_ms,
		    k_thread_state_str(consumer, state, sizeof(state)));
	shell_print(sh, "policy     %s", drop_oldest ? "drop-oldest" : "keep");
	shell_print(sh, "delivered  %ld, %ld of them handed straight over",
		    atomic_get(&delivered), atomic_get(&handoffs));
	shell_print(sh, "sensor     %ld dropped, %ld waited (%ld ms), %ld purged",
		    atomic_get(&dropped), atomic_get(&waited_puts), atomic_get(&waited_ms),
		    atomic_get(&purged_waiters));
	shell_print(sh, "ticks      %ld lost", atomic_get(&ticks_lost));
	shell_print(sh, "alarms     %ld raised, %ld lost, %ld readings evicted for them",
		    atomic_get(&alarms_seen), atomic_get(&alarms_lost), atomic_get(&evicted));
	if (atomic_get(&alarms_seen) > 0) {
		shell_print(sh, "           the last one came from %s and %s",
			    alarm_in_isr ? "SW0's interrupt" : "a thread",
			    alarm_err == 0 ? "got in" : "was lost");
	}
	return 0;
}

static int cmd_timeout(const struct shell *sh, size_t argc, char **argv)
{
	char timeout[24];

	ARG_UNUSED(argc);

	if (strcmp(argv[1], "none") == 0) {
		put_timeout_ms = 0;
	} else if (strcmp(argv[1], "forever") == 0) {
		put_timeout_ms = -1;
	} else {
		int err = 0;
		unsigned long ms = shell_strtoul(argv[1], 10, &err);

		if (err != 0 || ms == 0 || ms > INT32_MAX) {
			shell_error(sh, "Give none, forever, or a number of milliseconds");
			return -EINVAL;
		}
		put_timeout_ms = (int32_t)ms;
	}

	shell_print(sh, "The sensor now puts with %s", timeout_name(timeout, sizeof(timeout)));
	return 0;
}

static int parse_ms(const struct shell *sh, const char *arg, uint32_t min, uint32_t *ms)
{
	int err = 0;
	unsigned long value = shell_strtoul(arg, 10, &err);

	if (err != 0 || value < min || value > 60000) {
		shell_error(sh, "Give a number of milliseconds from %u to 60000", min);
		return -EINVAL;
	}
	*ms = (uint32_t)value;
	return 0;
}

static int cmd_work(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);

	if (parse_ms(sh, argv[1], 0, &work_ms) != 0) {
		return -EINVAL;
	}
	shell_print(sh, "The consumer now spends %u ms on each reading", work_ms);
	return 0;
}

static int cmd_period(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);

	if (parse_ms(sh, argv[1], 10, &period_ms) != 0) {
		return -EINVAL;
	}
	shell_print(sh, "The sensor now makes a reading every %u ms", period_ms);
	return 0;
}

static int cmd_prio(const struct shell *sh, size_t argc, char **argv)
{
	int err = 0;
	long prio = shell_strtol(argv[1], 10, &err);

	ARG_UNUSED(argc);

	if (err != 0 || prio < K_HIGHEST_APPLICATION_THREAD_PRIO ||
	    prio > K_LOWEST_APPLICATION_THREAD_PRIO) {
		shell_error(sh, "Give a priority from %d to %d", K_HIGHEST_APPLICATION_THREAD_PRIO,
			    K_LOWEST_APPLICATION_THREAD_PRIO);
		return -EINVAL;
	}

	k_thread_priority_set(consumer, (int)prio);
	shell_print(sh, "The consumer now runs at priority %ld, the sensor at %d. "
		    "The lower number runs first.", prio, k_thread_priority_get(sensor));
	return 0;
}

static int cmd_consumer_suspend(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	k_thread_suspend(consumer);
	shell_print(sh, "The consumer is suspended: nothing takes readings out");
	return 0;
}

static int cmd_consumer_resume(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	k_thread_resume(consumer);
	shell_print(sh, "The consumer is running again");
	return 0;
}

static int cmd_purge(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	k_msgq_purge(&readings);
	shell_print(sh, "Purged: the queue is empty, and a put that was waiting got -ENOMSG");
	return 0;
}

static int cmd_policy_keep(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	drop_oldest = false;
	shell_print(sh, "Policy keep: an alarm that finds the queue full is lost");
	return 0;
}

static int cmd_policy_drop_oldest(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	drop_oldest = true;
	shell_print(sh, "Policy drop-oldest: an alarm throws the oldest reading out of a "
		    "full queue");
	return 0;
}

static int cmd_alarm(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	raise_alarm();
	if (alarm_err == 0) {
		shell_print(sh, "Alarm raised: it is next in line");
	} else {
		shell_print(sh, "Alarm lost: the queue is full");
	}
	return 0;
}

static int cmd_verbose_on(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	verbose = true;
	shell_print(sh, "The consumer now logs every reading it takes");
	return 0;
}

static int cmd_verbose_off(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	verbose = false;
	shell_print(sh, "The consumer now logs alarms only");
	return 0;
}

static int cmd_reset(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	put_timeout_ms = 0;
	period_ms = DEFAULT_PERIOD_MS;
	work_ms = DEFAULT_WORK_MS;
	drop_oldest = false;
	verbose = false;
	k_msgq_purge(&readings);

	atomic_clear(&delivered);
	atomic_clear(&handoffs);
	atomic_clear(&dropped);
	atomic_clear(&waited_puts);
	atomic_clear(&waited_ms);
	atomic_clear(&purged_waiters);
	atomic_clear(&ticks_lost);
	atomic_clear(&alarms_seen);
	atomic_clear(&alarms_lost);
	atomic_clear(&evicted);
	atomic_clear(&peak_used);

	k_thread_priority_set(consumer, CONSUMER_PRIO);
	k_thread_resume(consumer);
	shell_print(sh, "Back to the start: an empty queue, default settings, counters at zero");
	return 0;
}

SHELL_STATIC_SUBCMD_SET_CREATE(consumer_cmds,
	SHELL_CMD(suspend, NULL, "Stop the consumer taking readings out", cmd_consumer_suspend),
	SHELL_CMD(resume, NULL, "Let it run again", cmd_consumer_resume),
	SHELL_SUBCMD_SET_END);

SHELL_STATIC_SUBCMD_SET_CREATE(policy_cmds,
	SHELL_CMD(keep, NULL, "An alarm that finds the queue full is lost", cmd_policy_keep),
	SHELL_CMD(drop-oldest, NULL, "An alarm throws the oldest reading out of a full queue",
		  cmd_policy_drop_oldest),
	SHELL_SUBCMD_SET_END);

SHELL_STATIC_SUBCMD_SET_CREATE(verbose_cmds,
	SHELL_CMD(on, NULL, "Log every reading the consumer takes", cmd_verbose_on),
	SHELL_CMD(off, NULL, "Log alarms only", cmd_verbose_off),
	SHELL_SUBCMD_SET_END);

SHELL_STATIC_SUBCMD_SET_CREATE(msgq_cmds,
	SHELL_CMD_ARG(stat, NULL, "Show the queue, the settings and the counters", cmd_stat, 1,
		      0),
	SHELL_CMD_ARG(timeout, NULL, "<none|forever|ms>  How long the sensor's put may wait",
		      cmd_timeout, 2, 0),
	SHELL_CMD_ARG(work, NULL, "<ms>  Time the consumer spends on each reading", cmd_work, 2,
		      0),
	SHELL_CMD_ARG(period, NULL, "<ms>  Time between two sensor readings", cmd_period, 2, 0),
	SHELL_CMD_ARG(prio, NULL, "<n>  The consumer's priority (the sensor's is 6)", cmd_prio, 2,
		      0),
	SHELL_CMD(consumer, &consumer_cmds, "Suspend or resume the consumer", NULL),
	SHELL_CMD_ARG(purge, NULL, "Empty the queue with k_msgq_purge()", cmd_purge, 1, 0),
	SHELL_CMD(policy, &policy_cmds, "What an alarm does about a full queue", NULL),
	SHELL_CMD_ARG(alarm, NULL, "Raise an alarm from this thread, as SW0 does from its "
		      "interrupt", cmd_alarm, 1, 0),
	SHELL_CMD(verbose, &verbose_cmds, "Log every reading, or alarms only", NULL),
	SHELL_CMD_ARG(reset, NULL, "Defaults, an empty queue and zeroed counters", cmd_reset, 1,
		      0),
	SHELL_SUBCMD_SET_END);

SHELL_CMD_REGISTER(msgq, &msgq_cmds, "The message queue lab", NULL);
