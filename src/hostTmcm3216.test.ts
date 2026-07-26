/**
 * TMCM-3216 TMCL unit tests: checksum, SAP/GAP, MVP motion completion.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as hostUart1 from '@/hostUart1'
import * as hostTmcm3216 from '@/hostTmcm3216'

const FRAME = 9
const STATUS_OK = 100
const CMD_SAP = 5
const CMD_GAP = 6
const CMD_MVP = 4
const MVP_REL = 1
const AP_ACTUAL_POSITION = 1
const AP_MAX_VELOCITY = 4
const AP_POSITION_REACHED = 8
const AP_ACTUAL_VELOCITY = 3

function be32(n: number): [number, number, number, number] {
  const v = n >>> 0
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
}

function makeFrame(cmd: number, type: number, bank: number, data: number): Uint8Array {
  const d = be32(data)
  const frame = new Uint8Array([1, cmd, type, bank, d[0]!, d[1]!, d[2]!, d[3]!, 0])
  frame[8] = hostTmcm3216.checksumForTests(frame)
  return frame
}

describe('hostTmcm3216', () => {
  const fed: number[] = []

  beforeEach(() => {
    fed.length = 0
    hostTmcm3216.resetForTests()
    vi.spyOn(hostUart1, 'feed').mockImplementation((bytes) => {
      for (let i = 0; i < bytes.length; i++) fed.push(bytes[i]!)
    })
    hostTmcm3216.attach()
  })

  afterEach(() => {
    hostTmcm3216.resetForTests()
    vi.restoreAllMocks()
  })

  it('answers SAP/GAP for max velocity', () => {
    hostTmcm3216.handleFrameForTests(makeFrame(CMD_SAP, AP_MAX_VELOCITY, 0, 5000))
    // echo (9) + reply (9)
    expect(fed.length).toBeGreaterThanOrEqual(9)
    // handleFrameForTests does not go through onTx echo path — only reply
    expect(fed.length).toBe(9)
    expect(fed[2]).toBe(STATUS_OK)
    expect(fed[3]).toBe(CMD_SAP)

    fed.length = 0
    hostTmcm3216.handleFrameForTests(makeFrame(CMD_GAP, AP_MAX_VELOCITY, 0, 0))
    expect(fed.length).toBe(9)
    expect(fed[2]).toBe(STATUS_OK)
    const value = ((fed[4]! << 24) | (fed[5]! << 16) | (fed[6]! << 8) | fed[7]!) >>> 0
    expect(value).toBe(5000)
  })

  it('completes a relative MVP and reports position reached', async () => {
    hostTmcm3216.handleFrameForTests(makeFrame(CMD_SAP, AP_MAX_VELOCITY, 0, 100000))
    fed.length = 0
    hostTmcm3216.handleFrameForTests(makeFrame(CMD_MVP, MVP_REL, 0, 200))

    // Allow motion to finish (setTimeout fallback when rAF is absent).
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 20))
      const snap = hostTmcm3216.getSnapshot()
      if (snap.axes[0] && !snap.axes[0].moving && snap.axes[0].position === 200) break
    }

    const snap = hostTmcm3216.getSnapshot()
    expect(snap.axes[0]?.position).toBe(200)
    expect(snap.axes[0]?.moving).toBe(false)

    fed.length = 0
    hostTmcm3216.handleFrameForTests(makeFrame(CMD_GAP, AP_POSITION_REACHED, 0, 0))
    const reached = ((fed[4]! << 24) | (fed[5]! << 16) | (fed[6]! << 8) | fed[7]!) >>> 0
    expect(reached).toBe(1)

    fed.length = 0
    hostTmcm3216.handleFrameForTests(makeFrame(CMD_GAP, AP_ACTUAL_POSITION, 0, 0))
    const pos = ((fed[4]! << 24) | (fed[5]! << 16) | (fed[6]! << 8) | fed[7]!) >>> 0
    expect(pos | 0).toBe(200)

    fed.length = 0
    hostTmcm3216.handleFrameForTests(makeFrame(CMD_GAP, AP_ACTUAL_VELOCITY, 0, 0))
    const vel = ((fed[4]! << 24) | (fed[5]! << 16) | (fed[6]! << 8) | fed[7]!) >>> 0
    expect(vel | 0).toBe(0)
  })

  it('rejects bad checksum silently (no reply)', () => {
    const frame = makeFrame(CMD_GAP, AP_ACTUAL_POSITION, 0, 0)
    frame[8] = (frame[8]! + 1) & 0xff
    hostTmcm3216.handleFrameForTests(frame)
    expect(fed.length).toBe(0)
  })
})

describe('tmcm checksum', () => {
  it('matches the Zephyr sum-of-bytes formula', () => {
    const frame = new Uint8Array([1, 5, 4, 0, 0, 0, 0x13, 0x88, 0])
    frame[8] = hostTmcm3216.checksumForTests(frame)
    let sum = 0
    for (let i = 0; i < FRAME - 1; i++) sum = (sum + frame[i]!) & 0xff
    expect(frame[8]).toBe(sum)
  })
})
