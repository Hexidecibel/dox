import { useState } from 'react';
import {
  Box,
  Typography,
  TextField,
  InputAdornment,
  Button,
  Grid,
  CircularProgress,
  Alert,
  MenuItem,
  Select,
  FormControl,
  InputLabel,
  Paper,
  ToggleButtonGroup,
  ToggleButton,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import {
  Search as SearchIcon,
  Download as DownloadIcon,
} from '@mui/icons-material';
import { api } from '../lib/api';
import type { Document } from '../lib/types';
import { DocumentCard } from '../components/DocumentCard';

export function Search() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [results, setResults] = useState<Document[]>([]);
  const [total, setTotal] = useState(0);
  const [searched, setSearched] = useState(false);
  const [exportFormat, setExportFormat] = useState<'csv' | 'json'>('csv');
  const [exporting, setExporting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  const handleSearch = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    setError('');
    try {
      const result = await api.documents.search(query.trim(), {
        category: category || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
      });
      setResults(result.documents);
      setTotal(result.total);
      setSearched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  const handleExport = async () => {
    if (results.length === 0) return;
    setExporting(true);
    setError('');
    try {
      await api.reports.generate({
        category: category || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        format: exportFormat,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  return (
    <Box>
      <Typography variant="h4" fontWeight={700} gutterBottom>
        Search Documents
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
        Search across all documents by title, description, tags, file names, and file content.
      </Typography>

      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}>
        <Box component="form" onSubmit={handleSearch}>
          <TextField
            placeholder="Search titles, tags, file names, and content..."
            fullWidth
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon />
                </InputAdornment>
              ),
            }}
            sx={{ mb: 2 }}
          />

          <Grid container spacing={2} sx={{ mb: 2 }}>
            <Grid item xs={12} sm={4}>
              <FormControl fullWidth size="small">
                <InputLabel>Category</InputLabel>
                <Select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  label="Category"
                >
                  <MenuItem value="">All Categories</MenuItem>
                  <MenuItem value="Regulatory">Regulatory</MenuItem>
                  <MenuItem value="Compliance">Compliance</MenuItem>
                  <MenuItem value="Safety">Safety</MenuItem>
                  <MenuItem value="Quality">Quality</MenuItem>
                  <MenuItem value="Technical">Technical</MenuItem>
                  <MenuItem value="Other">Other</MenuItem>
                </Select>
              </FormControl>
            </Grid>
            <Grid item xs={6} sm={4}>
              <TextField
                label="Date From"
                type="date"
                fullWidth
                size="small"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                InputLabelProps={{ shrink: true }}
              />
            </Grid>
            <Grid item xs={6} sm={4}>
              <TextField
                label="Date To"
                type="date"
                fullWidth
                size="small"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                InputLabelProps={{ shrink: true }}
              />
            </Grid>
          </Grid>

          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            <Button
              type="submit"
              variant="contained"
              startIcon={<SearchIcon />}
              disabled={!query.trim() || loading}
              fullWidth={isMobile}
            >
              {loading ? 'Searching...' : 'Search'}
            </Button>
            {results.length > 0 && (
              <>
                <ToggleButtonGroup
                  size="small"
                  value={exportFormat}
                  exclusive
                  onChange={(_, v) => { if (v) setExportFormat(v); }}
                >
                  <ToggleButton value="csv">CSV</ToggleButton>
                  <ToggleButton value="json">JSON</ToggleButton>
                </ToggleButtonGroup>
                <Button
                  variant="outlined"
                  startIcon={<DownloadIcon />}
                  onClick={handleExport}
                  disabled={exporting}
                >
                  {exporting ? 'Exporting...' : `Export ${exportFormat.toUpperCase()}`}
                </Button>
              </>
            )}
          </Box>
        </Box>
      </Paper>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      ) : searched ? (
        <>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {total} result{total !== 1 ? 's' : ''} found
          </Typography>
          {results.length === 0 ? (
            <Box sx={{ textAlign: 'center', py: 8 }}>
              <Typography variant="h6" color="text.secondary">
                No documents match your search
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Try different keywords or adjust your filters.
              </Typography>
            </Box>
          ) : (
            <Grid container spacing={2}>
              {results.map((doc) => (
                <Grid item xs={12} sm={6} md={4} key={doc.id}>
                  <DocumentCard document={doc} />
                </Grid>
              ))}
            </Grid>
          )}
        </>
      ) : (
        <Box sx={{ textAlign: 'center', py: 8 }}>
          <SearchIcon sx={{ fontSize: 64, color: 'text.secondary', mb: 1 }} />
          <Typography variant="h6" color="text.secondary">
            Enter a search query to find documents
          </Typography>
        </Box>
      )}
    </Box>
  );
}
