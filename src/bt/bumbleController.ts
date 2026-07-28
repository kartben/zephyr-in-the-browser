/**
 * Lazy Bumble virtual controller under Pyodide.
 *
 * Vendoring and pin details: public/vendor/bumble/README.md
 * (wheel) and the Pyodide CDN pin in {@link PYODIDE_INDEX_URL}.
 *
 * Peers share the controller's LocalLink — the page is the air.
 * Speaker peers push A2DP SBC payloads to {@link ./speakerAudio}.
 */

import { onSpeakerPacket } from '@/bt/speakerAudio'

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
  /** Live params for a peer (speaker stream counters, etc.). */
  peerParams?: (id: string) => Record<string, string | number | boolean> | null
  setPeerParam: (id: string, key: string, value: string | number | boolean) => Promise<void>
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
from bumble.a2dp import (
    A2DP_SBC_CODEC_TYPE,
    SbcMediaCodecInformation,
    make_audio_sink_service_sdp_records,
)
from bumble.avdtp import (
    AVDTP_AUDIO_MEDIA_TYPE,
    Listener,
    MediaCodecCapabilities,
)
from bumble.controller import Controller
from bumble.core import AdvertisingData
from bumble.device import Device, DeviceConfiguration
from bumble.gatt import GATT_HEART_RATE_SERVICE
from bumble.hci import Address
from bumble.host import Host
from bumble.link import LocalLink
from bumble.pairing import PairingConfig
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
    'speaker': 'Speaker',
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

def _speaker_detail(info):
    state = info.get('stream_state', 'idle')
    pkts = info.get('packets', 0)
    muted = ' · muted' if info.get('muted') else ''
    if state in ('started', 'suspended') or pkts:
        return f'{state} · {pkts} pkts{muted}'
    if not info.get('discoverable', True):
        return f'hidden{muted}'
    return f'A2DP sink · discoverable{muted}'

def _sbc_capabilities():
    freqs = (
        SbcMediaCodecInformation.SamplingFrequency.SF_16000
        | SbcMediaCodecInformation.SamplingFrequency.SF_32000
        | SbcMediaCodecInformation.SamplingFrequency.SF_44100
        | SbcMediaCodecInformation.SamplingFrequency.SF_48000
    )
    return MediaCodecCapabilities(
        media_type=AVDTP_AUDIO_MEDIA_TYPE,
        media_codec_type=A2DP_SBC_CODEC_TYPE,
        media_codec_information=SbcMediaCodecInformation(
            sampling_frequency=freqs,
            channel_mode=(
                SbcMediaCodecInformation.ChannelMode.MONO
                | SbcMediaCodecInformation.ChannelMode.DUAL_CHANNEL
                | SbcMediaCodecInformation.ChannelMode.STEREO
                | SbcMediaCodecInformation.ChannelMode.JOINT_STEREO
            ),
            block_length=(
                SbcMediaCodecInformation.BlockLength.BL_4
                | SbcMediaCodecInformation.BlockLength.BL_8
                | SbcMediaCodecInformation.BlockLength.BL_12
                | SbcMediaCodecInformation.BlockLength.BL_16
            ),
            subbands=(
                SbcMediaCodecInformation.Subbands.S_4
                | SbcMediaCodecInformation.Subbands.S_8
            ),
            allocation_method=(
                SbcMediaCodecInformation.AllocationMethod.LOUDNESS
                | SbcMediaCodecInformation.AllocationMethod.SNR
            ),
            minimum_bitpool_value=2,
            maximum_bitpool_value=53,
        ),
    )

def on_host_packet(data):
    controller.on_packet(bytes(data))

def list_peers():
    out = []
    for peer_id, info in _peers.items():
        out.append((peer_id, info['type'], info['name'], info['detail']))
    return out

def get_peer_params(peer_id: str):
    info = _peers.get(peer_id)
    if info is None:
        return None
    if info['type'] == 'speaker':
        return (
            info.get('stream_state', 'idle'),
            int(info.get('packets', 0)),
            int(info.get('bytes', 0)),
            bool(info.get('muted', False)),
            bool(info.get('discoverable', True)),
            bool(info.get('connectable', True)),
            'sbc',
        )
    return None

