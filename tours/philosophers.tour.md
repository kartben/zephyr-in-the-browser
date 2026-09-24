---
tour: Dining Philosophers: threads, priorities and mutexes
sample: samples/philosophers
---

Six philosophers sit around a table with six forks, one between each pair.
Each philosopher is a **thread**, and each fork is a **mutex**. To eat, a
philosopher needs both of its forks.

The **terminal** has one row per philosopher. Each row cycles through
`STARVING`, `HOLDING ONE FORK`, `EATING`, `DROPPED ONE FORK`, `THINKING`.
The tag in brackets shows how the thread is scheduled: `P` means preemptible,
`C` means cooperative, and the number is its priority.

This tour pauses the sample at six moments while it starts up.

## One function, six threads

```tour
at: z_impl_k_thread_create
when: first
threads: yes
watch:
  - entry point = $arg3 as code
  - stack size = $arg2 as dec
```

This is the first `k_thread_create()` call, inside the kernel. All six
philosophers run the same entry function, `philosopher()`. The only
difference between them is the id passed in as an argument.

Zephyr doesn't allocate a thread's stack for you. This sample reserves six
2 KB stacks at build time with `K_THREAD_STACK_ARRAY_DEFINE`, and passes one
in here.

The thread list only has `main` and `idle` so far. Each thread is created with
`K_FOREVER`, so it waits for `k_thread_start()`, which comes right after.

## Started last, runs first

```tour
at: main.c:/STARVING/ | main.c:162
when: first
threads: yes
```

`main` started philosophers 0 to 3 first, yet philosopher **4** is the first
to run, and it's about to print its first `STARVING` line. It has priority -1, and in Zephyr a lower number means a higher
priority. `main` is priority 0, so starting philosopher 4 preempts `main`
straight away. Philosophers 0 to 3 have priorities 3 to 0 and wait in the
list as *ready*.

A negative priority makes a thread **cooperative** (`C` in the terminal). No
other thread can preempt it. It keeps the CPU until it sleeps, blocks or
yields. Preemptible threads (`P`) give up the CPU as soon as a
higher-priority thread is ready.

## Dijkstra's rule: lowest fork first

```tour
at: philosopher
when: first
watch:
  - philosopher = $arg0 as dec
highlight: /Dijkstra/ + 7
```

Philosopher 4 took its forks and is now asleep, eating. `main` started the
last philosopher, number 5, and it's running now.

If every philosopher picked up the left fork and then the right, all six could
hold one fork and wait for the next one forever. That's a **deadlock**. The
fix is to always pick up the lower-numbered fork first. Philosopher 5 needs
forks 5 and 0, so it's the only one that swaps the order. That one exception
makes a circle of waiting threads impossible.

## Asking for a fork someone else holds

```tour
at: main.c:/take\(my_fork2\)/ | main.c:165
when: first
objects: mutex
threads: yes
```

Philosopher 5 got fork 0 without waiting, and its terminal row now says
`HOLDING ONE FORK`. Next it asks for fork 5. In the mutex list,
`fork_objs[5]` belongs to **Philosopher 4**, which is still eating.

`k_mutex_lock(fork, K_FOREVER)` won't return until the fork is free, and the
waiting thread doesn't spin on the CPU. The kernel takes philosopher 5 off
the run queue and puts it in this mutex's wait queue. When philosopher 4
calls `k_mutex_unlock()`, the kernel gives the mutex to the waiting thread.

## Priority inheritance, caught in the act

```tour
at: z_thread_prio_set
when: first
threads: yes
```

Philosopher 5 (priority -2) is now waiting on philosopher 4 (priority -1).
If a medium-priority thread got in the way, the high-priority thread would be
stuck behind a low-priority one. That's called **priority inversion**. To
prevent it, the kernel lends philosopher 4 the waiter's priority, -2, until it
unlocks the fork. That happens right here: the thread list still shows -1,
because the change is about to be made.

You didn't have to ask for this. Every `k_mutex` does it.

## The whole table, mid-meal

```tour
at: main.c:/k_msleep\(delay\)/ | main.c:169
when: first
threads: yes
objects: mutex
```

A philosopher has both its forks and is about to sleep with `k_msleep()`
for its meal. It keeps holding both mutexes while it sleeps, so its
neighbours stay blocked, and the scheduler runs the next ready thread.

This is the whole sample in one picture. The thread list names the fork each
blocked philosopher is waiting on, and the mutex list shows who holds it. On
the terminal, those are the rows stuck at `STARVING` or `HOLDING ONE FORK`.
After you continue, **Debug → Objects** keeps this view up to date while the
sample runs.
