---
tour: Dining Philosophers: threads, mutexes, scheduling
sample: samples/philosophers
---

This **sample** runs six **threads** (the philosophers) that share six forks.

Read the story in the **terminal**. Pick this sample’s traced build and **Trace**
shows what the **kernel** is doing underneath: which thread runs, which ones
wait, and what changes that.

## Six threads, created and then started

```tour
at: z_impl_k_thread_create
when: first
threads: yes
watch:
  - stack size = $arg2 as dec
  - entry point = $arg3 as code
```

You are stopped inside the first `k_thread_create()`. Each philosopher is one
**thread** running the same entry function, told apart by the argument it is
passed.

Zephyr does not allocate the stack for you: the sample passes one from
`K_THREAD_STACK_ARRAY_DEFINE`, 2 KB each here and fixed at link time.

All six are created with `K_FOREVER`, so none of them is schedulable until
`k_thread_start()` runs a few lines later. Watch the thread list fill up.

## Dijkstra’s rule, in five lines

```tour
at: main.c:/if \(is_last_philosopher/ | main.c:151
when: first
highlight: /Dijkstra/ + 7
```

Each philosopher needs two forks and there are only six. Taking your left fork
first deadlocks: all six end up holding one fork, waiting forever for a
neighbour.

The fix is classic: **always take the lower-numbered fork first**. Five
philosophers do the obvious thing, the last one swaps its order, and that single
asymmetry makes a cycle of waiters impossible. No timeout, no retry, no arbiter.

## A fork is a mutex

```tour
at: z_impl_k_mutex_lock
when: first
objects:
  type: mutex
  focus: $arg0
```

Each fork is a `k_mutex`. This stop picks out the one being locked; the other
five are listed beside it in **Debug**.

A **mutex** tracks which thread owns it, how many times that thread has locked
it (locking one you already hold just counts up), and who is waiting. No owner
means the fork is free.

If a low-priority holder blocks a higher-priority waiter, the kernel raises the
holder to the waiter’s priority until it unlocks (**priority inheritance**).
Without that, a mid-priority thread could keep the holder off the CPU, and the
higher-priority thread would wait behind it.

## Waiting is not spinning

```tour
at: main.c:/EATING/ | main.c:168
when: hits == 6
trace: yes
```

**Trace** draws one lane per thread from Zephyr’s own tracing, coloured by
state: green while it runs, yellow while it is ready, red while it is blocked on
a fork, cyan while it sleeps.

Only one lane is green at a time, because this board has one core. A blocked
philosopher has no green at all: it is not polling and not on a timer. The kernel
took that **thread** off the run queue and onto the wait queue inside the mutex,
where it uses no CPU.

## What a handover looks like

```tour
at: main.c:/EATING/ | main.c:168
when: hits == 8
trace: yes
stop: no
```

The guest keeps running through this step, so the lanes grow while you read. A
cyan stretch is `k_msleep()`: this philosopher holds both forks while it eats, so
its neighbours stay red until it drops them.

Watch a red lane turn green. When a fork is unlocked, ownership passes to the
highest-priority thread waiting for it, and that thread runs as soon as the
scheduler picks it. That is the sample in one picture: threads alternate running,
sleeping, and blocking on **mutexes**, and the scheduler chooses who goes next.
