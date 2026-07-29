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
