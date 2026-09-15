import { Box, Typography } from '@mui/material';
import { UniversalSearchPanel } from '../components/search/UniversalSearchPanel';
import { useTenant } from '../contexts/TenantContext';
import { useAuth } from '../contexts/AuthContext';
import { useModuleAccess } from '../contexts/ModuleAccessContext';
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
  const { user } = useAuth();
  const { isVisible } = useModuleAccess();

  // Search itself belongs to no module and stays always-on, but taking
  // documents OUT of it is the supplier-document library's surface — so the
  // selection bar follows `library`, matching the server gate on
  // /api/document-exports (shared/modules.ts).
  const canExport = isVisible('library');

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
        enableExport={canExport}
        exportSender={
          user ? { name: user.name || user.email, email: user.email } : undefined
        }
      />
    </Box>
  );
}
