const STANDARD_FIELDS = ['lot_number', 'po_number', 'code_date', 'expiration_date'];

export function computeConfidenceScore(
  aiConfidence: 'high' | 'medium' | 'low',
  extractedFields: Record<string, string | null>,
): number {
  // Base score from AI self-assessment
  let score = aiConfidence === 'high' ? 0.9 : aiConfidence === 'medium' ? 0.6 : 0.3;

  // Bonus for finding standard fields
  const foundStandard = STANDARD_FIELDS.filter(f => extractedFields[f] != null).length;
  score += foundStandard * 0.02;

  // Small bonus for finding more data overall (capped)
  const totalFields = Object.values(extractedFields).filter(v => v != null).length;
  score += Math.min(totalFields * 0.005, 0.05);

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
