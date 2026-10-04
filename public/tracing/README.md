# Zephyr CTF metadata

Copy of `zephyr/subsys/tracing/ctf/tsdl/metadata` from upstream Zephyr, kept
byte for byte. The in-page Trace panel reads CTF event layouts from it; without
it the decoder falls back to the core scheduling events baked into `src/ctf/`.

It is the fallback table, not the first choice. CTF event ids are positional and
Zephyr renumbers them as events come and go, so only the table an image was
built with is sure to match it. `tools/build-zephyr-image.sh` ships that table
beside every image that emits CTF, as `public/qemu/zephyr/<board>/<app>.tsdl`,
and the page tries it first. This copy decodes everything else: images from a
release that predates those tables, a dropped ELF, and live boards.

So refresh it from the Zephyr the current image release was built from, and
ship the refresh together with that release:

```console
cp $ZEPHYR_BASE/subsys/tracing/ctf/tsdl/metadata public/tracing/metadata
```

Then update the ids in `src/ctf/types.ts` by event name, never by offset, and
run `npm test`: `src/ctf/metadata.test.ts` fails on any id there that names a
different event, or a different record size, than this file.
