/**
 * Dedicated Atomics.wait worker for virtio request wakes. Device models stay on
 * the main thread; detach terminates this worker because a blocked wait cannot
 * receive a stop message.
 */

export interface RequestWaiterStart {
  type: 'start'
  buffer: SharedArrayBuffer
  wordIndex: number
  expected: number
}

export type MainToRequestWaiter = RequestWaiterStart

export type RequestWaiterToMain =
  | { type: 'ready' }
  | { type: 'wake'; count: number }
  | { type: 'fatal'; message: string }

// DOM lib types `self` as Window in this project. Keep the worker surface
// narrow instead of pulling WebWorker globals into the whole application.
const workerSelf = self as unknown as {
  addEventListener(type: 'message', listener: (event: MessageEvent<MainToRequestWaiter>) => void): void
  postMessage(message: RequestWaiterToMain): void
}

function post(message: RequestWaiterToMain) {
  workerSelf.postMessage(message)
}

function waitForRequests(message: RequestWaiterStart) {
  const { buffer, wordIndex } = message
  if (
    !Number.isInteger(wordIndex) ||
    wordIndex < 0 ||
    wordIndex >= buffer.byteLength / Int32Array.BYTES_PER_ELEMENT
  ) {
    throw new Error(`invalid request futex index ${wordIndex}`)
  }

  const words = new Int32Array(buffer)
  let expected = message.expected | 0
  post({ type: 'ready' })

  for (;;) {
    Atomics.wait(words, wordIndex, expected)
    const current = Atomics.load(words, wordIndex)
    if (current === expected) continue

    const count = (current - expected) >>> 0
    expected = current
    post({ type: 'wake', count })
  }
}

workerSelf.addEventListener('message', (event) => {
  try {
    waitForRequests(event.data)
  } catch (error) {
    post({ type: 'fatal', message: error instanceof Error ? error.message : String(error) })
  }
})
