/**
 * SupplierListImport — "easy mode" for requirements derived from real data.
 *
 * Download the template, fill in the verified supplier list with what is bought
 * from each supplier, upload it, read the preview, apply. The page never
 * derives anything itself: it posts the file to POST /api/supplier-list/import
 * (dry run first), which is the same door a future webhook/API feed uses, and
 * renders what the one rule function said.
 *
 * The preview leads with the two things a QA manager must not miss: rows that
 * could not be used (and why), and requirements that a previous import derived
 * but this list no longer supports — those are flagged for review, not deleted.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  CircularProgress,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import {
  Download as DownloadIcon,
  ExpandMore as ExpandMoreIcon,
  UploadFile as UploadIcon,
} from '@mui/icons-material';
import { api } from '../lib/api';
import {
  SUPPLIER_LIST_COLUMNS,
  supplierListTemplateCsv,
} from '../../shared/supplierListTemplate';
import type {
  SupplierListDerivedLine,
  SupplierListImportResponse,
  SupplierListImportRun,
} from '../../shared/types';

export interface SupplierListImportProps {
  tenantId?: string;
  onApplied?: () => void;
}

const ACTION_LABEL: Record<SupplierListDerivedLine['action'], string> = {
  add: 'Add',
  adopt_unconfirmed: 'Confirms unconfirmed',
  refresh_derived: 'Already derived',
  keep_person: 'Kept — set by a person',
};

function downloadTemplate() {
  const blob = new Blob([supplierListTemplateCsv()], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'verified-supplier-list-template.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function readFile(file: File): Promise<{ csv?: string; xlsx_base64?: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the file'));
    if (/\.xlsx$/i.test(file.name)) {
      reader.onload = () => resolve({ xlsx_base64: String(reader.result) });
      reader.readAsDataURL(file);
    } else {
      reader.onload = () => resolve({ csv: String(reader.result) });
      reader.readAsText(file);
    }
  });
}

export function importSummary(r: SupplierListImportResponse): string {
  const c = r.counts;
  const parts = [
    `${c.suppliers_listed} supplier${c.suppliers_listed === 1 ? '' : 's'} (${c.suppliers_matched} matched, ${c.suppliers_created} new)`,
    `${c.requirements_added} requirement${c.requirements_added === 1 ? '' : 's'} to add`,
  ];
  if (c.requirements_adopted_unconfirmed) parts.push(`${c.requirements_adopted_unconfirmed} unconfirmed confirmed by the list`);
  if (c.requirements_tier_changed) parts.push(`${c.requirements_tier_changed} tier change${c.requirements_tier_changed === 1 ? '' : 's'}`);
  if (c.requirements_kept_person_set) parts.push(`${c.requirements_kept_person_set} kept as a person set them`);
  if (c.requirements_newly_flagged) parts.push(`${c.requirements_newly_flagged} no longer on the list (flagged)`);
  return parts.join(' · ');
}

export default function SupplierListImport({ tenantId, onApplied }: SupplierListImportProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [payload, setPayload] = useState<{ csv?: string; xlsx_base64?: string } | null>(null);
  const [preview, setPreview] = useState<SupplierListImportResponse | null>(null);
  const [applied, setApplied] = useState<SupplierListImportResponse | null>(null);
  const [runs, setRuns] = useState<SupplierListImportRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadRuns = useCallback(async () => {
    try {
      setRuns((await api.supplierList.imports({ tenant_id: tenantId, limit: 5 })).imports);
    } catch {
      // The history is a convenience; the import works without it.
    }
  }, [tenantId]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  const send = async (dryRun: boolean, body = payload, name = fileName) => {
    if (!body) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.supplierList.import({ ...body, file_name: name ?? undefined, dry_run: dryRun, tenant_id: tenantId });
      if (dryRun) {
        setPreview(res);
        setApplied(null);
      } else {
        setApplied(res);
        setPreview(null);
        setPayload(null);
        await loadRuns();
        onApplied?.();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    setApplied(null);
    try {
      const body = await readFile(file);
      setFileName(file.name);
      setPayload(body);
      await send(true, body, file.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the file');
    }
  };

  const rejected = preview?.rows.filter((r) => r.status === 'rejected') ?? [];
  const otherUnmatched = preview?.unmatched.filter((u) => u.kind !== 'row') ?? [];

  return (
    <Box>
      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle1" fontWeight={600}>
          Import your verified supplier list
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          One row per supplier and product you buy from them. Requirements are worked out from it: every approved supplier
          owes a certificate of insurance and a third-party food safety certificate; its category adds that category&apos;s
          packet; each claim you make on a product adds the paperwork that claim needs; each product bought adds a spec
          sheet. Requirements a person set are never changed.
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 1.5 }}>
          <Button size="small" variant="outlined" startIcon={<DownloadIcon />} onClick={downloadTemplate}>
            Download template
          </Button>
          <Button size="small" variant="contained" startIcon={<UploadIcon />} disabled={busy} onClick={() => inputRef.current?.click()}>
            Upload list (.csv or .xlsx)
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.xlsx,text/csv"
            hidden
            data-testid="supplier-list-file"
            onChange={(e) => {
              void onFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </Box>
        <Typography variant="caption" color="text.secondary" component="div">
          Columns: {SUPPLIER_LIST_COLUMNS.map((c) => `${c.header}${c.required ? ' *' : ''}`).join(' · ')}
        </Typography>
      </Paper>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}
      {busy && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
          <CircularProgress size={24} />
        </Box>
      )}

      {applied && (
        <Alert severity="success" sx={{ mb: 2 }}>
          <AlertTitle>Imported {applied.file_name ?? 'the list'}</AlertTitle>
          {importSummary(applied)}
        </Alert>
      )}

      {preview && !busy && (
        <Box data-testid="supplier-list-preview">
          <Alert severity="info" sx={{ mb: 2 }}>
            <AlertTitle>Preview of {preview.file_name ?? 'the list'} — nothing has been written yet</AlertTitle>
            {importSummary(preview)}
          </Alert>

          {rejected.length > 0 && (
            <Alert severity="error" sx={{ mb: 2 }}>
              <AlertTitle>
                {rejected.length} row{rejected.length === 1 ? '' : 's'} could not be used
              </AlertTitle>
              {rejected.map((r) => (
                <div key={r.line}>
                  Line {r.line}
                  {r.supplier_name ? ` (${r.supplier_name})` : ''}: {r.problems.join(' ')}
                </div>
              ))}
            </Alert>
          )}

          {otherUnmatched.length > 0 && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              <AlertTitle>Not matched</AlertTitle>
              {otherUnmatched.map((u, i) => (
                <div key={`${u.line}-${i}`}>
                  Line {u.line}: {u.reason}
                </div>
              ))}
            </Alert>
          )}

          {preview.rule_problems.length > 0 && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              {preview.rule_problems.map((p) => (
                <div key={p}>{p}</div>
              ))}
            </Alert>
          )}

          {preview.flagged.some((f) => !f.already_flagged) && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              <AlertTitle>No longer supported by this list — will be flagged for review, not deleted</AlertTitle>
              {preview.flagged
                .filter((f) => !f.already_flagged)
                .map((f) => (
                  <div key={f.row_id}>
                    {f.supplier_name}: {f.requirement_name} ({f.tier})
                  </div>
                ))}
            </Alert>
          )}

          {preview.suppliers.map((s) => (
            <Accordion key={s.supplier_key} disableGutters variant="outlined">
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Typography variant="body2" fontWeight={600}>
                    {s.supplier_name}
                  </Typography>
                  <Chip
                    size="small"
                    variant="outlined"
                    color={s.supplier_match === 'matched' ? 'default' : 'primary'}
                    label={s.supplier_match === 'matched' ? 'Existing supplier' : 'New supplier'}
                  />
                  {s.categories.map((c) => (
                    <Chip key={c} size="small" variant="outlined" label={c} />
                  ))}
                  {!s.approved && <Chip size="small" color="warning" label="Not approved — nothing derived" />}
                  <Typography variant="caption" color="text.secondary">
                    {s.lines.filter((l) => l.tier === 'required').length} required ·{' '}
                    {s.lines.filter((l) => l.tier === 'recommended').length} recommended
                    {s.products.length ? ` · ${s.products.length} product${s.products.length === 1 ? '' : 's'}` : ''}
                  </Typography>
                </Box>
              </AccordionSummary>
              <AccordionDetails>
                {s.lines.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    Nothing derived.
                  </Typography>
                ) : (
                  <Box sx={{ overflowX: 'auto' }}>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>Requirement</TableCell>
                          <TableCell>Tier</TableCell>
                          <TableCell>What happens</TableCell>
                          <TableCell>Because</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {s.lines.map((l) => (
                          <TableRow key={l.requirement_slug}>
                            <TableCell>{l.requirement_name}</TableCell>
                            <TableCell>{l.tier}</TableCell>
                            <TableCell>
                              {ACTION_LABEL[l.action]}
                              {l.from_tier && l.from_tier !== l.tier && l.action !== 'keep_person' ? ` (${l.from_tier} → ${l.tier})` : ''}
                            </TableCell>
                            <TableCell>{l.because.join('; ')}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </Box>
                )}
              </AccordionDetails>
            </Accordion>
          ))}

          <Box sx={{ display: 'flex', gap: 1, mt: 2 }}>
            <Button variant="contained" disabled={busy || preview.counts.rows_accepted === 0} onClick={() => void send(false)}>
              Apply this list
            </Button>
            <Button
              onClick={() => {
                setPreview(null);
                setPayload(null);
              }}
            >
              Discard
            </Button>
          </Box>
        </Box>
      )}

      {runs.length > 0 && (
        <Box sx={{ mt: 3 }}>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Recent imports
          </Typography>
          {runs.map((r) => (
            <Typography key={r.id} variant="body2" color="text.secondary">
              {new Date(r.created_at.replace(' ', 'T') + (r.created_at.endsWith('Z') ? '' : 'Z')).toLocaleString()} —{' '}
              {r.file_name ?? r.input_format} by {r.created_by_name ?? 'unknown'}: {r.counts.suppliers_listed} suppliers,{' '}
              {r.counts.requirements_added} added, {r.counts.requirements_newly_flagged} flagged
            </Typography>
          ))}
        </Box>
      )}
    </Box>
  );
}
