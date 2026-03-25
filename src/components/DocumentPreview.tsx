import { useState, useEffect, useMemo } from 'react';
import PdfViewer from './PdfViewer';
import {
  Box,
  Paper,
  Typography,
  Button,
  Chip,
  CircularProgress,
  Alert,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  IconButton,
  Tooltip,
} from '@mui/material';
import {
  Download as DownloadIcon,
  OpenInNew as OpenInNewIcon,
  InsertDriveFile as FileIcon,
  PictureAsPdf as PdfIcon,
  Image as ImageIcon,
  Description as TextIcon,
} from '@mui/icons-material';

interface DocumentPreviewProps {
  documentId: string;
  versionNumber?: number;
  fileName: string;
  mimeType: string;
}

type PreviewType = 'pdf' | 'image' | 'text' | 'csv' | 'json' | 'office' | 'unknown';

function getPreviewType(mimeType: string, fileName?: string): PreviewType {
  if (mimeType === 'application/pdf') return 'pdf';
  if (['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'].includes(mimeType)) return 'image';
  if (mimeType === 'text/csv') return 'csv';
  if (mimeType === 'application/json') return 'json';
  if (mimeType === 'text/plain') {
    // Fallback: detect .json extension even if served as text/plain
    if (fileName && fileName.toLowerCase().endsWith('.json')) return 'json';
    return 'text';
  }
  if (
    mimeType === 'application/msword' ||
    mimeType === 'application/vnd.ms-excel' ||
    mimeType === 'application/vnd.ms-powerpoint' ||
    mimeType.startsWith('application/vnd.openxmlformats-officedocument.')
  ) return 'office';
  return 'unknown';
}

function getPreviewTypeLabel(type: PreviewType): string {
  switch (type) {
    case 'pdf': return 'PDF';
    case 'image': return 'Image';
    case 'text': return 'Text';
    case 'csv': return 'CSV';
    case 'json': return 'JSON';
    case 'office': return 'Office';
    default: return 'File';
  }
}

function getPreviewIcon(type: PreviewType) {
  switch (type) {
    case 'pdf': return <PdfIcon fontSize="small" />;
    case 'image': return <ImageIcon fontSize="small" />;
    case 'text': case 'csv': case 'json': return <TextIcon fontSize="small" />;
    default: return <FileIcon fontSize="small" />;
  }
}

const MAX_TEXT_LINES = 500;

function buildPreviewUrl(documentId: string, versionNumber?: number): string {
  const token = localStorage.getItem('auth_token'); // matches AUTH_TOKEN_KEY
  const params = new URLSearchParams();
  params.set('preview', 'true');
  if (versionNumber) params.set('version', String(versionNumber));
  if (token) params.set('token', token);
  return `/api/documents/${documentId}/download?${params.toString()}`;
}

function ImagePreview({ url, fileName }: { url: string; fileName: string }) {
  const [error, setError] = useState(false);

  if (error) {
    return (
      <Alert severity="warning" sx={{ m: 2 }}>
        Failed to load image preview.
      </Alert>
    );
  }

  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'center',
        p: 2,
        bgcolor: 'grey.50',
        borderRadius: 1,
      }}
    >
      <a href={url} target="_blank" rel="noopener noreferrer" style={{ display: 'block' }}>
        <img
          src={url}
          alt={fileName}
          onError={() => setError(true)}
          style={{
            maxWidth: '100%',
            maxHeight: 600,
            objectFit: 'contain',
            borderRadius: 4,
            boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
            cursor: 'pointer',
          }}
        />
      </a>
    </Box>
  );
}

