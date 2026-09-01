/**
 * DocumentFacetPicker — pick, from the tenant's OWN vocabulary, what a
 * document satisfies (layer 2, `requirements`) or triggers (layer 3,
 * `claim_types`). Migration 0080; write paths landed in cfb1b5e.
 *
 * Why a picker and not a text field: a link that resolves to a real
 * requirement id can be satisfied, can drive expiry, and can be subtracted by
 * gap detection. Free text produces a document the registry cannot reason
 * about — which is the filing cabinet this product exists to replace. So the
 * control offers the vocabulary and nothing else; a term that is missing is
 * added under Settings, not typed here.
 *
 * The idiom deliberately mirrors ClaimRequirementsDialog: a grouped checkbox
 * list, a search box once the list is long, an explicit empty state, and a
 * two-word toggle that only appears once a box is ticked.
 *
 * Status semantics (see functions/lib/registry.ts):
 *   suggested — proposed by a pipeline. Does NOT count toward compliance.
 *   confirmed — a person decided it. This is what gap detection counts.
 *   rejected  — a person turned it down. Retained, not deleted, so ingest's
 *               `preserveRejected` stops the same wrong guess coming back.
 *
 * Unticking therefore does two different things on purpose. A link that
 * exists on the server becomes `rejected` (the human's "no" is worth keeping);
 * a link the user only just added is simply dropped, because there is no
 * decision to record.
 */

