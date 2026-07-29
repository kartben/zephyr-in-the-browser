---
tour: Dining Philosophers, from the scheduler's side
sample: samples/philosophers
---

Six threads, six forks, and a rule about which one to pick up first. The
terminal shows the philosophers' own account of what is happening; this tour
shows the kernel's.

Every step breaks in a different place — one in the sample, one in the mutex
implementation, one in the scheduler — and reads the kernel objects involved
directly out of guest memory. None of it is printed by the sample, and none of
it could be: a thread cannot describe the run queue it is currently on.

## Six threads, created and then started

```tour
at: z_impl_k_thread_create
when: first
threads: yes
watch:
  - new thread = $arg0 as addr
  - stack area = $arg1 as addr
  - stack size = $arg2 as u32
  - entry point = $arg3 as code
```

The machine is stopped inside the kernel, at the top of the function
`k_thread_create()` resolves to, the first of the six times the sample calls it.
The thread list below is still short — `main` and the kernel's own threads. Six
more are about to join it.

The arguments are read straight out of the registers the ABI passes them in,
which is why this step reads the same on AArch64 and on RISC-V: `$arg0` is
whichever register this guest's calling convention uses. They are only
trustworthy here, at the function's first line, before the compiler starts
reusing them.

`k_thread_create` is handed a stack *area* and its size rather than allocating
one: thread stacks in Zephyr are objects with static storage, declared by
`K_THREAD_STACK_ARRAY_DEFINE` in this sample, so their footprint is decided at
link time and cannot grow.

The threads are created `K_FOREVER`, which means "do not schedule this yet". The
`k_thread_start()` a few lines down is what actually releases each one.

## Dijkstra's rule, in five lines

```tour
at: main.c:/if \(is_last_philosopher/
when: first
```

Each philosopher needs two forks and there are only six, so the naive order —
"take the one on my left, then the one on my right" — deadlocks the moment all
six are holding their left fork.

The fix is the classic one: **always take the lower-numbered fork first.** Five
philosophers do the obvious thing; the last one swaps its order, and that single
asymmetry is what makes a cycle of waiters impossible. There is no timeout, no
retry and no arbiter, and the code that implements it is the `if` under the
cursor.

## A fork is a mutex, and this is what one looks like

```tour
at: z_impl_k_mutex_lock
when: first
watch:
  - fork = $arg0 as addr
  - owner = *($arg0+2p) as ptr
  - lock count = $arg0+3p as u32
memory:
  at: $arg0
  len: 32
  mark: 2p..3p
  note: owner — the thread currently holding this fork
```

The breakpoint is inside the kernel, on the function `k_mutex_lock()` resolves
to. The fork the philosopher asked for is in the first argument register, and
above is the whole object: a wait queue, an owner pointer, a lock count and the
owner's original priority.

That last pair is priority inheritance. If a low-priority philosopher holds a
fork a high-priority one wants, the kernel temporarily raises the holder to the
waiter's priority so it can finish and let go — and `owner_orig_prio` is where
it remembers what to put back. It is four words in RAM, and it is the entire
mechanism.

A null owner means the fork is on the table. Continue a few times and watch it
change.

## Waiting is not spinning

```tour
at: z_impl_k_mutex_lock
when: hits % 12 == 0
repeat: yes
threads: yes
```

Twelve fork-takes later, and now the thread list is the interesting part.

Some philosophers are *pending* — blocked on a mutex, off the run queue
entirely, costing nothing. One is *ready* or running. No thread is looping to
check whether its fork became free; the kernel put each waiter on the wait queue
inside the mutex it wanted, and whoever unlocks that mutex hands it straight to
the highest-priority waiter.

That is why this sample is a fair test of a scheduler rather than of a CPU. The
philosophers spend almost all their time asleep or blocked, and everything
interesting happens in the transitions.

## Eating is a sleep, and sleeping is scheduling

```tour
at: main.c:/EATING/
when: hits % 6 == 0
repeat: yes
stop: no
threads: yes
```

`k_msleep(delay)` — the philosopher holding two forks now yields the CPU for a
random interval while it "eats". It is asleep, holding both forks, and everyone
adjacent to it is blocked on one of them.

This step does not stop the machine (`stop: no`), so the terminal keeps
scrolling underneath the card while the thread list updates. The whole demo is
this: six threads taking turns being blocked, and a scheduler deciding who is
next.
