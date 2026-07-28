/**
 * Lazy Bumble virtual controller under Pyodide.
 *
 * Vendoring and pin details: public/vendor/bumble/README.md
 * (wheel) and the Pyodide CDN pin in {@link PYODIDE_INDEX_URL}.
 *
 * Peers share the controller's LocalLink — the page is the air.
 */

export interface BtPeerInfo {
  id: string
  typeId: string
  name: string
  detail: string
}

export interface BtControllerHandle {
  name: string
  /** Deliver one complete H:4 HCI packet (with type byte) from the Zephyr host. */
  onHostPacket: (packet: Uint8Array) => void
  addPeer: (typeId: string) => Promise<BtPeerInfo>
  removePeer: (id: string) => Promise<void>
  listPeers: () => BtPeerInfo[]
  close: () => void
}

export interface EnsureControllerOpts {
  /** Controller → Zephyr host: full HCI packet including type byte. */
  onHostPacket: (packet: Uint8Array) => void
  /** Fired when a peer's detail string changes (e.g. scanner adv count). */
  onPeersChanged?: () => void
}

/** Pinned Pyodide release. Override at build time with VITE_PYODIDE_INDEX_URL. */
export const PYODIDE_INDEX_URL =
  (import.meta.env.VITE_PYODIDE_INDEX_URL as string | undefined) ??
  'https://cdn.jsdelivr.net/pyodide/v314.0.3/full/'

/**
 * Served from public/; produced by tools/vendor-bumble.sh.
 *
 * micropip rejects relative URLs (it resolves them as file: paths inside its
 * virtual filesystem), so resolve this against the browser document first.
 */
export const BUMBLE_WHEEL_URL = new URL(
  `${import.meta.env.BASE_URL}vendor/bumble/bumble-0.0.233-py3-none-any.whl`,
  globalThis.location?.href ?? 'http://localhost/',
).href

