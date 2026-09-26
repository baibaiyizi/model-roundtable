import type { AppAPI } from '../../shared/types'

declare global { interface Window { roundtable: AppAPI } }
export const api = window.roundtable
export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