async def _publish_heart_rate(peer_id, device, service):
    while True:
        await asyncio.sleep(1)
        info = _peers.get(peer_id)
        if info is None:
            return
        await device.notify_subscribers(
            service.heart_rate_measurement_characteristic,
            HeartRateService.HeartRateMeasurement(heart_rate=info['bpm']),
        )

async def _add_le_peer(type_id, peer_id, name, peer_ctl):
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
            info = _peers.get(peer_id)
            return HeartRateService.HeartRateMeasurement(
                heart_rate=info['bpm'] if info is not None else 72
            )
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
        'bpm': 72,
    }
    if hr_service is not None:
        _peers[peer_id]['notify_task'] = asyncio.create_task(
            _publish_heart_rate(peer_id, device, hr_service)
        )

async def _add_speaker(peer_id, name, peer_ctl):
    config = DeviceConfiguration()
    config.name = name
    # AV major + wearable-headset minor (0x240404). The stock Zephyr
    # a2dp_source sample filters inquiry results on that CoD pair.
    config.class_of_device = 0x240404
    config.classic_enabled = True
    config.le_enabled = False
    config.address = peer_ctl.public_address

    host = Host(controller_source=peer_ctl, controller_sink=peer_ctl)
    device = Device(config=config, host=host)
    device.sdp_service_records = {
        0x00010001: make_audio_sink_service_sdp_records(0x00010001)
    }
    device.pairing_config_factory = lambda _connection: PairingConfig(mitm=False)

    info = {
        'type': 'speaker',
        'name': name,
        'detail': 'A2DP sink · discoverable',
        'device': device,
        'controller': peer_ctl,
        'stream_state': 'idle',
        'packets': 0,
        'bytes': 0,
        'muted': False,
        'discoverable': True,
        'connectable': True,
    }
    _peers[peer_id] = info

    def on_bt_connection(_connection):
        info['stream_state'] = 'connected'
        info['detail'] = _speaker_detail(info)
        _notify_peers()

    def on_bt_disconnection(_reason):
        info['stream_state'] = 'idle'
        info['detail'] = _speaker_detail(info)
        _notify_peers()
        asyncio.get_running_loop().create_task(device.set_discoverable(True))
        asyncio.get_running_loop().create_task(device.set_connectable(True))

    def on_avdtp(protocol):
        sink = protocol.add_sink(_sbc_capabilities())

        def on_start():
            info['stream_state'] = 'started'
            info['detail'] = _speaker_detail(info)
            _notify_peers()

        def on_stop():
            info['stream_state'] = 'stopped'
            info['detail'] = _speaker_detail(info)
            _notify_peers()

        def on_suspend():
            info['stream_state'] = 'suspended'
            info['detail'] = _speaker_detail(info)
            _notify_peers()

        def on_rtp(packet):
            info['packets'] = info.get('packets', 0) + 1
            info['bytes'] = info.get('bytes', 0) + len(packet.payload)
            # Throttle UI updates — every 8th packet is enough for the roster.
            if info['packets'] == 1 or info['packets'] % 8 == 0:
                info['detail'] = _speaker_detail(info)
                _notify_peers()
            if info.get('muted'):
                return
            try:
                # A2DP media payload (1-byte header + SBC frames).
                js_speaker_audio(peer_id, packet.payload)
            except Exception:
                pass

        sink.on('start', on_start)
        sink.on('stop', on_stop)
        sink.on('suspend', on_suspend)
        sink.on('rtp_packet', on_rtp)

    device.on('connection', on_bt_connection)
    device.on('disconnection', on_bt_disconnection)

    await device.power_on()
    listener = Listener.for_device(device)
    listener.on('connection', on_avdtp)
    info['listener'] = listener
    await device.set_discoverable(True)
    await device.set_connectable(True)

