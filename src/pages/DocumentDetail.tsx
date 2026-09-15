import { useState, useEffect, type ReactElement } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { formatDate } from '../utils/format';
import {
  Box,
  Typography,
  Button,
  Chip,
  CircularProgress,
  Alert,
  Paper,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  useMediaQuery,
  useTheme,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  Collapse,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Select,
  InputLabel,
  FormControl,
  Tooltip,
  Autocomplete,
} from '@mui/material';
import {
  ArrowBack as BackIcon,
  Download as DownloadIcon,
  CloudUpload as UploadIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Archive as ArchiveIcon,
  MoreVert as MoreIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  Save as SaveIcon,
  CheckCircle as ConfirmedIcon,
  HelpOutline as SuggestedIcon,
  Block as RejectedIcon,
} from '@mui/icons-material';
import { api } from '../lib/api';
import type {
  Document,
  DocumentVersion,
  ApiDocumentType,
  ApiRequirement,
  ApiClaimType,
  ApiDocumentRequirement,
  ApiDocumentClaim,
  DocumentLinkedLot,
  RenewalType,
} from '../lib/types';
import {
  DocumentFacetPicker,
  draftsFromLinks,
  linksFromDrafts,
  type FacetLinkDraft,
  type FacetLinkDraftMap,
} from '../components/DocumentFacetPicker';
import { VersionHistory } from '../components/VersionHistory';
import { UploadDialog } from '../components/UploadDialog';
import { RoleGuard } from '../components/RoleGuard';
import { DocumentPreview } from '../components/DocumentPreview';
import { CopyId } from '../components/CopyId';
import { ProductLinker } from '../components/ProductLinker';
import { useAuth } from '../contexts/AuthContext';
import SupplierAutocomplete, { type SupplierValue } from '../components/SupplierAutocomplete';
import EntityNotes from '../components/EntityNotes';
import { HelpWell } from '../components/HelpWell';
import { InfoTooltip } from '../components/InfoTooltip';
import { helpContent } from '../lib/helpContent';

const statusColors: Record<string, 'success' | 'warning' | 'error'> = {
  active: 'success',
  archived: 'warning',
  deleted: 'error',
};

const RENEWAL_OPTIONS: { value: RenewalType; label: string; hasInterval: boolean }[] = [
  { value: 'renewal_application', label: 'Renewal application', hasInterval: true },
  { value: 'hard_expiry', label: 'Hard expiry', hasInterval: false },
  { value: 'keep_current', label: 'Keep current', hasInterval: false },
  { value: 'review_cycle', label: 'Review cycle', hasInterval: true },
];

function renewalLabel(t: RenewalType | null | undefined): string {
  return RENEWAL_OPTIONS.find((o) => o.value === t)?.label || '';
}

/**
 * Split a facet's links into the three states a reviewer actually acts on.
 * Anything that is not explicitly confirmed or rejected counts as awaiting
 * review — an unknown status must never read as a pass.
 */
function splitByStatus<T extends { status: string }>(links: T[] | undefined) {
  const confirmed: T[] = [];
  const suggested: T[] = [];
  const rejected: T[] = [];
  for (const link of links ?? []) {
    if (link.status === 'confirmed') confirmed.push(link);
    else if (link.status === 'rejected') rejected.push(link);
    else suggested.push(link);
  }
  return { confirmed, suggested, rejected };
}

/** Either facet's link row, as the document endpoints return it. */
type FacetLinkView = ApiDocumentRequirement | ApiDocumentClaim;

/** Vocabulary name for a facet link, whichever alias the endpoint emitted. */
function facetLinkName(link: FacetLinkView): string {
  const l = link as unknown as Record<string, unknown>;
  return String(
    l.vocab_name ?? l.requirement_name ?? l.claim_type_name ?? l.vocab_slug ?? '(unknown)',
  );
}

/** Provenance line for a link's tooltip — where it came from, how sure. */
function facetLinkProvenance(link: FacetLinkView): string {
  const l = link as unknown as Record<string, unknown>;
  const bits: string[] = [];
  if (l.source) bits.push(`source: ${String(l.source)}`);
  if (l.confidence != null) bits.push(`${Math.round(Number(l.confidence) * 100)}% confidence`);
  if (l.confirmed_at) bits.push(`confirmed ${String(l.confirmed_at)}`);
  if (l.evidence) bits.push(`evidence: “${String(l.evidence)}”`);
  return bits.join(' · ');
}