const CONTROLLER_PY = `
import asyncio
from bumble.controller import Controller
from bumble.core import AdvertisingData
from bumble.device import Device
from bumble.gatt import GATT_HEART_RATE_SERVICE
from bumble.host import Host
from bumble.link import LocalLink
from bumble.profiles.heart_rate_service import HeartRateService

class _JsSink:
    def __init__(self, send):
        self._send = send
    def on_packet(self, packet):
        # packet is already bytes with the HCI type prefix
        self._send(packet)

link = LocalLink()
_sink = _JsSink(js_send_to_host)
controller = Controller('zephyr-browser', host_sink=_sink, link=link)

_peers = {}
_seq = 0

_TYPE_NAMES = {
    'hrm': 'Heart rate',
    'advertiser': 'Advertiser',
    'scanner': 'Scanner',
}

def _flags():
    return bytes([
        int(AdvertisingData.Flags.LE_GENERAL_DISCOVERABLE_MODE)
        | int(AdvertisingData.Flags.BR_EDR_NOT_SUPPORTED)
    ])

def _adv_name(name: str, service_uuid=None):
    parts = [
        (AdvertisingData.Type.FLAGS, _flags()),
        (AdvertisingData.Type.COMPLETE_LOCAL_NAME, name.encode('utf-8')),
    ]
    if service_uuid is not None:
        parts.insert(
            1,
            (
                AdvertisingData.Type.COMPLETE_LIST_OF_16_BIT_SERVICE_CLASS_UUIDS,
                service_uuid.uuid_bytes,
            ),
        )
    return bytes(AdvertisingData(parts))

def _notify_peers():
    try:
        js_peers_changed()
    except Exception:
        pass

def on_host_packet(data):
    controller.on_packet(bytes(data))

def list_peers():
    out = []
    for peer_id, info in _peers.items():
        out.append((peer_id, info['type'], info['name'], info['detail']))
    return out

async def _publish_heart_rate(peer_id, device, service):
    while peer_id in _peers:
        await asyncio.sleep(1)
        await device.notify_subscribers(
            service.heart_rate_measurement_characteristic,
            HeartRateService.HeartRateMeasurement(heart_rate=72),
        )

async def add_peer(type_id: str):
    global _seq
    if type_id not in _TYPE_NAMES:
        raise ValueError(f'unknown peer type: {type_id}')
    _seq += 1
    peer_id = f'{type_id}-{_seq}'
    name = f'{_TYPE_NAMES[type_id]} {_seq}'

    peer_ctl = Controller(peer_id, link=link)
    host = Host(controller_source=peer_ctl, controller_sink=peer_ctl)
    device = Device(name=name, host=host)

    detail = {
        'hrm': 'Advertises GATT Heart Rate (0x180D)',
        'advertiser': 'Connectable LE advertisement',
        'scanner': '0 adv reports',
    }[type_id]

    hr_service = None
    if type_id == 'hrm':
        def read_hr(_connection):
            return HeartRateService.HeartRateMeasurement(heart_rate=72)
        hr_service = HeartRateService(
            read_heart_rate_measurement=read_hr,
            body_sensor_location=HeartRateService.BodySensorLocation.CHEST,
        )
        device.add_service(hr_service)
        device.advertising_data = _adv_name(name, GATT_HEART_RATE_SERVICE)
    elif type_id == 'advertiser':
        device.advertising_data = _adv_name(name)
    elif type_id == 'scanner':
        def on_adv(_advertisement):
            info = _peers.get(peer_id)
            if not info:
                return
            info['adv_count'] = info.get('adv_count', 0) + 1
            info['detail'] = f"{info['adv_count']} adv reports"
            _notify_peers()
        device.on(Device.EVENT_ADVERTISEMENT, on_adv)

    await device.power_on()
    if type_id == 'scanner':
        await device.start_scanning(active=False)
    else:
        await device.start_advertising()

    _peers[peer_id] = {
        'type': type_id,
        'name': name,
        'detail': detail,
        'device': device,
        'controller': peer_ctl,
        'adv_count': 0,
    }
    if hr_service is not None:
        _peers[peer_id]['notify_task'] = asyncio.create_task(
            _publish_heart_rate(peer_id, device, hr_service)
        )
    return peer_id

async def remove_peer(peer_id: str):
    info = _peers.pop(peer_id, None)
    if info is None:
        return
    device = info['device']
    peer_ctl = info['controller']
    notify_task = info.get('notify_task')
    if notify_task is not None:
        notify_task.cancel()
    try:
        if info['type'] == 'scanner':
            await device.stop_scanning()
        else:
            await device.stop_advertising()
    except Exception:
        pass
    try:
        await device.power_off()
    except Exception:
        pass
    try:
        link.remove_controller(peer_ctl)
    except Exception:
        pass

async def close_async():
    for peer_id in list(_peers):
        await remove_peer(peer_id)

def close():
    # Sync entry used when the JS handle tears down without awaiting.
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(close_async())
    except RuntimeError:
        _peers.clear()
`

type PyodideInterface = {
  loadPackage: (names: string | string[]) => Promise<void>
  runPythonAsync: (code: string) => Promise<unknown>
  globals: { set: (k: string, v: unknown) => void; get: (k: string) => unknown }
  pyimport: (name: string) => {
    install: (url: string | string[]) => Promise<void>
  }
}

let pyodidePromise: Promise<PyodideInterface> | null = null
let handle: BtControllerHandle | null = null
let pyodideRef: PyodideInterface | null = null
let peersChangedCb: (() => void) | null = null

