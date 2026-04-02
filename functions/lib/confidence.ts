import type { ExtractionField } from '../../shared/types';

export function computeConfidenceScore(
  aiConfidence: 'high' | 'medium' | 'low',
  extractedFields: Record<string, string | null>,
  expectedFields: ExtractionField[]
): number {
  // Base score from AI self-assessment
  let score = aiConfidence === 'high' ? 0.9 : aiConfidence === 'medium' ? 0.6 : 0.3;

  // Penalize missing expected fields
  const expectedCount = expectedFields.length;
  const extractedCount = Object.values(extractedFields).filter(v => v !== null && v !== '').length;
  if (expectedCount > 0) {
    const missingPenalty = Math.max(0, expectedCount - extractedCount) * 0.05;
    score -= missingPenalty;
  }

  // Validate date field plausibility
  const dateFieldNames = ['expiration_date', 'code_date', 'date', 'production_date'];
  for (const [key, value] of Object.entries(extractedFields)) {
    if (value && dateFieldNames.some(d => key.includes(d))) {
      // Check if it looks like a date (YYYY-MM-DD or common formats)
      if (!/\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(value) && !/\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/.test(value)) {
        score -= 0.1;
      }
    }
  }

  // Penalize very short lot numbers
  const lotValue = extractedFields['lot_number'];
  if (lotValue && lotValue.length < 3) {
    score -= 0.05;
  }

  return Math.max(0, Math.min(1, score));
}
