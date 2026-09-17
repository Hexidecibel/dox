/**
 * RequestLineComposer — what a request ASKS FOR, composed line by line.
 *
 * This is the control the whole composer screen is built around, and it has one
 * job beyond collecting text: making the typed line the obvious thing to do.
 *
 * WHY THE PICKER IS NOT A TEXT BOX
 * --------------------------------
 * A line that resolves to a requirement id can be satisfied by an arriving
 * document, can drive expiry, and can be counted when it is missing — the
 * registry already holds the join (`document_requirements`, migration 0080) and
 * the composer reuses it rather than inventing a second mechanism. A line that
 * is only free text produces a document the registry cannot reason about, which
 * quietly turns the portal back into a filing cabinet. The API enforces this
 * (`resolveLines` refuses an untyped line unless `line_kind: "free_text"` is
 * asked for BY NAME) and this control is the same rule made visible:
 *
 *   * The body of the picker is the tenant's own checklist. Checkboxes, no
 *     text input, exactly like DocumentFacetPicker.
 *   * Free text is not on screen at rest. It is one low-emphasis link, which
 *     opens a panel that states the cost before it accepts a name.
 *   * A free-text line, once added, keeps a warning border and says what it
 *     cannot do. It is not a normal-looking row with a different icon.
 *
 * Nothing here blocks the escape hatch. A QA manager who needs to ask for
 * something the taxonomy has not caught up with can, in three clicks — and the
 * screen never pretends the two kinds of line are worth the same.
 *
 * SEEDING. `outstanding` is the set of requirement ids the gap report says this
 * supplier already owes (shared/requirementGap.ts). Those sort to the top and
 * are flagged, the same way ClaimRules floats unconfigured claims: the work
 * that is already known should not have to be rediscovered by scrolling.
 */

import { useMemo, useState, type ReactNode } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Checkbox,
  Chip,
  Collapse,
  Divider,
  FormControlLabel,
  IconButton,
  InputAdornment,
  MenuItem,
  Paper,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Search as SearchIcon,
  Delete as DeleteIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  WarningAmber as WarningIcon,
} from '@mui/icons-material';
import type {
  RequestLineInput,
  RequestLineKind,
  SupplierRequirementTier,
  UpdateRequestLineRequest,
} from '../lib/types';

/** One row of the tenant's checklist, as the picker needs it. */
export interface RequirementOption {
  id: string;
  name: string;
  description?: string | null;
  /** The requirement's `checklist` — its grouping label. */
  checklist?: string | null;
  sort_order?: number;
}

/**
 * A line being composed. Mirrors `RequestLineInput` plus the local bookkeeping
 * a form needs: a stable key for React, and where the line came from.
 */
export interface RequestLineDraft {
  /** Stable local identity. For a typed line this is the requirement id. */
  key: string;
  line_kind: RequestLineKind;
  requirement_id: string | null;
  name: string;
  explanation: string;
  acceptable_formats: string;
  criteria: string;
  owner: string;
  /**
   * "Send this as its own file" (migration 0119). The cheap half of the packet
   * problem: a supplier who combines twenty-five documents into one PDF is
   * answering an ask that did not say not to.
   */
  one_document_per_file: boolean;
  tier: SupplierRequirementTier;
  /** True when the gap report put this line here rather than a person. */
  seeded?: boolean;
}

let freeTextSeq = 0;

/** A draft for one requirement, with the requirement's own name as the default. */
export function draftFromRequirement(
  option: RequirementOption,
  extras: Partial<RequestLineDraft> = {},
): RequestLineDraft {
  return {
    key: option.id,
    line_kind: 'requirement',
    requirement_id: option.id,
    name: option.name,
    explanation: '',
    acceptable_formats: '',
    criteria: '',
    owner: '',
    one_document_per_file: false,
    tier: 'required',
    ...extras,
  };
}

