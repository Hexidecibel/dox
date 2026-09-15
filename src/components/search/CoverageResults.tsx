import {
  Alert,
  AlertTitle,
  Box,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ReportProblemIcon from '@mui/icons-material/ReportProblem';
import HourglassTopIcon from '@mui/icons-material/HourglassTop';
import { Link as RouterLink } from 'react-router-dom';
import { ResultCardDocument } from './ResultCardDocument';
import type {
  SearchConstraintCheck,
  SearchCoverageFields,
  SearchFieldProvenance,
  SearchUnreviewedCandidate,
  UniversalSearchDocument,
} from '../../../shared/types';

/**
 * Coverage-aware result view (Any-Field COA Retrieval, D6 / R9).
 *
 * Three sections, never blended, in this order:
 *   1. documents that COVER what was asked (every stated constraint verified
 *      on the document's own fields), with the evidence under each;
 *   2. nearby documents that do NOT — under a heading that says so, each with
 *      the reason it does not match;
 *   3. Review Queue files that look relevant but are not on file yet.
 *
 * When nothing covers the search the page leads with that, in words, before
 * any candidate is shown — so a near miss can never be read as the answer.
 */
export interface CoverageResultsProps extends SearchCoverageFields {
  documents: UniversalSearchDocument[];
}

const PROVENANCE_LABEL: Record<SearchFieldProvenance, string> = {
  extracted: 'read from the document',
  linked_record: 'linked record',
  system: 'recorded by the portal',
};

function Evidence({ checks, kind }: { checks: SearchConstraintCheck[]; kind: 'covering' | 'candidate' }) {
  const shown = kind === 'covering' ? checks : checks.filter((c) => c.outcome !== 'match');
  if (shown.length === 0) return null;
  return (
    <Stack spacing={0.25} sx={{ mt: 0.75 }} data-testid={`evidence-${kind}`}>
      {shown.map((c, i) => (
        <Typography
          key={`${c.constraint_id}-${i}`}
          variant="caption"
          sx={{ display: 'block', color: kind === 'covering' ? 'success.dark' : 'warning.dark' }}
        >
          {kind === 'covering' ? '✓ ' : '✕ '}
          {c.message}
          {c.provenance && (
            <Box component="span" sx={{ color: 'text.secondary' }}>
              {' '}({c.field_label ? `${c.field_label}, ` : ''}{PROVENANCE_LABEL[c.provenance]})
            </Box>
          )}
        </Typography>
      ))}
    </Stack>
  );
}

function UnreviewedCard({ u }: { u: SearchUnreviewedCandidate }) {
  return (
    <Card variant="outlined" sx={{ mb: 1, borderStyle: 'dashed' }}>
      <CardActionArea component={RouterLink} to={u.review_url}>
        <CardContent sx={{ py: 1.25, '&:last-child': { pb: 1.25 } }}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }} useFlexGap>
            <HourglassTopIcon fontSize="small" color="action" />
            <Typography variant="subtitle2" sx={{ fontWeight: 600, minWidth: 0, overflowWrap: 'anywhere' }}>
              {u.file_name}
            </Typography>
            <Chip size="small" label="Not reviewed" variant="outlined" />
            {u.record_label && <Chip size="small" label={u.record_label} variant="outlined" />}
            {u.supplier && <Chip size="small" label={u.supplier} variant="outlined" color="secondary" />}
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            {u.match_reason} Open it in the Review Queue →
          </Typography>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}