function TextPreview({ url }: { url: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError('');
    setContent(null);
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error('Failed to fetch file');
        return res.text();
      })
      .then((text) => {
        const lines = text.split('\n');
        if (lines.length > MAX_TEXT_LINES) {
          setContent(lines.slice(0, MAX_TEXT_LINES).join('\n'));
          setTruncated(true);
        } else {
          setContent(text);
          setTruncated(false);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [url]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress size={24} />
      </Box>
    );
  }

  if (error) {
    return <Alert severity="warning" sx={{ m: 2 }}>{error}</Alert>;
  }

  return (
    <Box sx={{ position: 'relative' }}>
      <Paper
        variant="outlined"
        sx={{
          m: 2,
          p: 2,
          maxHeight: 500,
          overflow: 'auto',
          bgcolor: 'grey.50',
        }}
      >
        <pre style={{ margin: 0, fontFamily: '"JetBrains Mono", "Fira Code", monospace', fontSize: '0.85rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {content}
        </pre>
      </Paper>
      {truncated && (
        <Typography variant="caption" color="text.secondary" sx={{ px: 2, pb: 1, display: 'block' }}>
          Showing first {MAX_TEXT_LINES} lines. Download the full file to view everything.
        </Typography>
      )}
    </Box>
  );
}

function CsvPreview({ url }: { url: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError('');
    setContent(null);
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error('Failed to fetch file');
        return res.text();
      })
      .then((text) => {
        const lines = text.split('\n');
        if (lines.length > MAX_TEXT_LINES) {
          setContent(lines.slice(0, MAX_TEXT_LINES).join('\n'));
          setTruncated(true);
        } else {
          setContent(text);
          setTruncated(false);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [url]);

  const rows = useMemo(() => {
    if (!content) return [];
    return content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => parseCsvLine(line));
  }, [content]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress size={24} />
      </Box>
    );
  }

  if (error) {
    return <Alert severity="warning" sx={{ m: 2 }}>{error}</Alert>;
  }

  if (rows.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
        Empty CSV file.
      </Typography>
    );
  }

  const headerRow = rows[0];
  const dataRows = rows.slice(1);

  return (
    <Box>
      <TableContainer sx={{ maxHeight: 500, m: 2, mr: 2 }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              {headerRow.map((cell, i) => (
                <TableCell key={i} sx={{ fontWeight: 700, bgcolor: 'grey.100', whiteSpace: 'nowrap' }}>
                  {cell}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {dataRows.map((row, ri) => (
              <TableRow key={ri} hover>
                {row.map((cell, ci) => (
                  <TableCell key={ci} sx={{ whiteSpace: 'nowrap', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {cell}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      {truncated && (
        <Typography variant="caption" color="text.secondary" sx={{ px: 2, pb: 1, display: 'block' }}>
          Showing first {MAX_TEXT_LINES} lines. Download the full file to view everything.
        </Typography>
      )}
    </Box>
  );
}

const MAX_JSON_LINES = 500;

/** Syntax-highlight a JSON string with colored spans */
function highlightJson(jsonStr: string): string {
  return jsonStr.replace(
    /("(?:\\.|[^"\\])*")\s*:/g,  // keys
    '<span style="color:#1a237e;font-weight:500">$1</span>:'
  ).replace(
    /:\s*("(?:\\.|[^"\\])*")/g,  // string values
    (_match, val) => `: <span style="color:#2e7d32">${val}</span>`
  ).replace(
    /:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/g,  // numbers
    ': <span style="color:#e65100">$1</span>'
  ).replace(
    /:\s*(true|false|null)\b/g,  // booleans/null
    ': <span style="color:#7b1fa2;font-weight:500">$1</span>'
  ).replace(
    /([[\]{}])/g,  // brackets/braces
    '<span style="color:#757575">$1</span>'
  );
}

function JsonPreview({ url }: { url: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [fullContent, setFullContent] = useState<string | null>(null);
  const [parseError, setParseError] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError('');
    setContent(null);
    setFullContent(null);
    setParseError(false);
    setShowAll(false);
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error('Failed to fetch file');
        return res.text();
      })
      .then((text) => {
        // Try to parse and pretty-print
        let formatted: string;
        try {
          const parsed = JSON.parse(text);
          formatted = JSON.stringify(parsed, null, 2);
        } catch {
          // Invalid JSON — show raw text
          formatted = text;
          setParseError(true);
        }
        const lines = formatted.split('\n');
        if (lines.length > MAX_JSON_LINES) {
          setContent(lines.slice(0, MAX_JSON_LINES).join('\n'));
          setFullContent(formatted);
          setTruncated(true);
        } else {
          setContent(formatted);
          setTruncated(false);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [url]);

  const displayContent = showAll && fullContent ? fullContent : content;

  const highlighted = useMemo(() => {
    if (!displayContent || parseError) return null;
    return highlightJson(displayContent);
  }, [displayContent, parseError]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress size={24} />
      </Box>
    );
  }

  if (error) {
    return <Alert severity="warning" sx={{ m: 2 }}>{error}</Alert>;
  }

  return (
    <Box sx={{ position: 'relative' }}>
      {parseError && (
        <Alert severity="info" sx={{ mx: 2, mt: 2 }}>
          File could not be parsed as valid JSON. Showing raw content.
        </Alert>
      )}
      <Paper
        variant="outlined"
        sx={{
          m: 2,
          p: 2,
          maxHeight: showAll ? 'none' : 500,
          overflow: 'auto',
          bgcolor: '#fafafa',
        }}
      >
        {highlighted ? (
          <pre
            style={{
              margin: 0,
              fontFamily: '"JetBrains Mono", "Fira Code", monospace',
              fontSize: '0.85rem',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              lineHeight: 1.5,
            }}
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        ) : (
          <pre
            style={{
              margin: 0,
              fontFamily: '"JetBrains Mono", "Fira Code", monospace',
              fontSize: '0.85rem',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {displayContent}
          </pre>
        )}
      </Paper>
      {truncated && !showAll && (
        <Box sx={{ px: 2, pb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="caption" color="text.secondary">
            Showing first {MAX_JSON_LINES} lines.
          </Typography>
          <Button size="small" onClick={() => setShowAll(true)}>
            Show all
          </Button>
        </Box>
      )}
    </Box>
  );
}

/** Simple CSV line parser that handles quoted fields */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current.trim());
  return result;
}

function NoPreview({ fileName }: { fileName: string; isOffice?: boolean }) {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 2,
        py: 6,
        px: 3,
      }}
    >
      <FileIcon sx={{ fontSize: 64, color: 'text.secondary', opacity: 0.5 }} />
      <Typography variant="h6" color="text.secondary" fontWeight={500}>
        Preview not available
      </Typography>
      <Typography variant="body2" color="text.secondary" textAlign="center">
        <strong>{fileName}</strong> cannot be previewed inline.
        <br />
        Download the file to view its contents.
      </Typography>
    </Box>
  );
}

export function DocumentPreview({ documentId, versionNumber, fileName, mimeType }: DocumentPreviewProps) {
  const previewType = getPreviewType(mimeType, fileName);
  const previewUrl = useMemo(
    () => buildPreviewUrl(documentId, versionNumber),
    [documentId, versionNumber]
  );

  const handleDownload = () => {
    const token = localStorage.getItem('auth_token');
    const params = new URLSearchParams();
    if (versionNumber) params.set('version', String(versionNumber));
    if (token) params.set('token', token);
    const qs = params.toString();
    window.open(`/api/documents/${documentId}/download${qs ? `?${qs}` : ''}`, '_blank');
  };

  const handleOpenNewTab = () => {
    window.open(previewUrl, '_blank');
  };

  return (
    <Paper variant="outlined" sx={{ overflow: 'hidden', mb: 3 }}>
      {/* Toolbar */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 2,
          py: 1.5,
          borderBottom: '1px solid',
          borderColor: 'divider',
          bgcolor: 'grey.50',
          flexWrap: 'wrap',
        }}
      >
        {getPreviewIcon(previewType)}
        <Typography
          variant="body2"
          fontWeight={600}
          sx={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {fileName}
        </Typography>
        <Chip
          label={getPreviewTypeLabel(previewType)}
          size="small"
          variant="outlined"
          color="primary"
          sx={{ fontWeight: 600, fontSize: '0.7rem' }}
        />
        {versionNumber && (
          <Chip
            label={`v${versionNumber}`}
            size="small"
            variant="filled"
            color="primary"
            sx={{ fontWeight: 700, fontSize: '0.7rem' }}
          />
        )}
        <Box sx={{ display: 'flex', gap: 0.5 }}>
          <Tooltip title="Open in new tab">
            <IconButton size="small" onClick={handleOpenNewTab}>
              <OpenInNewIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Download">
            <IconButton size="small" onClick={handleDownload}>
              <DownloadIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {/* Preview Content */}
      {previewType === 'pdf' && <PdfViewer url={previewUrl} fileName={fileName} />}
      {previewType === 'image' && <ImagePreview url={previewUrl} fileName={fileName} />}
      {previewType === 'text' && <TextPreview url={previewUrl} />}
      {previewType === 'json' && <JsonPreview url={previewUrl} />}
      {previewType === 'csv' && <CsvPreview url={previewUrl} />}
      {(previewType === 'office' || previewType === 'unknown') && (
        <NoPreview fileName={fileName} isOffice={previewType === 'office'} />
      )}

      {/* Download button for non-previewable types */}
      {(previewType === 'office' || previewType === 'unknown') && (
        <Box sx={{ display: 'flex', justifyContent: 'center', pb: 3 }}>
          <Button
            variant="contained"
            startIcon={<DownloadIcon />}
            onClick={handleDownload}
          >
            Download File
          </Button>
        </Box>
      )}
    </Paper>
  );
}
