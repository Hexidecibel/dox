/**
 * The sharing rule on one document (decision C-003, migration 0137): may this
 * document leave the organization, where that answer comes from, and -- for QA
 * and administrators -- a way to give this one document its own answer.
 *
 * Everybody sees the rule: a person about to add a document to an order or a
 * ZIP should know before they try that it is locked. Only somebody who may
 * change it sees the button; the server decides that (`sharing.can_edit`), and
 * decides again when the change is saved.
 *
 * A REASON IS REQUIRED. The override is a person deciding against the
 * document type's rule, and the audit row has to say why.
 */
import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import { api } from '../lib/api';
import { formatDate } from '../utils/format';
import {
  SHARING_RULES,
  SHARING_RULE_HELP,
  SHARING_RULE_LABELS,
  sharingRuleSourceLabel,
  type SharingRule,
} from '../../shared/sharingRule';
import type { DocumentSharingInfo } from '../../shared/types';

/** The Select's value for "no override: follow the document type". */
const FOLLOW_TYPE = 'type';

export function sharingRuleChipColor(rule: SharingRule): 'success' | 'warning' | 'error' {
  return rule === 'free' ? 'success' : rule === 'qa' ? 'warning' : 'error';
}

interface Props {
  documentId: string;
  sharing: DocumentSharingInfo | undefined;
  /** Called after a change is saved, so the page can reload the document. */
  onChanged: () => void;
}

export function DocumentSharingRule({ documentId, sharing, onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<string>(FOLLOW_TYPE);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // An older API response carries no rule; say nothing rather than guess one.
  if (!sharing) return null;

  const openDialog = () => {
    setChoice(sharing.override ?? FOLLOW_TYPE);
    setReason('');
    setError('');
    setOpen(true);
  };

  const nextOverride: SharingRule | null = choice === FOLLOW_TYPE ? null : (choice as SharingRule);
  const nextRule: SharingRule = nextOverride ?? sharing.type_rule;
  const unchanged = nextOverride === sharing.override;
  // Moving a document off "Locked" is an administrator's act; the server
  // enforces it, and the dialog says so before the person types a reason.
  const needsAdmin = sharing.rule === 'locked' && nextRule !== 'locked' && !sharing.can_unlock;

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await api.documents.update(documentId, {
        sharing_rule_override: nextOverride,
        sharing_rule_reason: reason.trim(),
      });
      setOpen(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The sharing rule could not be changed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box sx={{ mb: 2 }} data-testid="document-sharing-rule">
      <Typography variant="subtitle2" color="text.secondary" gutterBottom>
        Sharing
      </Typography>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Chip
          label={SHARING_RULE_LABELS[sharing.rule]}
          color={sharingRuleChipColor(sharing.rule)}
          variant="outlined"
          size="small"
        />
        <Typography variant="body2" color="text.secondary">
          {sharingRuleSourceLabel(sharing.source)}
        </Typography>
        {sharing.can_edit && (
          <Button size="small" onClick={openDialog} sx={{ textTransform: 'none' }}>
            Change
          </Button>
        )}
      </Box>
      <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
        {SHARING_RULE_HELP[sharing.rule]}
      </Typography>
      {sharing.override && (
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
          Set{sharing.override_by_name ? ` by ${sharing.override_by_name}` : ''}
          {sharing.override_at ? ` on ${formatDate(sharing.override_at)}` : ''}
          {sharing.override_reason ? `: ${sharing.override_reason}` : '.'}
        </Typography>
      )}

      <Dialog open={open} onClose={() => !saving && setOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>How this document may be shared</DialogTitle>
        <DialogContent>
          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}
          <FormControl fullWidth sx={{ mt: 1, mb: 1 }}>
            <InputLabel id="document-sharing-rule-label">Sharing</InputLabel>
            <Select
              labelId="document-sharing-rule-label"
              label="Sharing"
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              disabled={saving}
              inputProps={{ 'data-testid': 'document-sharing-select' }}
            >
              <MenuItem value={FOLLOW_TYPE}>
                Use the document type's rule ({SHARING_RULE_LABELS[sharing.type_rule]})
              </MenuItem>
              {SHARING_RULES.map((rule) => (
                <MenuItem key={rule} value={rule}>
                  {SHARING_RULE_LABELS[rule]} for this document
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {SHARING_RULE_HELP[nextRule]}
          </Typography>
          {needsAdmin && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              This document is locked. Only an administrator can unlock it.
            </Alert>
          )}
          <TextField
            label="Why"
            fullWidth
            required
            multiline
            minRows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={saving}
            helperText="Recorded with the change. Whoever reads the audit trail will see it."
            inputProps={{ maxLength: 500, 'data-testid': 'document-sharing-reason' }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={save}
            disabled={saving || unchanged || needsAdmin || reason.trim().length === 0}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
