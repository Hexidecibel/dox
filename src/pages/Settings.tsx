import { useMemo } from 'react';
import { useParams, useNavigate, Navigate } from 'react-router-dom';
import {
  Box,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Typography,
  Paper,
  Divider,
} from '@mui/material';
import {
  Category as DocTypesIcon,
  Hub as ConnectorsIcon,
  People as UsersIcon,
  AssignmentInd as AssignmentsIcon,
  VpnKey as ApiKeyIcon,
  Business as TenantsIcon,
  History as HistoryIcon,
  MonitorHeart as MonitorHeartIcon,
  Insights as InsightsIcon,
  Psychology as ExtractionContextIcon,
  Checklist as ChecklistIcon,
  Straighten as SpecLimitsIcon,
  LocalOffer as ClaimsIcon,
  Rule as RuleIcon,
} from '@mui/icons-material';
import { useAuth } from '../contexts/AuthContext';
import type { Role } from '../lib/types';

// Embedded page components — these already render their own content inside
// the app Layout (no nested layout), so we just render them in the pane.
import { DocumentTypes } from './admin/DocumentTypes';
import { Requirements } from './admin/Requirements';
import { SpecLimits } from './admin/SpecLimits';
import { ClaimTypes } from './admin/ClaimTypes';
import { ClaimRules } from './admin/ClaimRules';
import { Sources } from './admin/Sources';
import { Users } from './admin/Users';
import { Assignments } from './admin/Assignments';
import { ApiKeys } from './admin/ApiKeys';
import { Tenants } from './admin/Tenants';
import { IngestHistory } from './IngestHistory';
import { ProcessingStatus } from './admin/ProcessingStatus';
import LearningDashboard from './admin/LearningDashboard';
import TenantExtractionContextBox from './TenantExtractionContextBox';

interface SettingsItem {
  // URL-friendly key used as /settings/:section
  key: string;
  label: string;
  icon: React.ReactNode;
  roles: Role[];
  component: React.ComponentType;
}

interface SettingsSection {
  title: string;
  items: SettingsItem[];
}

const ALL_ADMIN: Role[] = ['super_admin', 'org_admin'];

const SECTIONS: SettingsSection[] = [
  {
    title: 'Catalog & Sources',
    items: [
      { key: 'extraction-context', label: 'Extraction Context', icon: <ExtractionContextIcon />, roles: ALL_ADMIN, component: TenantExtractionContextBox },
      { key: 'document-types', label: 'Document Types', icon: <DocTypesIcon />, roles: ALL_ADMIN, component: DocumentTypes },
      // The three registry facets, in the order a tenant configures them:
      // what a document IS (document types), what it SATISFIES (checklist),
      // what it TRIGGERS (claims) and what each claim opens (claim rules).
      { key: 'requirements', label: 'Checklist', icon: <ChecklistIcon />, roles: ALL_ADMIN, component: Requirements },
      { key: 'claim-types', label: 'Claims', icon: <ClaimsIcon />, roles: ALL_ADMIN, component: ClaimTypes },
      { key: 'claim-rules', label: 'Claim Rules', icon: <RuleIcon />, roles: ALL_ADMIN, component: ClaimRules },
      // Acceptance criteria for the values inside a document, as opposed to
      // the taxonomy above, which is about the document itself.
      { key: 'spec-limits', label: 'Spec Limits', icon: <SpecLimitsIcon />, roles: ALL_ADMIN, component: SpecLimits },
      { key: 'sources', label: 'Sources', icon: <ConnectorsIcon />, roles: ALL_ADMIN, component: Sources },
    ],
  },
  {
    title: 'Access',
    items: [
      { key: 'users', label: 'Users', icon: <UsersIcon />, roles: ALL_ADMIN, component: Users },
      { key: 'assignments', label: 'Assignments', icon: <AssignmentsIcon />, roles: ALL_ADMIN, component: Assignments },
      { key: 'api-keys', label: 'API Keys', icon: <ApiKeyIcon />, roles: ALL_ADMIN, component: ApiKeys },
      { key: 'tenants', label: 'Tenants', icon: <TenantsIcon />, roles: ['super_admin'], component: Tenants },
    ],
  },
  {
    title: 'System & Monitoring',
    items: [
      { key: 'ingest-history', label: 'Ingest History', icon: <HistoryIcon />, roles: ['super_admin', 'org_admin', 'user'], component: IngestHistory },
      { key: 'processing-status', label: 'Processing Status', icon: <MonitorHeartIcon />, roles: ['super_admin'], component: ProcessingStatus },
      { key: 'learning-dashboard', label: 'Learning Dashboard', icon: <InsightsIcon />, roles: ALL_ADMIN, component: LearningDashboard },
    ],
  },
];

