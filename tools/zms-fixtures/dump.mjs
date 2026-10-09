#!/usr/bin/env node
/**
 * Turns the generator's console output into binary fixtures:
 *
 *   node tools/zms-fixtures/dump.mjs <qemu-output.txt> <out-prefix>
 *
 * writes <out-prefix>-<name>.bin for each partition the app dumped
 * ("ZMSDUMP <name> <offset> <hex>" lines). See tools/zms-fixtures/README.md.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const [input, prefix] = process.argv.slice(2)
if (!input || !prefix) {
  console.error('usage: dump.mjs <qemu-output.txt> <out-prefix>')
  process.exit(2)
}

const parts = new Map()
for (const line of readFileSync(input, 'utf8').split('\n')) {
  const m = /ZMSDUMP (\w+) ([0-9a-f]+) ([0-9a-f]+)/.exec(line)
  if (!m) continue
  const [, name, off, hex] = m
  const chunks = parts.get(name) ?? []
  chunks.push({ off: parseInt(off, 16), bytes: Buffer.from(hex, 'hex') })
  parts.set(name, chunks)
}
if (parts.size === 0) {
  console.error(`no ZMSDUMP lines in ${input}`)
  process.exit(1)
}
for (const [name, chunks] of parts) {
  const size = Math.max(...chunks.map((c) => c.off + c.bytes.length))
  const image = Buffer.alloc(size, 0xff)
  for (const { off, bytes } of chunks) bytes.copy(image, off)
  writeFileSync(`${prefix}-${name}.bin`, image)
  console.log(`${prefix}-${name}.bin  ${size} bytes`)
}