/** A draft for the escape hatch. Never reachable without an explicit request. */
export function draftFromFreeText(name: string): RequestLineDraft {
  freeTextSeq += 1;
  return {
    key: `free:${freeTextSeq}:${name.trim().toLowerCase()}`,
    line_kind: 'free_text',
    requirement_id: null,
    name: name.trim(),
    explanation: '',
    acceptable_formats: '',
    criteria: '',
    owner: '',
    one_document_per_file: false,
    tier: 'required',
  };
}

/** Tick / untick one requirement. Untick removes the line; there is no history to keep. */
export function toggleRequirement(
  drafts: RequestLineDraft[],
  option: RequirementOption,
): RequestLineDraft[] {
  const existing = drafts.findIndex((d) => d.requirement_id === option.id);
  if (existing >= 0) return drafts.filter((_, i) => i !== existing);
  return [...drafts, draftFromRequirement(option)];
}

/**
 * The payload the API takes.
 *
 * Empty strings become null rather than travelling as '' — the server treats a
 * blank as absent anyway, and a column full of empty strings reads as
 * "somebody filled this in" to the next person querying it.
 */
export function draftsToLineInputs(drafts: RequestLineDraft[]): RequestLineInput[] {
  return drafts.map((d, i) => ({
    // Sent explicitly on BOTH kinds. The server defaults to 'requirement', so
    // omitting it on a free-text line would be a 400 rather than a silent
    // untyped line — the client should not lean on that.
    line_kind: d.line_kind,
    requirement_id: d.line_kind === 'requirement' ? d.requirement_id : undefined,
    name: d.name.trim(),
    explanation: d.explanation.trim() || null,
    acceptable_formats: d.acceptable_formats.trim() || null,
    criteria: d.criteria.trim() || null,
    owner: d.owner.trim() || null,
    one_document_per_file: d.one_document_per_file,
    tier: d.tier,
    sort_order: i,
  }));
}

/**
 * What changed between the lines a DRAFT currently holds and the composed set.
 *
 * A draft's lines are managed one at a time — `POST :id/lines` adds,
 * `DELETE /request-lines/:id` removes, `PUT /request-lines/:id` rewords — so
 * that adding one item to a fifty-line packet is not a whole-set replace. This
 * turns the form's end state into that minimal set of calls.
 *
 * Identity is the line's identity, not its position: a typed line IS its
 * requirement, and a free-text line has nothing better than its name — the same
 * rule `lineKey` uses server-side when carrying progress across an amendment,
 * and another small, concrete cost of the escape hatch.
 *
 * Only fields the user can actually edit are compared, so a round trip through
 * the form with nothing touched produces no calls at all.
 */
export interface ExistingLine {
  id: string;
  line_kind: RequestLineKind;
  requirement_id: string | null;
  name: string;
  explanation: string | null;
  acceptable_formats: string | null;
  criteria: string | null;
  owner: string | null;
  one_document_per_file: boolean;
  tier: SupplierRequirementTier;
  sort_order: number;
}

export interface LineDiff {
  add: RequestLineInput[];
  remove: string[];
  /** Exactly the fields that changed, typed as the PUT body takes them. */
  update: { id: string; patch: UpdateRequestLineRequest }[];
}

function identity(l: {
  line_kind: RequestLineKind;
  requirement_id: string | null;
  name: string;
}): string {
  return l.line_kind === 'requirement' && l.requirement_id
    ? `req:${l.requirement_id}`
    : `txt:${l.name.trim().toLowerCase()}`;
}

