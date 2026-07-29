---
tour: Dining Philosophers: threads and mutexes
sample: samples/philosophers
---

This **sample** runs six **threads** (the philosophers) that share six forks.

Read the story in the **terminal**. On each stop, use the thread list and mutex
objects in **Debug** to see who is ready, who is blocked, and which fork (mutex)
each thread holds.

## Six threads, created and then started

```tour
at: z_impl_k_thread_create
when: first
threads: yes
watch:
  - new thread = $arg0 as addr
  - stack area = $arg1 as addr
  - stack size = $arg2 as dec
  - entry point = $arg3 as code
```

You are stopped inside the first `k_thread_create()`. Each philosopher is one
**thread** with the same entry function; the argument identifies which
philosopher it is.

Zephyr does not allocate the stack for you: the sample passes a stack from
`K_THREAD_STACK_ARRAY_DEFINE` (2 KB each here, fixed at link time).

These threads are created with `K_FOREVER`, so they are not schedulable until
`k_thread_start()` runs a few lines later. Watch them appear in the thread list
as they are created.

## Dijkstra's rule, in five lines

```tour
at: main.c:/if \(is_last_philosopher/ | main.c:151
when: first
highlight: /Dijkstra/ + 7
```

Each philosopher needs two forks and there are only six, so the obvious order —
“take the one on my left, then the one on my right” — deadlocks: everyone waits
forever for a neighbour.

The fix is classic: **always take the lower-numbered fork first**. Five
philosophers do the obvious thing, the last one swaps its order, and that single
asymmetry makes a cycle of waiters impossible. No timeout, no retry, no arbiter.

The highlighted block is the asymmetry — only the last philosopher swaps fork
order.

## A fork is a mutex

```tour
at: z_impl_k_mutex_lock
when: first
objects:
  type: mutex
  focus: $arg0
watch:
  - fork wanted = $arg0 as addr
  - owner = $arg0+2p as ptr
  - lock count = $arg0+3p as u32
```

Each fork is a `k_mutex`. The stop focuses the mutex this philosopher is locking
— see its owner and waiters in **Debug**.

A mutex tracks which **thread** owns it, how many times that thread has locked
it (locking one you already hold just counts up), and who is waiting. No owner
means the fork is free.

If a low-priority holder blocks a higher-priority waiter, the kernel can
temporarily raise the holder’s priority (**priority inheritance**) so it can
unlock sooner. You do not need the internal field names to use `k_mutex_lock()`.

## Waiting is not spinning

```tour
at: main.c:/EATING/ | main.c:168
when: hits == 6
threads: yes
objects: mutex
```

After several meals, this philosopher holds both forks while eating — those two
mutexes name it as owner.

A waiter does **not** spin-poll. The **kernel** blocks that **thread** (off the
run queue) on the mutex’s wait queue until the owner unlocks; then ownership can
pass to a waiting thread.

In the thread list, look for blocked philosophers; in the **terminal**, match
that to the “hungry” / “eating” lines.

## Eating is a sleep, and sleeping is scheduling

```tour
at: main.c:/EATING/ | main.c:168
when: hits == 8
stop: no
watch:
  - in = $pc as code
```

`k_msleep()` runs while this thread still holds both forks. Neighbours that need
those forks stay blocked; the kernel runs whoever else is ready.

That is the sample in one picture: threads alternate running, sleeping, and
blocking on **mutexes**, and the kernel’s scheduler chooses the next ready
thread.
