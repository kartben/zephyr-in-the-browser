---
tour: "Sensor pipeline, part 3: sharing the bus"
sample: samples/subsys/tracing/pipeline
---

After each frame, the aggregator writes a summary to a bus it shares with the
storage thread. This tour is about what happens when the highest-priority
thread in the app has to wait for the lowest.

## The bus is taken

```tour
at: main.c:/BUS_LOCK\(\);/ | main.c:186
when:
  - k_mutex(bus_mutex).owner as ptr == _k_thread_obj_storage_thread
  - first
objects:
  type: mutex
  focus: bus_mutex
```

After publishing a frame, the aggregator writes a summary to a bus it shares
with the `storage` thread, and `bus_mutex` guards it. The mutex list shows
who holds it now: `storage`, the lowest-priority thread in the app (its base
priority is 9), which keeps the bus for 12 ms at a time while it flushes.

The aggregator, at priority 3, is about to call `k_mutex_lock()`. It will
have to wait.

## Storage runs at priority 3

```tour
at: main.c:/"store_end"/ | main.c:282
when:
  - _thread_base(k_thread(_k_thread_obj_aggregator_thread).base).pended_on as ptr == bus_mutex
  - first
highlight: /"store_end"/ + 1
threads: yes
```

`storage` has finished its flush and is about to unlock the bus. The thread
list shows it at priority 3, not 9: while the aggregator waits on
`bus_mutex`, the kernel lends the mutex's owner the waiter's priority. This
is **priority inheritance**, and every `k_mutex` does it.

That way, nothing below priority 3 can run ahead of `storage` while the
aggregator waits for it.

## Back to priority 9

```tour
at: main.c:/"bus_write"/ | main.c:187
when: first
highlight: /BUS_LOCK\(\);/
threads: yes
```

`storage` unlocked the bus and dropped back to priority 9, and the
aggregator got the bus straight away. Its wait lasted only as long as
`storage` needed to finish.

## What you saw

A mutex knows which thread owns it. When a higher-priority thread waits on
it, the kernel raises the owner to that priority until it unlocks, so the
wait for a slow, low-priority owner lasts no longer than the owner's own
work.
