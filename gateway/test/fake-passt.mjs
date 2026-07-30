/**
 * A stand-in for passt so the proxy's lifecycle tests run on macOS and in CI
 * without the real (Linux-only) binary. Speaks just enough of its CLI:
 * `--version` exits 0 (the preflight), and `--socket <path>` listens on the
 * UNIX socket and echoes every byte back — which the tests use to prove the
 * ws ⇄ socket pipe is transparent in both directions.
 */

import { createServer } from 'node:net'

const args = process.argv.slice(2)

if (args.includes('--version')) {
  console.log('fake-passt 0')
  process.exit(0)
}

const sockIdx = args.findIndex((a) => a === '--socket' || a === '-s')
if (sockIdx === -1 || !args[sockIdx + 1]) {
  console.error('fake-passt: no --socket path')
  process.exit(1)
}
const sockPath = args[sockIdx + 1]

if (args.includes('--exit-early')) {
  // Simulates a passt that dies right away (bad flags, sandbox failure).
  console.error('fake-passt: exiting early as instructed')
  process.exit(1)
}

const server = createServer((conn) => {
  conn.pipe(conn)
  // --one-off semantics: the process lives exactly as long as its client.
  conn.on('close', () => process.exit(0))
  conn.on('error', () => process.exit(0))
})
server.listen(sockPath, () => {
  console.error(`fake-passt: listening on ${sockPath}`)
})
process.on('SIGTERM', () => process.exit(0))
