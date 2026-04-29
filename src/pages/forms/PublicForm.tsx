/**
 * /f/:slug — Public Typeform-feel form page.
 *
 * No app shell, no nav, no auth. The route is mounted OUTSIDE the
 * ProtectedRoute boundary in App.tsx so anonymous external users can
 * land here without being redirected to /login.
 *
 * The page only handles fetch + submit IO; the visual experience lives
 * in PublicFormRenderer so the form builder can preview it inline.
 */

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Box, CircularProgress, Typography } from '@mui/material';
import { publicFormsApi } from '../../lib/recordsApi';
import { PublicFormRenderer } from '../../components/forms/PublicFormRenderer';
import type { PublicFormView, RecordRowData } from '../../../shared/types';

export function PublicForm() {
  const { slug } = useParams<{ slug: string }>();
  const [view, setView] = useState<PublicFormView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!slug) {
      setError('Form not available.');
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const v = await publicFormsApi.get(slug);
        if (cancelled) return;
        setView(v);
        // Set tab title to the form's name
        document.title = v.form.name;
      } catch (err) {
        if (cancelled) return;
        const code = (err as { code?: string }).code;
        setError(code === 'not_found'
          ? 'This form is no longer available.'
          : 'We couldn’t load this form. Please try again.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (loading) {
    return (
      <Box
        sx={{
          minHeight: { xs: '100dvh', md: '100vh' },
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: 'background.paper',
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  if (error || !view) {
    return (
      <Box
        sx={{
          minHeight: { xs: '100dvh', md: '100vh' },
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: 'background.paper',
          textAlign: 'center',
          px: 3,
        }}
      >
        <Box sx={{ maxWidth: 460 }}>
          <Typography
            sx={{
              fontSize: { xs: 28, md: 34 },
              fontWeight: 600,
              letterSpacing: -0.4,
              color: 'text.primary',
              mb: 1.5,
              lineHeight: 1.2,
            }}
          >
            This form isn’t available
          </Typography>
          <Typography
            sx={{
              color: 'text.secondary',
              fontSize: { xs: 15, md: 16 },
              lineHeight: 1.6,
            }}
          >
            It may have been moved, archived, or isn’t accepting submissions
            right now. If you think this is a mistake, contact whoever shared
            the link with you.
          </Typography>
        </Box>
      </Box>
    );
  }

  return (
    <PublicFormRenderer
      view={view}
      onSubmit={async (data: RecordRowData, turnstileToken: string) => {
        if (!slug) throw new Error('No slug');
        await publicFormsApi.submit(slug, {
          data,
          turnstile_token: turnstileToken,
        });
      }}
    />
  );
}
