/**
 * `threads: aggregator, consumer*` — which of the kernel's threads a card
 * lists. A step is about two or three threads, and the other six push the code
 * below the fold, so a step can name the ones it means. `*` matches any run of
 * characters, so `sensor_*` is all three sensors. An empty list is every thread.
 */

function matcher(pattern: string): (name: string) => boolean {
  if (!pattern.includes('*')) return (name) => name === pattern
  const escaped = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(`^${escaped.join('.*')}$`)
  return (name) => re.test(name)
}

/** Whether a thread's name is one a step's `threads:` asks for. */
export function threadNameFilter(patterns: readonly string[]): (name: string) => boolean {
  if (patterns.length === 0) return () => true
  const matchers = patterns.map(matcher)
  return (name) => matchers.some((match) => match(name))
}

/** The names a step asked for that no thread at this stop has: an author's slip, worth a line. */
export function unmatchedThreadNames(patterns: readonly string[], names: readonly string[]): string[] {
  return patterns.filter((pattern) => {
    const match = matcher(pattern)
    return !names.some(match)
  })
}