export function Settings() {
  const { section } = useParams<{ section?: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const role = user?.role;

  // Sections filtered to items the current user can see; sections with no
  // visible items are dropped entirely.
  const visibleSections = useMemo(() => {
    if (!role) return [];
    return SECTIONS.map((s) => ({
      ...s,
      items: s.items.filter((i) => i.roles.includes(role)),
    })).filter((s) => s.items.length > 0);
  }, [role]);

  const allVisibleItems = useMemo(
    () => visibleSections.flatMap((s) => s.items),
    [visibleSections]
  );

  // The first item the user can see is the default selection.
  const defaultKey = allVisibleItems[0]?.key;
  const selected = section && allVisibleItems.some((i) => i.key === section) ? section : defaultKey;

  // No section in URL (or an invalid/unauthorized one) — redirect to the
  // default so the URL always reflects the visible selection.
  if (defaultKey && section !== selected) {
    return <Navigate to={`/settings/${selected}`} replace />;
  }

  if (!defaultKey) {
    return (
      <Box>
        <Typography variant="h5" fontWeight={700} gutterBottom>
          Settings
        </Typography>
        <Typography color="text.secondary">
          You don't have access to any settings.
        </Typography>
      </Box>
    );
  }

  const ActiveComponent = allVisibleItems.find((i) => i.key === selected)?.component;

  return (
    <Box>
      <Typography variant="h5" fontWeight={700} sx={{ mb: 2 }}>
        Settings
      </Typography>
      <Box sx={{ display: 'flex', gap: 3, flexDirection: { xs: 'column', md: 'row' }, alignItems: 'flex-start' }}>
        {/* Secondary in-page nav */}
        <Paper
          variant="outlined"
          sx={{
            width: { xs: '100%', md: 240 },
            flexShrink: 0,
            position: { md: 'sticky' },
            top: { md: 16 },
          }}
        >
          {visibleSections.map((s, idx) => (
            <Box key={s.title}>
              {idx > 0 && <Divider />}
              <Typography
                variant="overline"
                sx={{ display: 'block', px: 2, pt: 1.5, color: 'text.secondary', fontSize: '0.65rem' }}
              >
                {s.title}
              </Typography>
              <List dense sx={{ pt: 0 }}>
                {s.items.map((item) => (
                  <ListItemButton
                    key={item.key}
                    selected={item.key === selected}
                    onClick={() => navigate(`/settings/${item.key}`)}
                    sx={{ borderRadius: 1, mx: 1, mb: 0.25 }}
                  >
                    <ListItemIcon
                      sx={{ minWidth: 36, color: item.key === selected ? 'primary.main' : 'text.secondary' }}
                    >
                      {item.icon}
                    </ListItemIcon>
                    <ListItemText
                      primary={item.label}
                      primaryTypographyProps={{ fontSize: '0.875rem', fontWeight: item.key === selected ? 600 : 400 }}
                    />
                  </ListItemButton>
                ))}
              </List>
            </Box>
          ))}
        </Paper>

        {/* Content pane — renders the selected page component */}
        <Box sx={{ flex: 1, minWidth: 0, width: '100%' }}>
          {ActiveComponent && <ActiveComponent />}
        </Box>
      </Box>
    </Box>
  );
}
