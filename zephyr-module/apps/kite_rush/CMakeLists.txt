# SPDX-FileCopyrightText: Copyright The Zephyr Project Contributors
# SPDX-License-Identifier: Apache-2.0

cmake_minimum_required(VERSION 3.28.0)

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(kite_rush)

target_sources(app PRIVATE
  src/controls.c
  src/font.c
  src/game.c
  src/gfx.c
  src/kite.c
  src/main.c
  src/render.c
  src/storage.c
  src/telemetry.c
)
