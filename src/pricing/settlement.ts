import type { CostQuote } from './pricing.js'

export type SettlementStatus = 'pending' | 'pre-authorized' | 'settled' | 'failed' | 'refunded'

export interface LedgerEntry {
  id: string
  userId: string
  conversationId?: string
  createdAt: number
  modelId: string
  numImages: number
  creditsPerImage: number
  totalCredits: number
  preAuthorizedCredits: number
  status: SettlementStatus
  quoteEvidence: CostQuote
  actualImages: number
  settlementEvidence: Record<string, unknown> | null
}

export interface SettlementRequest {
  userId: string
  modelId: string
  numImages: number
  quote: CostQuote
  conversationId?: string
}

export interface SettlementResult {
  entryId: string
  status: SettlementStatus
  chargedCredits: number
  actualImages: number
  refundCredits: number
}

export interface SettlementStore {
  preAuthorize(entry: LedgerEntry): Promise<void>
  settle(entryId: string, actualImages: number, evidence: Record<string, unknown> | null): Promise<SettlementResult>
  refund(entryId: string): Promise<SettlementResult>
}
