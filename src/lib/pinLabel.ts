/**
 * A GPIO key or LED's name as the dock shows it.
 *
 * The labels come from the guest's devicetree, and the page's own overlays
 * spell them for the host that drives the line: `label = "Host SW0"` on the
 * Cortex-M3, `"Browser LED0"` on the A53. Inside the page that prefix says
 * nothing, and the samples' docs and Try it lines call the key SW0, after its
 * `sw0` alias. So the dock drops it, and keeps the label as written for the
 * tooltip. The overlays stay as they are: changing them would mean rebuilding
 * every image.
 *
 * Only that one leading word goes. A board's own labels ("User SW1", "BOOT
 * Button" on the ESP32s) are left alone, and so is a label that would be
 * nothing without it.
 */
export function pinDisplayName(label: string): string {
  const short = label.replace(/^(?:Host|Browser)\s+/, '').trim()
  return short === '' ? label : short
}
