/**
 * The two places the first-run wizard is offered: a dismissible banner across
 * the top of the shell, and a card on the dashboard.
 *
 * DELIBERATELY NOT A FORCED MODAL. `TenantContext` lets a super_admin scope
 * into any tenant, so a modal that fired on "this tenant looks empty" would
 * ambush a live demo the moment somebody switched into a fresh tenant to show
 * something. An offer that can be ignored is also the honest shape: nothing in
 * the wizard is required, and the portal works with none of it.
 *
 * WHEN IT APPEARS. `GET /api/tenant-setup` answers, and it says yes only when
 * the tenant has NO completed run AND zero active documents. Either test on its
 * own is wrong: a tenant with documents but no run must never be nagged (they
 * are plainly already working), and a completed run over a still-empty tenant
 * must not re-prompt (they finished; the emptiness is their choice).
 *
 * DISMISSAL IS PER BROWSER, PER TENANT, and lives in `localStorage` rather than
 * on the run row. Dismissing the banner is not a statement about the tenant —
 * it is one person saying "not now" — and writing it to a shared row would hide
 * the prompt from that person's colleague as well.
 */

import { useCallback, useEffect, useState } from 'react';
import { Alert, AlertTitle, Box, Button, Card, CardContent, Typography } from '@mui/material';
import { AutoFixHigh as SetupIcon } from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { useTenant } from '../contexts/TenantContext';
import type { TenantSetupNeedReason } from '../lib/types';

const DISMISS_KEY_PREFIX = 'dox.setupBannerDismissed.';

interface SetupPromptState {
  needed: boolean;
  reason: TenantSetupNeedReason;
  /** Resuming reads differently from starting, and the run knows which. */
  resuming: boolean;
  step: number;
}

/**
 * Ask whether the wizard should be offered for the tenant currently in scope.
 *
 * Admin-only, and silent on failure: an offer that cannot be computed is simply
 * not made. Nothing here is load-bearing enough to justify an error state on
 * the dashboard of a working tenant.
 */
export function useSetupPrompt(): SetupPromptState | null {
  const { user } = useAuth();
  const { selectedTenantId } = useTenant();
  const [state, setState] = useState<SetupPromptState | null>(null);

  const isAdmin = user?.role === 'super_admin' || user?.role === 'org_admin';
  const tenantId = selectedTenantId ?? undefined;

  useEffect(() => {
    if (!isAdmin) {
      setState(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.tenantSetup.get({ tenantId });
        if (cancelled) return;
        setState({
          needed: res.needed,
          reason: res.reason,
          resuming: res.reason === 'in_progress',
          step: res.run?.current_step ?? 1,
        });
      } catch {
        if (!cancelled) setState(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdmin, tenantId]);

  return state;
}

/** The dismissible banner. Renders nothing at all when the answer is no. */
export function SetupBanner() {
  const prompt = useSetupPrompt();
  const { selectedTenantId } = useTenant();
  const navigate = useNavigate();
  const key = `${DISMISS_KEY_PREFIX}${selectedTenantId ?? 'self'}`;
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(key) === '1');
    } catch {
      // localStorage unavailable — show the banner rather than hide it. An
      // offer shown twice is a nuisance; an offer never shown is the feature
      // failing to exist.
      setDismissed(false);
    }
  }, [key]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(key, '1');
    } catch {
      /* the dismissal just will not persist */
    }
  }, [key]);

  if (!prompt?.needed || dismissed) return null;

  return (
    <Alert
      severity="info"
      icon={<SetupIcon />}
      onClose={dismiss}
      sx={{ mb: 2 }}
      action={
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <Button
            size="small"
            variant="contained"
            onClick={() => navigate(prompt.resuming ? `/setup/${prompt.step}` : '/setup')}
          >
            {prompt.resuming ? `Resume at step ${prompt.step}` : 'Set it up'}
          </Button>
          <Button size="small" onClick={dismiss}>
            Not now
          </Button>
        </Box>
      }
    >
      <AlertTitle>
        {prompt.resuming ? 'Setup is half finished' : 'This tenant has not been set up yet'}
      </AlertTitle>
      Six short screens fill it with the vocabulary the rest of the portal reasons about, and point
      renewal alerts at real people. You can leave part way through and come back.
    </Alert>
  );
}

/** The dashboard card. Same offer, in the place somebody lands. */
export function SetupCard() {
  const prompt = useSetupPrompt();
  const navigate = useNavigate();

  if (!prompt?.needed) return null;

  return (
    <Card
      sx={{
        cursor: 'pointer',
        borderColor: 'primary.light',
        transition: 'border-color 0.15s',
        '&:hover': { borderColor: 'primary.main' },
      }}
      onClick={() => navigate(prompt.resuming ? `/setup/${prompt.step}` : '/setup')}
    >
      <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <Box
          sx={{
            width: 48,
            height: 48,
            borderRadius: 1.5,
            bgcolor: 'primary.main',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <SetupIcon sx={{ fontSize: 24, color: 'white' }} />
        </Box>
        <Box>
          <Typography variant="body1" fontWeight={700}>
            {prompt.resuming ? `Finish setting up — step ${prompt.step} of 6` : 'Set up this tenant'}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Six screens from empty to a portal that demonstrates itself.
          </Typography>
        </Box>
      </CardContent>
    </Card>
  );
}

export default SetupBanner;
