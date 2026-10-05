/**
 * The comments a built zephyr.dts carries about where each line came from.
 *
 * Zephyr's build writes a `node '/leds' defined in <file>:<line>` comment above
 * each node, and pads an `in <file>:<line>` comment into a column after each
 * property. They help when debugging a build. In a tour card they are most of
 * the excerpt, and the paths are the build machine's, so the card leaves them
 * out, and `dts:` counts lines the way the card shows them.
 */

const NODE_ORIGIN = /^\s*\/\* node '[^']*' defined in [^*]*\*\/\s*$/
const PROPERTY_ORIGIN = /\s*\/\* in [^*]*\*\/\s*$/

/** `lines` without the build's provenance comments, or the padding before them. */
export function stripDtsProvenance(lines: readonly string[]): string[] {
  return lines
    .filter((line) => !NODE_ORIGIN.test(line))
    .map((line) => line.replace(PROPERTY_ORIGIN, ''))
}
