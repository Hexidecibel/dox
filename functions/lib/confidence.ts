export function computeConfidenceScore(
  aiConfidence: 'high' | 'medium' | 'low',
  extractedFields: Record<string, string | null>,
): number {
  // Base score from AI self-assessment
  let score = aiConfidence === 'high' ? 0.9 : aiConfidence === 'medium' ? 0.6 : 0.3;

  // Bonus for finding more data overall (capped)
  const totalFields = Object.values(extractedFields).filter(v => v != null).length;
  score += Math.min(totalFields * 0.01, 0.08);

  // Validate date field plausibility
  for (const [key, value] of Object.entries(extractedFields)) {
    if (value && key.includes('date')) {
      // Check if it looks like a date (YYYY-MM-DD or common formats)
      if (!/\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(value) && !/\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/.test(value)) {
        score -= 0.1;
      }
    }
  }

  // Penalize very short lot/batch numbers
  const lotValue = extractedFields['lot_number'] || extractedFields['batch_number'];
  if (lotValue && lotValue.length < 3) {
    score -= 0.05;
  }

  return Math.max(0, Math.min(1, score));
}