import { useMemo, useState, type ReactNode } from 'react';
import {
  Alert,
  Box,
  Checkbox,
  Chip,
  InputAdornment,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { Search as SearchIcon } from '@mui/icons-material';
import type { DocumentFacetLinkInput, RegistryLinkStatus } from '../lib/types';

/** One row of the tenant's vocabulary, facet-neutral. */
export interface FacetVocabItem {
  id: string;
  name: string;
  description?: string | null;
  /** Optional grouping label — a requirement's `checklist`. */
  group?: string | null;
}

/**
 * The editor's working copy of one document->vocabulary link.
 *
 * Every field the junction carries is round-tripped, because PUT
 * /api/documents/:id REPLACES the facet's whole set: anything not sent back is
 * deleted, so a save that dropped `confidence`/`evidence`/the claim subject
 * would quietly destroy the pipeline's provenance.
 */
export interface FacetLinkDraft {
  /** Vocabulary row id — a requirement id or a claim_type id. */
  id: string;
  status: RegistryLinkStatus;
  source?: string;
  confidence?: number | null;
  notes?: string | null;
  evidence?: string | null;
  subject_type?: string;
  subject_id?: string | null;
  /** Read-only, for display: the resolved product/supplier name. */
  subject_name?: string | null;
  /**
   * The status the SERVER held when this draft was loaded. `undefined` means
   * the link does not exist yet, which is what makes "untick = reject" apply
   * only to links a pipeline or a previous save actually recorded.
   */
  originalStatus?: RegistryLinkStatus;
}

/** Drafts keyed by vocabulary id. */
export type FacetLinkDraftMap = Map<string, FacetLinkDraft>;

export interface DocumentFacetPickerProps {
  /** The tenant's vocabulary. MUST already be tenant-scoped: the API rejects
   *  cross-tenant ids, so offering them would only produce a 400 on save. */
  vocab: FacetVocabItem[];
  value: FacetLinkDraftMap;
  onChange: (next: FacetLinkDraftMap) => void;
  /** Status stamped on a link the user has just ticked. */
  newLinkStatus?: RegistryLinkStatus;
  /** Show the per-link status toggle and the pipeline's provenance. Off on the
   *  create page, where every link is by definition a person's own choice. */
  showStatus?: boolean;
  disabled?: boolean;
  /** Rendered instead of the list when the tenant has configured nothing. */
  emptyMessage: ReactNode;
  /** The search box appears past this many items. */
  searchThreshold?: number;
  searchPlaceholder?: string;
}

const UNGROUPED = 'Other';

export function DocumentFacetPicker({
  vocab,
  value,
  onChange,
  newLinkStatus = 'confirmed',
  showStatus = false,
  disabled = false,
  emptyMessage,
  searchThreshold = 8,
  searchPlaceholder = 'Search…',
}: DocumentFacetPickerProps) {
  const [search, setSearch] = useState('');

  // Group in the order the tenant configured its vocabulary (the list arrives
  // sorted), so the control mirrors the paper checklist the user already knows.
  const groups = useMemo(() => {
    const term = search.trim().toLowerCase();
    const out = new Map<string, FacetVocabItem[]>();
    for (const item of vocab) {
      if (term && !`${item.name} ${item.description ?? ''}`.toLowerCase().includes(term)) continue;
      const key = item.group || UNGROUPED;
      if (!out.has(key)) out.set(key, []);
      out.get(key)!.push(item);
    }
    return out;
  }, [vocab, search]);

  const toggle = (item: FacetVocabItem, checked: boolean) => {
    const next = new Map(value);
    const existing = next.get(item.id);
    if (checked) {
      next.set(item.id, {
        ...(existing ?? { id: item.id }),
        id: item.id,
        status: newLinkStatus,
      });
    } else if (existing?.originalStatus) {
      // A recorded link the reviewer is turning down. Keep it as a rejection
      // rather than deleting it, so re-ingesting the same extraction cannot
      // resurrect the suggestion.
      next.set(item.id, { ...existing, status: 'rejected' });
    } else {
      next.delete(item.id);
    }
    onChange(next);
  };

  const setStatus = (itemId: string, status: RegistryLinkStatus) => {
    const existing = value.get(itemId);
    if (!existing) return;
    const next = new Map(value);
    next.set(itemId, { ...existing, status });
    onChange(next);
  };

  if (vocab.length === 0) {
    return <Alert severity="info">{emptyMessage}</Alert>;
  }

  return (
    <Box>
      {vocab.length > searchThreshold && (
        <TextField
          fullWidth
          size="small"
          placeholder={searchPlaceholder}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          disabled={disabled}
          sx={{ mb: 1.5 }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
        />
      )}

      {[...groups.entries()].map(([group, items]) => (
        <Box key={group} sx={{ mb: 1.5 }}>
          {groups.size > 1 || group !== UNGROUPED ? (
            <Typography
              variant="overline"
              color="text.secondary"
              sx={{ display: 'block', letterSpacing: 0.6 }}
            >
              {group}
            </Typography>
          ) : null}
          {items.map((item) => {
            const draft = value.get(item.id);
            const checked = !!draft && draft.status !== 'rejected';
            const rejected = draft?.status === 'rejected';
            return (
              <Box
                key={item.id}
                sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, py: 0.5, flexWrap: 'wrap' }}
              >
                <Checkbox
                  checked={checked}
                  onChange={(e) => toggle(item, e.target.checked)}
                  disabled={disabled}
                  size="small"
                  sx={{ mt: -0.25 }}
                  inputProps={{ 'aria-label': item.name }}
                />
                <Box sx={{ flexGrow: 1, minWidth: 180 }}>
                  <Typography variant="body2" fontWeight={checked ? 600 : 400}>
                    {item.name}
                    {draft?.subject_name ? (
                      <Typography component="span" variant="body2" color="text.secondary">
                        {` · about ${draft.subject_name}`}
                      </Typography>
                    ) : null}
                  </Typography>
                  {item.description && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                      {item.description}
                    </Typography>
                  )}
                  {showStatus && draft?.originalStatus === 'suggested' && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                      Proposed by {draft.source || 'the pipeline'}
                      {draft.confidence != null ? ` · ${Math.round(draft.confidence * 100)}% confidence` : ''}
                      {draft.evidence ? ` · “${draft.evidence}”` : ''}
                    </Typography>
                  )}
                </Box>
                {rejected && (
                  <Chip size="small" label="Rejected" variant="outlined" color="default" />
                )}
                {showStatus && checked && (
                  <ToggleButtonGroup
                    size="small"
                    exclusive
                    value={draft!.status}
                    onChange={(_, v: RegistryLinkStatus | null) => {
                      if (v !== null) setStatus(item.id, v);
                    }}
                    disabled={disabled}
                    aria-label={`${item.name} status`}
                  >
                    <ToggleButton value="confirmed" sx={{ py: 0.25, px: 1, textTransform: 'none' }}>
                      Confirmed
                    </ToggleButton>
                    <ToggleButton value="suggested" sx={{ py: 0.25, px: 1, textTransform: 'none' }}>
                      Suggested
                    </ToggleButton>
                  </ToggleButtonGroup>
                )}
              </Box>
            );
          })}
        </Box>
      ))}

      {groups.size === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
          Nothing matches “{search}”.
        </Typography>
      )}
    </Box>
  );
}

