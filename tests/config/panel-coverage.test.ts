import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  GLOBAL_RUNTIME_FIELDS,
  LEGACY_FIELDS,
  PROVIDER_SETTINGS_FIELDS,
  USER_EDITABLE_FIELDS,
  normalizeConfig,
} from '../../client/normalize.js'

const PAGE_VUE = readFileSync(resolve(process.cwd(), 'client/page.vue'), 'utf8')

/**
 * Contract test: every non-deprecated user-editable field in Config must be
 * rendered/referenced by client/page.vue. Avoids brittle UI string matching
 * by using the maintained field set exported from client/normalize.ts.
 */
describe('aka-tools panel field coverage', () => {
  test('page.vue references every USER_EDITABLE_FIELDS entry', () => {
    const missing: string[] = []
    for (const field of USER_EDITABLE_FIELDS) {
      if (!PAGE_VUE.includes(field)) missing.push(field)
    }
    expect(missing, `page.vue missing bindings for: ${missing.join(', ')}`).toEqual([])
  })

  test('page.vue references every provider settings sub-field', () => {
    const missing: string[] = []
    for (const field of PROVIDER_SETTINGS_FIELDS) {
      if (!PAGE_VUE.includes(field)) missing.push(field)
    }
    expect(missing, `page.vue missing provider bindings for: ${missing.join(', ')}`).toEqual([])
  })

  test('required additions listed in the spec are all wired up', () => {
    const REQUIRED = [
      'openaiCompatibleExtraHeaders',
      'showQuotaInImageCommands',
      'securityBlockWindow',
      'securityBlockWarningThreshold',
      'chatlunaContextHistorySize',
      'chatlunaContextTtlSeconds',
      'chatlunaPreferLastGeneratedInPrivateRoom',
      'setupGuide',
    ]
    for (const field of REQUIRED) {
      expect(PAGE_VUE, `expected page.vue to bind ${field}`).toContain(field)
    }
  })

  test('legacy flat provider fields are NOT exposed as v-model bindings', () => {
    // Legacy fields overlap with nested providerSettings names; guard by the
    // v-model form ("cfg.<field>") which would indicate a top-level edit.
    for (const field of LEGACY_FIELDS) {
      const topLevelBinding = new RegExp(`cfg\\.${field}(?![A-Za-z0-9_])`)
      expect(topLevelBinding.test(PAGE_VUE), `page.vue must not bind cfg.${field}`).toBe(false)
    }
  })

  test('global runtime fields (owned by Koishi config page) are NOT bound in aka-tools panel', () => {
    for (const field of GLOBAL_RUNTIME_FIELDS) {
      const topLevelBinding = new RegExp(`cfg\\.${field}(?![A-Za-z0-9_])`)
      expect(topLevelBinding.test(PAGE_VUE), `page.vue must not bind cfg.${field}`).toBe(false)
    }
  })

  test('USER_EDITABLE_FIELDS and GLOBAL_RUNTIME_FIELDS are disjoint', () => {
    const overlap = USER_EDITABLE_FIELDS.filter(f => (GLOBAL_RUNTIME_FIELDS as readonly string[]).includes(f))
    expect(overlap, `fields must be owned by exactly one panel: ${overlap.join(', ')}`).toEqual([])
  })
})

describe('normalizeConfig defaults', () => {
  test('fills every USER_EDITABLE_FIELDS entry when raw is empty', () => {
    const normalized = normalizeConfig({})
    for (const field of USER_EDITABLE_FIELDS) {
      expect(normalized[field], `normalizeConfig({}) must define ${field}`).not.toBeUndefined()
    }
  })

  test('providerSettings gets every sub-field default', () => {
    const normalized = normalizeConfig({})
    for (const field of PROVIDER_SETTINGS_FIELDS) {
      expect(normalized.providerSettings[field], `providerSettings.${field} must be defined`).not.toBeUndefined()
    }
    expect(normalized.providerSettings.openaiCompatibleExtraHeaders).toEqual({})
  })

  test('sanitizes extra headers: drops empty keys, nulls, and coerces values to strings', () => {
    const normalized = normalizeConfig({
      providerSettings: {
        openaiCompatibleExtraHeaders: {
          'X-Foo': 'bar',
          '   ': 'blank-key',
          'X-Empty': '',
          'X-Null': null,
          'X-Number': 42,
        },
      },
    })
    expect(normalized.providerSettings.openaiCompatibleExtraHeaders).toEqual({
      'X-Foo': 'bar',
      'X-Number': '42',
    })
  })

  test('preserves nested arrays without leaking references', () => {
    const raw = { adminUsers: ['a'], modelMappings: [{ suffix: 'x', modelId: 'y' }] }
    const normalized = normalizeConfig(raw)
    normalized.adminUsers.push('b')
    normalized.modelMappings[0].suffix = 'mut'
    expect(raw.adminUsers).toEqual(['a'])
    expect(raw.modelMappings[0].suffix).toBe('x')
  })

  test('carries every GLOBAL_RUNTIME_FIELDS value through untouched (avoids overwriting Koishi-managed settings on save)', () => {
    const raw = { apiTimeout: 123, catalogRefreshHours: 9, logLevel: 'detail' }
    const normalized = normalizeConfig(raw)
    for (const field of GLOBAL_RUNTIME_FIELDS) {
      expect(normalized[field], `normalizeConfig must preserve ${field}`).toBe((raw as any)[field])
    }
  })

  test('does not synthesize defaults for GLOBAL_RUNTIME_FIELDS when raw is empty (Koishi Config Schema owns those defaults)', () => {
    const normalized = normalizeConfig({})
    for (const field of GLOBAL_RUNTIME_FIELDS) {
      expect(normalized[field], `normalizeConfig({}) must not synthesize ${field}`).toBeUndefined()
    }
  })
})
