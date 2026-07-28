/*
 * Compatibility fallback for Zephyr targets without a SoC-specific soc.h.
 *
 * Zephyr's Bluetooth host currently includes <soc.h> unconditionally, while
 * qemu_cortex_a53 deliberately has no SoC header. Board-specific headers
 * precede this module include path, so they continue to win where present.
 */

#ifndef ZEPHYR_BROWSER_BRIDGE_SOC_H_
#define ZEPHYR_BROWSER_BRIDGE_SOC_H_
#endif
