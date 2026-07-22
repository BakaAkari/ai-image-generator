import { describe, test, expect } from 'vitest'
import type { CostQuote } from '../../src/pricing/pricing.js'
import type { LedgerEntry } from '../../src/pricing/settlement.js'

describe('settlement types', () => {
  test('LedgerEntry has status and evidence fields', () => {
    const quote: CostQuote = {
      costUsdPerImage: 0.01,
      creditsPerImage: 13,
      totalCostUsd: 0.01,
      totalCredits: 13,
      numImages: 1,
      kind: 'catalog-quote',
      pricingMode: 'per-call',
      fallback: false,
      evidence: {
        modelId: 'dall-e-3',
        creditExchangeRate: 1000,
        costMarkup: 1.3,
        explanation: 'test',
      },
    }
    const entry: LedgerEntry = {
      id: 'entry-1',
      userId: 'u1',
      createdAt: Date.now(),
      modelId: 'dall-e-3',
      numImages: 1,
      creditsPerImage: 13,
      totalCredits: 13,
      preAuthorizedCredits: 13,
      status: 'pre-authorized',
      quoteEvidence: quote,
      actualImages: 0,
      settlementEvidence: null,
    }
    expect(entry.status).toBe('pre-authorized')
    expect(entry.quoteEvidence.totalCredits).toBe(13)
  })
})