async def add_peer(type_id: str):
    global _seq
    if type_id not in _TYPE_NAMES:
        raise ValueError(f'unknown peer type: {type_id}')
    _seq += 1
    peer_id = f'{type_id}-{_seq}'
    name = f'{_TYPE_NAMES[type_id]} {_seq}'
    # Unique public address so classic LocalLink routing can find the speaker.
    addr = Address(
        bytes([0xF0, 0x42, 0x54, 0x00, (_seq >> 8) & 0xFF, _seq & 0xFF]),
        Address.PUBLIC_DEVICE_ADDRESS,
    )
    peer_ctl = Controller(peer_id, link=link, public_address=addr)

    if type_id == 'speaker':
        await _add_speaker(peer_id, name, peer_ctl)
    else:
        await _add_le_peer(type_id, peer_id, name, peer_ctl)
    return peer_id

async def set_peer_param(peer_id: str, key: str, value):
    info = _peers.get(peer_id)
    if info is None:
        raise ValueError(f'unknown peer: {peer_id}')
    device = info['device']
    if info['type'] == 'hrm' and key == 'bpm':
        bpm = int(value)
        if bpm < 0 or bpm > 0xFFFF:
            raise ValueError(f'heart rate out of range: {bpm}')
        info['bpm'] = bpm
        info['detail'] = f'{bpm} BPM · advertising'
        _notify_peers()
        return
    if info['type'] == 'speaker':
        if key == 'muted':
            info['muted'] = bool(value)
            info['detail'] = _speaker_detail(info)
            _notify_peers()
            return
        if key == 'discoverable':
            info['discoverable'] = bool(value)
            await device.set_discoverable(bool(value))
            info['detail'] = _speaker_detail(info)
            _notify_peers()
            return
        if key == 'connectable':
            info['connectable'] = bool(value)
            await device.set_connectable(bool(value))
            info['detail'] = _speaker_detail(info)
            _notify_peers()
            return
    # Other peer types: params applied from the JS overlay for now.

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
        elif info['type'] == 'speaker':
            await device.set_discoverable(False)
            await device.set_connectable(False)
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
  // A2DP SBC frames → WASM decode → Web Audio (enable() required first).
  pyodide.globals.set(
    'js_speaker_audio',
    (peerId: string, payload: ArrayBuffer | Uint8Array | { toJs?: () => Uint8Array }) => {
      let bytes: Uint8Array
      if (payload instanceof Uint8Array) bytes = payload
      else if (payload instanceof ArrayBuffer) bytes = new Uint8Array(payload)
      else if (payload && typeof payload.toJs === 'function') bytes = payload.toJs()
      else bytes = new Uint8Array(payload as ArrayBuffer)
      onSpeakerPacket(String(peerId), bytes)
    },
  )
  await pyodide.runPythonAsync(CONTROLLER_PY)

  const onHostPacketPy = pyodide.globals.get('on_host_packet') as (data: Uint8Array) => void
  const closePy = pyodide.globals.get('close') as () => void
  const getPeerParamsPy = pyodide.globals.get('get_peer_params') as (id: string) => unknown

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
    peerParams: (id) => {
      if (!pyodideRef) return null
      const raw = getPeerParamsPy(id) as
        | null
        | { toJs?: () => unknown[]; length?: number; [i: number]: unknown }
      if (raw == null) return null
      const cells =
        raw && typeof raw.toJs === 'function'
          ? (raw.toJs() as unknown[])
          : Array.from(raw as ArrayLike<unknown>)
      if (!cells.length) return null
      return {
        streamState: String(cells[0]),
        packets: Number(cells[1]),
        bytes: Number(cells[2]),
        muted: Boolean(cells[3]),
        discoverable: Boolean(cells[4]),
        connectable: Boolean(cells[5]),
        codec: String(cells[6] ?? 'sbc'),
      }
    },
    setPeerParam: async (id, key, value) => {
      pyodide.globals.set('_param_peer_id', id)
      pyodide.globals.set('_param_key', key)
      pyodide.globals.set('_param_value', value)
      await pyodide.runPythonAsync('await set_peer_param(_param_peer_id, _param_key, _param_value)')
    },
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
