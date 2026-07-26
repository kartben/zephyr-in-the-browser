/*
 * Template-based linker pipeline (CONFIG_CMAKE_LINKER_GENERATOR=n, the default
 * on the qemu boards) ignores the zephyr_iterable_section() call in
 * CMakeLists.txt, so the sample_annotation iterable needs its section emitted
 * here too. Without it STRUCT_SECTION_FOREACH(sample_annotation, ...) links
 * against undefined _sample_annotation_list_start/_end. See
 * https://docs.zephyrproject.org/latest/kernel/iterable_sections/index.html
 */
#include <zephyr/linker/iterable_sections.h>

ITERABLE_SECTION_ROM(sample_annotation, Z_LINK_ITERABLE_SUBALIGN)
