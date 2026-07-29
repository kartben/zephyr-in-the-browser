import {
  buildSemanticGraph,
  type FlowNodeSpec,
  type FlowSpec,
} from '@/components/queueGraph/model'

function nodesForCapacities(large: boolean): FlowNodeSpec[] {
  return [
    { id: 'thread:main', kind: 'thread', label: 'main', detail: 'priority 0' },
    { id: 'thread:input', kind: 'thread', label: 'input', detail: 'priority 2' },
    { id: 'thread:logging', kind: 'thread', label: 'logging', detail: 'priority 5' },
    { id: 'thread:idle', kind: 'thread', label: 'idle', detail: 'priority 15' },
    {
      id: 'object:input-msgq',
      kind: 'msgq',
      label: 'input_msgq',
      depth: large ? 12_288 : 3,
      capacity: large ? 1_048_576 : 8,
    },
    {
      id: 'object:state-stack',
      kind: 'stack',
      label: '0x40070000',
      depth: large ? 1_536 : 3,
      capacity: large ? 4_096 : 6,
    },
  ]
}

const flows: FlowSpec[] = [
  {
    id: 'flow:main-put-msgq',
    threadId: 'thread:main',
    objectId: 'object:input-msgq',
    action: 'put',
  },
  {
    id: 'flow:logging-put-front-msgq',
    threadId: 'thread:logging',
    objectId: 'object:input-msgq',
    action: 'put-front',
  },
  {
    id: 'flow:input-get-msgq',
    threadId: 'thread:input',
    objectId: 'object:input-msgq',
    action: 'get',
  },
  {
    id: 'flow:logging-push-stack',
    threadId: 'thread:logging',
    objectId: 'object:state-stack',
    action: 'push',
  },
  {
    id: 'flow:main-pop-stack',
    threadId: 'thread:main',
    objectId: 'object:state-stack',
    action: 'pop',
  },
  {
    id: 'flow:idle-pop-stack',
    threadId: 'thread:idle',
    objectId: 'object:state-stack',
    action: 'pop',
  },
]

export const queueGraphMock = buildSemanticGraph(nodesForCapacities(false), flows)
export const queueGraphLargeCapacityMock = buildSemanticGraph(nodesForCapacities(true), flows)

const routingStressNodes: FlowNodeSpec[] = [
  { id: 'thread:main', kind: 'thread', label: 'main', detail: 'priority 0' },
  { id: 'thread:sensor-rx', kind: 'thread', label: 'sensor_rx', detail: 'priority 1' },
  { id: 'thread:input', kind: 'thread', label: 'input', detail: 'priority 2' },
  { id: 'thread:router', kind: 'thread', label: 'router', detail: 'priority 3' },
  { id: 'thread:control', kind: 'thread', label: 'control', detail: 'priority 4' },
  { id: 'thread:worker', kind: 'thread', label: 'worker', detail: 'priority 5' },
  { id: 'thread:logger', kind: 'thread', label: 'logger', detail: 'priority 6' },
  { id: 'thread:telemetry', kind: 'thread', label: 'telemetry', detail: 'priority 7' },
  { id: 'thread:watchdog', kind: 'thread', label: 'watchdog', detail: 'priority 8' },
  { id: 'thread:shell', kind: 'thread', label: 'shell', detail: 'priority 9' },
  { id: 'thread:storage', kind: 'thread', label: 'storage', detail: 'priority 10' },
  { id: 'thread:idle', kind: 'thread', label: 'idle', detail: 'priority 15' },
  { id: 'object:input-msgq', kind: 'msgq', label: 'input_msgq', depth: 13, capacity: 64 },
  { id: 'object:command-fifo', kind: 'fifo', label: 'command_fifo', depth: 4, capacity: null },
  { id: 'object:work-queue', kind: 'queue', label: 'work_queue', depth: 7, capacity: null },
  { id: 'object:undo-lifo', kind: 'lifo', label: 'undo_lifo', depth: 2, capacity: null },
  { id: 'object:state-stack', kind: 'stack', label: 'state_stack', depth: 11, capacity: 32 },
  { id: 'object:log-msgq', kind: 'msgq', label: 'log_msgq', depth: 48, capacity: 256 },
  { id: 'object:telemetry-fifo', kind: 'fifo', label: 'telemetry_fifo', depth: 3, capacity: null },
]

const routingStressFlows: FlowSpec[] = [
  { id: 'stress:main-input', threadId: 'thread:main', objectId: 'object:input-msgq', action: 'put' },
  { id: 'stress:sensor-input', threadId: 'thread:sensor-rx', objectId: 'object:input-msgq', action: 'put' },
  { id: 'stress:shell-input-front', threadId: 'thread:shell', objectId: 'object:input-msgq', action: 'put-front' },
  { id: 'stress:input-read', threadId: 'thread:input', objectId: 'object:input-msgq', action: 'get' },
  { id: 'stress:input-command', threadId: 'thread:input', objectId: 'object:command-fifo', action: 'put' },
  { id: 'stress:router-command', threadId: 'thread:router', objectId: 'object:command-fifo', action: 'get' },
  { id: 'stress:router-work', threadId: 'thread:router', objectId: 'object:work-queue', action: 'put' },
  { id: 'stress:control-work-front', threadId: 'thread:control', objectId: 'object:work-queue', action: 'put-front' },
  { id: 'stress:worker-work', threadId: 'thread:worker', objectId: 'object:work-queue', action: 'get' },
  { id: 'stress:main-work', threadId: 'thread:main', objectId: 'object:work-queue', action: 'get' },
  { id: 'stress:router-undo', threadId: 'thread:router', objectId: 'object:undo-lifo', action: 'push' },
  { id: 'stress:main-undo', threadId: 'thread:main', objectId: 'object:undo-lifo', action: 'push' },
  { id: 'stress:shell-undo', threadId: 'thread:shell', objectId: 'object:undo-lifo', action: 'pop' },
  { id: 'stress:worker-state', threadId: 'thread:worker', objectId: 'object:state-stack', action: 'push' },
  { id: 'stress:storage-state', threadId: 'thread:storage', objectId: 'object:state-stack', action: 'push' },
  { id: 'stress:control-state', threadId: 'thread:control', objectId: 'object:state-stack', action: 'pop' },
  { id: 'stress:watchdog-state', threadId: 'thread:watchdog', objectId: 'object:state-stack', action: 'pop' },
  { id: 'stress:idle-state', threadId: 'thread:idle', objectId: 'object:state-stack', action: 'pop' },
  { id: 'stress:worker-log', threadId: 'thread:worker', objectId: 'object:log-msgq', action: 'put' },
  { id: 'stress:control-log', threadId: 'thread:control', objectId: 'object:log-msgq', action: 'put' },
  { id: 'stress:router-log', threadId: 'thread:router', objectId: 'object:log-msgq', action: 'put' },
  { id: 'stress:storage-log-front', threadId: 'thread:storage', objectId: 'object:log-msgq', action: 'put-front' },
  { id: 'stress:logger-log', threadId: 'thread:logger', objectId: 'object:log-msgq', action: 'get' },
  { id: 'stress:logger-telemetry', threadId: 'thread:logger', objectId: 'object:telemetry-fifo', action: 'put' },
  { id: 'stress:telemetry-read', threadId: 'thread:telemetry', objectId: 'object:telemetry-fifo', action: 'get' },
]

export const queueGraphRoutingStressMock = buildSemanticGraph(
  routingStressNodes,
  routingStressFlows,
)
