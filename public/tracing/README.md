# Zephyr CTF metadata

Copy of `zephyr/subsys/tracing/ctf/tsdl/metadata` from upstream Zephyr. The
in-page Trace panel fetches it to learn CTF event layouts; without it the
decoder falls back to the core scheduling events baked into `src/ctf/`.

Refresh from a Zephyr checkout when tracing event ids change:

```console
cp $ZEPHYR_BASE/subsys/tracing/ctf/tsdl/metadata public/tracing/metadata
```
