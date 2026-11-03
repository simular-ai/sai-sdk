#!/usr/bin/env node
/**
 * The conformance suite's own tests: the matching, and that every case is well formed and calls
 * only what the README's call table lists.
 *
 *   node conformance/selftest.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { deepEqual, loadCases, subsetDiff } from './server.mjs'

test('subsetDiff', () => {
  assert.equal(subsetDiff({ a: 1 }, { a: 1, b: 2 }), null)
  assert.match(subsetDiff({ a: 1 }, { a: 2 }), /\$\.a: expected 1, got 2/)
  assert.equal(subsetDiff({ a: null }, {}), null)
  assert.match(subsetDiff({ a: 'x' }, {}), /missing/)
  assert.match(subsetDiff([1], [1, 2]), /expected 1 items/)
  assert.equal(subsetDiff({ $regex: '^ab' }, 'abc'), null)
  assert.equal(subsetDiff({ $any: true }, 0), null)
  assert.equal(subsetDiff({ a: { $absent: true } }, {}), null)
  assert.match(subsetDiff({ a: { $absent: true } }, { a: 1 }), /expected absent/)
  assert.equal(subsetDiff({ $len: 2 }, [1, 2]), null)
})

test('deepEqual', () => {
  assert.ok(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }))
  assert.ok(!deepEqual({ a: 1 }, { a: 1, b: undefined }))
  assert.ok(!deepEqual({ a: 1 }, { a: 1, b: null }))
})

// The calls a case may make: the README's table.
const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8')
const CALLS = new Set(
  [...readme.matchAll(/^\| `([A-Za-z_.]+)`(?:, `([A-Za-z_.]+)`)? +\|/gm)].flatMap((m) =>
    m.slice(1).filter(Boolean),
  ),
)

test('every case is well formed', () => {
  const cases = loadCases()
  assert.ok(cases.size > 0)
  for (const c of cases.values()) {
    assert.ok(c.doc, `${c.id}: doc`)
    assert.ok(Array.isArray(c.steps) && c.steps.length, `${c.id}: steps`)
    assert.ok(Array.isArray(c.exchanges), `${c.id}: exchanges`)
    // What each saved name holds, to check the calls made on it.
    const saved = new Map([['client', 'client']])
    for (const [i, step] of c.steps.entries()) {
      const [head, ...rest] = step.call.split('.')
      const kind = saved.get(head) ?? 'client'
      const method = saved.has(head) ? rest.join('.') : step.call
      const call = kind === 'client' ? method : `${kind}.${method}`
      assert.ok(
        CALLS.has(call),
        `${c.id} step ${i}: ${step.call} (${call}) is not in the README's call table`,
      )
      if (step.expect)
        assert.ok('result' in step.expect || 'error' in step.expect, `${c.id} step ${i}: expect`)
      if (step.save) saved.set(step.save, step.pick ? 'value' : savedKind(call))
    }
    for (const [i, ex] of c.exchanges.entries()) {
      assert.match(
        ex.request?.method ?? '',
        /^(GET|POST|PATCH|DELETE)$/,
        `${c.id} exchange ${i}: method`,
      )
      assert.match(ex.request?.path ?? '', /^\/v1\//, `${c.id} exchange ${i}: path`)
    }
  }
})

/** What a call returns, for the calls whose result later steps call methods on. */
function savedKind(call) {
  if (call === 'sessions.create' || call === 'sessions.resume') return 'Session'
  if (call === 'Session.send') return 'Turn'
  if (call === 'control.open') return 'ControlLease'
  if (call === 'tenants.client') return 'client'
  return 'value'
}
