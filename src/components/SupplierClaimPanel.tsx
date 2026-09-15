/**
 * SupplierClaimPanel — on a Review Queue item that came through a supplier's
 * request link, what the supplier said the file covers, and (while the item is
 * pending) what the reviewer decides about it.
 *
 * ONE ACTION, STILL TWO JUDGEMENTS
 * --------------------------------
 * This panel used to be read-only: approve here, then decide on the request's
 * arrivals screen. The client asked for one action (14 Sep 2026), so for a
 * pending item the supplier's claims are offered as PRE-TICKED checkboxes, with
 * "add a requirement", and the reviewer picks what the approval should also do:
 *
 *   - accept the ticked requirements,
 *   - send them back to the supplier (with the sentence the supplier reads), or
 *   - decide later, on the arrivals screen (the old two-step path).
 *
 * NOTHING IS PRE-SELECTED among those three. Ticking is a convenience; the
 * choice is not. An approve that silently accepted whatever the supplier said
 * the file covers would be the back door migration 0092 was written to close,
 * so the Review Queue's Approve button waits for this choice. The choice then
 * rides on the approve body as `arrival_decision`.
 *
 * Accept is offered only when the approval will actually produce a document;
 * a reviewer rejecting the file can still send requirements back from the
 * reject dialog.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Checkbox,
  Chip,
  FormControlLabel,
  Link,
  MenuItem,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { api } from '../lib/api';
import { ATTENTION_REASON_PRESETS } from '../lib/types';
import type { QueueArrivalDecisionInput, RequestArrival } from '../lib/types';
import { claimChip } from './ArrivalCard';

/** What the reviewer has chosen so far. `mode: null` = not chosen yet. */
export interface ArrivalDraft {
  uploadId: string;
  mode: 'accepted' | 'needs_attention' | 'later' | null;
  /** Ticked, CURRENT-version line ids. */
  lineIds: string[];
  attentionReason: string;
  statusNote: string;
}

/**
 * The `arrival_decision` body for a draft, or undefined when the approval
 * should decide nothing (decide later, or nothing ticked).
 */
export function arrivalDecisionFor(draft: ArrivalDraft | undefined): QueueArrivalDecisionInput | undefined {
  if (!draft || draft.mode === null || draft.mode === 'later' || draft.lineIds.length === 0) {
    return undefined;
  }
  const mode = draft.mode;
  return {
    decisions: draft.lineIds.map((lineId) => ({
      line_id: lineId,
      decision: mode,
      ...(draft.statusNote.trim() ? { status_note: draft.statusNote.trim() } : {}),
      ...(mode === 'needs_attention' ? { attention_reason: draft.attentionReason.trim() || null } : {}),
    })),
  };
}

/** A line on the current version that the reviewer can still add. */
interface OfferedLine {
  id: string;
  name: string;
}

/** The lines the supplier claimed that are still waiting on a person. */
export function initialTickedLineIds(arrival: RequestArrival): string[] {
  return arrival.claims
    .filter(
      (c) =>
        c.line_id !== null &&
        c.decision === null &&
        (c.line_status === 'received' || c.line_status === 'under_review'),
    )
    .map((c) => c.line_id!);
}

export interface SupplierClaimPanelProps {
  queueId: string;
  tenantId: string;
  /** Passed only for a super_admin, whose list call must name a tenant. */
  asSuperAdmin: boolean;
  onOpenRequest: (requestId: string) => void;
  /**
   * Present when the reviewer can decide here (a pending item and a role that
   * can approve). Absent renders the read-only context panel.
   */
  draft?: ArrivalDraft;
  onDraftChange?: (draft: ArrivalDraft) => void;
  /** Tells the page which arrival this item is, once it has loaded. */
  onArrivalLoaded?: (arrival: RequestArrival) => void;
  disabled?: boolean;
}