export function diffLineDrafts(
  existing: ExistingLine[],
  drafts: RequestLineDraft[],
): LineDiff {
  const inputs = draftsToLineInputs(drafts);
  const byIdentity = new Map(existing.map((l) => [identity(l), l]));
  const seen = new Set<string>();

  const add: RequestLineInput[] = [];
  const update: { id: string; patch: UpdateRequestLineRequest }[] = [];

  drafts.forEach((draft, i) => {
    const key = identity(draft);
    seen.add(key);
    const current = byIdentity.get(key);
    if (!current) {
      add.push(inputs[i]);
      return;
    }
    const patch: UpdateRequestLineRequest = {};
    const input = inputs[i];
    if (input.name !== current.name) patch.name = input.name;
    if ((input.explanation ?? null) !== current.explanation)
      patch.explanation = input.explanation ?? null;
    if ((input.acceptable_formats ?? null) !== current.acceptable_formats)
      patch.acceptable_formats = input.acceptable_formats ?? null;
    if ((input.criteria ?? null) !== current.criteria) patch.criteria = input.criteria ?? null;
    if ((input.owner ?? null) !== current.owner) patch.owner = input.owner ?? null;
    if ((input.one_document_per_file ?? false) !== !!current.one_document_per_file)
      patch.one_document_per_file = input.one_document_per_file ?? false;
    if (input.tier !== current.tier) patch.tier = input.tier;
    if (i !== current.sort_order) patch.sort_order = i;
    if (Object.keys(patch).length > 0) update.push({ id: current.id, patch });
  });

  const remove = existing.filter((l) => !seen.has(identity(l))).map((l) => l.id);
  return { add, remove, update };
}

/** The stored lines of a draft, as the composer's drafts. */
export function draftsFromLines(lines: ExistingLine[]): RequestLineDraft[] {
  return lines.map((l) => ({
    key: l.requirement_id ?? `free:${l.id}`,
    line_kind: l.line_kind,
    requirement_id: l.requirement_id,
    name: l.name,
    explanation: l.explanation ?? '',
    acceptable_formats: l.acceptable_formats ?? '',
    criteria: l.criteria ?? '',
    owner: l.owner ?? '',
    one_document_per_file: !!l.one_document_per_file,
    tier: l.tier,
  }));
}

/** typed / free-text split, for the sentence above the list. */
export function countDrafts(drafts: RequestLineDraft[]): {
  total: number;
  typed: number;
  freeText: number;
} {
  const freeText = drafts.filter((d) => d.line_kind === 'free_text').length;
  return { total: drafts.length, typed: drafts.length - freeText, freeText };
}

const UNGROUPED = 'Other';

export interface RequestLineComposerProps {
  /** The tenant's checklist. MUST be tenant-scoped and active. */
  vocab: RequirementOption[];
  value: RequestLineDraft[];
  onChange: (next: RequestLineDraft[]) => void;
  /** Requirement ids this supplier already owes and has not sent. */
  outstanding?: Set<string>;
  /** Rendered instead of the checklist when the tenant has configured nothing. */
  emptyMessage: ReactNode;
  disabled?: boolean;
  /** The search box appears past this many requirements. */
  searchThreshold?: number;
}

