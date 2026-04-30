/**
 * Help — top-level docs viewer.
 *
 * Sidebar lists every module from `helpContent`; the right pane shows
 * the well + (eventually, in D1-D5) deep-link content for the selected
 * module. For D0 this is intentionally a shell — content fills in per
 * module slice.
 *
 * Route: `/help` and `/help/:module`. Admin-only auth gate happens at
 * the route registration level in App.tsx.
 */

import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Box,
  Card,
  Divider,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Typography,
} from '@mui/material';
import { helpContent, type HelpModuleKey } from '../lib/helpContent';
import { HelpWell } from '../components/HelpWell';

const MODULE_LABEL: Record<HelpModuleKey, string> = {
  connectors: 'Connectors',
  orders: 'Orders',
  customers: 'Customers',
  suppliers: 'Suppliers',
  products: 'Products',
  documents: 'Documents',
  document_types: 'Document Types',
  naming_templates: 'Naming Templates',
  bundles: 'Bundles',
  reports: 'Reports',
  activity: 'Activity',
  audit: 'Audit Log',
  search: 'Search',
  tenants: 'Tenants',
  users: 'Users',
  api_keys: 'API Keys',
  settings: 'Settings',
  records: 'Records',
  approvals: 'Approvals',
};

const MODULE_ORDER: HelpModuleKey[] = [
  'documents',
  'search',
  'bundles',
  'orders',
  'customers',
  'suppliers',
  'products',
  'document_types',
  'naming_templates',
  'connectors',
  'records',
  'approvals',
  'activity',
  'reports',
  'audit',
  'users',
  'api_keys',
  'tenants',
  'settings',
];

function isHelpModuleKey(value: string | undefined): value is HelpModuleKey {
  return !!value && Object.prototype.hasOwnProperty.call(helpContent, value);
}

export function Help() {
  const navigate = useNavigate();
  const { module } = useParams<{ module?: string }>();

  const selected: HelpModuleKey | null = useMemo(
    () => (isHelpModuleKey(module) ? module : null),
    [module],
  );
  const entry = selected ? helpContent[selected] : null;

  return (
    <Box>
      <Typography variant="h4" sx={{ mb: 2, fontWeight: 600 }}>
        Help &amp; Docs
      </Typography>
      <HelpWell id="help.index" title="In-app documentation">
        Pick a topic from the sidebar to read about it. Every page in
        dox also surfaces module-specific help via the (?) icons next
        to labels and the dismissible banners up top.
      </HelpWell>

      <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start' }}>
        <Card
          variant="outlined"
          sx={{ width: 240, flexShrink: 0, p: 0.5 }}
        >
          <List dense disablePadding>
            {MODULE_ORDER.map((key) => (
              <ListItem key={key} disablePadding>
                <ListItemButton
                  selected={selected === key}
                  onClick={() => navigate(`/help/${key}`)}
                  sx={{ borderRadius: 1 }}
                >
                  <ListItemText
                    primary={MODULE_LABEL[key]}
                    primaryTypographyProps={{
                      fontSize: '0.875rem',
                      fontWeight: selected === key ? 600 : 400,
                    }}
                  />
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        </Card>

        <Card variant="outlined" sx={{ flex: 1, p: 3, minHeight: 360 }}>
          {entry ? (
            <>
              <Typography variant="h5" sx={{ mb: 1, fontWeight: 600 }}>
                {entry.headline}
              </Typography>
              <Divider sx={{ mb: 2 }} />
              <Typography variant="body1" sx={{ mb: 2 }}>
                {entry.well}
              </Typography>
              {'list' in entry &&
                entry.list &&
                (entry.list.well as string) !== (entry.well as string) && (
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ mt: 2 }}
                  >
                    {entry.list.well}
                  </Typography>
                )}
              {/* Long-form sections from the module-specific `help` block.
                  D1 fills these in for connectors; later D-slices fill in
                  their own modules. Modules without a `help` block fall
                  back to the placeholder caption below. */}
              {selected === 'connectors' &&
                helpContent.connectors.help.sections.map((section) => (
                  <Box key={section.heading} sx={{ mt: 3 }}>
                    <Typography variant="h6" sx={{ fontWeight: 600, mb: 1 }}>
                      {section.heading}
                    </Typography>
                    <Typography
                      variant="body2"
                      sx={{ whiteSpace: 'pre-line' }}
                      color="text.primary"
                    >
                      {section.body}
                    </Typography>
                  </Box>
                ))}
              {selected !== 'connectors' && (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ mt: 4, display: 'block' }}
                >
                  Deep dives, screenshots, and field reference are added per
                  module slice (D1-D5).
                </Typography>
              )}
            </>
          ) : (
            <Typography variant="body1" color="text.secondary">
              Select a topic from the sidebar.
            </Typography>
          )}
        </Card>
      </Box>
    </Box>
  );
}
