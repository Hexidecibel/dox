/**
 * ApplyPacketDialog — apply one requirement packet to the suppliers an admin
 * picked, PREVIEW FIRST.
 *
 * The apply button does not exist until a preview has been shown for exactly
 * the packet and options on screen. The preview says, per supplier, what gets
 * added, which unconfirmed rows (from the initial bulk seed) get adopted or
 * removed, and what is already there — including a tier a person chose that
 * differs from the packet's, which is kept. A packet never changes a row a
 * person or the verified supplier list set; the dialog says so rather than
 * letting somebody find out.
 *
 * Mounted from Supplier Requirements (many suppliers), Supplier › Requirements
 * (one), and the worklist's "Replace with a packet" (replaceUnconfirmed on).
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Radio,
  RadioGroup,
  Typography,
} from '@mui/material';
import { api } from '../lib/api';
import type {
  BulkApplyPacketResponse,
  PacketPreviewLine,
  RequirementPacketCatalogResponse,
} from '../../shared/types';

export interface ApplyPacketDialogProps {
  open: boolean;
  onClose: () => void;
  suppliers: Array<{ id: string; name: string }>;
  tenantId?: string;
  /** Start with "also remove unconfirmed rows the packet does not name" ticked. */
  defaultReplaceUnconfirmed?: boolean;
  onApplied?: (result: BulkApplyPacketResponse) => void;
}

const ACTION_LABEL: Record<PacketPreviewLine['action'], string> = {
  add: 'Add',
  adopt_unconfirmed: 'Confirm unconfirmed',
  already_present: 'Already set',
  remove_unconfirmed: 'Remove unconfirmed',
};

const SOURCE_LABEL: Record<string, string> = {
  human: 'set by a person',
  packet: 'from a packet',
  derived: 'from the verified supplier list',
};

export function describePacketLine(line: PacketPreviewLine): string {
  switch (line.action) {
    case 'add':
      return `Add as ${line.tier}`;
    case 'adopt_unconfirmed':
      return line.from_tier === line.tier
        ? `Unconfirmed row confirmed as ${line.tier}`
        : `Unconfirmed row changes ${line.from_tier} → ${line.tier}`;
    case 'already_present': {
      const who = line.existing_source ? SOURCE_LABEL[line.existing_source] ?? line.existing_source : '';
      return line.tier === line.packet_tier
        ? `Already ${line.tier}${who ? `, ${who}` : ''}`
        : `Kept as ${line.tier} (${who}); the packet says ${line.packet_tier}`;
    }
    case 'remove_unconfirmed':
      return `Unconfirmed ${line.from_tier} row removed — the packet does not name it`;
  }
}

