---
tour: "Message queues, part 1: the ring"
sample: samples/kernel/msg_queue
sources:
  - kernel/msg_q.c
---

This is Zephyr's message queue sample: one producer thread, one consumer
thread and a queue between them. The producer sends nine one-character
messages, two normal ones and then an urgent one, three times over. Urgent
messages jump the queue with `k_msgq_put_front()`. The consumer starts only
once all nine are in, reads them, and prints them in the order it got them.

This tour stops the sample six times to look inside the queue: a ring of
slots, a read pointer and a write pointer.

## A queue is ten slots and two pointers

```tour
at: main.c:/k_msgq_put\(&my_msgq/ | main.c:30
when: first
highlight: /K_MSGQ_DEFINE/
objects:
  type: msgq
  focus: my_msgq
```

The producer is about to send its first message. It sends one every 100 ms:
two normal ones, then an urgent one, three times over. The consumer reads
them only once all nine are in.

`K_MSGQ_DEFINE` set the queue up at build time: ten one-byte slots
(`sizeof(char)`), drawn here as a strip, and the `struct k_msgq` that keeps
track of them. Its `read_ptr` (R) points at the next message out, its
`write_ptr` (W) at the next free slot, and `used_msgs` counts the messages.
R and W both start on slot 0.

A message queue copies. `k_msgq_put()` copies one message from
`&normal_data` into the slot at W, so the producer can change `normal_data`
again as soon as the call returns.

## An urgent message goes in front

```tour
at: msg_q.c:/if \(slot == msgq->buffer_start\)/ | z_impl_k_msgq_put_front
when: first
highlight: /slot = msgq->read_ptr;/ + 5
watch:
  - read_ptr = k_msgq(my_msgq).read_ptr as ptr
  - buffer_start = k_msgq(my_msgq).buffer_start as ptr
objects:
  type: msgq
  focus: my_msgq
```

Two messages are in, `'0'` in slot 0 and `'1'` in slot 1: each
`k_msgq_put()` copied into the slot at W and moved W on. Now the producer
has called `k_msgq_put_front()` with the urgent `'A'`, and this stop is
inside the kernel.

A message put at the front has to come out before the one at R, so the
kernel moves R back one slot and copies the message there. But R is on
slot 0, and there is no slot before it: `read_ptr` equals `buffer_start`. So
the kernel jumps to `buffer_end` and steps back from there.

## `'A'` lands in the last slot

```tour
at: main.c:/urgent_data\+\+/ | main.c:37
when: first
highlight: /k_msgq_put_front\(&my_msgq/
objects:
  type: msgq
  focus: my_msgq
```

`'A'` went into slot 9, the last one, and R is on it. The strip numbers the
messages in the order they will come out: `'A'` first, then `'0'` and `'1'`.

So where a message sits in the buffer is not its place in line. The buffer
is a ring: a pointer moving forward off the last slot wraps to slot 0, and R
stepping back from slot 0 wraps to the last slot. Messages come out from R
onward, round the ring.

## Nine messages, and the order they come out

```tour
at: main.c:/k_thread_start/ | main.c:48
highlight: /K_THREAD_DEFINE\(consumer_thread/ + 1
objects:
  type: msgq
  focus: my_msgq
threads: yes
look: trace.queues
```

All nine are in. The normal ones went in at W, in slots 0 to 5. Each urgent
one went in front of R, so `'C'`, `'B'` and `'A'` sit in slots 7, 8 and 9,
with R on `'C'`. Slot 6 is free, and W points at it.

Read from R and the order is **C B A 0 1 2 3 4 5**: the urgent messages
newest first, then the normal ones in the order they were sent. That is the
line the consumer will print.

The queue could fill because nobody was reading it. In the thread list,
`consumer_thread` has not run yet: `K_THREAD_DEFINE()` gave it a start delay
of `INACTIVE`, -1, which means forever, so it waits for this
`k_thread_start()`.

On the traced build, **Trace → Queues** draws the same picture: two routes
into `my_msgq`, put and put front, and none out of it.

## `K_NO_WAIT` is a timeout of zero ticks

```tour
at: msg_q.c:/^int z_impl_k_msgq_get\(/ | z_impl_k_msgq_get
when:
  - $arg0 == my_msgq
  - first
highlight:
  - /likely\(msgq->used_msgs > 0U\)/
  - /don't wait for a message to become available/ + 1
watch:
  - timeout = $arg2 as dec
```

The consumer is running, and its first `k_msgq_get()` has just entered the
kernel. Its timeout, `K_NO_WAIT`, arrives as the third argument: 0.

`K_NO_WAIT` is not a flag. A `k_timeout_t` holds a count of ticks, and
`K_NO_WAIT` is zero of them. `K_FOREVER` is -1.

The kernel looks at the timeout only when it has to. First it checks
`used_msgs`, and with nine messages waiting it takes the one at R. On an
empty queue it would reach `K_TIMEOUT_EQ()`, which compares tick counts:
zero ticks means returning `-ENOMSG` at once instead of waiting.

`k_msgq_put_front()` takes no timeout at all. It passes `K_NO_WAIT` itself,
so an urgent message never waits for room: on a full queue, it fails.

## Empty again, with the bytes still there

```tour
at: main.c:/received\[BUF_SIZE - 1\]/ | main.c:59
objects:
  type: msgq
  focus: my_msgq
memory:
  at: "*k_msgq(my_msgq).buffer_start"
  len: 10
```

The consumer took all nine. Each `k_msgq_get()` copied the message at R out
into `received[]` and moved R forward. R wrapped from slot 9 to slot 0 on
the way, and now sits on slot 6 with W.

When R and W point at the same slot, the queue is either empty or full, and
the pointers alone cannot tell which. `used_msgs` can: it is 0.

Taking a message does not erase it. Under the strip is the buffer itself,
slot 0 to slot 9: `012345`, the slot nobody used, then `CBA`. Every byte the
producer sent is still there. The slots are free all the same, and the next
puts would overwrite them.

Continue, and the consumer prints what it got.

## What you saw

A `k_msgq` is a fixed number of fixed-size slots, set aside at build time,
and every message is copied in and copied out. Two pointers and a count say
which slots hold messages: `k_msgq_put()` writes at W and moves it forward,
`k_msgq_get()` reads at R and moves it forward, and `k_msgq_put_front()`
moves R back. Both pointers wrap at the ends of the buffer, which is how the
urgent `'A'` could sit in the last slot and still come out first.

The terminal shows the consumer's line, `CBA012345`, the order the ring
predicted. `K_NO_WAIT` never mattered: the queue was never full for the
producer, nor empty for the consumer. The sample does not check what
`k_msgq_put()` and `k_msgq_get()` return, and with `K_NO_WAIT` that return
value is the only sign that a message did not make it.
