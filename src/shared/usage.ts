/** Token counts must be actual non-negative integers, never coerced or estimated. */
export function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