async function loadPyodide(): Promise<PyodideInterface> {
  if (pyodidePromise) return pyodidePromise
  pyodidePromise = (async () => {
    // Official loader attaches loadPyodide on globalThis. Load via <script>
    // rather than import() — Vite cannot resolve the CDN ESM entry as a chunk.
    await new Promise<void>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>('script[data-pyodide]')
      if (existing) {
        if ((globalThis as { loadPyodide?: unknown }).loadPyodide) {
          resolve()
          return
        }
        existing.addEventListener('load', () => resolve(), { once: true })
        existing.addEventListener('error', () => reject(new Error('pyodide.js failed')), {
          once: true,
        })
        return
      }
      const script = document.createElement('script')
      script.src = `${PYODIDE_INDEX_URL}pyodide.js`
      script.async = true
      script.dataset.pyodide = '1'
      script.onload = () => resolve()
      script.onerror = () => reject(new Error(`failed to load ${script.src}`))
      document.head.appendChild(script)
    })
    const loader = (globalThis as unknown as {
      loadPyodide: (opts: { indexURL: string }) => Promise<PyodideInterface>
    }).loadPyodide
    if (typeof loader !== 'function') {
      throw new Error('loadPyodide missing after loading pyodide.js')
    }
    const pyodide = await loader({ indexURL: PYODIDE_INDEX_URL })
    // cryptography (Emscripten build) + pyee are Bumble's hard deps in-browser.
    await pyodide.loadPackage(['micropip'])
    const micropip = pyodide.pyimport('micropip')
    await micropip.install(['pyee'])
    try {
      await pyodide.loadPackage(['cryptography'])
    } catch {
      await micropip.install(['cryptography'])
    }
    await micropip.install([BUMBLE_WHEEL_URL])
    return pyodide
  })()
  return pyodidePromise
}

function readPeerList(pyodide: PyodideInterface): BtPeerInfo[] {
  const raw = pyodide.globals.get('list_peers') as () => unknown
  const listed = raw() as {
    toJs?: (opts?: { create_proxies?: boolean }) => unknown[]
    length?: number
    [i: number]: unknown
  }
  const rows: unknown[] =
    listed && typeof listed.toJs === 'function'
      ? (listed.toJs({ create_proxies: false }) as unknown[])
      : Array.from(listed as ArrayLike<unknown>)
  return rows.map((row) => {
    const cells =
      row && typeof (row as { toJs?: () => unknown }).toJs === 'function'
        ? ((row as { toJs: () => unknown[] }).toJs() as unknown[])
        : (row as unknown[])
    return {
      id: String(cells[0]),
      typeId: String(cells[1]),
      name: String(cells[2]),
      detail: String(cells[3]),
    }
  })
}

export async function ensureController(opts: EnsureControllerOpts): Promise<BtControllerHandle> {
  if (handle) return handle
  const pyodide = await loadPyodide()
  pyodideRef = pyodide
  peersChangedCb = opts.onPeersChanged ?? null

  const sendToHost = (packet: ArrayBuffer | Uint8Array | { toJs?: () => Uint8Array }) => {
    let bytes: Uint8Array
    if (packet instanceof Uint8Array) bytes = packet
    else if (packet instanceof ArrayBuffer) bytes = new Uint8Array(packet)
    else if (packet && typeof packet.toJs === 'function') bytes = packet.toJs()
    else bytes = new Uint8Array(packet as ArrayBuffer)
    opts.onHostPacket(bytes)
  }

  pyodide.globals.set('js_send_to_host', sendToHost)
  pyodide.globals.set('js_peers_changed', () => {
    peersChangedCb?.()
  })
  await pyodide.runPythonAsync(CONTROLLER_PY)

  const onHostPacketPy = pyodide.globals.get('on_host_packet') as (data: Uint8Array) => void
  const closePy = pyodide.globals.get('close') as () => void

  handle = {
    name: 'zephyr-browser',
    onHostPacket: (packet) => {
      onHostPacketPy(packet)
    },
    addPeer: async (typeId) => {
      pyodide.globals.set('_add_peer_type', typeId)
      const peerId = String(await pyodide.runPythonAsync('await add_peer(_add_peer_type)'))
      const peers = readPeerList(pyodide)
      const found = peers.find((p) => p.id === peerId)
      if (!found) throw new Error(`peer ${peerId} missing after add`)
      return found
    },
    removePeer: async (id) => {
      pyodide.globals.set('_remove_peer_id', id)
      await pyodide.runPythonAsync('await remove_peer(_remove_peer_id)')
    },
    listPeers: () => (pyodideRef ? readPeerList(pyodideRef) : []),
    close: () => {
      try {
        closePy()
      } catch {
        /* ignore */
      }
      handle = null
      pyodideRef = null
      peersChangedCb = null
    },
  }
  return handle
}

/** Test helper: drop the cached handle so the next ensure reloads. */
export function resetControllerForTests() {
  handle?.close()
  handle = null
  pyodideRef = null
  peersChangedCb = null
}
