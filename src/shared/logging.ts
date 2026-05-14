export type LogLevel = 'simple' | 'detail' | 'info' | 'debug'

export function normalizeLogLevel(value: unknown): 'simple' | 'detail' {
  return value === 'detail' || value === 'debug' ? 'detail' : 'simple'
}

export function isDetailLogLevel(value: unknown): boolean {
  return normalizeLogLevel(value) === 'detail'
}
