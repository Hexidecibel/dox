/**
 * Satisfied-vs-open for one supplier, on the supplier record.
 *
 * The Documents tab has always answered "we have N documents from this
 * supplier". That is the retriever's question. The reviewer's question is the
 * other one — "this supplier owes M" — and until migration 0087 the portal
 * could not represent it at all. This panel is that second number, sitting
 * directly above the flat list so the two are read together.
 *
 * DENSE AND FACTUAL, deliberately. This is the reviewer surface: counts first,
 * every applicable line item enumerable underneath, and no decorative
 * summarising. It REPORTS rather than edits — the one exception is the optional
 * `onConfigure` escape hatch to the editor, because a "not configured" warning
 * with nowhere to go is a dead end.
 *
 * THE FALSE-CLEAN GUARD IS THE POINT. Three visual states, never two:
 *
 *   not configured  no requirements attached — rendered as a WARNING, never a
 *                   green tick. A supplier nobody wrote a checklist for is not
 *                   a compliant supplier, and this is the exact failure that
 *                   makes a narrow-testing supplier look fine.
 *   open            at least one required item unsatisfied.
 *   satisfied       everything required is closed by a confirmed link — and
 *                   even then, an unclassified backlog is shown beside it,
 *                   because a document nobody has classified cannot close
 *                   anything and therefore quietly shrinks the satisfied side.
 *
 * WHY ITS OWN FETCH. `src/lib/api.ts`'s `fetchApi` is module-private, so this
 * component carries the same three lines `src/lib/recordsApi.ts` and
 * `src/pages/admin/LearningDashboard.tsx` already carry. If a gap client is
 * ever added to api.ts, delete this helper and call it instead.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControlLabel,
  Link,
  Paper,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import { AUTH_TOKEN_KEY } from '../lib/types';
import type { GapRequirement, SupplierGap, SupplierGapListResponse } from '../lib/types';

async function fetchGap(
  supplierId: string,
  includeRecommended: boolean,
): Promise<SupplierGap | null> {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  const params = new URLSearchParams({ supplier_id: supplierId });
  if (includeRecommended) params.set('include_recommended', '1');
  const res = await fetch(`/api/supplier-gaps?${params.toString()}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      message = body.error || message;
    } catch {
      // Keep the status code; the body was not JSON.
    }
    throw new Error(message);
  }
  const body = (await res.json()) as SupplierGapListResponse;
  return body.gaps[0] ?? null;
}

/** A count with a label. Reads as a number first, which is the whole point. */
function Stat({
  label,
  value,
  tone = 'default',
  title,
}: {
  label: string;
  value: number | string;
  tone?: 'default' | 'open' | 'ok' | 'warn';
  title?: string;
}) {
  const color =
    tone === 'open'
      ? 'error.main'
      : tone === 'ok'
        ? 'success.main'
        : tone === 'warn'
          ? 'warning.main'
          : 'text.primary';
  return (
    <Tooltip title={title ?? ''} disableHoverListener={!title}>
      <Box sx={{ minWidth: 96, pr: 3 }}>
        <Typography variant="h5" fontWeight={700} color={color} lineHeight={1.1}>
          {value}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {label}
        </Typography>
      </Box>
    </Tooltip>
  );
}

function TierChip({ tier }: { tier: GapRequirement['tier'] }) {
  return (
    <Chip
      size="small"
      variant="outlined"
      label={tier}
      color={tier === 'required' ? 'primary' : 'default'}
    />
  );
}

/** Why a line item applies at all — configured, triggered by a claim, or both. */
function OriginCell({ item }: { item: GapRequirement }) {
  if (item.origins.includes('claim')) {
    const claims = [...new Set(item.opened_by.map((c) => c.claim_type_name))];
    const label = claims.length > 0 ? `claim: ${claims.join(', ')}` : 'claim';
    return (
      <Tooltip
        title={item.opened_by
          .map((c) => `"${c.claim_type_name}" on ${c.document_title}`)
          .join('; ')}
      >
        <Chip
          size="small"
          variant="outlined"
          color="warning"
          label={item.origins.includes('applicability') ? `configured + ${label}` : label}
        />
      </Tooltip>
    );
  }
  return (
    <Typography variant="body2" color="text.secondary">
      configured
    </Typography>
  );
}

