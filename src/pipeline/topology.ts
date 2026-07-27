/**
 * Static topology of Zephyr's samples/subsys/tracing/pipeline sample.
 *
 * Layout (left → right, bus hanging off the aggregator):
 *
 *   sensor_temp ─┐
 *   sensor_press ─┼→ sensor_q → aggregator ─┬→ frame → consumer0
 *   sensor_imu  ─┘              │             └→       → consumer1
 *                               └→ bus ↔ storage
 */

export type PipelineNodeId =
  | 'sensor_temp'
  | 'sensor_press'
  | 'sensor_imu'
  | 'aggregator'
  | 'consumer0'
  | 'consumer1'
  | 'storage'

export type PipelineEdgeId = 'sensor_q' | 'frame' | 'bus'

export type PipelineColumn = 'sensors' | 'queue' | 'agg' | 'frame' | 'consumers' | 'bus' | 'storage'

export interface PipelineNodeDef {
  id: PipelineNodeId
  /** Exact Zephyr thread name. */
  threadName: string
  /** Short label for the diagram. */
  label: string
  column: PipelineColumn
  /** Vertical slot within the column (0 = top). */
  row: number
}

export interface PipelineEdgeDef {
  id: PipelineEdgeId
  label: string
  /** Sync primitive the sample documents for this hop. */
  kind: 'msgq' | 'condvar' | 'mutex'
}

export const PIPELINE_NODES: readonly PipelineNodeDef[] = [
  { id: 'sensor_temp', threadName: 'sensor_temp', label: 'temp', column: 'sensors', row: 0 },
  { id: 'sensor_press', threadName: 'sensor_press', label: 'press', column: 'sensors', row: 1 },
  { id: 'sensor_imu', threadName: 'sensor_imu', label: 'imu', column: 'sensors', row: 2 },
  { id: 'aggregator', threadName: 'aggregator', label: 'aggregator', column: 'agg', row: 1 },
  { id: 'consumer0', threadName: 'consumer0', label: 'c0', column: 'consumers', row: 0 },
  { id: 'consumer1', threadName: 'consumer1', label: 'c1', column: 'consumers', row: 2 },
  { id: 'storage', threadName: 'storage', label: 'storage', column: 'storage', row: 1 },
]

export const PIPELINE_EDGES: readonly PipelineEdgeDef[] = [
  { id: 'sensor_q', label: 'msgq', kind: 'msgq' },
  { id: 'frame', label: 'frame', kind: 'condvar' },
  { id: 'bus', label: 'bus', kind: 'mutex' },
]

/** Map Zephyr thread name → pipeline node. */
export const NODE_BY_THREAD = new Map(PIPELINE_NODES.map((n) => [n.threadName, n.id]))

/**
 * sensor_sample arg0 → node. Matches the sample's SENSOR_* enum order
 * (temp, press, imu); falls back to the running thread when unknown.
 */
export const SENSOR_BY_ARG0: readonly PipelineNodeId[] = [
  'sensor_temp',
  'sensor_press',
  'sensor_imu',
]
