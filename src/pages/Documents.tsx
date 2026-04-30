import { useState, useEffect } from 'react';

import {
  Box,
  Typography,
  Grid,
  TextField,
  InputAdornment,
  Chip,
  Button,
  CircularProgress,
  Alert,
  Pagination,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
} from '@mui/material';
import {
  Search as SearchIcon,
  AutoAwesome as AiIcon,
} from '@mui/icons-material';
import { api } from '../lib/api';
import type { Document, ApiDocumentType, ParsedQuery } from '../lib/types';
import { DocumentCard } from '../components/DocumentCard';
import { useTenant } from '../contexts/TenantContext';
import { HelpWell } from '../components/HelpWell';
import { InfoTooltip } from '../components/InfoTooltip';
import { EmptyState } from '../components/EmptyState';
import { helpContent } from '../lib/helpContent';

const ITEMS_PER_PAGE = 12;

const statusOptions = ['active', 'archived'];

export function Documents() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [docTypeFilter, setDocTypeFilter] = useState<string>('');
  const [documentTypes, setDocumentTypes] = useState<ApiDocumentType[]>([]);
  const [aiSearchActive, setAiSearchActive] = useState(false);
  const [aiSearchLoading, setAiSearchLoading] = useState(false);
  const [aiParsedQuery, setAiParsedQuery] = useState<ParsedQuery | null>(null);
  const [aiSearchError, setAiSearchError] = useState('');

  const { selectedTenantId } = useTenant();

  // Load document types for filter
  useEffect(() => {
    const loadDocTypes = async () => {
      try {
        const result = await api.documentTypes.list({
          tenant_id: selectedTenantId || undefined,
          active: 1,
        });
        setDocumentTypes(result.documentTypes);
      } catch {
        // Silently fail -- document types filter is optional
      }
    };
    loadDocTypes();
  }, [selectedTenantId]);

  const loadDocuments = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api.documents.list({
        page,
        limit: ITEMS_PER_PAGE,
        status: statusFilter || undefined,
        category: categoryFilter || undefined,
        tenantId: selectedTenantId || undefined,
      });
      setDocuments(result.documents);
      setTotal(result.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load documents');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!aiSearchActive) {
      loadDocuments();
    }
  }, [page, statusFilter, categoryFilter, selectedTenantId]);

  const handleAiSearch = async () => {
    if (!search.trim()) return;
    setAiSearchLoading(true);
    setAiSearchError('');
    setAiParsedQuery(null);
    try {
      const result = await api.naturalSearch(search.trim(), selectedTenantId || undefined);
      setAiParsedQuery(result.parsed_query);
      setDocuments((result.results || []).map((d: any) => {
        let primaryMetadata = null;
        if (d.primary_metadata) {
          try { primaryMetadata = typeof d.primary_metadata === 'string' ? JSON.parse(d.primary_metadata) : d.primary_metadata; } catch { /* ignore */ }
        }
        let extendedMetadata = null;
        if (d.extended_metadata) {
          try { extendedMetadata = typeof d.extended_metadata === 'string' ? JSON.parse(d.extended_metadata) : d.extended_metadata; } catch { /* ignore */ }
        }
        return {
          ...d,
          tags: typeof d.tags === 'string' ? (() => { try { return JSON.parse(d.tags); } catch { return []; } })() : (d.tags || []),
          documentTypeId: d.document_type_id ?? null,
          documentTypeName: d.document_type_name,
          documentTypeSlug: d.document_type_slug,
          supplierId: d.supplier_id ?? null,
          supplierName: d.supplier_name,
          primaryMetadata,
          extendedMetadata,
          match_context: d.match_context,
          relevance_score: d.relevance_score,
        };
      }));
      setTotal(result.total || 0);
    } catch (err) {
      setAiSearchError(err instanceof Error ? err.message : 'AI search failed');
      // Fall back to regular search
      loadDocuments();
    } finally {
      setAiSearchLoading(false);
    }
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && aiSearchActive) {
      e.preventDefault();
      handleAiSearch();
    }
  };

  const clearAiSearch = () => {
    setAiParsedQuery(null);
    setAiSearchError('');
    setSearch('');
    loadDocuments();
  };

  const filteredDocs = documents.filter((d) => {
    if (search && !aiParsedQuery) {
      const q = search.toLowerCase();
      const searchableText = [
        d.title,
        d.description,
        d.category,
        d.supplierName,
        d.documentTypeName,
        ...(d.tags || []),
        d.primaryMetadata ? JSON.stringify(d.primaryMetadata) : '',
        d.extendedMetadata ? JSON.stringify(d.extendedMetadata) : '',
      ].filter(Boolean).join(' ').toLowerCase();

      if (!searchableText.includes(q)) return false;
    }
    if (docTypeFilter && d.documentTypeId !== docTypeFilter) return false;
    return true;
  });

  const totalPages = Math.ceil(total / ITEMS_PER_PAGE);

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3, flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="h4" fontWeight={700}>
          Documents
        </Typography>
      </Box>

      <HelpWell id="documents.list" title={helpContent.documents.list?.headline ?? 'Documents'}>
        {helpContent.documents.list?.well ?? helpContent.documents.well}
      </HelpWell>

      {/* Search and Filters */}
      <Box sx={{ mb: 3 }}>
        <Box sx={{ display: 'flex', gap: 1, mb: 2 }}>
          <TextField
            placeholder={aiSearchActive ? 'Search with AI (e.g. "COAs for Butter from March")...' : 'Search documents...'}
            fullWidth
            size="small"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  {aiSearchActive ? <AiIcon color="primary" /> : <SearchIcon />}
                </InputAdornment>
              ),
              endAdornment: aiSearchActive && search ? (
                <InputAdornment position="end">
                  <Button
                    size="small"
                    onClick={handleAiSearch}
                    disabled={aiSearchLoading}
                    variant="contained"
                    sx={{ minWidth: 'auto', px: 1.5 }}
                  >
                    {aiSearchLoading ? <CircularProgress size={16} color="inherit" /> : 'Search'}
                  </Button>
                </InputAdornment>
              ) : undefined,
            }}
          />
          <Button
            variant={aiSearchActive ? 'contained' : 'outlined'}
            size="small"
            onClick={() => {
              setAiSearchActive(!aiSearchActive);
              if (aiSearchActive) {
                clearAiSearch();
              }
            }}
            startIcon={<AiIcon />}
            sx={{ whiteSpace: 'nowrap' }}
          >
            AI
          </Button>
          <InfoTooltip text="Toggle natural-language search. Keyword mode does exact-match across title / tags / content; AI mode parses your query into structured filters first." />
        </Box>

        {/* AI search error */}
        {aiSearchError && (
          <Alert severity="warning" sx={{ mb: 2 }} onClose={() => setAiSearchError('')}>
            {aiSearchError}
          </Alert>
        )}

        {/* AI parsed query display */}
        {aiParsedQuery && (
          <Box sx={{ mb: 2, p: 1.5, bgcolor: 'action.hover', borderRadius: 1 }}>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              <Typography component="span" variant="body2" fontWeight={600}>
                {aiParsedQuery.intent_summary || 'General search'}
              </Typography>
            </Typography>
            <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
              {aiParsedQuery.document_type_slug && (
                <Chip label={`Type: ${aiParsedQuery.document_type_slug}`} size="small" onDelete={clearAiSearch} />
              )}
              {aiParsedQuery.product_names.length > 0 && (
                <Chip label={`Products: ${aiParsedQuery.product_names.join(', ')}`} size="small" onDelete={clearAiSearch} />
              )}
              {aiParsedQuery.supplier_name && (
                <Chip label={`Supplier: ${aiParsedQuery.supplier_name}`} size="small" onDelete={clearAiSearch} />
              )}
              {aiParsedQuery.metadata_filters.length > 0 && (
                <Chip label={`Metadata: ${aiParsedQuery.metadata_filters.map(f => `${f.field}=${f.value}`).join(', ')}`} size="small" onDelete={clearAiSearch} />
              )}
              {aiParsedQuery.date_from && (
                <Chip label={`From: ${aiParsedQuery.date_from}`} size="small" onDelete={clearAiSearch} />
              )}
              {aiParsedQuery.date_to && (
                <Chip label={`To: ${aiParsedQuery.date_to}`} size="small" onDelete={clearAiSearch} />
              )}
              {aiParsedQuery.keywords.map((kw, i) => (
                <Chip key={i} label={kw} size="small" onDelete={clearAiSearch} />
              ))}
              {aiParsedQuery.expiration_filter && (
                <Chip
                  label={`Expiring ${aiParsedQuery.expiration_filter.operator} ${aiParsedQuery.expiration_filter.date1}`}
                  size="small"
                  color="warning"
                  onDelete={clearAiSearch}
                />
              )}
              {aiParsedQuery.content_search && (
                <Chip
                  label={`Content: "${aiParsedQuery.content_search}"`}
                  size="small"
                  onDelete={clearAiSearch}
                />
              )}
            </Box>
          </Box>
        )}
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          <Typography variant="body2" color="text.secondary" sx={{ mr: 0.5 }}>
            Status:
          </Typography>
          <Chip
            label="All"
            size="small"
            variant={statusFilter === '' ? 'filled' : 'outlined'}
            color={statusFilter === '' ? 'primary' : 'default'}
            onClick={() => { setStatusFilter(''); setPage(1); }}
          />
          {statusOptions.map((status) => (
            <Chip
              key={status}
              label={status}
              size="small"
              variant={statusFilter === status ? 'filled' : 'outlined'}
              color={statusFilter === status ? 'primary' : 'default'}
              onClick={() => { setStatusFilter(status); setPage(1); }}
              sx={{ textTransform: 'capitalize' }}
            />
          ))}
          {categoryFilter && (
            <>
              <Typography variant="body2" color="text.secondary" sx={{ ml: { xs: 0, sm: 2 }, mr: 0.5 }}>
                Category:
              </Typography>
              <Chip
                label={categoryFilter}
                size="small"
                color="secondary"
                onDelete={() => { setCategoryFilter(''); setPage(1); }}
              />
            </>
          )}
          {documentTypes.length > 0 && (
            <FormControl size="small" sx={{ ml: { xs: 0, sm: 2 }, minWidth: 160 }}>
              <InputLabel id="doctype-filter-label">Document Type</InputLabel>
              <Select
                labelId="doctype-filter-label"
                value={docTypeFilter}
                onChange={(e) => { setDocTypeFilter(e.target.value); setPage(1); }}
                label="Document Type"
              >
                <MenuItem value="">All Types</MenuItem>
                {documentTypes.map((dt) => (
                  <MenuItem key={dt.id} value={dt.id}>
                    {dt.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          )}
        </Box>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      ) : filteredDocs.length === 0 ? (
        search || statusFilter || categoryFilter || docTypeFilter ? (
          <EmptyState
            title="No documents match your filters"
            description="Clear filters or try a different search term. Toggle AI search if your query is more natural-language than keyword."
          />
        ) : (
          <EmptyState
            title={helpContent.documents.list?.emptyTitle ?? 'No documents yet'}
            description={helpContent.documents.list?.emptyDescription}
          />
        )
      ) : (
        <>
          <Grid container spacing={2}>
            {filteredDocs.map((doc) => (
              <Grid item xs={12} sm={6} md={4} lg={3} key={doc.id}>
                <DocumentCard document={doc} />
              </Grid>
            ))}
          </Grid>
          {totalPages > 1 && (
            <Box sx={{ display: 'flex', justifyContent: 'center', mt: 4 }}>
              <Pagination
                count={totalPages}
                page={page}
                onChange={(_, p) => setPage(p)}
                color="primary"
              />
            </Box>
          )}
        </>
      )}

    </Box>
  );
}
