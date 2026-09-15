/**
 * LotMatchSuggestionList — the matcher's evidence for one order line, and the
 * one click that turns it into a link.
 *
 * The matcher never links a COA to a shipment on its own (client rule, AJ:
 * "It presents the evidence and I make the call"), so every candidate lands
 * here, the high-confidence ones included. Confidence and basis are shown so
 * the call is an informed one; Confirm is the only thing that writes the link.
 */

import { useState } from 'react';
import { Box, Button, Chip, CircularProgress, Stack, Tooltip, Typography } from '@mui/material';
import { Check as CheckIcon, Close as CloseIcon } from '@mui/icons-material';
import { api } from '../lib/api';

export interface LotMatchSuggestionLike {
  id: string;
  document_id: string;
  document_title?: string | null;
  match_basis: string | null;
  match_confidence: number | null;
  /** The matcher's words when the product bridge was unsure or unconfirmed (0113). */
  match_note?: string | null;
}

/** Plain words for the engine's basis codes. */
export function matchBasisLabel(basis: string | null): string {
  switch (basis) {
    case 'lot+product+supplier':
      return 'lot, product and supplier agree';
    case 'lot+product':
      return 'lot and product agree';
    case 'lot+code':
      return 'lot and product code agree';
    case 'lot_only':
      return 'lot number only';
    case 'legacy_auto_link':
      return 'linked automatically before matches needed confirming';
    default:
      return basis ?? 'unknown basis';
  }
}

export function LotMatchSuggestionList({
  suggestions,
  canResolve,
  onResolved,
  onOpenDocument,
}: {
  suggestions: LotMatchSuggestionLike[];
  canResolve: boolean;
  onResolved: () => void;
  onOpenDocument?: (documentId: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  if (suggestions.length === 0) return null;

  const resolve = async (id: string, action: 'accept' | 'reject') => {
    setBusy(id);
    setError('');
    try {
      await api.lotMatches.resolve(id, action);
      onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Stack spacing={0.75}>
      {suggestions.map((s) => {
        const pct = s.match_confidence != null ? Math.round(s.match_confidence * 100) : null;
        const high = s.match_confidence != null && s.match_confidence >= 0.85;
        return (
          <Box key={s.id} sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
            <Chip
              size="small"
              color={high ? 'info' : 'default'}
              variant={high ? 'filled' : 'outlined'}
              label={pct != null ? `Suggested ${pct}%` : 'Suggested'}
            />
            <Tooltip title={`Why: ${matchBasisLabel(s.match_basis)}.${s.match_note ? ` ${s.match_note}` : ''} Not linked until someone confirms it.`}>
              <Typography
                variant="body2"
                component={onOpenDocument ? 'button' : 'span'}
                onClick={onOpenDocument ? () => onOpenDocument(s.document_id) : undefined}
                sx={{
                  border: 0,
                  background: 'none',
                  p: 0,
                  cursor: onOpenDocument ? 'pointer' : 'default',
                  color: onOpenDocument ? 'primary.main' : 'text.primary',
                  textAlign: 'left',
                  wordBreak: 'break-word',
                }}
              >
                {s.document_title || s.document_id}
              </Typography>
            </Tooltip>
            <Typography variant="caption" color="text.secondary">
              {matchBasisLabel(s.match_basis)}
            </Typography>
            {s.match_note && (
              <Typography variant="caption" color="warning.main" sx={{ flexBasis: '100%' }} data-testid="lot-match-note">
                {s.match_note}
              </Typography>
            )}
            {canResolve && (
              <Box sx={{ display: 'inline-flex', gap: 0.5, ml: 'auto' }}>
                <Button
                  size="small"
                  variant="contained"
                  color="success"
                  disabled={busy !== null}
                  startIcon={busy === s.id ? <CircularProgress size={14} color="inherit" /> : <CheckIcon fontSize="small" />}
                  onClick={() => resolve(s.id, 'accept')}
                >
                  Confirm
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  color="error"
                  disabled={busy !== null}
                  startIcon={<CloseIcon fontSize="small" />}
                  onClick={() => resolve(s.id, 'reject')}
                >
                  Reject
                </Button>
              </Box>
            )}
          </Box>
        );
      })}
      {error && (
        <Typography variant="caption" color="error">
          {error}
        </Typography>
      )}
    </Stack>
  );
}
