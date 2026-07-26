/** Public CTF trace parsing and rendering surface. */

export {
  fallbackDefs,
  loadEventDefs,
  parseMetadata,
  makeEventDef,
  decodeFields,
  type EventDef,
} from './metadata'
export {
  TraceReader,
  laneOrder,
  threadLabel,
  fmtTime,
  niceTimeStep,
  renderStateRows,
  stateAt,
  threadRunningAt,
  windowStats,
  contextSwitchesIn,
  type CtfEvent,
  type Trace,
  type ThreadInfo,
  type StateSeg,
} from './reader'
export {
  STATE_COLOR,
  STATE_LABEL,
  STATE_PREC,
  type ThreadState,
  FALLBACK_EVENTS,
} from './types'
