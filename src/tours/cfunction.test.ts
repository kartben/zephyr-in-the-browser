import { describe, expect, it } from 'vitest'
import { functionLines } from '@/tours/cfunction'

const SOURCE = [
  '/* storage_entry() { is not code */', //  0
  'static void storage_entry(void *p1);', //  1 a prototype
  '#define BUS_UNLOCK() k_mutex_unlock(&bus)', //  2
  '', //  3
  'static void publish(void)', //  4
  '{', //  5
  '\tconst char *s = "storage_entry(x) {";', //  6 a string
  '\tBUS_UNLOCK();', //  7
  '}', //  8
  '', //  9
  'static void storage_entry(void *p1)', // 10 the definition
  '{', // 11
  "\tchar brace = '}';", // 12 a character literal
  '\twhile (1) {', // 13
  '\t\tops->storage_entry(p1);', // 14 a member call
  '\t\tBUS_UNLOCK();', // 15
  '\t}', // 16
  '}', // 17
  'K_THREAD_DEFINE(t, 512, storage_entry, NULL, NULL, NULL, 9, 0, 0);', // 18
]

describe('functionLines', () => {
  it('finds a definition, past its prototype, comments and strings', () => {
    expect(functionLines(SOURCE, 'storage_entry')).toEqual({ first: 10, last: 17 })
    expect(functionLines(SOURCE, 'publish')).toEqual({ first: 4, last: 8 })
  })

  it('is null for a function the file only declares, calls or names', () => {
    expect(functionLines(SOURCE, 'k_mutex_unlock')).toBeNull()
    expect(functionLines(SOURCE, 'BUS_UNLOCK')).toBeNull()
    expect(functionLines(SOURCE, 'missing')).toBeNull()
    expect(functionLines(SOURCE, 'not a name')).toBeNull()
  })

  it('finds the storage thread in the stock tracing pipeline sample', () => {
    // Its shape, not a copy that would pin a version: two BUS_UNLOCK() lines.
    const text = [
      'static void publish_frame(void)',
      '{',
      '\tBUS_LOCK();',
      '\tBUS_UNLOCK();',
      '}',
      'static void storage_entry(void *p1, void *p2, void *p3)',
      '{',
      '\twhile (1) {',
      '\t\tBUS_LOCK();',
      '\t\tBUS_UNLOCK();',
      '\t}',
      '}',
    ]
    expect(functionLines(text, 'storage_entry')).toEqual({ first: 5, last: 11 })
  })
})
