---
tour: "zbus: channels and observers"
sample: samples/subsys/zbus/hello_world
next: zbus.internals
---

This is zbus's Hello World sample. zbus, the Zephyr bus, lets threads share
data without knowing about each other: a thread publishes a message on a
**channel**, and zbus hands it on to the channel's **observers**.

The sample defines three channels. `acc_data_chan` carries an accelerometer
reading and has three observers, one of each main kind: a listener, a
subscriber and an async listener. `simple_chan` holds an `int` and accepts
only 0 to 9. `version_chan` holds a version number that nobody publishes.

```mermaid
flowchart LR
  main(["main<br/><small>thread, priority 5</small>"]) -- publish --> acc[("acc_data_chan<br/><small>struct acc_msg</small>")]
  acc --> foo{{"foo_lis<br/><small>listener</small>"}}
  acc --> bar[["bar_sub<br/><small>subscriber</small>"]]
  acc --> baz{{"baz_async_lis<br/><small>async listener</small>"}}
  bar --> sub(["subscriber_task_id<br/><small>thread, priority 3</small>"])
  baz --> wq(["sysworkq<br/><small>system work queue</small>"])
  class acc focus
```

`main()` publishes twice on `acc_data_chan`, a second apart, then tries two
values on `simple_chan`. This tour follows the first publish to each observer,
then watches `simple_chan` turn a value away.

## A channel holds a message

```tour
at: main.c:main/zbus_chan_pub\(&acc_data_chan, &acc1,/
highlight: /ZBUS_CHAN_DEFINE\(acc_data_chan/ + 7
memory:
  at: _zbus_message_acc_data_chan
  len: 12
  note: the channel's message, a struct acc_msg
```

`main()` is about to publish its first reading, x, y and z all 1.

`ZBUS_CHAN_DEFINE` gave `acc_data_chan` a `struct acc_msg` of its own, drawn
here, still all zeros. A channel keeps the last message published on it, and
any thread can read it at any time.

It also fixed the channel's observers at build time: the ones named in
`ZBUS_OBSERVERS()`. zbus tells them in the order they are written, `foo_lis`,
then `bar_sub`, then `baz_async_lis`.

## A listener runs inside the publish

```tour
at: listener_callback_example
highlight: /ZBUS_LISTENER_DEFINE\(foo_lis/
watch:
  - lock = k_sem(zbus_channel_data(_zbus_chan_data_acc_data_chan).sem).count as u32
memory:
  at: _zbus_message_acc_data_chan
  len: 12
  note: x, y and z, now 1
threads: main
```

`foo_lis` is first in the list, and it is a **listener**:
`ZBUS_LISTENER_DEFINE` gave it a callback, and zbus calls it as part of the
publish. The channel's message already holds the new reading.

The thread list shows `main` running. A listener runs in the publisher's
thread, inside `zbus_chan_pub()`, with the channel locked: the lock reads 0.
That is what makes `zbus_chan_const_msg()` safe here: it points at the
channel's own message, without a copy, and nobody can change that message
until the publish ends.

It also means a listener holds everyone up: the observers after it, and
`main()` itself. Keep listeners short, and never let one wait.

## A subscriber wakes with the channel

```tour
at: main.c:subscriber_task/zbus_chan_read\(&acc_data_chan/
when: first
highlight:
  - /while \(!zbus_sub_wait\(&bar_sub, &chan/
  - /ZBUS_SUBSCRIBER_DEFINE\(bar_sub/
watch:
  - lock = k_sem(zbus_channel_data(_zbus_chan_data_acc_data_chan).sem).count as u32
objects:
  type: msgq
  focus: _zbus_observer_queue_bar_sub
threads: main, subscriber_task_id
```

`bar_sub` is a **subscriber**. `ZBUS_SUBSCRIBER_DEFINE(bar_sub, 4)` gave it a
queue with four slots, drawn here, and the sample's `subscriber_task_id`
thread waits on that queue in `zbus_sub_wait()`.

What came through the queue is not the reading but the channel: rest the
pointer on `chan`, and it holds `acc_data_chan`'s address. The subscriber
learns which channel changed, and reads the message itself.

`subscriber_task_id` has priority 3, and `main` has 5. In Zephyr a lower
number is a higher priority, so as soon as zbus queued the channel, the
scheduler switched to the subscriber, in the middle of `main()`'s publish: the
thread list shows `main` ready, not running. The lock still reads 0, so the
`zbus_chan_read()` it is about to make waits until `main` has told everyone
and let go.

A subscriber reads whatever the channel holds when it gets there: if two
publishes come before it reads, it sees only the second. A **message
subscriber**, from `ZBUS_MSG_SUBSCRIBER_DEFINE`, gets its own copy of each
message instead.

## The async listener works on a copy

```tour
at: async_listener_callback_example
highlight: /ZBUS_ASYNC_LISTENER_DEFINE\(baz_async_lis/
watch:
  - lock = k_sem(zbus_channel_data(_zbus_chan_data_acc_data_chan).sem).count as u32
memory:
  at: $arg1
  len: 12
  note: the copy this callback reads
threads: main, subscriber_task_id, sysworkq
look:
  - trace.zbus
```

The last observer, `baz_async_lis`, is an **async listener**: a callback,
like a listener, but zbus runs it later, from a work queue. Here that is the
system work queue, whose thread `sysworkq` runs ahead of every other thread
here (priority -1).

zbus gave it its own copy of the message, drawn here. The callback reads the
copy, not the channel: the lock still reads 0, held by `main`, and this
callback never needs it. A later publish cannot change what it is reading,
either.

`main` is still in its publish, and the subscriber is still waiting for the
lock. On the traced build, **Trace → zbus** draws this moment at its right
edge: the publish still open on `acc_data_chan`, `foo_lis`'s callback done,
`bar_sub`'s thread woken and waiting in its read, and this callback running in
`sysworkq`.

## A validator turns a value away

```tour
at: simple_chan_validator
when: $arg0 as i32 == 15
highlight:
  - /\(\*simple >= 0\) && \(\*simple < 10\)/
  - /ZBUS_CHAN_DEFINE\(simple_chan/ + 6
watch:
  - value = $arg0 as i32
  - simple_chan holds = _zbus_message_simple_chan as i32
  - lock = k_sem(zbus_channel_data(_zbus_chan_data_simple_chan).sem).count as u32
```

Both publishes on `acc_data_chan` are done, and the terminal shows each
observer's line. Now `main()` publishes on `simple_chan`, whose
`ZBUS_CHAN_DEFINE` names a validator: `simple_chan_validator()` accepts 0 to 9.

The first value, 5, passed, and `simple_chan` still holds it. This stop is the
second try, 15. `zbus_chan_pub()` asks the validator before it takes the lock,
so the lock is free, nothing has been copied, and no observer will hear of
it. The validator returns `false`, and `zbus_chan_pub()` returns `-ENOMSG`.

## What you saw

A zbus channel is a message and a list of observers fixed at build time.
Publishing locks the channel, copies the message in, tells every observer in
order, and unlocks.

Each kind of observer hears about it differently:

- A **listener** runs inside the publish, in the publisher's thread, with the channel locked.
- A **subscriber** gets the channel in its own queue, and reads the message later, under the lock.
- An **async listener** gets a copy of the message, and runs from a work queue.

That is the order of the lines in the terminal: listener, async listener,
subscriber. The subscriber was second in the list and woke up before the
async listener ran, but it could not read until `main` had told everyone and
released the lock.

**zbus under the hood** follows the same publish from inside zbus and the
kernel.
