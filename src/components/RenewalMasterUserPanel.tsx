/**
 * "Who approves a supplier request when a record has no owner to ask?"
 * (migration 0133; AJ Conner, D-050.)
 *
 * A renewal request to a supplier needs one approval from a person. That
 * person is the first portal user behind the record's owner label, below on
 * this same page. This setting is the fallback: the master user. With neither,
 * the draft goes to the organisation's administrators.
 *
 * It sits beside the lead time because the three answers on this page are one
 * sentence: WHO is told, WHEN they are told, and who APPROVES what is then
 * sent to the supplier.
 */

import { useEffect, useState } from 'react';
import { Alert, Box, Button, CircularProgress, MenuItem, Paper, TextField, Typography } from '@mui/material';
import { api } from '../lib/api';
import type { RenewalDefaultOwnerResponse } from '../../shared/types';

const NONE = '__none__';

export function RenewalMasterUserPanel({ tenantId }: { tenantId?: string }) {
  const [data, setData] = useState<RenewalDefaultOwnerResponse | null>(null);
  const [value, setValue] = useState<string>(NONE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api.expirations.defaultOwner
      .get({ tenantId })
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setValue(d.user_id ?? NONE);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load the master user');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  const save = async () => {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const d = await api.expirations.defaultOwner.put({ userId: value === NONE ? null : value, tenantId });
      setData(d);
      setValue(d.user_id ?? NONE);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save the master user');
    } finally {
      setSaving(false);
    }
  };

  const dirty = (data?.user_id ?? NONE) !== value;
  // A stored user who no longer resolves is still shown, so it can be seen and replaced.
  const stale = data && data.user_id && !data.resolves ? data : null;

  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 2 }} data-testid="renewal-master-user">
      <Typography variant="h6" sx={{ mb: 0.5 }}>
        Who approves supplier requests
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        When a document nears its renewal date, a request to the supplier is drafted and waits for{' '}
        <strong>one approval by a person</strong> — nothing is ever sent to a supplier automatically.
        The approver is the first portal user behind the document's owner below. When the owner has
        no portal user (or the document has no owner), it is the master user chosen here; with
        neither, it goes to your administrators.
      </Typography>

      {loading ? (
        <CircularProgress size={22} />
      ) : (
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
          <TextField
            select
            size="small"
            label="Master user"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setSaved(false);
            }}
            sx={{ minWidth: 320 }}
            inputProps={{ 'aria-label': 'Master user' }}
          >
            <MenuItem value={NONE}>Nobody — use the administrators</MenuItem>
            {stale && (
              <MenuItem value={stale.user_id as string}>
                {stale.user_name || stale.user_email || 'Unknown user'} (inactive)
              </MenuItem>
            )}
            {(data?.candidates ?? []).map((c) => (
              <MenuItem key={c.id} value={c.id}>
                {c.name} — {c.email}
              </MenuItem>
            ))}
          </TextField>
          <Button variant="contained" size="small" onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
          {data?.updated_at && (
            <Typography variant="caption" color="text.secondary">
              Last changed{data.updated_by_name ? ` by ${data.updated_by_name}` : ''}.
            </Typography>
          )}
        </Box>
      )}

      {stale && (
        <Alert severity="warning" sx={{ mt: 2 }}>
          The master user on file is no longer an active user of this organization, so supplier
          requests currently fall to the administrators. Choose someone else or clear it.
        </Alert>
      )}
      {saved && <Alert severity="success" sx={{ mt: 2 }}>Saved.</Alert>}
      {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
    </Paper>
  );
}

export default RenewalMasterUserPanel;
