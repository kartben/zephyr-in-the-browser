# Trace → zbus

zbus moves a lot of data between threads, and a trace showed almost none of
it. A publish appeared as an anonymous semaphore taken and given, a
subscriber's notification as a put into a message queue zbus made behind the
scenes, and a listener's callback not at all. The **zbus** tab shows the bus
itself: which thread published on which channel, which observers heard about
it and in what order, how long each took, and what each did next.

## What it shows

One row per channel, and under each channel one row per observer, in the order
the dispatcher notifies them.

- **Channel row.** Each publish is a bar from `zbus_chan_pub()` entering to it
  returning, labelled with the thread that made it. A rejected or timed-out
  call is red and says why (`main -ENOMSG`). Reads and claims are thinner bars
  under it, and a claimed channel is shaded from claim to finish.
- **Listener row.** The listener's callback, inside the publish, since that is
  where a listener runs.
- **Subscriber row.** The put into its queue, a dot where its thread woke with
  the channel, then that thread's read of the message, joined by dashed lines.
- **Async listener row.** The hand-off to its work queue, then its callback
  where the work queue ran it, labelled with the work queue's thread.

Hover anything, or tap it on a touch screen, for a two-line tip: what it is,
then how long it took, how long after the dispatcher it came, or why it failed
(`-ENOMSG: rejected by the validator`, `-ENOMSG from bar_sub`). Over a name, the
tip says what that kind of observer does. A read that began while another
thread was publishing says so: that is a subscriber waiting for the lock.

Above the lanes: channels, publishes, rejected publishes, notifications and
reads in the visible window, and a legend. The tab shares the Trace window,
gestures and box zoom with the other tabs, and appears only for an image that
has zbus.

## Where it comes from

**The topology is in the image.** Channels, observers and the list of which
observer belongs to which channel are constant data in three iterable
sections, `zbus_channel`, `zbus_observer` and `zbus_channel_observation`, at
the addresses the guest uses. `src/debug/elfZbus.ts` reads them out of the ELF
the page already has, with no gdb session and before the guest boots: names
from the symbol table, observer kinds from each observer's type byte, and
member offsets from DWARF (counted from the end of each struct when there is
none, which works because the fields Kconfig removes come first).

**The activity is in the trace.** `src/ctf/zbus.ts` rebuilds calls,
notifications, wake-ups and async runs from the `zbus_*` CTF events, pairing
enter and exit per calling thread, and per interrupt context, on a stack,
because a listener can publish to another channel from inside a publish. The
events carry addresses only; the topology names them.

| Event | Fields | Means |
| --- | --- | --- |
| `zbus_chan_{pub,read,notify,claim}_enter` | channel, timeout (µs) | the call started |
| `zbus_chan_{pub,read,notify,claim}_exit` | channel, timeout, ret | it returned |
| `zbus_chan_finish_enter` / `_exit` | channel (, ret) | a claim ended |
| `zbus_sub_wait_enter` / `zbus_sub_wait_msg_enter` | observer, timeout | a subscriber waits |
| `zbus_sub_wait_exit` / `zbus_sub_wait_msg_exit` | observer, timeout, channel, ret | it woke, and which channel woke it |
| `zbus_obs_notify_enter` / `_exit` | observer, channel (, ret) | the dispatcher told one observer |
| `zbus_async_listener_enter` / `_exit` | work item, channel | an async listener's callback ran |

## The hooks are not upstream yet

Zephyr main has no zbus tracing. The events above come from a proposed patch
that adds `sys_port_trace_zbus_*` hooks (on by default with
`CONFIG_TRACING_ZBUS`, which follows `CONFIG_ZBUS`), calls them from
`subsys/zbus/zbus.c`, and records them as CTF events `0x186` to `0x197`. It is
on the `browser-traces` branch of
[kartben/zephyr](https://github.com/kartben/zephyr/tree/browser-traces), on top
of Zephyr main, with the PM hooks the Power band reads
([cpu-power-states.md](cpu-power-states.md)).

The images this site deploys are built from that branch, since images release
v105, so the tab shows the activity. An image built from Zephyr main gets the
channels and observers with a note, and no activity; its traced build still
shows part of zbus in **IPC**: a subscriber's message queue and an async
listener's FIFO, under the names zbus gave them.

To see the activity, build the images from a tree with the patch applied:

```sh
# In a scratch west workspace whose zephyr/ is kartben/zephyr browser-traces
ZEPHYR_WS=<workspace> tools/build-zephyr-image.sh qemu_cortex_a53 zbus
```

The build ships the patched tree's TSDL beside the traced image as
`zbus_trace.tsdl`, and the page decodes that image's trace with it, so the new
events decode by name with no change to the page's own table.

## Not done

- Without the hooks, the channel's lock (`k_sem` events on
  `_zbus_chan_data_<channel>.sem`) and the subscriber's queue already say when
  a channel was held and when a subscriber was told. The tab could draw those
  on stock images.
- Clicking does nothing yet: a tip cannot be pinned, or open the call in Debug.
- Observers added at run time get a row when first told, named by address.
