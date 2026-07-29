---
tour: Dining Philosophers, from the scheduler's side
sample: samples/philosophers
---

Six threads, six forks, and a rule about which one to pick up first. The
terminal shows what the philosophers think is happening. This shows what the
kernel is doing underneath: which threads exist, which of them are blocked, and
who is holding what.

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

The first of the six `k_thread_create()` calls, caught inside the kernel. Each
philosopher is one thread running the same function, told apart only by the
argument it is passed.

Zephyr does not allocate the stack for you: `k_thread_create()` is *handed* one,
declared at build time with `K_THREAD_STACK_ARRAY_DEFINE`. Two kilobytes each
here, decided when the image was linked, and it cannot grow later.

All six are created `K_FOREVER`, which means "do not schedule this yet". They
sit there until `k_thread_start()` releases them a few lines further down.

## Dijkstra's rule, in five lines

```tour
at: main.c:/if \(is_last_philosopher/ | main.c:151
when: first
highlight: /Dijkstra/ + 7
```

Each philosopher needs two forks and there are only six, so the obvious order —
"take the one on my left, then the one on my right" — deadlocks the moment all
six are holding their left fork. Everyone waits for a neighbour, forever.

The fix is the classic one: **always take the lower-numbered fork first**. Five
philosophers do the obvious thing, the last one swaps its order, and that single
asymmetry makes a cycle of waiters impossible. No timeout, no retry, no arbiter.

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

Every fork in this sample is a `k_mutex`, and here they all are — the one this
philosopher is reaching for is picked out.

A mutex is a small thing: which thread owns it, how many times that thread has
locked it (locking one you already hold just counts up), and a queue of whoever
is waiting. No owner means the fork is on the table.

The fourth field is `owner_orig_prio`, and it is the whole of priority
inheritance. If a low-priority philosopher holds a fork that a high-priority one
wants, the kernel temporarily raises the holder so it can finish and let go —
and that field is where it remembers what to put back afterwards.

## Waiting is not spinning

```tour
at: main.c:/EATING/ | main.c:168
when: hits == 6
threads: yes
objects: mutex
```

Six meals in, and two forks now name their owner: the philosopher stopped here,
holding both while it eats.

Anyone who wants one of those two does not sit in a loop checking. The kernel
takes that thread off the run queue entirely and parks it on a queue inside the
mutex itself, where it costs nothing at all — no CPU, no timer, no polling. When
the fork is dropped, ownership passes straight to the highest-priority thread
waiting for it.

That is why this sample is a good test of a scheduler rather than of a CPU. The
philosophers spend nearly all their time asleep or blocked, and everything
interesting happens in the handovers.

## Eating is a sleep, and sleeping is scheduling

```tour
at: main.c:/EATING/ | main.c:168
when: hits == 8
stop: no
watch:
  - in = $pc as code
```

`k_msleep()` again, this time with two forks held. The philosopher is asleep,
its neighbours are blocked on the forks it is holding, and the kernel is free to
run whoever else is ready.

And that is the whole demo: six threads taking turns being blocked, and a
scheduler deciding who goes next.
