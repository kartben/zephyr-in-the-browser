# Zephyr CTF metadata

Copy of `zephyr/subsys/tracing/ctf/tsdl/metadata` from upstream Zephyr, taken
at the revision the current guest images were built from (`8f62a4ab82b5`,
v4.5.0-rc1-170).

It is the fallback. The image build ships the metadata of the Zephyr it used
beside the images, as `qemu/zephyr/tracing/metadata`, and the Trace panel reads
that copy first: the images follow Zephyr's main branch, and Zephyr adds and
renumbers trace events, so only that copy is sure to match. This one decodes
image releases from before it shipped, and traces from the desktop bridge.
Without either, the decoder falls back to the core events baked into
`src/ctf/types.ts`.

Refresh it from the Zephyr checkout that built the images:

```console
cp $ZEPHYR_BASE/subsys/tracing/ctf/tsdl/metadata public/tracing/metadata
```

The ids in `FALLBACK_EVENTS` (`src/ctf/types.ts`) have to move with it;
`npm test` fails when one of them names a different record size.
