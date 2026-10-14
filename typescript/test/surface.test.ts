import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import * as sdk from '../src/index.js'
import {
  ControlLease,
  EVENT_KINDS,
  Sai,
  Session,
  TURN_RECORD_STATUSES,
  TURN_STATUSES,
  Turn,
} from '../src/index.js'

// surface.json is the contract every language's SDK implements (AGENTS.md).
const surface = JSON.parse(
  readFileSync(new URL('../../surface.json', import.meta.url), 'utf8'),
) as {
  resources: Record<string, string[]>
  objects: Record<string, string[]>
  errors: string[]
  event_kinds: string[]
  turn_statuses: string[]
  turn_record_statuses: string[]
}

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())

function publicMethods(proto: object): string[] {
  return Object.getOwnPropertyNames(proto)
    .filter((n) => n !== 'constructor' && !n.startsWith('_'))
    .filter((n) => {
      const d = Object.getOwnPropertyDescriptor(proto, n)
      return typeof d?.value === 'function'
    })
    .sort()
}

describe('surface parity with surface.json', () => {
  const sai = new Sai({ apiKey: 'sapi_test', fetch: async () => new Response('{}') })

  it('client resources', () => {
    const attrs = Object.keys(sai).sort()
    expect(attrs).toEqual(surface.resources.client!.map(camel).sort())
  })

  for (const [resource, methods] of Object.entries(surface.resources)) {
    if (resource === 'client') continue
    it(`${resource} methods`, () => {
      const obj = (sai as unknown as Record<string, object>)[camel(resource)]!
      // resolveId is internal plumbing shared with sessions
      const actual = publicMethods(Object.getPrototypeOf(obj)).filter((m) => m !== 'resolveId')
      expect(actual).toEqual(methods.map(camel).sort())
    })
  }

  const classes: Record<string, { prototype: object }> = { Session, Turn, ControlLease }
  for (const [name, methods] of Object.entries(surface.objects)) {
    it(`${name} methods`, () => {
      expect(publicMethods(classes[name]!.prototype)).toEqual(methods.map(camel).sort())
    })
  }

  it('errors', () => {
    const exported = Object.entries(sdk)
      .filter(
        ([, v]) =>
          typeof v === 'function' && (v === sdk.SaiError || v.prototype instanceof sdk.SaiError),
      )
      .map(([k]) => k)
      .sort()
    expect(exported).toEqual([...surface.errors].sort())
  })

  it('event kinds, turn statuses and turn record statuses', () => {
    expect([...EVENT_KINDS]).toEqual(surface.event_kinds)
    expect([...TURN_STATUSES]).toEqual(surface.turn_statuses)
    expect([...TURN_RECORD_STATUSES]).toEqual(surface.turn_record_statuses)
  })
})
