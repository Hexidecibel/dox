/**
 * What tests/unit/noFirstTenantValues.test.ts deliberately lets through.
 *
 * Every entry is a path, a pattern matched against the offending line (with
 * comments already removed), and the reason it stays. Add one only when the
 * value is not the first tenant's to begin with, or when removing it is a
 * behaviour change that belongs to its own piece of work -- and say which.
 */
import type { AllowEntry } from './noFirstTenantValues.scan';

/**
 * PROMPT TEXT, HELD FOR MEASUREMENT. Every line below is sent to a model, and
 * in this project a prompt does not change on the strength of reading it: it
 * changes when bin/eval-aj-docs and bin/measure-doctype-extraction say the
 * numbers held. The replacements are written and sit on their own commit; that
 * commit DELETES this block. If you are reading this on master, the prompt
 * cleanup has not been measured and merged yet.
 */
const PENDING_PROMPT_MEASUREMENT =
  'Prompt text sent to a model. Its tenant-neutral replacement is on a separate commit that must be measured ' +
  '(bin/eval-aj-docs, bin/measure-doctype-extraction) before it merges; that commit removes this entry.';

export const ALLOWLIST: AllowEntry[] = [
  { path: 'functions/lib/llm.ts', pattern: /If "MEDOSWEET FARMS" appears after "Ship To:"/, reason: PENDING_PROMPT_MEASUREMENT },
  { path: 'functions/lib/llm.ts', pattern: /Darigold Inc\.|COA for Darigold Grade AA Butter/, reason: PENDING_PROMPT_MEASUREMENT },
  { path: 'functions/lib/llm.ts', pattern: /"darigold" matches "Darigold, Inc\."/, reason: PENDING_PROMPT_MEASUREMENT },
  { path: 'functions/lib/llm.ts', pattern: /810004/, reason: PENDING_PROMPT_MEASUREMENT },
  { path: 'shared/fieldMappings.ts', pattern: /ORD-2026-001, 1784767/, reason: PENDING_PROMPT_MEASUREMENT },
  { path: 'functions/lib/connectors/schemaDiscovery.ts', pattern: /\(K00166\) CHUCKANUT BAY FOODS/, reason: PENDING_PROMPT_MEASUREMENT },
  { path: 'shared/orderPrompt.ts', pattern: /CHUCKANUT|chuckanut|K00166|1784767/, reason: PENDING_PROMPT_MEASUREMENT },
];

export interface KnownShape {
  path: string;
  /** Text that must still be in the file, so this record dies with the code it describes. */
  marker: string;
  reason: string;
}

/**
 * First-tenant-SHAPED code the denylist cannot see, because it names nobody:
 * it is vocabulary, not a value. Recorded here so the next reader knows it was
 * looked at and left on purpose, and what would have to be true to change it.
 * The test only checks that each marker is still present.
 */
export const KNOWN_FIRST_TENANT_SHAPED: KnownShape[] = [
  {
    path: 'shared/productVocabulary.ts',
    marker: String.raw`{ re: /\bHG\b/g, unit: 'gal', caseSensitive: true }`,
    reason:
      'Pack vocabulary: "HG" as half gallon, "GL" as gallon, "G" as gallons. Learned from the first tenant\'s suppliers ' +
      'and code-owned by design (search and lot matching both read it). Making pack spellings per-tenant configuration ' +
      'is later work; changing them here changes which products a phrase resolves to for every tenant.',
  },
  {
    path: 'shared/productVocabulary.ts',
    marker: String.raw`{ re: /(?<![A-Za-z0-9/])NS(?![A-Za-z0-9/])/g, attribute: 'unsalted' }`,
    reason:
      'Attribute vocabulary: "U/S" and "NS" both read as unsalted. Same status as the pack vocabulary above -- a ' +
      'code-owned list built from the first tenant\'s abbreviations, left alone until attribute spellings are tenant data.',
  },
  {
    path: 'shared/specBand.ts',
    marker: "source: 'FDA action level for aflatoxin M1 in milk (CPG Sec. 527.400)'",
    reason:
      'A public regulatory figure (0.5 ppb), not a tenant value: the D3 ruling ships a well-known legal ceiling as a ' +
      'code default that a client overrides on the analyte. It is never written to a database.',
  },
];
