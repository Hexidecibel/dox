/**
 * Compute confidence score for document extraction results.
 * Validates actual field quality rather than trusting LLM self-assessment.
 */
export function computeConfidenceScore(
  aiConfidence: string | undefined,
  extractedFields: Record<string, any>,
  tables: Array<{ name?: string; headers?: string[]; rows?: any[][] }> = []
): number {
  // Lower base weights — LLM self-assessment is unreliable
  let score = aiConfidence === 'high' ? 0.85 : aiConfidence === 'medium' ? 0.55 : 0.25;

  const fields = extractedFields || {};
  const nonNullFields = Object.entries(fields).filter(([, v]) => v != null && String(v).trim() !== '');

  // Bonus for finding data (up to +0.08)
  score += Math.min(nonNullFields.length * 0.01, 0.08);

  // Reward key document fields being present (+0.02 each, up to +0.06)
  const keyFields = ['supplier_name', 'product_name', 'lot_number'];
  for (const key of keyFields) {
    if (fields[key] != null && String(fields[key]).trim() !== '') {
      score += 0.02;
    }
  }

  // Reward having at least one date field (+0.02)
  const hasDate = Object.entries(fields).some(
    ([k, v]) => k.includes('date') && v != null && String(v).trim() !== ''
  );
  if (hasDate) score += 0.02;

  // Reward having test results table with actual rows (+0.03)
  const hasTestResults = tables.some(
    t => t.rows && t.rows.length > 0 && t.headers && t.headers.length > 0
  );
  if (hasTestResults) score += 0.03;

  // Penalize date fields that don't look like dates (-0.08 each)
  for (const [key, value] of Object.entries(fields)) {
    if (value && key.includes('date')) {
      const v = String(value);
      const looksLikeDate =
        /\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(v) ||
        /\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/.test(v);
      if (!looksLikeDate) {
        score -= 0.08;
      }
    }
  }

  // Penalize very short lot numbers (-0.05)
  const lotValue = fields['lot_number'];
  if (lotValue && String(lotValue).trim().length < 3) {
    score -= 0.05;
  }

  // Penalize uncertainty markers (-0.05 each)
  for (const [, value] of nonNullFields) {
    if (String(value).includes('(?)')) {
      score -= 0.05;
    }
  }

  return Math.max(0, Math.min(1, score));
}
