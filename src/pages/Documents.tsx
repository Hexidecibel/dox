import { Box, Typography } from '@mui/material';
import { DocumentSearchPanel } from '../components/search/DocumentSearchPanel';
import { useTenant } from '../contexts/TenantContext';
import { HelpWell } from '../components/HelpWell';
import { helpContent } from '../lib/helpContent';

/**
 * Documents page — Phase 6 of the Document Search v2 migration.
 *
 * The page is now a thin shell over <DocumentSearchPanel>. The panel
 * owns search input, facets, sort, results, pagination, and URL
 * sync. The legacy client-side substring filter and the redundant
 * status/category chip strip have been removed in favor of the
 * server-backed FTS5 search and the facet sidebar.
 */
export function Documents() {
  const { selectedTenantId } = useTenant();

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          mb: 3,
          flexWrap: 'wrap',
          gap: 1,
        }}
      >
        <Typography variant="h4" fontWeight={700}>
          Documents
        </Typography>
      </Box>

      <HelpWell
        id="documents.list"
        title={helpContent.documents.list?.headline ?? 'Documents'}
      >
        {helpContent.documents.list?.well ?? helpContent.documents.well}
      </HelpWell>

      <DocumentSearchPanel
        syncToUrl
        tenantId={selectedTenantId || undefined}
      />
    </Box>
  );
}