export default function ApplyPacketDialog({
  open,
  onClose,
  suppliers,
  tenantId,
  defaultReplaceUnconfirmed = false,
  onApplied,
}: ApplyPacketDialogProps) {
  const [catalog, setCatalog] = useState<RequirementPacketCatalogResponse | null>(null);
  const [packet, setPacket] = useState('');
  const [replace, setReplace] = useState(defaultReplaceUnconfirmed);
  const [preview, setPreview] = useState<BulkApplyPacketResponse | null>(null);
  const [previewKey, setPreviewKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setPreviewKey('');
    setError('');
    setReplace(defaultReplaceUnconfirmed);
    api.supplierRequirements
      .packets({ tenant_id: tenantId })
      .then((res) => {
        setCatalog(res);
        setPacket((cur) => cur || res.packets[0]?.slug || '');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load packets'));
  }, [open, tenantId, defaultReplaceUnconfirmed]);

  const ids = useMemo(() => suppliers.map((s) => s.id), [suppliers]);
  const currentKey = `${packet}|${replace}|${ids.join(',')}`;
  const previewIsCurrent = preview !== null && previewKey === currentKey;

  const run = async (dryRun: boolean) => {
    setBusy(true);
    setError('');
    try {
      const res = await api.supplierRequirements.applyPacket({
        packet,
        supplier_ids: ids,
        dry_run: dryRun,
        replace_unconfirmed: replace,
        tenant_id: tenantId,
      });
      if (dryRun) {
        setPreview(res);
        setPreviewKey(currentKey);
      } else {
        onApplied?.(res);
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply packet');
    } finally {
      setBusy(false);
    }
  };

  const changes = preview ? preview.totals.add + preview.totals.adopt_unconfirmed + preview.totals.remove_unconfirmed : 0;
  const title =
    suppliers.length === 1 ? `Apply a requirement packet to ${suppliers[0].name}` : `Apply a requirement packet to ${suppliers.length} suppliers`;

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent dividers>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        {!catalog ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
            <CircularProgress size={24} />
          </Box>
        ) : (
          <>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              A packet adds requirements. It never changes or removes a requirement a person set, or one that came from
              the verified supplier list.
            </Typography>
            <RadioGroup value={packet} onChange={(e) => setPacket(e.target.value)}>
              {catalog.packets.map((p) => (
                <FormControlLabel
                  key={p.slug}
                  value={p.slug}
                  control={<Radio size="small" />}
                  label={
                    <Box sx={{ py: 0.5 }}>
                      <Typography variant="body2" fontWeight={600}>
                        {p.name}{' '}
                        <Typography component="span" variant="caption" color="text.secondary">
                          {p.requirements.length} required, {p.recommends.length} recommended
                        </Typography>
                      </Typography>
                      {p.description && (
                        <Typography variant="caption" color="text.secondary" display="block">
                          {p.description}
                        </Typography>
                      )}
                    </Box>
                  }
                />
              ))}
            </RadioGroup>
            <FormControlLabel
              sx={{ mt: 1 }}
              control={<Checkbox size="small" checked={replace} onChange={(e) => setReplace(e.target.checked)} />}
              label={
                <Typography variant="body2">
                  Also remove each supplier&apos;s <strong>unconfirmed</strong> requirements (from the initial bulk
                  seed) that this packet does not name
                </Typography>
              }
            />

            {preview && previewIsCurrent && (
              <Box sx={{ mt: 2 }} data-testid="packet-preview">
                <Alert severity={changes === 0 ? 'info' : 'success'} sx={{ mb: 1.5 }}>
                  {changes === 0
                    ? 'Nothing would change — every requirement in this packet is already set for these suppliers.'
                    : `${preview.totals.add} to add, ${preview.totals.adopt_unconfirmed} unconfirmed to confirm, ${preview.totals.remove_unconfirmed} unconfirmed to remove, ${preview.totals.already_present} already set.`}
                </Alert>
                {preview.unknown_requirements.length > 0 && (
                  <Alert severity="warning" sx={{ mb: 1.5 }}>
                    This tenant has no active requirement for: {preview.unknown_requirements.join(', ')}. Those items
                    are skipped.
                  </Alert>
                )}
                {preview.suppliers.map((s) => (
                  <Box key={s.supplier_id} sx={{ mb: 1.5 }}>
                    <Typography variant="subtitle2">
                      {s.supplier_name}{' '}
                      <Typography component="span" variant="caption" color="text.secondary">
                        {s.counts.add} add · {s.counts.adopt_unconfirmed} confirm · {s.counts.remove_unconfirmed} remove ·{' '}
                        {s.counts.already_present} already set
                        {s.counts.tier_kept_different > 0 ? ` (${s.counts.tier_kept_different} kept at a different tier)` : ''}
                      </Typography>
                    </Typography>
                    {s.lines
                      .filter((l) => l.action !== 'already_present' || l.tier !== l.packet_tier)
                      .map((l) => (
                        <Box
                          key={`${l.action}-${l.requirement_slug}`}
                          sx={{ display: 'flex', gap: 1, alignItems: 'center', pl: 1, py: 0.25, flexWrap: 'wrap' }}
                        >
                          <Chip
                            size="small"
                            variant="outlined"
                            color={l.action === 'remove_unconfirmed' ? 'warning' : l.action === 'add' ? 'primary' : 'default'}
                            label={ACTION_LABEL[l.action]}
                          />
                          <Typography variant="body2">{l.requirement_name}</Typography>
                          <Typography variant="caption" color="text.secondary">
                            {describePacketLine(l)}
                          </Typography>
                        </Box>
                      ))}
                  </Box>
                ))}
              </Box>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button onClick={() => void run(true)} disabled={!packet || busy || ids.length === 0}>
          {busy && !previewIsCurrent ? 'Previewing…' : 'Preview'}
        </Button>
        <Button
          variant="contained"
          onClick={() => void run(false)}
          disabled={!previewIsCurrent || busy || changes === 0}
        >
          {busy && previewIsCurrent ? 'Applying…' : 'Apply'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
