import { describe, expect, test } from 'vitest'
import type { Session } from 'koishi'

import { isGroupChat, resolveInteractionMode } from '../../src/shared/interaction-mode.js'

function makeSession(fields: Partial<Session>): Session {
  return fields as unknown as Session
}

describe('isGroupChat', () => {
  test('returns false when session is missing', () => {
    expect(isGroupChat(null)).toBe(false)
    expect(isGroupChat(undefined)).toBe(false)
  })

  test('isDirect === true forces private chat', () => {
    const session = makeSession({ isDirect: true, guildId: 'ignored', channelId: 'ignored', userId: 'u1' })
    expect(isGroupChat(session)).toBe(false)
  })

  test('isDirect === false forces group chat', () => {
    const session = makeSession({ isDirect: false, userId: 'u1' })
    expect(isGroupChat(session)).toBe(true)
  })

  test('guildId falls back to group when isDirect missing', () => {
    const session = makeSession({ guildId: 'g1', userId: 'u1' })
    expect(isGroupChat(session)).toBe(true)
  })

  test('channelId ≠ userId falls back to group when isDirect/guildId missing', () => {
    const session = makeSession({ channelId: 'c1', userId: 'u1' })
    expect(isGroupChat(session)).toBe(true)
  })

  test('channelId equals userId is treated as private', () => {
    const session = makeSession({ channelId: 'u1', userId: 'u1' })
    expect(isGroupChat(session)).toBe(false)
  })

  test('empty session returns false', () => {
    expect(isGroupChat(makeSession({}))).toBe(false)
  })
})

describe('resolveInteractionMode', () => {
  test('advanced global mode ignores session type', () => {
    expect(resolveInteractionMode('advanced', undefined, makeSession({ isDirect: true }))).toBe('advanced')
    expect(resolveInteractionMode('advanced', undefined, makeSession({ isDirect: false }))).toBe('advanced')
  })

  test('guided global mode ignores session type', () => {
    expect(resolveInteractionMode('guided', undefined, makeSession({ isDirect: true }))).toBe('guided')
    expect(resolveInteractionMode('guided', undefined, makeSession({ isDirect: false }))).toBe('guided')
  })

  test('auto uses group=advanced, private=guided', () => {
    expect(resolveInteractionMode('auto', undefined, makeSession({ isDirect: false }))).toBe('advanced')
    expect(resolveInteractionMode('auto', undefined, makeSession({ isDirect: true }))).toBe('guided')
  })

  test('auto with no session falls back to guided (private)', () => {
    expect(resolveInteractionMode('auto', undefined, undefined)).toBe('guided')
  })

  test('platform override advanced beats guided global', () => {
    const session = makeSession({ platform: 'lark', isDirect: true })
    expect(resolveInteractionMode('guided', { lark: 'advanced' }, session)).toBe('advanced')
  })

  test('platform override guided beats advanced global', () => {
    const session = makeSession({ platform: 'onebot', isDirect: false })
    expect(resolveInteractionMode('advanced', { onebot: 'guided' }, session)).toBe('guided')
  })

  test('platform override auto still resolves by session type', () => {
    const groupSession = makeSession({ platform: 'lark', isDirect: false })
    const privateSession = makeSession({ platform: 'lark', isDirect: true })
    expect(resolveInteractionMode('advanced', { lark: 'auto' }, groupSession)).toBe('advanced')
    expect(resolveInteractionMode('advanced', { lark: 'auto' }, privateSession)).toBe('guided')
  })

  test('unknown platform falls back to global mode', () => {
    const session = makeSession({ platform: 'qq', isDirect: false })
    expect(resolveInteractionMode('guided', { lark: 'advanced' }, session)).toBe('guided')
  })

  test('empty overrides object falls back to global mode', () => {
    const session = makeSession({ platform: 'lark', isDirect: true })
    expect(resolveInteractionMode('advanced', {}, session)).toBe('advanced')
  })

  test('session without platform ignores overrides', () => {
    expect(resolveInteractionMode('guided', { lark: 'advanced' }, makeSession({ isDirect: true }))).toBe('guided')
  })
})
