# SPDX-License-Identifier: Apache-2.0

cmake_minimum_required(VERSION 3.20.0)

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(guided_blinky)

FILE(GLOB app_sources src/*.c)

# Lift the `@annotate` comments out of the sources before compiling them.
#
# This produces three things: a header of annotation ids and the table entry
# for each (all the firmware ever sees), an annotations.json carrying the prose
# for the browser, and stripped copies of the sources with the comment blocks
# removed. The stripped copies are what ship to public/ and what the annotation
# popup shows — the text is already in the popup, and leaving it in the code
# would bury the sample it is explaining.
#
# The build compiles the *original* sources, not the stripped ones: line
# numbers in a compiler diagnostic should match the file the author edits.
# Only the display copies move.
set(annotations_dir ${CMAKE_CURRENT_BINARY_DIR}/annotations)
set(annotations_header ${annotations_dir}/include/sample_annotations_generated.h)
set(annotations_json ${annotations_dir}/annotations.json)
set(annotations_src ${annotations_dir}/src)

set(extract ${CMAKE_CURRENT_LIST_DIR}/../../../tools/extract-annotations.py)

set(extract_args "")
foreach(src ${app_sources})
  list(APPEND extract_args --source ${src})
endforeach()

add_custom_command(
  OUTPUT ${annotations_header} ${annotations_json}
  COMMAND ${PYTHON_EXECUTABLE} ${extract}
          --app guided
          --source-root ${CMAKE_CURRENT_LIST_DIR}
          ${extract_args}
          --out-header ${annotations_header}
          --out-json ${annotations_json}
          --out-src-dir ${annotations_src}
  DEPENDS ${extract} ${app_sources}
  COMMENT "Extracting sample annotations"
  VERBATIM
)
add_custom_target(guided_blinky_annotations DEPENDS ${annotations_header})

target_sources(app PRIVATE ${app_sources})
target_include_directories(app PRIVATE ${annotations_dir}/include)
add_dependencies(app guided_blinky_annotations)