/**
 * Turn the API's link rows into editor drafts, keyed by vocabulary id.
 *
 * Returns the extras separately rather than dropping them: a claim type can
 * legitimately be linked twice with different subjects (the junction's
 * uniqueness guard is on (document, claim_type, subject)), and the checkbox
 * list is keyed by vocabulary id alone. The caller concatenates `passthrough`
 * back onto its save payload so those rows survive the REPLACE.
 */
export function draftsFromLinks(
  links: Array<Record<string, unknown>> | undefined,
  vocabIdKey: string,
): { drafts: FacetLinkDraftMap; passthrough: FacetLinkDraft[] } {
  const drafts: FacetLinkDraftMap = new Map();
  const passthrough: FacetLinkDraft[] = [];
  for (const raw of links ?? []) {
    const id = String(raw[vocabIdKey] ?? '');
    if (!id) continue;
    const status = (raw.status as RegistryLinkStatus) ?? 'suggested';
    const draft: FacetLinkDraft = {
      id,
      status,
      originalStatus: status,
      source: typeof raw.source === 'string' ? raw.source : undefined,
      confidence: (raw.confidence as number | null) ?? null,
      notes: (raw.notes as string | null) ?? null,
      evidence: (raw.evidence as string | null) ?? null,
      subject_type: typeof raw.subject_type === 'string' ? raw.subject_type : undefined,
      subject_id: (raw.subject_id as string | null) ?? null,
      subject_name: (raw.subject_name as string | null) ?? null,
    };
    if (drafts.has(id)) passthrough.push(draft);
    else drafts.set(id, draft);
  }
  return { drafts, passthrough };
}

/**
 * `source` has no DB CHECK but IS validated at the edge against a closed set
 * (functions/lib/registry.ts REGISTRY_LINK_SOURCES). Round-tripping a value
 * from outside that set would 400 the whole save, so an unrecognised
 * provenance is dropped and the endpoint's 'human' default applies.
 */
const KNOWN_SOURCES = new Set(['human', 'extraction', 'rule', 'import']);

/** Flatten drafts (plus any passthrough rows) into the API's link payload. */
export function linksFromDrafts(
  drafts: FacetLinkDraftMap,
  passthrough: FacetLinkDraft[] = [],
): DocumentFacetLinkInput[] {
  return [...drafts.values(), ...passthrough].map((d) => {
    const out: DocumentFacetLinkInput = { id: d.id, status: d.status };
    if (d.source && KNOWN_SOURCES.has(d.source)) out.source = d.source;
    if (d.confidence != null) out.confidence = d.confidence;
    if (d.notes) out.notes = d.notes;
    if (d.evidence) out.evidence = d.evidence;
    // 'tenant' is the endpoint's own default and MUST carry no subject_id, so
    // send the pair only when a real subject is attached.
    if (d.subject_type && d.subject_type !== 'tenant' && d.subject_id) {
      out.subject_type = d.subject_type;
      out.subject_id = d.subject_id;
    }
    return out;
  });
}

export default DocumentFacetPicker;