export function SupplierClaimPanel({
  queueId,
  tenantId,
  asSuperAdmin,
  onOpenRequest,
  draft,
  onDraftChange,
  onArrivalLoaded,
  disabled,
}: SupplierClaimPanelProps) {
  const [arrival, setArrival] = useState<RequestArrival | null>(null);
  const [lines, setLines] = useState<OfferedLine[]>([]);
  const editable = Boolean(onDraftChange);

  useEffect(() => {
    let cancelled = false;
    api.requestUploads
      .list({ queue_id: queueId, tenant_id: asSuperAdmin ? tenantId : undefined, limit: 1 })
      .then((res) => {
        if (cancelled) return;
        const a = res.arrivals[0] ?? null;
        setArrival(a);
        if (a) onArrivalLoaded?.(a);
      })
      .catch(() => {
        // Context only. The review works without it.
      });
    return () => {
      cancelled = true;
    };
    // onArrivalLoaded is a page callback; re-running on its identity would refetch every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueId, tenantId, asSuperAdmin]);

  // Seed the draft once the arrival is known: claims pre-ticked, no choice made.
  useEffect(() => {
    if (!arrival || !editable || draft) return;
    onDraftChange!({
      uploadId: arrival.id,
      mode: null,
      lineIds: initialTickedLineIds(arrival),
      attentionReason: '',
      statusNote: '',
    });
  }, [arrival, editable, draft, onDraftChange]);

  // Every line on the current version, for "add a requirement".
  useEffect(() => {
    if (!arrival || !editable || arrival.current_request_status !== 'issued') return;
    let cancelled = false;
    api.documentRequests
      .get(arrival.current_request_id)
      .then((res) => {
        if (!cancelled) setLines(res.request.lines.map((l) => ({ id: l.id, name: l.name })));
      })
      .catch(() => {
        // The claimed lines can still be decided without the full list.
      });
    return () => {
      cancelled = true;
    };
  }, [arrival, editable]);

  const claimed = useMemo(
    () => (arrival?.claims ?? []).filter((c) => c.line_id !== null),
    [arrival],
  );

  if (!arrival) return null;

  const title = (
    <AlertTitle>
      {arrival.supplier_name ?? 'The supplier'} sent this for{' '}
      <Link component="button" onClick={() => onOpenRequest(arrival.current_request_id)}>
        {arrival.request_title}
      </Link>
    </AlertTitle>
  );

  const decidable = editable && draft && arrival.current_request_status === 'issued';

  if (!decidable) {
    return (
      <Alert severity="info" sx={{ mb: 2 }}>
        {title}
        {arrival.claims.length === 0 ? (
          'They did not say which requirement it covers.'
        ) : (
          <>
            They said it covers these requirements.
            <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ mt: 1 }}>
              {arrival.claims.map((c) => {
                const chip = claimChip(c);
                return (
                  <Box key={c.claim_id}>
                    <Chip size="small" variant="outlined" label={`${c.line_name} · ${chip.label}`} />
                  </Box>
                );
              })}
            </Stack>
          </>
        )}
      </Alert>
    );
  }

  const set = (patch: Partial<ArrivalDraft>) => onDraftChange!({ ...draft, ...patch });
  const ticked = new Set(draft.lineIds);
  const toggle = (lineId: string) => {
    const next = new Set(ticked);
    if (next.has(lineId)) next.delete(lineId);
    else next.add(lineId);
    set({ lineIds: [...next] });
  };

  const claimedIds = new Set(claimed.map((c) => c.line_id!));
  const addedRows = draft.lineIds
    .filter((id) => !claimedIds.has(id))
    .map((id) => lines.find((l) => l.id === id))
    .filter((l): l is OfferedLine => Boolean(l));
  const addable = lines.filter((l) => !claimedIds.has(l.id) && !ticked.has(l.id));
  const count = draft.lineIds.length;

  return (
    <Alert severity={draft.mode === null ? 'warning' : 'info'} sx={{ mb: 2 }} icon={false}>
      {title}
      <Typography variant="body2" sx={{ mb: 1 }}>
        {claimed.length === 0
          ? 'They did not say which requirement it covers. Add the one it does, if any.'
          : 'They said it covers the ticked requirements. Untick anything it does not.'}
      </Typography>

      <Stack spacing={0} sx={{ mb: 1 }}>
        {claimed.map((c) => (
          <Box key={c.claim_id}>
            <FormControlLabel
              control={
                <Checkbox
                  size="small"
                  checked={ticked.has(c.line_id!)}
                  onChange={() => toggle(c.line_id!)}
                  disabled={disabled}
                />
              }
              label={
                <Typography variant="body2">
                  {c.line_name}{' '}
                  <Typography component="span" variant="caption" color="text.secondary">
                    · {c.claimed_by === 'staff' ? 'added by your team' : 'supplier said'} · {claimChip(c).label}
                  </Typography>
                </Typography>
              }
            />
          </Box>
        ))}
        {addedRows.map((l) => (
          <Box key={l.id}>
            <FormControlLabel
              control={<Checkbox size="small" checked onChange={() => toggle(l.id)} disabled={disabled} />}
              label={
                <Typography variant="body2">
                  {l.name}{' '}
                  <Typography component="span" variant="caption" color="text.secondary">
                    · you are adding this; the supplier did not tick it
                  </Typography>
                </Typography>
              }
            />
          </Box>
        ))}
      </Stack>
      {addable.length > 0 && (
        <TextField
          select
          size="small"
          label="Add a requirement this file also covers"
          value=""
          onChange={(e) => set({ lineIds: [...draft.lineIds, e.target.value] })}
          disabled={disabled}
          sx={{ mb: 1.5, minWidth: 320, maxWidth: '100%' }}
        >
          {addable.map((l) => (
            <MenuItem key={l.id} value={l.id}>
              {l.name}
            </MenuItem>
          ))}
        </TextField>
      )}

      <Typography variant="subtitle2" sx={{ mt: 0.5 }}>
        When you approve, also…
      </Typography>
      <RadioGroup
        value={draft.mode ?? ''}
        onChange={(e) => set({ mode: e.target.value as ArrivalDraft['mode'] })}
      >
        <FormControlLabel
          value="accepted"
          control={<Radio size="small" />}
          disabled={disabled || count === 0}
          label={
            <Typography variant="body2">
              Accept {count === 1 ? 'this requirement' : `these ${count} requirements`}: the document satisfies{' '}
              {count === 1 ? 'it' : 'them'}
            </Typography>
          }
        />
        <FormControlLabel
          value="needs_attention"
          control={<Radio size="small" />}
          disabled={disabled || count === 0}
          label={<Typography variant="body2">Send {count === 1 ? 'it' : 'them'} back to the supplier</Typography>}
        />
        <FormControlLabel
          value="later"
          control={<Radio size="small" />}
          disabled={disabled}
          label={<Typography variant="body2">Decide later, on Requests › Arrivals</Typography>}
        />
      </RadioGroup>
      {draft.mode === null && (
        <Typography variant="caption" color="text.secondary" display="block">
          Approve waits for this choice. Nothing is accepted just because the supplier ticked it.
        </Typography>
      )}

      {draft.mode === 'needs_attention' && (
        <Box sx={{ mt: 1 }}>
          <AttentionReasonField
            value={draft.attentionReason}
            onChange={(v) => set({ attentionReason: v })}
            disabled={disabled}
          />
        </Box>
      )}
      {(draft.mode === 'accepted' || draft.mode === 'needs_attention') && (
        <TextField
          size="small"
          fullWidth
          label="Internal note"
          value={draft.statusNote}
          onChange={(e) => set({ statusNote: e.target.value })}
          helperText="Only your team sees this."
          disabled={disabled}
          sx={{ mt: 1.5 }}
        />
      )}
    </Alert>
  );
}

/**
 * The supplier-facing send-back sentence, with ready-made reasons one click
 * away. A preset fills the box; the reviewer can still edit it.
 */
export function AttentionReasonField({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <>
      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ mb: 1 }}>
        {ATTENTION_REASON_PRESETS.map((p) => (
          <Chip
            key={p.key}
            size="small"
            label={p.label}
            onClick={disabled ? undefined : () => onChange(p.text)}
            color={value === p.text ? 'primary' : 'default'}
            variant={value === p.text ? 'filled' : 'outlined'}
          />
        ))}
      </Stack>
      <TextField
        size="small"
        fullWidth
        multiline
        minRows={2}
        label="What the supplier needs to fix"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. This is the 2023 statement; we need one signed this year."
        helperText="The supplier reads this on their link. Leave it blank and they see a sentence built from the requirement's own criteria."
        disabled={disabled}
      />
    </>
  );
}
