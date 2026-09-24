---
tour: Dining Philosophers: threads and the scheduler
sample: samples/philosophers
---

Six **threads** share six forks. Each fork is a `k_mutex`.

The **terminal** prints each thread's state (STARVING, HOLDING ONE FORK, EATING,
THINKING). Prefer **Philosophers · traced** so **Trace → Timeline** can show which
thread is running, ready, sleeping, or blocked.

## Creating the threads

```tour
at: z_impl_k_thread_create
when: first
threads: yes
watch:
  - new thread = $arg0 as addr
```

First `k_thread_create()`. Each philosopher is one **thread** with the same entry
function; the argument is its id.

Created with `K_FOREVER`, so they are not ready until `k_thread_start()`. Watch
them appear in the thread list.

## Fork order that does not deadlock

```tour
at: main.c:/if \(is_last_philosopher/ | main.c:151
when: first
highlight: /is_last_philosopher/
```

Each thread needs two forks. The same left-then-right order for everyone can
deadlock: every thread holds one fork and waits for the next.

This sample always takes the lower-numbered fork first. Five threads take
`id` then `id+1`; the last one swaps. That way they cannot all wait on each
other.

## Taking a mutex

```tour
at: z_impl_k_mutex_lock
when: first
objects:
  type: mutex
  focus: $arg0
```

`k_mutex_lock()` on one fork. The card focuses that mutex; owner and waiters are
in **Debug**.

If it is free, this thread becomes the owner. If another thread holds it, this
one blocks until unlock.

## When a thread blocks

```tour
at: main.c:/EATING/ | main.c:168
when: hits == 6
threads: yes
objects: mutex
panel: trace
```

This thread holds both forks while eating. Threads that need those mutexes are
blocked, not spinning in a loop.

Open **Trace → Timeline**: blocked time shows on those lanes. Match it to
STARVING / HOLDING ONE FORK in the **terminal**.

## Sleep and the scheduler

```tour
at: main.c:/EATING/ | main.c:168
when: hits == 8
stop: no
panel: trace
```

`k_msleep()` while still holding both forks. This thread leaves the ready set;
the **kernel** runs another ready thread.

Keep **Trace → Timeline** open as the guest continues. Context switches and sleep
intervals are the scheduler on screen.
