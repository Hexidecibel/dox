import { useEffect, useState } from 'react';
import { Snackbar, Alert, Button } from '@mui/material';
import { useAuth } from '../contexts/AuthContext';
import { useReleaseNotes } from '../contexts/ReleaseNotesContext';
import { versionInfo } from '../lib/versionInfo';
import { compareVersions } from '../lib/versionCompare';

const STORAGE_PREFIX = 'dox_lastSeenVersion_';

function storageKey(userId: string | null): string {
  return STORAGE_PREFIX + (userId || 'anon');
}

export function WhatsNewToast() {
  const { user, loading } = useAuth();
  const { openReleaseNotes } = useReleaseNotes();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (loading) return;
    const key = storageKey(user?.id ?? null);
    const stored = localStorage.getItem(key);
    if (stored === null) {
      // First visit ever for this scope — silently mark as seen.
      localStorage.setItem(key, versionInfo.version);
      return;
    }
    try {
      if (compareVersions(stored, versionInfo.version) < 0) {
        setOpen(true);
      }
    } catch {
      // If stored value is malformed, treat as never seen.
      localStorage.setItem(key, versionInfo.version);
    }
  }, [loading, user?.id]);

  const markSeen = () => {
    const key = storageKey(user?.id ?? null);
    localStorage.setItem(key, versionInfo.version);
    setOpen(false);
  };

  const handleView = () => {
    openReleaseNotes(versionInfo.version);
    markSeen();
  };

  return (
    <Snackbar
      open={open}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      onClose={(_, reason) => {
        if (reason === 'clickaway') return;
        markSeen();
      }}
    >
      <Alert
        severity="info"
        variant="filled"
        onClose={markSeen}
        action={
          <Button color="inherit" size="small" onClick={handleView}>
            View
          </Button>
        }
        sx={{ alignItems: 'center' }}
      >
        ✨ What's new in v{versionInfo.version} — view changes
      </Alert>
    </Snackbar>
  );
}
