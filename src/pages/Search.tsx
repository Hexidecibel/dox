import { Box, Typography } from '@mui/material';
import { UniversalSearchPanel } from '../components/search/UniversalSearchPanel';
import { useTenant } from '../contexts/TenantContext';
import { HelpWell } from '../components/HelpWell';
import { helpContent } from '../lib/helpContent';

/**
 * Search page — Phase 6b of the Document Search v2 migration.
 *
 * The page is now a thin shell over <UniversalSearchPanel>. The panel
 * owns the search input (with recent/saved popover + AI toggle), the
 * type tabs (All | Documents | Orders | Customers | Bundles), the
 * cross-entity result rendering, and URL sync — all backed by the new
 * `/api/search` universal FTS5 endpoint.
 *
 * The legacy two-tab Documents/Orders form, the manual category +
 * date-range filters, the CSV/JSON export controls, and the direct
 * calls to `api.documents.search()` / `api.orders.list()` /
 * `api.orders.naturalSearch()` have all been removed in favor of the
 * unified panel.
 */
export function Search() {
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
          Search
        </Typography>
      </Box>

      <HelpWell
        id="search.list"
        title={helpContent.search.list?.headline ?? 'Search'}
      >
        {helpContent.search.list?.well ?? helpContent.search.well}
      </HelpWell>

      <UniversalSearchPanel
        syncToUrl
        tenantId={selectedTenantId || undefined}
      />
    </Box>
  );
}