export default function SupplierRequirementGaps({
  supplierId,
  onConfigure,
}: {
  supplierId: string;
  /**
   * Take the reader to the editor. Optional because this panel still reports
   * correctly without one — but a "not configured" warning with nowhere to go
   * is a dead end, and the whole point of the warning is that somebody should
   * act on it.
   */
  onConfigure?: () => void;
}) {
  const [gap, setGap] = useState<SupplierGap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [includeRecommended, setIncludeRecommended] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setGap(await fetchGap(supplierId, includeRecommended));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load requirement gaps');
      setGap(null);
    } finally {
      setLoading(false);
    }
  }, [supplierId, includeRecommended]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
        <CircularProgress size={20} />
      </Box>
    );
  }

  if (error) {
    return (
      <Alert severity="error" sx={{ mb: 2 }}>
        {error}
      </Alert>
    );
  }

  if (!gap) return null;

  const unreviewed =
    gap.documents.classification.unclassified + gap.documents.classification.needs_review;
  const rows = showAll ? gap.applicable : gap.open;

  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          flexWrap: 'wrap',
          gap: 1,
          mb: 1.5,
        }}
      >
        <Box>
          <Typography variant="subtitle1" fontWeight={600}>
            Requirements
          </Typography>
          <Typography variant="caption" color="text.secondary">
            What this supplier owes, minus what their confirmed documents close.
            Counting {gap.tiers_counted.join(' + ')}.
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={includeRecommended}
                onChange={(e) => setIncludeRecommended(e.target.checked)}
              />
            }
            label={<Typography variant="body2">Count recommended too</Typography>}
          />
          {onConfigure && gap.status !== 'not_configured' ? (
            <Button size="small" variant="outlined" onClick={onConfigure}>
              Edit requirements
            </Button>
          ) : null}
        </Box>
      </Box>

      {/* The three states, never two. "Not configured" is a warning, not a pass. */}
      {gap.status === 'not_configured' ? (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <AlertTitle>No requirements configured</AlertTitle>
          Nothing has been attached to this supplier, so nothing is being checked.
          This is <strong>not</strong> the same as compliant — attach the requirements
          this supplier owes before reading anything below as clean.
          {onConfigure ? (
            <Box sx={{ mt: 1 }}>
              <Button size="small" variant="contained" color="warning" onClick={onConfigure}>
                Set up requirements
              </Button>
            </Box>
          ) : null}
        </Alert>
      ) : gap.status === 'satisfied' ? (
        <Alert severity={unreviewed > 0 ? 'info' : 'success'} sx={{ mb: 2 }}>
          Every {gap.tiers_counted.join(' + ')} requirement on file for this supplier is
          closed by a confirmed document
          {unreviewed > 0
            ? ` — but ${unreviewed} document${unreviewed === 1 ? '' : 's'} here ${
                unreviewed === 1 ? 'has' : 'have'
              } not been classified yet, so this may be premature.`
            : '.'}
        </Alert>
      ) : null}

      <Box sx={{ display: 'flex', flexWrap: 'wrap', rowGap: 1.5, mb: 2 }}>
        <Stat
          label="open"
          value={gap.open.length}
          tone={gap.open.length > 0 ? 'open' : 'ok'}
          title="Applicable requirements with no confirmed document closing them"
        />
        <Stat
          label="satisfied"
          value={
            gap.counts.required.satisfied +
            (includeRecommended ? gap.counts.recommended.satisfied : 0)
          }
          tone="ok"
          title="Closed by a confirmed document_requirements link"
        />
        <Stat
          label="applicable"
          value={
            gap.counts.required.applicable +
            (includeRecommended ? gap.counts.recommended.applicable : 0)
          }
          title="Configured for this supplier, plus anything a confirmed claim triggered"
        />
        <Stat
          label="documents"
          value={gap.documents.total}
          title="Active documents attributed to this supplier"
        />
        <Stat
          label="unclassified"
          value={unreviewed}
          tone={unreviewed > 0 ? 'warn' : 'default'}
          title={
            'Documents never classified, or machine-proposed and awaiting a human. ' +
            'They cannot close a requirement, so open counts may be overstated. ' +
            '"Unclassifiable" is a terminal human ruling and is excluded.'
          }
        />
        {!includeRecommended && gap.counts.recommended.open > 0 ? (
          <Stat
            label="recommended (not counted)"
            value={gap.counts.recommended.open}
            title="Advisory items, excluded from the counts by default"
          />
        ) : null}
      </Box>

      {gap.caveats.length > 0 ? (
        <Box sx={{ mb: 2 }}>
          {gap.caveats
            .filter((c) => c.code !== 'no_requirements_configured' || gap.status !== 'not_configured')
            .map((c) => (
              <Typography key={c.code} variant="caption" color="text.secondary" display="block">
                • {c.message}
              </Typography>
            ))}
        </Box>
      ) : null}

      {gap.applicable.length > 0 ? (
        <>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
            <Typography variant="body2" fontWeight={600}>
              {showAll
                ? `All applicable (${gap.applicable.length})`
                : `Open (${gap.open.length})`}
            </Typography>
            <Link
              component="button"
              variant="body2"
              underline="hover"
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll ? 'Show open only' : 'Show satisfied too'}
            </Link>
          </Box>
            <TableContainer component={Paper} variant="outlined">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Requirement</TableCell>
                    <TableCell>Group</TableCell>
                    <TableCell>Tier</TableCell>
                    <TableCell>Applies because</TableCell>
                    <TableCell>Status</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5}>
                        <Typography variant="body2" color="text.secondary">
                          Nothing open in the counted tiers.
                        </Typography>
                      </TableCell>
                    </TableRow>
                  ) : (
                    rows.map((item) => (
                      <TableRow key={item.requirement_id} hover>
                        <TableCell>
                          <Typography variant="body2" fontWeight={500}>
                            {item.name}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {item.requirement_id}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2" color="text.secondary">
                            {item.checklist || '—'}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <TierChip tier={item.tier} />
                        </TableCell>
                        <TableCell>
                          <OriginCell item={item} />
                        </TableCell>
                        <TableCell>
                          {item.satisfied ? (
                            <Tooltip
                              title={item.satisfied_by.map((d) => d.document_title).join('; ')}
                            >
                              <Chip
                                size="small"
                                color="success"
                                variant="outlined"
                                label={`closed by ${item.satisfied_by.length}`}
                              />
                            </Tooltip>
                          ) : (
                            <Chip size="small" color="error" variant="outlined" label="open" />
                          )}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </TableContainer>
        </>
      ) : null}
    </Paper>
  );
}
