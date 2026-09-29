import { Box, Typography } from '@mui/material';
import { SearchWorkspace } from '../components/search/SearchWorkspace';
import { useTenant } from '../contexts/TenantContext';
import { useAuth } from '../contexts/AuthContext';
import { useModuleAccess } from '../contexts/ModuleAccessContext';
import { HelpWell } from '../components/HelpWell';
import { helpContent } from '../lib/helpContent';

/**
 * Search — a thin shell over the one search workspace (search redesign
 * Phase 2). /documents renders the same workspace; this page starts from a
 * quiet, empty answer with the facet rail folded away.
 */
export function Search() {
  const { selectedTenantId } = useTenant();
  const { user } = useAuth();
  const { isVisible } = useModuleAccess();

  // Search itself belongs to no module and stays always-on, but taking
  // documents OUT of it is the supplier-document library's surface — so the
  // selection bar follows `library`, matching the server gate on
  // /api/document-exports (shared/modules.ts).
  const canExport = isVisible('library');

  return (
    <Box>
      <Box sx={{ mb: 2.5 }}>
        <Typography
          component="h1"
          sx={{
            fontFamily: "'Newsreader', Georgia, 'Times New Roman', serif",
            fontWeight: 500,
            fontSize: { xs: '1.9rem', sm: '2.3rem' },
            lineHeight: 1.15,
            letterSpacing: '-0.015em',
            color: 'text.primary',
          }}
        >
          Find the paper <Box component="em" sx={{ color: 'primary.main' }}>that proves it.</Box>
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75, maxWidth: 680 }}>
          Ask the way you would say it. dox reads the lot, date, PO and product out of your words, then tells you whether a document on file actually covers it.
        </Typography>
      </Box>

      <HelpWell id="search.list" title={helpContent.search.list?.headline ?? 'Search'}>
        {helpContent.search.list?.well ?? helpContent.search.well}
      </HelpWell>

      <SearchWorkspace
        surface="search"
        syncToUrl
        tenantId={selectedTenantId || undefined}
        enableExport={canExport}
        exportSender={user ? { name: user.name || user.email, email: user.email } : undefined}
      />
    </Box>
  );
}