export function CoverageResults({
  documents,
  coverage,
  constraints = [],
  dropped_constraints = [],
  coverage_summary,
  unreviewed_candidates = [],
  coverage_scan_truncated,
}: CoverageResultsProps) {
  const covering = documents.filter((d) => d.match_status === 'covering');
  const candidates = documents.filter((d) => d.match_status === 'candidate_not_matching');

  if (!coverage || coverage === 'unconstrained') {
    // Nothing was stated to verify, so nothing is labelled: a plain list.
    return (
      <Box data-testid="coverage-results">
        {documents.map((d) => <ResultCardDocument key={d.id} doc={d} />)}
        {documents.length === 0 && unreviewed_candidates.length === 0 && (
          <Typography variant="body2" color="text.secondary">No documents found.</Typography>
        )}
        <Box sx={{ mt: documents.length ? 2 : 0 }}>
          <UnreviewedCandidatesSection items={unreviewed_candidates} />
        </Box>
      </Box>
    );
  }

  return (
    <Box data-testid="coverage-results">
      {constraints.length > 0 && (
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mb: 1.5, flexWrap: 'wrap' }} useFlexGap>
          <Typography variant="caption" color="text.secondary">
            Searching for a document that covers:
          </Typography>
          {constraints.map((c) => (
            <Tooltip key={c.id} title={c.note ?? `Checked against: ${c.fields.join(', ')}`}>
              <Chip size="small" label={c.label} color="primary" variant="outlined" />
            </Tooltip>
          ))}
        </Stack>
      )}

      {dropped_constraints.length > 0 && (
        <Alert severity="info" sx={{ mb: 2 }}>
          <AlertTitle>Part of your search could not be applied</AlertTitle>
          {dropped_constraints.map((d, i) => (
            <Typography key={i} variant="body2">
              “{d.label}”: {d.reason}
            </Typography>
          ))}
          <Typography variant="body2" sx={{ mt: 0.5 }}>
            Because of that, nothing below can be confirmed as covering your search.
          </Typography>
        </Alert>
      )}

      {coverage === 'none' && (
        <Alert severity="warning" icon={<ReportProblemIcon />} sx={{ mb: 2 }} data-testid="no-coverage-banner">
          <AlertTitle>No covering document on file</AlertTitle>
          {coverage_summary}
          {candidates.length > 0 && ' The documents below are nearby, but none of them matches — check the reason on each before using one.'}
        </Alert>
      )}

      {coverage === 'covered' && (
        <Alert severity="success" icon={<CheckCircleIcon />} sx={{ mb: 2 }}>
          {coverage_summary} The fields each was checked against are shown under it.
        </Alert>
      )}

      {coverage_scan_truncated && (
        <Alert severity="info" sx={{ mb: 2 }}>
          This workspace has more documents than one coverage check reads, so the oldest were not checked.
        </Alert>
      )}

      {covering.length > 0 && (
        <Box sx={{ mb: 3 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
            Covering documents ({covering.length})
          </Typography>
          {covering.map((d) => (
            <ResultCardDocument
              key={d.id}
              doc={d}
              tone="covering"
              footer={<Evidence checks={d.match_checks ?? []} kind="covering" />}
            />
          ))}
        </Box>
      )}

      {candidates.length > 0 && (
        <Box sx={{ mb: 3 }} data-testid="candidates-section">
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
            Nearby — does not match ({candidates.length})
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            These are close to what you asked for. Each one fails at least one part of your search.
          </Typography>
          {candidates.map((d) => (
            <ResultCardDocument
              key={d.id}
              doc={d}
              tone="candidate"
              footer={<Evidence checks={d.match_checks ?? []} kind="candidate" />}
            />
          ))}
        </Box>
      )}

      {unreviewed_candidates.length > 0 && (
        <Box sx={{ mb: 3 }} data-testid="unreviewed-section">
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
            In the Review Queue — not on file yet ({unreviewed_candidates.length})
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            A file here is never a covering document until someone approves it.
          </Typography>
          {unreviewed_candidates.map((u) => (
            <UnreviewedCard key={u.queue_id} u={u} />
          ))}
        </Box>
      )}

    </Box>
  );
}

/** Unreviewed queue files for an ordinary search — shown under the results. */
export function UnreviewedCandidatesSection({ items }: { items: SearchUnreviewedCandidate[] }) {
  if (items.length === 0) return null;
  return (
    <Box data-testid="unreviewed-section">
      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
        In the Review Queue — not on file yet ({items.length})
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        These match your search but have not been reviewed.
      </Typography>
      {items.map((u) => (
        <UnreviewedCard key={u.queue_id} u={u} />
      ))}
    </Box>
  );
}