export function DocumentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const { isReader, isAdmin } = useAuth();
  const [doc, setDoc] = useState<Document | null>(null);
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);

  // Mobile action menu
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const menuOpen = Boolean(anchorEl);

  // Preview version
  const [previewVersion, setPreviewVersion] = useState<DocumentVersion | null>(null);

  // Edit dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editTags, setEditTags] = useState('');
  const [editDocumentTypeId, setEditDocumentTypeId] = useState('');
  const [saving, setSaving] = useState(false);

  // Metadata inline editing
  const [metaEditing, setMetaEditing] = useState(false);
  const [metaFields, setMetaFields] = useState<Record<string, string>>({});
  const [metaSaving, setMetaSaving] = useState(false);

  // Admin-only supplier editing
  const [supplierEditing, setSupplierEditing] = useState(false);
  const [supplierValue, setSupplierValue] = useState<SupplierValue>({ supplierName: '', verified: false });
  const [supplierSaving, setSupplierSaving] = useState(false);

  // Source metadata collapse
  const [sourceMetaOpen, setSourceMetaOpen] = useState(false);

  // Document types for dropdown
  const [documentTypes, setDocumentTypes] = useState<ApiDocumentType[]>([]);

  // Registry edit (categories multi, aliases, criteria, applies_to, owner, renewal)
  const [tenantDocTypes, setTenantDocTypes] = useState<ApiDocumentType[]>([]);
  const [registryEditing, setRegistryEditing] = useState(false);
  const [registrySaving, setRegistrySaving] = useState(false);
  const [regCategoryIds, setRegCategoryIds] = useState<string[]>([]);
  const [regPrimaryId, setRegPrimaryId] = useState('');
  const [regAliases, setRegAliases] = useState<string[]>([]);
  const [regCriteria, setRegCriteria] = useState<string[]>([]);
  const [regAppliesTo, setRegAppliesTo] = useState<string[]>([]);
  const [regOwner, setRegOwner] = useState('');
  const [regRenewalType, setRegRenewalType] = useState<RenewalType | ''>('');
  const [regRenewalInterval, setRegRenewalInterval] = useState('');
  const [regRenewalDue, setRegRenewalDue] = useState('');

  // Registry facets (migration 0080): layer 2 (what this document SATISFIES)
  // and layer 3 (what it TRIGGERS). This page is where a machine's `suggested`
  // link becomes a human's `confirmed` one — the only status gap detection
  // counts — so the two are rendered as separate, labelled groups rather than
  // one undifferentiated chip row.
  const [requirementVocab, setRequirementVocab] = useState<ApiRequirement[]>([]);
  const [claimVocab, setClaimVocab] = useState<ApiClaimType[]>([]);
  const [facetsEditing, setFacetsEditing] = useState(false);
  const [facetsSaving, setFacetsSaving] = useState(false);
  const [reqLinks, setReqLinks] = useState<FacetLinkDraftMap>(new Map());
  const [claimLinks, setClaimLinks] = useState<FacetLinkDraftMap>(new Map());
  // Links the checkbox list cannot represent (a second link to the same claim
  // type with a different subject). Carried through the save untouched, because
  // PUT REPLACES the set and would otherwise delete them.
  const [reqPassthrough, setReqPassthrough] = useState<FacetLinkDraft[]>([]);
  const [claimPassthrough, setClaimPassthrough] = useState<FacetLinkDraft[]>([]);

  // Linked lots (one per sublot under Option B). Best-effort; empty for docs
  // with no lot linkage.
  const [linkedLots, setLinkedLots] = useState<DocumentLinkedLot[]>([]);

  const loadDocument = async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [document, vers, lots] = await Promise.all([
        api.documents.get(id),
        api.documents.versions(id),
        api.documents.lots(id).catch(() => [] as DocumentLinkedLot[]),
      ]);
      setDoc(document);
      setVersions(vers);
      setLinkedLots(lots);
      // Set preview to latest version (or keep current selection if still valid)
      if (vers.length > 0) {
        setPreviewVersion((prev) => {
          if (prev && vers.find((v: { version_number: number }) => v.version_number === prev.version_number)) return prev;
          return vers[0]; // versions are ordered newest first
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load document');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDocument();
  }, [id]);

  // Sync inline metadata fields when doc loads
  useEffect(() => {
    if (doc) {
      const fields: Record<string, string> = {};
      if (doc.primaryMetadata) {
        for (const [k, v] of Object.entries(doc.primaryMetadata)) {
          fields[k] = v || '';
        }
      }
      setMetaFields(fields);
    }
  }, [doc]);

  // Load document types for the dropdown, scoped to the document's
  // supplier so the picker shows global (supplier_id NULL) + that
  // supplier's own doctypes rather than the whole tenant list.
  useEffect(() => {
    const loadDocTypes = async () => {
      try {
        const result = await api.documentTypes.list({
          tenant_id: doc?.tenant_id || undefined,
          active: 1,
          supplier_id: doc?.supplierId ?? undefined,
        });
        setDocumentTypes(result.documentTypes || []);
      } catch {
        // Non-critical, silently ignore
      }
    };
    if (doc?.tenant_id) loadDocTypes();
  }, [doc?.tenant_id, doc?.supplierId]);

  // Full tenant document-type list for the multi-category registry picker.
  useEffect(() => {
    const load = async () => {
      try {
        const result = await api.documentTypes.list({ tenant_id: doc?.tenant_id || undefined, active: 1 });
        setTenantDocTypes(result.documentTypes || []);
      } catch { /* non-critical */ }
    };
    if (doc?.tenant_id) load();
  }, [doc?.tenant_id]);

  // The tenant's facet vocabularies, loaded the same way admin/Requirements.tsx
  // and admin/ClaimTypes.tsx load them. Scoped to the document's tenant because
  // the write path rejects cross-tenant ids outright.
  useEffect(() => {
    const load = async () => {
      try {
        const [reqs, claims] = await Promise.all([
          api.requirements.list({ tenant_id: doc?.tenant_id || undefined, active: 1 }),
          api.claimTypes.list({ tenant_id: doc?.tenant_id || undefined, active: 1 }),
        ]);
        setRequirementVocab(reqs.requirements || []);
        setClaimVocab(claims.claimTypes || []);
      } catch { /* non-critical: the section degrades to its empty state */ }
    };
    if (doc?.tenant_id) load();
  }, [doc?.tenant_id]);

  const openRegistryEdit = () => {
    if (!doc) return;
    const cats = (doc.categories || []).map((c) => c.document_type_id);
    setRegCategoryIds(cats);
    setRegPrimaryId((doc.categories || []).find((c) => c.is_primary)?.document_type_id || cats[0] || '');
    setRegAliases(doc.aliases || []);
    setRegCriteria(doc.criteria || []);
    setRegAppliesTo(doc.appliesTo || []);
    setRegOwner(doc.owner || '');
    setRegRenewalType(doc.renewalType || '');
    setRegRenewalInterval(doc.renewalIntervalMonths != null ? String(doc.renewalIntervalMonths) : '');
    setRegRenewalDue(doc.renewalDueDate || '');
    setRegistryEditing(true);
  };

  const toggleRegCategory = (id: string, checked: boolean) => {
    setRegCategoryIds((prev) => {
      const next = checked ? [...prev, id] : prev.filter((c) => c !== id);
      setRegPrimaryId((cur) => {
        if (next.length === 0) return '';
        if (!cur || !next.includes(cur)) return next[0];
        return cur;
      });
      return next;
    });
  };

  const regRenewalHasInterval = RENEWAL_OPTIONS.find((o) => o.value === regRenewalType)?.hasInterval;

  const handleSaveRegistry = async () => {
    if (!doc || !id) return;
    setRegistrySaving(true);
    try {
      await api.documents.update(id, {
        categories: regCategoryIds,
        primary_category_id: regPrimaryId || null,
        aliases: regAliases,
        criteria: regCriteria,
        applies_to: regAppliesTo,
        owner: regOwner.trim() || null,
        renewal_type: regRenewalType || null,
        renewal_interval_months:
          regRenewalHasInterval && regRenewalInterval ? parseInt(regRenewalInterval, 10) : null,
        renewal_due_date: regRenewalDue || null,
      });
      setRegistryEditing(false);
      loadDocument();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update registry fields');
    } finally {
      setRegistrySaving(false);
    }
  };

  // --- Registry facets -----------------------------------------------------

  const openFacetsEdit = () => {
    if (!doc) return;
    const reqs = draftsFromLinks(doc.requirements as unknown as Array<Record<string, unknown>>, 'requirement_id');
    const claims = draftsFromLinks(doc.claims as unknown as Array<Record<string, unknown>>, 'claim_type_id');
    setReqLinks(reqs.drafts);
    setReqPassthrough(reqs.passthrough);
    setClaimLinks(claims.drafts);
    setClaimPassthrough(claims.passthrough);
    setFacetsEditing(true);
  };

  /**
   * Save both facet sets. PUT replaces each facet's whole set, so BOTH keys are
   * always sent — including rejected rows, which would otherwise be deleted and
   * re-suggested by the next ingest of the same document.
   */
  const handleSaveFacets = async () => {
    if (!doc || !id) return;
    setFacetsSaving(true);
    try {
      await api.documents.update(id, {
        requirements: linksFromDrafts(reqLinks, reqPassthrough),
        claims: linksFromDrafts(claimLinks, claimPassthrough),
      });
      setFacetsEditing(false);
      loadDocument();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save requirements and claims');
    } finally {
      setFacetsSaving(false);
    }
  };

  /**
   * The one-click reviewer path: everything the pipeline proposed becomes a
   * human decision. Confirmed and rejected links are resent unchanged so the
   * REPLACE does not drop them.
   */
  const handleConfirmSuggestions = async () => {
    if (!doc || !id) return;
    setFacetsSaving(true);
    try {
      const promote = (links: Array<Record<string, unknown>> | undefined, key: string) => {
        const { drafts, passthrough } = draftsFromLinks(links, key);
        for (const [k, d] of drafts) {
          if (d.status === 'suggested') drafts.set(k, { ...d, status: 'confirmed' });
        }
        const promoted = passthrough.map((d) =>
          d.status === 'suggested' ? { ...d, status: 'confirmed' as const } : d,
        );
        return linksFromDrafts(drafts, promoted);
      };
      await api.documents.update(id, {
        requirements: promote(doc.requirements as unknown as Array<Record<string, unknown>>, 'requirement_id'),
        claims: promote(doc.claims as unknown as Array<Record<string, unknown>>, 'claim_type_id'),
      });
      loadDocument();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to confirm suggestions');
    } finally {
      setFacetsSaving(false);
    }
  };

  const handleUploadSuccess = () => {
    setUploadOpen(false);
    loadDocument();
  };

  const openEdit = () => {
    if (!doc) return;
    setEditTitle(doc.title);
    setEditDescription(doc.description || '');
    setEditCategory(doc.category || '');
    setEditTags(doc.tags.join(', '));
    setEditDocumentTypeId(doc.documentTypeId || '');
    setEditOpen(true);
    setAnchorEl(null);
  };

  const handleSaveEdit = async () => {
    if (!doc || !id) return;
    setSaving(true);
    try {
      await api.documents.update(id, {
        title: editTitle.trim(),
        description: editDescription.trim() || undefined,
        category: editCategory.trim() || undefined,
        tags: editTags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        document_type_id: editDocumentTypeId || null,
      });
      setEditOpen(false);
      loadDocument();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update document');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveMetadata = async () => {
    if (!doc || !id) return;
    setMetaSaving(true);
    try {
      // Build primary_metadata from edited fields, stripping empty values
      const newMeta: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(metaFields)) {
        newMeta[k] = v.trim() || null;
      }
      await api.documents.update(id, {
        primary_metadata: Object.values(newMeta).some(v => v) ? newMeta : null,
      });
      setMetaEditing(false);
      loadDocument();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update metadata');
    } finally {
      setMetaSaving(false);
    }
  };

  // Admin-only: change the supplier on an existing document. Sends supplier_id
  // when an existing supplier was selected, else supplier_name (find-or-create).
  const openSupplierEdit = () => {
    if (!doc) return;
    setSupplierValue(
      doc.supplierId
        ? { supplierId: doc.supplierId, supplierName: doc.supplierName || '', verified: true }
        : { supplierName: doc.supplierName || '', verified: false },
    );
    setSupplierEditing(true);
  };

  const handleSaveSupplier = async () => {
    if (!doc || !id) return;
    setSupplierSaving(true);
    try {
      const payload: { supplier_id?: string; supplier_name?: string } = supplierValue.supplierId
        ? { supplier_id: supplierValue.supplierId }
        : { supplier_name: supplierValue.supplierName.trim() };
      await api.documents.update(id, payload);
      setSupplierEditing(false);
      loadDocument();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update supplier');
    } finally {
      setSupplierSaving(false);
    }
  };

  const handleArchive = async () => {
    if (!id) return;
    setAnchorEl(null);
    if (!confirm('Archive this document? It can be restored later.')) return;
    try {
      await api.documents.update(id, { status: 'archived' });
      loadDocument();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to archive document');
    }
  };

  const handleDelete = async () => {
    if (!id) return;
    setAnchorEl(null);
    if (!confirm('Delete this document? This action cannot be undone.')) return;
    try {
      await api.documents.delete(id);
      navigate('/documents');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete document');
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error && !doc) {
    return (
      <Box>
        <Button startIcon={<BackIcon />} onClick={() => navigate('/documents')} sx={{ mb: 2 }}>
          Back to Documents
        </Button>
        <Alert severity="error">{error}</Alert>
      </Box>
    );
  }

  if (!doc) return null;

  return (
    <Box>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: { xs: 1, sm: 2 }, mb: 3 }}>
        <IconButton onClick={() => navigate('/documents')} sx={{ mt: 0.5 }} size={isMobile ? 'small' : 'medium'}>
          <BackIcon />
        </IconButton>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <Typography variant={isMobile ? 'h5' : 'h4'} fontWeight={700} sx={{ wordBreak: 'break-word' }}>
              {doc.title}
            </Typography>
            <Tooltip title={helpContent.documents.list?.columnTooltips?.version ?? ''}>
              <Chip
                label={`v${doc.current_version}`}
                size="small"
                color="primary"
                variant="outlined"
              />
            </Tooltip>
            <Tooltip title={helpContent.documents.list?.columnTooltips?.status ?? ''}>
              <Chip
                label={doc.status}
                size="small"
                color={statusColors[doc.status] || 'default'}
                variant="filled"
                sx={{ textTransform: 'capitalize' }}
              />
            </Tooltip>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5, flexWrap: 'wrap' }}>
            <Typography variant="body2" color="text.secondary">
              {doc.creator_name && `Created by ${doc.creator_name} · `}
              {formatDate(doc.created_at)} · Updated{' '}
              {formatDate(doc.updated_at)}
            </Typography>
            <CopyId id={doc.id} label="Doc:" />
            {doc.tenant_id && <CopyId id={doc.tenant_id} label="Tenant:" />}
          </Box>
        </Box>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <HelpWell id="documents.detail" title={helpContent.documents.detail?.headline ?? 'Document detail'}>
        {helpContent.documents.detail?.well ?? helpContent.documents.well}
      </HelpWell>

      {/* Actions */}
      {isMobile ? (
        <Box sx={{ display: 'flex', gap: 1, mb: 3 }}>
          <Button
            variant="contained"
            startIcon={<DownloadIcon />}
            onClick={() => api.documents.download(doc.id)}
            sx={{ flex: 1 }}
          >
            Download
          </Button>
          <RoleGuard roles={['super_admin', 'org_admin', 'user']}>
            <Button
              variant="outlined"
              startIcon={<UploadIcon />}
              onClick={() => setUploadOpen(true)}
              sx={{ flex: 1 }}
            >
              Upload
            </Button>
            <IconButton onClick={(e) => setAnchorEl(e.currentTarget)}>
              <MoreIcon />
            </IconButton>
            <Menu anchorEl={anchorEl} open={menuOpen} onClose={() => setAnchorEl(null)}>
              <MenuItem onClick={openEdit}>
                <ListItemIcon><EditIcon fontSize="small" /></ListItemIcon>
                <ListItemText>Edit</ListItemText>
              </MenuItem>
              <MenuItem onClick={handleArchive}>
                <ListItemIcon><ArchiveIcon fontSize="small" color="warning" /></ListItemIcon>
                <ListItemText>Archive</ListItemText>
              </MenuItem>
              <MenuItem onClick={handleDelete}>
                <ListItemIcon><DeleteIcon fontSize="small" color="error" /></ListItemIcon>
                <ListItemText>Delete</ListItemText>
              </MenuItem>
            </Menu>
          </RoleGuard>
        </Box>
      ) : (
        <Box sx={{ display: 'flex', gap: 1, mb: 3, flexWrap: 'wrap' }}>
          <Button
            variant="contained"
            startIcon={<DownloadIcon />}
            onClick={() => api.documents.download(doc.id)}
          >
            Download Latest
          </Button>
          <RoleGuard roles={['super_admin', 'org_admin', 'user']}>
            <Button
              variant="outlined"
              startIcon={<UploadIcon />}
              onClick={() => setUploadOpen(true)}
            >
              Upload New Version
            </Button>
            <Button variant="outlined" startIcon={<EditIcon />} onClick={openEdit}>
              Edit
            </Button>
            <Button
              variant="outlined"
              color="warning"
              startIcon={<ArchiveIcon />}
              onClick={handleArchive}
            >
              Archive
            </Button>
            <Button
              variant="outlined"
              color="error"
              startIcon={<DeleteIcon />}
              onClick={handleDelete}
            >
              Delete
            </Button>
          </RoleGuard>
        </Box>
      )}

      {/* Document Info */}
      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}>
        {doc.description && (
          <Box sx={{ mb: 2 }}>
            <Typography variant="subtitle2" color="text.secondary" gutterBottom>
              Description
            </Typography>
            <Typography variant="body1">{doc.description}</Typography>
          </Box>
        )}

        {doc.category && (
          <Box sx={{ mb: 2 }}>
            <Typography variant="subtitle2" color="text.secondary" gutterBottom>
              Category
            </Typography>
            <Chip label={doc.category} color="secondary" variant="outlined" size="small" />
          </Box>
        )}

        {doc.tags.length > 0 && (
          <Box sx={{ mb: 2 }}>
            <Typography variant="subtitle2" color="text.secondary" gutterBottom>
              Tags
            </Typography>
            <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
              {doc.tags.map((tag) => (
                <Chip key={tag} label={tag} size="small" variant="outlined" />
              ))}
            </Box>
          </Box>
        )}

        {doc.documentTypeName && (
          <Box sx={{ mb: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                Document Type
              </Typography>
              <InfoTooltip text={helpContent.documents.list?.columnTooltips?.type} />
            </Box>
            <Chip label={doc.documentTypeName} color="info" variant="outlined" size="small" />
          </Box>
        )}

        {/* Supplier — read-only chip for everyone; admins can change it. */}
        {(doc.supplierName || isAdmin) && (
          <Box sx={{ mb: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                Supplier
              </Typography>
              <InfoTooltip text={helpContent.documents.list?.columnTooltips?.supplier} />
              {isAdmin && !supplierEditing && (
                <IconButton size="small" onClick={openSupplierEdit} aria-label="Change supplier">
                  <EditIcon fontSize="small" />
                </IconButton>
              )}
            </Box>
            {supplierEditing ? (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, maxWidth: 360 }}>
                <SupplierAutocomplete
                  tenantId={doc.tenant_id}
                  value={supplierValue}
                  onChange={setSupplierValue}
                  disabled={supplierSaving}
                />
                <Box sx={{ display: 'flex', gap: 1 }}>
                  <Button
                    size="small"
                    variant="contained"
                    startIcon={<SaveIcon />}
                    onClick={handleSaveSupplier}
                    disabled={supplierSaving || !supplierValue.verified || !supplierValue.supplierName.trim()}
                  >
                    {supplierSaving ? 'Saving...' : 'Save'}
                  </Button>
                  <Button size="small" onClick={() => setSupplierEditing(false)} disabled={supplierSaving}>
                    Cancel
                  </Button>
                </Box>
              </Box>
            ) : doc.supplierName ? (
              <Chip label={doc.supplierName} color="default" variant="outlined" size="small" />
            ) : (
              <Typography variant="body2" color="text.secondary">No supplier set</Typography>
            )}
          </Box>
        )}

        {/* Editable Primary Metadata Section */}
        {(doc.primaryMetadata && Object.keys(doc.primaryMetadata).length > 0 || !isReader) && (
          <Box sx={{ mb: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
              <Typography variant="subtitle2" color="text.secondary">
                Metadata
              </Typography>
              {!isReader && !metaEditing && (
                <IconButton size="small" onClick={() => setMetaEditing(true)}>
                  <EditIcon fontSize="small" />
                </IconButton>
              )}
            </Box>
            {metaEditing ? (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
                  {Object.entries(metaFields).map(([key, value]) => (
                    <TextField
                      key={key}
                      label={key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                      size="small"
                      value={value}
                      onChange={(e) => setMetaFields(prev => ({ ...prev, [key]: e.target.value }))}
                      disabled={metaSaving}
                      sx={{ flex: '1 1 180px' }}
                    />
                  ))}
                </Box>
                <Box sx={{ display: 'flex', gap: 1 }}>
                  <Button
                    size="small"
                    variant="contained"
                    startIcon={<SaveIcon />}
                    onClick={handleSaveMetadata}
                    disabled={metaSaving}
                  >
                    {metaSaving ? 'Saving...' : 'Save'}
                  </Button>
                  <Button
                    size="small"
                    onClick={() => {
                      setMetaEditing(false);
                      const fields: Record<string, string> = {};
                      if (doc.primaryMetadata) {
                        for (const [k, v] of Object.entries(doc.primaryMetadata)) {
                          fields[k] = v || '';
                        }
                      }
                      setMetaFields(fields);
                    }}
                    disabled={metaSaving}
                  >
                    Cancel
                  </Button>
                </Box>
              </Box>
            ) : (
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                {doc.primaryMetadata && Object.entries(doc.primaryMetadata).map(([key, value]) => (
                  value ? (
                    <Chip
                      key={key}
                      label={`${key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}: ${value}`}
                      size="small"
                      variant="outlined"
                    />
                  ) : null
                ))}
                {(!doc.primaryMetadata || Object.values(doc.primaryMetadata).every(v => !v)) && !isReader && (
                  <Typography variant="body2" color="text.secondary">No metadata</Typography>
                )}
              </Box>
            )}
          </Box>
        )}

        {/* Extended Metadata (collapsed) */}
        {doc.extendedMetadata && Object.keys(doc.extendedMetadata).length > 0 && (
          <Box sx={{ mb: 2 }}>
            <Button
              size="small"
              onClick={() => setSourceMetaOpen(!sourceMetaOpen)}
              endIcon={sourceMetaOpen ? <ExpandLessIcon /> : <ExpandMoreIcon />}
              sx={{ mb: 0.5, textTransform: 'none', color: 'text.secondary', px: 0, minWidth: 0 }}
            >
              <Typography variant="subtitle2" color="text.secondary">
                Extended Metadata
              </Typography>
            </Button>
            <Collapse in={sourceMetaOpen}>
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                {Object.entries(doc.extendedMetadata).map(([key, value]) => (
                  value ? (
                    <Chip
                      key={key}
                      label={`${key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}: ${value}`}
                      size="small"
                      variant="outlined"
                    />
                  ) : null
                ))}
              </Box>
            </Collapse>
          </Box>
        )}

        {doc.external_ref && (
          <Box sx={{ mb: 2 }}>
            <Typography variant="subtitle2" color="text.secondary" gutterBottom>
              External Reference
            </Typography>
            <Chip
              label={`Ref: ${doc.external_ref}`}
              size="small"
              color="info"
              variant="outlined"
            />
          </Box>
        )}

        {doc.source_metadata && (() => {
          try {
            const meta = JSON.parse(doc.source_metadata);
            const tables = meta._tables;
            const regularKeys = Object.keys(meta).filter((k) => k !== '_tables');

            return (
              <Box>
                <Button
                  size="small"
                  onClick={() => setSourceMetaOpen(!sourceMetaOpen)}
                  endIcon={sourceMetaOpen ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                  sx={{ mb: 0.5, textTransform: 'none', color: 'text.secondary', px: 0, minWidth: 0 }}
                >
                  <Typography variant="subtitle2" color="text.secondary">
                    Source Metadata
                  </Typography>
                </Button>
                <Collapse in={sourceMetaOpen}>
                  {regularKeys.length > 0 && (
                    <Box sx={{ mb: 1 }}>
                      {regularKeys.map((key) => {
                        const value = meta[key];
                        const displayValue =
                          typeof value === 'object' ? JSON.stringify(value) :
                          key.includes('date') || key.includes('_at') ? formatDate(String(value)) :
                          String(value);
                        return (
                          <Box key={key} sx={{ display: 'flex', gap: 1, py: 0.25 }}>
                            <Typography variant="body2" color="text.secondary" sx={{ minWidth: 120, fontWeight: 500 }}>
                              {key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}:
                            </Typography>
                            <Typography variant="body2">{displayValue}</Typography>
                          </Box>
                        );
                      })}
                    </Box>
                  )}
                  {tables && Array.isArray(tables) && tables.map((table: { title?: string; headers?: string[]; rows?: string[][] }, idx: number) => (
                    <Box key={idx} sx={{ mb: 2 }}>
                      {table.title && (
                        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                          {table.title}
                        </Typography>
                      )}
                      <TableContainer>
                        <Table size="small" sx={{ '& td, & th': { py: 0.5, px: 1 } }}>
                          {table.headers && (
                            <TableHead>
                              <TableRow>
                                {table.headers.map((h: string, i: number) => (
                                  <TableCell key={i} sx={{ fontWeight: 600 }}>{h}</TableCell>
                                ))}
                              </TableRow>
                            </TableHead>
                          )}
                          <TableBody>
                            {(table.rows || []).map((row: string[], ri: number) => (
                              <TableRow key={ri}>
                                {row.map((cell: string, ci: number) => (
                                  <TableCell key={ci}>{cell}</TableCell>
                                ))}
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </TableContainer>
                    </Box>
                  ))}
                </Collapse>
              </Box>
            );
          } catch {
            return null;
          }
        })()}
      </Paper>

      {/* Registry fields (categories multi, aliases, criteria, applies_to,
          owner, renewal). Viewable by all; editable by non-readers. */}
      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
          <Typography variant="h6" fontWeight={600}>Registry</Typography>
          {!isReader && !registryEditing && (
            <IconButton size="small" onClick={openRegistryEdit} aria-label="Edit registry fields">
              <EditIcon fontSize="small" />
            </IconButton>
          )}
        </Box>

        {registryEditing ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {/* Categories */}
            <Box>
              <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                Categories (star the primary)
              </Typography>
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                {tenantDocTypes.map((dt) => {
                  const selected = regCategoryIds.includes(dt.id);
                  const isPrimary = regPrimaryId === dt.id;
                  return (
                    <Chip
                      key={dt.id}
                      label={isPrimary ? `★ ${dt.name}` : dt.name}
                      color={selected ? 'primary' : 'default'}
                      variant={selected ? 'filled' : 'outlined'}
                      onClick={() => (selected ? setRegPrimaryId(dt.id) : toggleRegCategory(dt.id, true))}
                      onDelete={selected ? () => toggleRegCategory(dt.id, false) : undefined}
                    />
                  );
                })}
                {tenantDocTypes.length === 0 && (
                  <Typography variant="body2" color="text.secondary">No document types defined.</Typography>
                )}
              </Box>
            </Box>
            <Autocomplete
              multiple freeSolo options={[]} value={regAliases}
              onChange={(_, v) => setRegAliases(v as string[])}
              renderInput={(params) => <TextField {...params} label="Aliases" size="small" helperText="Names staff might ask for — powers natural-language search." />}
            />
            <Autocomplete
              multiple freeSolo options={[]} value={regCriteria}
              onChange={(_, v) => setRegCriteria(v as string[])}
              renderInput={(params) => <TextField {...params} label="Criteria" size="small" helperText="Regulatory references." />}
            />
            <Autocomplete
              multiple freeSolo options={['Kent', 'Portland', 'company']} value={regAppliesTo}
              onChange={(_, v) => setRegAppliesTo(v as string[])}
              renderInput={(params) => <TextField {...params} label="Applies to" size="small" />}
            />
            <TextField
              label="Owner" size="small" value={regOwner}
              onChange={(e) => setRegOwner(e.target.value)}
            />
            <FormControl size="small" fullWidth>
              <InputLabel>Renewal type</InputLabel>
              <Select
                value={regRenewalType}
                label="Renewal type"
                onChange={(e) => setRegRenewalType(e.target.value as RenewalType | '')}
              >
                <MenuItem value=""><em>None</em></MenuItem>
                {RENEWAL_OPTIONS.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
              </Select>
            </FormControl>
            {regRenewalHasInterval && (
              <TextField
                label="Renewal interval (months)" type="number" size="small"
                value={regRenewalInterval} onChange={(e) => setRegRenewalInterval(e.target.value)}
              />
            )}
            <TextField
              label="Renewal due date" type="date" size="small"
              value={regRenewalDue} onChange={(e) => setRegRenewalDue(e.target.value)}
              InputLabelProps={{ shrink: true }}
            />
            <Box sx={{ display: 'flex', gap: 1 }}>
              <Button size="small" variant="contained" startIcon={<SaveIcon />} onClick={handleSaveRegistry} disabled={registrySaving}>
                {registrySaving ? 'Saving...' : 'Save'}
              </Button>
              <Button size="small" onClick={() => setRegistryEditing(false)} disabled={registrySaving}>Cancel</Button>
            </Box>
          </Box>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            <Box>
              <Typography variant="subtitle2" color="text.secondary" gutterBottom>Categories</Typography>
              {doc.categories && doc.categories.length > 0 ? (
                <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                  {doc.categories.map((c) => (
                    <Chip
                      key={c.id}
                      label={c.is_primary ? `★ ${c.document_type_name || c.document_type_id}` : (c.document_type_name || c.document_type_id)}
                      size="small"
                      color={c.is_primary ? 'primary' : 'default'}
                      variant="outlined"
                    />
                  ))}
                </Box>
              ) : (
                <Typography variant="body2" color="text.secondary">No categories</Typography>
              )}
            </Box>
            {doc.aliases && doc.aliases.length > 0 && (
              <Box>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>Aliases</Typography>
                <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                  {doc.aliases.map((a) => <Chip key={a} label={a} size="small" variant="outlined" />)}
                </Box>
              </Box>
            )}
            {doc.criteria && doc.criteria.length > 0 && (
              <Box>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>Criteria</Typography>
                <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                  {doc.criteria.map((c) => <Chip key={c} label={c} size="small" variant="outlined" />)}
                </Box>
              </Box>
            )}
            {doc.appliesTo && doc.appliesTo.length > 0 && (
              <Box>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>Applies to</Typography>
                <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                  {doc.appliesTo.map((a) => <Chip key={a} label={a} size="small" variant="outlined" />)}
                </Box>
              </Box>
            )}
            {doc.owner && (
              <Box>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>Owner</Typography>
                <Typography variant="body2">{doc.owner}</Typography>
              </Box>
            )}
            {doc.renewalType && (
              <Box>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>Renewal</Typography>
                <Typography variant="body2">
                  {renewalLabel(doc.renewalType)}
                  {doc.renewalIntervalMonths ? ` · every ${doc.renewalIntervalMonths} mo` : ''}
                  {doc.renewalDueDate ? ` · due ${formatDate(doc.renewalDueDate)}` : ''}
                </Typography>
              </Box>
            )}
          </Box>
        )}
      </Paper>

      {/* Registry facets (migration 0080): what this document SATISFIES (layer 2)
          and what it TRIGGERS (layer 3). Viewable by all; editable by
          non-readers. Kept in its own Paper so a facet save sends only the
          facet keys — an omitted key leaves that facet's links untouched, so
          editing the Registry block above cannot disturb them. */}
      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 1.5 }}>
          <Typography variant="h6" fontWeight={600}>Requirements &amp; Claims</Typography>
          <InfoTooltip text="Which requirements this document closes, and what it asserts. Only CONFIRMED links count — a suggestion from the extraction pipeline leaves the requirement open until a person confirms it." />
          {!isReader && !facetsEditing && (
            <IconButton size="small" onClick={openFacetsEdit} aria-label="Edit requirements and claims">
              <EditIcon fontSize="small" />
            </IconButton>
          )}
        </Box>

        {(() => {
          const reqs = splitByStatus<ApiDocumentRequirement>(doc.requirements);
          const claims = splitByStatus<ApiDocumentClaim>(doc.claims);
          const pending = reqs.suggested.length + claims.suggested.length;

          /** One state's chips, with the state named rather than only colour-coded. */
          const group = (
            heading: string,
            caption: string,
            links: FacetLinkView[],
            color: 'success' | 'warning' | 'default',
            icon: ReactElement,
            faded = false,
          ) =>
            links.length === 0 ? null : (
              <Box sx={{ mb: 1 }}>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  {heading} — {caption}
                </Typography>
                <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.5, opacity: faded ? 0.6 : 1 }}>
                  {links.map((link) => {
                    const prov = facetLinkProvenance(link);
                    const subjectName = (link as unknown as Record<string, unknown>).subject_name;
                    const chip = (
                      <Chip
                        key={String(link.id)}
                        size="small"
                        icon={icon}
                        color={color}
                        variant="outlined"
                        label={
                          facetLinkName(link) +
                          (subjectName ? ` · about ${String(subjectName)}` : '')
                        }
                      />
                    );
                    return prov ? (
                      <Tooltip key={String(link.id)} title={prov}>
                        <span>{chip}</span>
                      </Tooltip>
                    ) : (
                      chip
                    );
                  })}
                </Box>
              </Box>
            );

          const facetView = (
            label: string,
            blurb: string,
            split: { confirmed: FacetLinkView[]; suggested: FacetLinkView[]; rejected: FacetLinkView[] },
            emptyText: string,
          ) => (
            <Box sx={{ mb: 2 }}>
              <Typography variant="subtitle2" color="text.secondary">{label}</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                {blurb}
              </Typography>
              {split.confirmed.length + split.suggested.length + split.rejected.length === 0 ? (
                <Typography variant="body2" color="text.secondary">{emptyText}</Typography>
              ) : (
                <>
                  {group('Confirmed', 'a person decided these; they count', split.confirmed, 'success', <ConfirmedIcon />)}
                  {group('Awaiting review', 'proposed by the pipeline; they do NOT count yet', split.suggested, 'warning', <SuggestedIcon />)}
                  {group('Rejected', 'turned down by a person; kept so it is not re-proposed', split.rejected, 'default', <RejectedIcon />, true)}
                </>
              )}
            </Box>
          );

          return (
            <>
              {pending > 0 && (
                <Alert
                  severity="warning"
                  sx={{ mb: 2 }}
                  action={
                    !isReader && !facetsEditing ? (
                      <Button size="small" onClick={handleConfirmSuggestions} disabled={facetsSaving}>
                        {facetsSaving ? 'Confirming…' : `Confirm all ${pending}`}
                      </Button>
                    ) : undefined
                  }
                >
                  {pending} {pending === 1 ? 'link was' : 'links were'} proposed by the extraction
                  pipeline and {pending === 1 ? 'is' : 'are'} awaiting review. Until a person confirms,
                  {' '}{pending === 1 ? 'it does' : 'they do'} not count — a gap report still shows the
                  requirement as open.
                </Alert>
              )}

              {facetsEditing ? (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <Box>
                    <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                      Satisfies (requirements this document closes)
                    </Typography>
                    <DocumentFacetPicker
                      vocab={requirementVocab.map((r) => ({
                        id: r.id,
                        name: r.name,
                        description: r.description,
                        group: r.checklist,
                      }))}
                      value={reqLinks}
                      onChange={setReqLinks}
                      showStatus
                      disabled={facetsSaving}
                      searchPlaceholder="Search requirements…"
                      emptyMessage={
                        <>
                          This tenant has no requirements yet. Add them under Settings &rarr;
                          Requirements before a document can say what it closes.
                        </>
                      }
                    />
                  </Box>
                  <Box>
                    <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                      Claims (what asserting this makes required elsewhere)
                    </Typography>
                    <DocumentFacetPicker
                      vocab={claimVocab.map((c) => ({ id: c.id, name: c.name, description: c.description }))}
                      value={claimLinks}
                      onChange={setClaimLinks}
                      showStatus
                      disabled={facetsSaving}
                      searchPlaceholder="Search claims…"
                      emptyMessage={
                        <>
                          This tenant has no claim types yet. Add them under Settings &rarr; Claims
                          to record what a document asserts.
                        </>
                      }
                    />
                  </Box>
                  <Box sx={{ display: 'flex', gap: 1 }}>
                    <Button size="small" variant="contained" startIcon={<SaveIcon />} onClick={handleSaveFacets} disabled={facetsSaving}>
                      {facetsSaving ? 'Saving...' : 'Save'}
                    </Button>
                    <Button size="small" onClick={() => setFacetsEditing(false)} disabled={facetsSaving}>Cancel</Button>
                  </Box>
                  <Typography variant="caption" color="text.secondary">
                    Ticking a box records a person's decision (confirmed). Unticking something the
                    pipeline proposed records a rejection, so the same guess is not offered again.
                  </Typography>
                </Box>
              ) : (
                <>
                  {facetView(
                    'Satisfies',
                    'Requirements this document closes.',
                    reqs,
                    requirementVocab.length === 0
                      ? 'No requirements are configured for this tenant yet.'
                      : 'Nothing linked.',
                  )}
                  {facetView(
                    'Claims',
                    'What this document asserts — each claim can make other documents required.',
                    claims,
                    claimVocab.length === 0
                      ? 'No claim types are configured for this tenant yet.'
                      : 'Nothing linked.',
                  )}
                </>
              )}
            </>
          );
        })()}
      </Paper>

      {/* Linked Products */}
      <ProductLinker
        documentId={doc.id}
        tenantId={doc.tenant_id}
        readOnly={isReader}
      />

      {/* Linked Lots (one per sublot under Option B). lot_key is the combined
          match key (lot_number + sub_lot_code) used against order lines. */}
      {linkedLots.length > 0 && (
        <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 1 }}>
            <Typography variant="h6" fontWeight={600}>
              Linked Lots
            </Typography>
            <InfoTooltip text="Each lot this document certifies. Under sublot split, one COA links to one lot per sublot; the combined key is what matches order lines." />
          </Box>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
            {linkedLots.map((lot) => (
              <Box key={lot.id} sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                <Typography variant="body2">
                  lot <strong>{lot.lot_number}</strong>
                  {lot.sub_lot_code ? ` · sublot ${lot.sub_lot_code}` : ''}
                </Typography>
                <Chip label={lot.lot_key} size="small" variant="outlined" />
                {lot.product_name && (
                  <Typography variant="caption" color="text.secondary">
                    {lot.product_name}
                  </Typography>
                )}
              </Box>
            ))}
          </Box>
        </Paper>
      )}

      {/* Notes (migration 0088) — a THREAD, distinct from the Description  */}
      {/* field edited in the Edit dialog above. Description is one            */}
      {/* overwritable sentence about what the document IS; a note is what     */}
      {/* somebody SAID about it, stamped with who and when, and it cannot be  */}
      {/* rewritten afterwards. Placed below the structured panels and above   */}
      {/* the preview: the metadata is the document, the notes are the         */}
      {/* conversation about it, and the conversation reads before the bytes.  */}
      <EntityNotes
        entityType="document"
        entityId={doc.id}
        tenantId={doc.tenant_id}
        description="No notes on this document yet. Notes are timestamped, attributed and permanent — for a one-line summary of the document itself, edit its description instead."
      />

      {/* Document Preview */}
      {previewVersion && (
        <>
          <Typography variant="h6" fontWeight={600} gutterBottom>
            Document Preview
          </Typography>
          <DocumentPreview
            documentId={doc.id}
            versionNumber={previewVersion.version_number}
            fileName={previewVersion.file_name}
            mimeType={previewVersion.mime_type}
          />
        </>
      )}

      {/* Version History */}
      <Typography variant="h6" fontWeight={600} gutterBottom>
        Version History
      </Typography>
      <VersionHistory
        documentId={doc.id}
        versions={versions}
        activeVersion={previewVersion?.version_number}
        onPreviewVersion={(version) => setPreviewVersion(version)}
      />

      {/* Upload Dialog */}
      <UploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        documentId={doc.id}
        onSuccess={handleUploadSuccess}
      />

      {/* Edit Dialog */}
      <Dialog open={editOpen} onClose={() => setEditOpen(false)} maxWidth="sm" fullWidth fullScreen={isMobile}>
        <DialogTitle>Edit Document</DialogTitle>
        <DialogContent>
          <TextField
            label="Title"
            fullWidth
            required
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            disabled={saving}
            sx={{ mt: 1, mb: 2 }}
          />
          <TextField
            label="Description"
            fullWidth
            multiline
            rows={3}
            value={editDescription}
            onChange={(e) => setEditDescription(e.target.value)}
            disabled={saving}
            sx={{ mb: 2 }}
          />
          <TextField
            label="Category"
            fullWidth
            value={editCategory}
            onChange={(e) => setEditCategory(e.target.value)}
            disabled={saving}
            sx={{ mb: 2 }}
          />
          <TextField
            label="Tags"
            fullWidth
            value={editTags}
            onChange={(e) => setEditTags(e.target.value)}
            disabled={saving}
            helperText="Comma-separated"
            sx={{ mb: 2 }}
          />
          {documentTypes.length > 0 && (
            <FormControl fullWidth sx={{ mb: 2 }}>
              <InputLabel>Document Type</InputLabel>
              <Select
                value={editDocumentTypeId}
                onChange={(e) => setEditDocumentTypeId(e.target.value as string)}
                label="Document Type"
                disabled={saving}
              >
                <MenuItem value="">
                  <em>None</em>
                </MenuItem>
                {documentTypes.map((dt) => (
                  <MenuItem key={dt.id} value={dt.id}>
                    {dt.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          )}
          {/* Metadata fields are edited inline on the document detail page, not in this dialog */}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setEditOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button variant="contained" onClick={handleSaveEdit} disabled={saving}>
            {saving ? 'Saving...' : 'Save Changes'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
