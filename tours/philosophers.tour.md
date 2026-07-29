---
tour: Dining Philosophers, from the scheduler's side
sample: samples/philosophers
---

Six threads, six forks, and a rule about which one to pick up first. The
terminal shows the philosophers' own account of what is happening; this tour
shows the kernel's, read straight out of guest memory. None of it is printed by
the sample, and none of it could be: a thread cannot describe the run queue it
is currently on.

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

The first of the six times the sample calls `k_thread_create()`. Its arguments
are read out of the registers the ABI passes them in, which is why this reads
the same on AArch64 and on RISC-V.

`k_thread_create` is *handed* a stack and its size rather than allocating one:
thread stacks are link-time objects and cannot grow. All six are created
`K_FOREVER` — nothing runs until `k_thread_start()`.

## Dijkstra's rule, in five lines

```tour
at: main.c:/if \(is_last_philosopher/ | main.c:151
when: first
highlight: /Dijkstra/ + 7
```

Two forks each, six forks total: "left first, then right" deadlocks the moment
all six philosophers hold their left one.

The fix is the classic one — **always take the lower-numbered fork first**. Five
philosophers do the obvious thing, the last one swaps its order, and that single
asymmetry makes a cycle of waiters impossible. No timeout, no arbiter.

## A fork is a mutex, and here are all six

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

The fork this philosopher asked for is highlighted below, next to the other
five. Nobody told the page where they are: `CONFIG_OBJ_CORE` links every mutex
onto a list the debugger walks, and the build's own DWARF says where `owner`
sits inside one.

A null owner means the fork is on the table. `owner_orig_prio` — one word past
the lock count — is the whole of priority inheritance: where the kernel parks a
holder's real priority while it lends it the waiter's.

## Waiting is not spinning

```tour
at: main.c:/EATING/ | main.c:168
when: hits == 6
threads: yes
objects: mutex
```

Six meals in, and two of the forks now name their owner — the philosopher
stopped here, holding both while it eats.

Anyone who wants one of those two does not spin waiting for it. The kernel takes
that thread off the run queue and parks it on the wait queue *inside the mutex*,
where it costs nothing; whoever unlocks hands the fork straight to the
highest-priority waiter. Watch a philosopher go **pending** in the list below as
the rounds go on.

## Eating is a sleep, and sleeping is scheduling

```tour
at: main.c:/EATING/ | main.c:168
when: hits == 8
stop: no
watch:
  - stopped in = $pc as code
```

Eight meals later, and this time without stopping the machine: `stop: no` puts
the card up and lets the guest run on, so the terminal keeps scrolling
underneath it.

Note the condition — `hits == 8`, not `hits % 8 == 0`. A step that keeps its
breakpoint alive on a line this hot goes on costing a trap per pass for the rest
of the run; this one fires once and lifts it. That is the whole demo: six
threads taking turns being blocked, and a scheduler deciding who is next.
