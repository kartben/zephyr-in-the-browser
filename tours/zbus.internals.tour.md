---
tour: "zbus under the hood"
sample: samples/subsys/zbus/hello_world
sources:
  - subsys/zbus/zbus.c
  - kernel/msg_q.c
---

This tour follows the first publish of zbus's Hello World sample again, this
time from inside zbus and the kernel: where the observer list lives, what a
publish does with the channel's lock, and how each kind of observer is told.
**zbus: channels and observers** follows the same publish from the sample's
side. Take it first.

## The observer list is a linker section

```tour
at: main.c:main/zbus_chan_pub\(&acc_data_chan, &acc1,/
highlight: /ZBUS_CHAN_DEFINE\(acc_data_chan/ + 7
watch:
  - 1st observer = zbus_channel_observation(acc_data_chan00).obs as ptr
  - 2nd observer = zbus_channel_observation(acc_data_chan01).obs as ptr
  - 3rd observer = zbus_channel_observation(acc_data_chan02).obs as ptr
```

`main()` is about to publish its first reading on `acc_data_chan`.

`ZBUS_CHAN_DEFINE` set up three things at compile time: the channel's message,
a semaphore that guards it, and the observers named in `ZBUS_OBSERVERS()`.

The observer list is not stored in the channel. Each channel and observer pair
is a small constant in a linker section, and the linker sorts the section by
name: `acc_data_chan00`, `acc_data_chan01`, `acc_data_chan02`. So one
channel's observers sit together, in the order you wrote them. The three
values above are read from those pairs.

Channels and observers have sorted sections of their own, which is why the
channel list the sample printed at startup is in alphabetical order.

## Publishing takes the lock, then copies

```tour
at: zbus.c:zbus_chan_pub/memcpy\(chan->message, msg/
highlight:
  - /chan->validator != NULL/ + 2
  - /err = chan_lock\(chan, timeout/ + 3
watch:
  - lock = k_sem(zbus_channel_data(_zbus_chan_data_acc_data_chan).sem).count as u32
```

This stop is inside zbus, in `zbus_chan_pub()`.

First comes the validator, for a channel that has one: `acc_data_chan` has
none. Then `chan_lock()` takes the channel's semaphore. Its count was 1, free,
and now reads 0: `main` holds the channel. A thread that wants it now has to
wait, for as long as the timeout it passed allows.

With the lock held, `memcpy()` copies the whole message over the channel's,
so a reader never sees half an update. Next, `_zbus_vded_exec()` tells each
observer, and only then does `chan_unlock()` give the semaphore back.

## The dispatcher calls the listener

```tour
at: listener_callback_example
highlight: /ZBUS_LISTENER_DEFINE\(foo_lis/
watch:
  - returns to = $lr as code
  - lock = k_sem(zbus_channel_data(_zbus_chan_data_acc_data_chan).sem).count as u32
threads: main
look:
  - debug.stack
```

`returns to` is the address the CPU saved when zbus called this function, so
it says who the caller is: `_zbus_vded_exec()`, the dispatcher, which
`zbus_chan_pub()` calls to tell each observer in turn. The call stack in
**Debug** shows the whole chain: `main()` called `zbus_chan_pub()`, which
called the dispatcher, which called this function.

For a listener, telling is just this call: the dispatcher calls the
listener's callback directly, in `main`'s thread, with the semaphore still
taken.

## Telling a subscriber is a k_msgq_put

```tour
at: z_impl_k_msgq_put
when:
  - $arg0 == _zbus_observer_queue_bar_sub
  - first
highlight: /pending_thread = z_unpend_first_thread_locked/ + 6
watch:
  - message = $arg1 as ptr
objects:
  type: msgq
  focus: _zbus_observer_queue_bar_sub
threads: main, subscriber_task_id
```

`ZBUS_SUBSCRIBER_DEFINE(bar_sub, 4)` gave `bar_sub` a message queue with four
slots, drawn here, so telling a subscriber is a `k_msgq_put()`, and this stop
is in the kernel, inside it. Look at the message being sent: not the reading,
but `acc_data_chan`. A subscriber's queue holds channel addresses, 8 bytes
each however big the message is.

The thread list shows `subscriber_task_id` waiting in `zbus_sub_wait()`, so
the kernel skips the slots, copies the address straight to the waiting thread,
and makes it ready to run.

## The read takes the same semaphore

```tour
at: zbus.c:zbus_chan_read/k_sem_take/
when: first
watch:
  - lock = k_sem(zbus_channel_data(_zbus_chan_data_acc_data_chan).sem).count as u32
threads: main, subscriber_task_id
```

The subscriber outranks `main`, so it ran as soon as the put made it ready,
in the middle of `main()`'s publish. It now calls `zbus_chan_read()` to copy
the message out.

Reading takes the same semaphore as publishing, and it still reads 0: `main`
holds it, with one observer left to tell. So the subscriber blocks in
`k_sem_take()`, and `main` gets the CPU back.

## Where the async listener's copy comes from

```tour
at: async_listener_callback_example
highlight: /ZBUS_ASYNC_LISTENER_DEFINE\(baz_async_lis/
watch:
  - message = $arg1 as addr
memory:
  at: $arg1
  len: 12
  note: the copy this callback reads
threads: main, subscriber_task_id, sysworkq
look:
  - trace.ipc
```

Before telling anyone, the dispatcher copied the message into a buffer from
the system heap, because this channel has an async listener. For
`baz_async_lis` it put that buffer in the listener's FIFO and submitted the
listener's work item. The system work queue outranks everything here, so it
ran the callback at once, while `main` is still in its publish: `message` is
that buffer, not the channel's message.

On the traced build, **Trace → IPC** shows what zbus built for these
observers, under the names it gave them: the subscriber's queue, this
listener's FIFO, and the pool the message buffers come from.

## What you saw

Under the API, a publish is a semaphore, a `memcpy()` and a loop.
`zbus_chan_pub()` asks the validator, takes the channel's semaphore and copies
the message in. `_zbus_vded_exec()` then walks the channel's observer pairs in
linker order: a listener is a function call, a subscriber a `k_msgq_put()` of
the channel's address, and an async listener a buffer in its FIFO and a
submitted work item. Only then is the semaphore given back. A read takes the
same semaphore, which is why the subscriber waited.
