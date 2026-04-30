/**
 * /docs/connectors — Phase D5 vendor-facing public docs.
 *
 * No auth, no app shell. The route is mounted OUTSIDE the
 * ProtectedRoute boundary in App.tsx so the URL is shareable with
 * vendors and external systems who do not have a dox login.
 *
 * What this page is for:
 *   Tenant admins set up a connector and pick which delivery doors
 *   they want their vendors to use (email, HTTP API, S3 bucket,
 *   public link, manual upload). Each door has slightly different
 *   plumbing and gotchas, and re-explaining them on every onboarding
 *   call is tedious. So we ship one canonical page that admins can
 *   send to anyone and say "here is how you deliver files to us."
 *
 * Content lives in `src/lib/vendorDocsContent.ts` so the copy is
 * grep-able and reviewable without having to read JSX.
 *
 * No tenant or connector data is fetched on this page — it is pure
 * documentation. Placeholders like `<connector-slug>` show through
 * verbatim; the user fills them in based on what their connector
 * owner told them. We deliberately do NOT inline any real slugs,
 * tokens, account ids, or secrets here.
 */

import { useEffect } from 'react';
import {
  Box,
  Container,
  Divider,
  Link as MuiLink,
  List,
  ListItem,
  ListItemText,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import { vendorDocsContent } from '../lib/vendorDocsContent';

/** Monospace code block styled to match the dark snippets used elsewhere. */
function CodeBlock({ children }: { children: string }) {
  return (
    <Box
      component="pre"
      sx={{
        m: 0,
        p: 1.5,
        bgcolor: 'grey.900',
        color: 'grey.50',
        borderRadius: 1,
        fontFamily: 'monospace',
        fontSize: '0.8rem',
        whiteSpace: 'pre',
        overflowX: 'auto',
      }}
    >
      {children}
    </Box>
  );
}

export function PublicDocsConnectors() {
  // Set a useful page title so a vendor with the link in a tab can
  // tell what it is at a glance.
  useEffect(() => {
    const previous = document.title;
    document.title = vendorDocsContent.pageTitle;
    return () => {
      document.title = previous;
    };
  }, []);

  return (
    <Box
      sx={{
        minHeight: { xs: '100dvh', md: '100vh' },
        bgcolor: 'background.default',
        py: { xs: 3, md: 6 },
      }}
    >
      <Container maxWidth="md">
        <Paper
          elevation={2}
          sx={{
            p: { xs: 3, md: 5 },
            borderRadius: 2,
          }}
        >
          {/* Header ------------------------------------------------- */}
          <Typography
            variant="h4"
            component="h1"
            sx={{ fontWeight: 700, mb: 1 }}
          >
            {vendorDocsContent.pageTitle}
          </Typography>
          <Typography
            variant="body1"
            color="text.secondary"
            sx={{ mb: 3, lineHeight: 1.6 }}
          >
            {vendorDocsContent.intro}
          </Typography>

          {/* TOC ---------------------------------------------------- */}
          <Box
            sx={{
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 1,
              p: 2,
              mb: 4,
              bgcolor: 'background.paper',
            }}
          >
            <Typography
              variant="overline"
              color="text.secondary"
              sx={{ display: 'block', mb: 0.5 }}
            >
              Delivery doors
            </Typography>
            <List dense disablePadding>
              {vendorDocsContent.doors.map((door) => (
                <ListItem
                  key={door.id}
                  disablePadding
                  sx={{ py: 0.25 }}
                >
                  <ListItemText
                    primary={
                      <MuiLink
                        href={`#${door.id}`}
                        underline="hover"
                        sx={{ fontSize: '0.95rem' }}
                      >
                        {door.title}
                      </MuiLink>
                    }
                  />
                </ListItem>
              ))}
            </List>
          </Box>

          {/* Sections ----------------------------------------------- */}
          <Stack spacing={5}>
            {vendorDocsContent.doors.map((door) => (
              <Box
                key={door.id}
                id={door.id}
                component="section"
                // Anchor offset so jumping to a section doesn't tuck
                // the heading under the top of the viewport.
                sx={{ scrollMarginTop: 24 }}
              >
                <Typography
                  variant="h5"
                  component="h2"
                  sx={{ fontWeight: 600, mb: 1 }}
                >
                  {door.title}
                </Typography>

                <Typography variant="body1" sx={{ mb: door.detail ? 1.5 : 2, lineHeight: 1.6 }}>
                  {door.intro}
                </Typography>
                {door.detail && (
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 2, lineHeight: 1.6 }}>
                    {door.detail}
                  </Typography>
                )}

                <Typography
                  variant="overline"
                  color="text.secondary"
                  sx={{ display: 'block', mb: 0.5 }}
                >
                  Example
                </Typography>
                <CodeBlock>{door.example}</CodeBlock>

                {door.secondaryExample && (
                  <Box sx={{ mt: 2 }}>
                    <Typography
                      variant="overline"
                      color="text.secondary"
                      sx={{ display: 'block', mb: 0.5 }}
                    >
                      {door.secondaryExampleTitle ?? 'Also'}
                    </Typography>
                    <CodeBlock>{door.secondaryExample}</CodeBlock>
                  </Box>
                )}

                {door.gotchas.length > 0 && (
                  <Box sx={{ mt: 2 }}>
                    <Typography
                      variant="overline"
                      color="text.secondary"
                      sx={{ display: 'block', mb: 0.5 }}
                    >
                      Gotchas
                    </Typography>
                    <Box
                      component="ul"
                      sx={{
                        m: 0,
                        pl: 3,
                        '& li': {
                          mb: 0.75,
                          fontSize: '0.9rem',
                          lineHeight: 1.55,
                        },
                      }}
                    >
                      {door.gotchas.map((g, i) => (
                        <li key={i}>{g}</li>
                      ))}
                    </Box>
                  </Box>
                )}
              </Box>
            ))}
          </Stack>

          {/* Footer ------------------------------------------------- */}
          <Divider sx={{ mt: 5, mb: 3 }} />
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ lineHeight: 1.6 }}
          >
            {vendorDocsContent.footer}
          </Typography>
        </Paper>
      </Container>
    </Box>
  );
}