export function RequestLineComposer({
  vocab,
  value,
  onChange,
  outstanding,
  emptyMessage,
  disabled = false,
  searchThreshold = 8,
}: RequestLineComposerProps) {
  const [search, setSearch] = useState('');
  const [escapeOpen, setEscapeOpen] = useState(false);
  const [freeText, setFreeText] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const picked = useMemo(
    () => new Set(value.map((d) => d.requirement_id).filter((v): v is string => !!v)),
    [value],
  );

  // Outstanding items first — that is the work the gap report already found —
  // then the tenant's own checklist order.
  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matched = needle
      ? vocab.filter(
          (v) =>
            v.name.toLowerCase().includes(needle) ||
            (v.checklist ?? '').toLowerCase().includes(needle) ||
            (v.description ?? '').toLowerCase().includes(needle),
        )
      : vocab;

    const owed: RequirementOption[] = [];
    const rest = new Map<string, RequirementOption[]>();
    for (const item of matched) {
      if (outstanding?.has(item.id)) {
        owed.push(item);
        continue;
      }
      const key = item.checklist || UNGROUPED;
      const list = rest.get(key) ?? [];
      list.push(item);
      rest.set(key, list);
    }

    const out: { label: string; owed: boolean; items: RequirementOption[] }[] = [];
    if (owed.length > 0) {
      out.push({ label: 'Already outstanding for this supplier', owed: true, items: owed });
    }
    for (const [label, items] of rest) out.push({ label, owed: false, items });
    return out;
  }, [vocab, search, outstanding]);

  const counts = countDrafts(value);

  const update = (key: string, patch: Partial<RequestLineDraft>) => {
    onChange(value.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  };
  const remove = (key: string) => {
    onChange(value.filter((d) => d.key !== key));
  };

  const addFreeText = () => {
    const name = freeText.trim();
    if (!name) return;
    onChange([...value, draftFromFreeText(name)]);
    setFreeText('');
    setEscapeOpen(false);
  };

  return (
    <Box>
      {/* ---------------------------------------------------------------- */}
      {/* The checklist. The default and, for most packets, the whole thing. */}
      {/* ---------------------------------------------------------------- */}
      <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 0.5 }}>
        What are you asking for?
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        Pick from your own requirements. Anything picked here can be closed by a document when
        it arrives, can be chased when it expires, and is counted when it is missing.
      </Typography>

      {vocab.length === 0 ? (
        <Alert severity="warning" icon={<WarningIcon />} sx={{ mb: 2 }}>
          <AlertTitle>Nothing to ask for yet</AlertTitle>
          {emptyMessage}
        </Alert>
      ) : (
        <Paper variant="outlined" sx={{ p: 1.5, mb: 2 }}>
          {vocab.length > searchThreshold && (
            <TextField
              size="small"
              fullWidth
              placeholder="Search your requirements…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              disabled={disabled}
              sx={{ mb: 1 }}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
              }}
            />
          )}

          {groups.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
              None of your requirements match “{search}”.
            </Typography>
          ) : (
            groups.map((group) => (
              <Box key={group.label} sx={{ mb: 1 }}>
                <Typography
                  variant="caption"
                  fontWeight={700}
                  color={group.owed ? 'warning.main' : 'text.secondary'}
                  sx={{ display: 'block', px: 1, pt: 0.5, textTransform: 'uppercase' }}
                >
                  {group.label}
                </Typography>
                {group.items.map((item) => (
                  <Box
                    key={item.id}
                    sx={{ display: 'flex', alignItems: 'flex-start', px: 0.5 }}
                  >
                    <Checkbox
                      size="small"
                      checked={picked.has(item.id)}
                      disabled={disabled}
                      inputProps={{ 'aria-label': item.name }}
                      onChange={() => onChange(toggleRequirement(value, item))}
                    />
                    <Box sx={{ pt: 0.75 }}>
                      <Typography variant="body2" component="span">
                        {item.name}
                      </Typography>
                      {group.owed && (
                        <Chip
                          size="small"
                          color="warning"
                          variant="outlined"
                          label="outstanding"
                          sx={{ ml: 1, height: 18, fontSize: '0.65rem' }}
                        />
                      )}
                      {item.description && (
                        <Typography variant="caption" color="text.secondary" display="block">
                          {item.description}
                        </Typography>
                      )}
                    </Box>
                  </Box>
                ))}
              </Box>
            ))
          )}
        </Paper>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* The escape hatch. Deliberately quiet, deliberately explained.      */}
      {/* ---------------------------------------------------------------- */}
      {!escapeOpen ? (
        <Button
          size="small"
          color="inherit"
          disabled={disabled}
          onClick={() => setEscapeOpen(true)}
          sx={{ textTransform: 'none', color: 'text.secondary', mb: 2 }}
        >
          Need something that isn’t one of your requirements?
        </Button>
      ) : (
        <Paper
          variant="outlined"
          sx={{ p: 2, mb: 2, borderColor: 'warning.main', borderStyle: 'dashed' }}
        >
          <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 0.5 }}>
            Ask for it as free text
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            A free-text line still reaches the supplier, but nothing that arrives can close
            it, it cannot be chased when it expires, and it is never counted as missing. If
            this is something you will ask for again, add it to your requirements under{' '}
            <strong>Settings → Requirements</strong> and pick it above instead.
          </Typography>
          <Stack direction="row" spacing={1} alignItems="flex-start">
            <TextField
              size="small"
              fullWidth
              label="What to ask for"
              placeholder="e.g. Signed copy of this year’s insurance rider"
              value={freeText}
              disabled={disabled}
              onChange={(e) => setFreeText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addFreeText();
                }
              }}
            />
            <Button
              variant="outlined"
              color="warning"
              disabled={disabled || freeText.trim().length === 0}
              onClick={addFreeText}
              sx={{ whiteSpace: 'nowrap' }}
            >
              Add anyway
            </Button>
            <Button
              color="inherit"
              onClick={() => {
                setEscapeOpen(false);
                setFreeText('');
              }}
            >
              Cancel
            </Button>
          </Stack>
        </Paper>
      )}

      <Divider sx={{ mb: 2 }} />

      {/* ---------------------------------------------------------------- */}
      {/* The composed lines.                                                */}
      {/* ---------------------------------------------------------------- */}
      {value.length === 0 ? (
        <Alert severity="info" variant="outlined">
          No lines yet. Tick what you need above — a request has to ask for at least one
          thing before it can be issued.
        </Alert>
      ) : (
        <>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {counts.total} line{counts.total === 1 ? '' : 's'} — {counts.typed} from your
            requirements
            {counts.freeText > 0 && (
              <>
                ,{' '}
                <Box component="span" sx={{ color: 'warning.main', fontWeight: 700 }}>
                  {counts.freeText} free text
                </Box>
              </>
            )}
            .
          </Typography>

          <Stack spacing={1}>
            {value.map((draft, index) => {
              const free = draft.line_kind === 'free_text';
              const open = expanded === draft.key;
              return (
                <Paper
                  key={draft.key}
                  variant="outlined"
                  sx={{ p: 1.5, borderColor: free ? 'warning.main' : undefined }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography variant="body2" color="text.secondary" sx={{ minWidth: 20 }}>
                      {index + 1}.
                    </Typography>
                    <Box sx={{ flexGrow: 1 }}>
                      <Typography variant="body2" fontWeight={600}>
                        {draft.name}
                      </Typography>
                      {free ? (
                        <Typography variant="caption" color="warning.main">
                          Free text — nothing can satisfy this line, and it is never counted
                          as missing.
                        </Typography>
                      ) : (
                        <Typography variant="caption" color="text.secondary">
                          {draft.seeded
                            ? 'From your requirements — already outstanding for this supplier.'
                            : 'From your requirements.'}
                        </Typography>
                      )}
                    </Box>

                    <ToggleButtonGroup
                      size="small"
                      exclusive
                      value={draft.tier}
                      disabled={disabled}
                      onChange={(_, next: SupplierRequirementTier | null) => {
                        if (next) update(draft.key, { tier: next });
                      }}
                    >
                      <ToggleButton value="required" sx={{ textTransform: 'none', py: 0.25 }}>
                        Required
                      </ToggleButton>
                      <ToggleButton
                        value="recommended"
                        sx={{ textTransform: 'none', py: 0.25 }}
                      >
                        Recommended
                      </ToggleButton>
                    </ToggleButtonGroup>

                    <Tooltip title={open ? 'Hide details' : 'Add wording, formats, criteria'}>
                      <IconButton
                        size="small"
                        onClick={() => setExpanded(open ? null : draft.key)}
                        aria-label={
                          open ? `Hide details for ${draft.name}` : `Details for ${draft.name}`
                        }
                      >
                        {open ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Remove this line">
                      <span>
                        <IconButton
                          size="small"
                          disabled={disabled}
                          onClick={() => remove(draft.key)}
                          aria-label={`Remove ${draft.name}`}
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </Box>

                  <Collapse in={open} unmountOnExit>
                    <Stack spacing={1.5} sx={{ mt: 1.5 }}>
                      <TextField
                        size="small"
                        fullWidth
                        label="What to call it"
                        value={draft.name}
                        disabled={disabled}
                        onChange={(e) => update(draft.key, { name: e.target.value })}
                        helperText={
                          free
                            ? 'The supplier sees exactly this.'
                            : 'Your requirements call it this. Reword it if the supplier knows it by another name — the line still resolves to the same requirement.'
                        }
                      />
                      <TextField
                        size="small"
                        fullWidth
                        multiline
                        minRows={2}
                        label="Why you need it"
                        value={draft.explanation}
                        disabled={disabled}
                        onChange={(e) => update(draft.key, { explanation: e.target.value })}
                        helperText="One sentence. The supplier reads this."
                      />
                      <TextField
                        size="small"
                        fullWidth
                        label="Acceptable formats"
                        placeholder="e.g. Signed PDF on letterhead"
                        value={draft.acceptable_formats}
                        disabled={disabled}
                        onChange={(e) =>
                          update(draft.key, { acceptable_formats: e.target.value })
                        }
                      />
                      <TextField
                        size="small"
                        fullWidth
                        multiline
                        minRows={2}
                        label="Criteria we will check"
                        placeholder="e.g. Must be dated within the last 12 months and name the plant"
                        value={draft.criteria}
                        disabled={disabled}
                        onChange={(e) => update(draft.key, { criteria: e.target.value })}
                      />
                      <TextField
                        size="small"
                        fullWidth
                        label="Owner"
                        placeholder="e.g. Plant QA"
                        value={draft.owner}
                        disabled={disabled}
                        onChange={(e) => update(draft.key, { owner: e.target.value })}
                        helperText="Who on their side is expected to produce it. Internal note — the supplier does not see this."
                      />
                      {/* THE CHEAP HALF OF THE PACKET PROBLEM (migration 0119).
                          A supplier who sends twenty-five documents in one PDF
                          is answering an ask that did not say not to — and the
                          expensive half is detecting it afterwards and asking a
                          human to carve it up. A checkbox rather than a
                          sentence in "Acceptable formats" so the ask is
                          countable: which of our requests said this, and did
                          they honour it. */}
                      <FormControlLabel
                        control={
                          <Checkbox
                            size="small"
                            checked={draft.one_document_per_file}
                            disabled={disabled}
                            onChange={(e) =>
                              update(draft.key, { one_document_per_file: e.target.checked })
                            }
                          />
                        }
                        label={
                          <Box>
                            <Typography variant="body2">One document per file</Typography>
                            <Typography variant="caption" color="text.secondary">
                              The supplier is told to send this on its own, not combined into a packet with
                              other documents. Leave it off where a single document is obviously what was asked for.
                            </Typography>
                          </Box>
                        }
                        sx={{ alignItems: 'flex-start', ml: 0 }}
                      />
                    </Stack>
                  </Collapse>
                </Paper>
              );
            })}
          </Stack>
        </>
      )}
    </Box>
  );
}

/** Tier selector reused by the template editor, which has no per-line card. */
export function TierSelect({
  value,
  onChange,
  disabled,
}: {
  value: SupplierRequirementTier;
  onChange: (next: SupplierRequirementTier) => void;
  disabled?: boolean;
}) {
  return (
    <TextField
      select
      size="small"
      label="Tier"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as SupplierRequirementTier)}
    >
      <MenuItem value="required">Required</MenuItem>
      <MenuItem value="recommended">Recommended</MenuItem>
    </TextField>
  );
}
