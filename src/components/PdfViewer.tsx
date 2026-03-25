import { useState, useEffect, useRef, useCallback } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/esm/Page/AnnotationLayer.css';
import 'react-pdf/dist/esm/Page/TextLayer.css';
import {
  Box, Paper, IconButton, Typography, TextField, Tooltip,
  CircularProgress, Alert, Button, ToggleButtonGroup, ToggleButton
} from '@mui/material';
import {
  NavigateBefore, NavigateNext, ZoomIn, ZoomOut,
  Download as DownloadIcon
} from '@mui/icons-material';

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

interface PdfViewerProps {
  url: string;
  fileName: string;
}

export default function PdfViewer({ url, fileName }: PdfViewerProps) {
  const [numPages, setNumPages] = useState<number>(0);
  const [pageNumber, setPageNumber] = useState<number>(1);
  const [scale, setScale] = useState<number>(1.0);
  const [fitMode, setFitMode] = useState<'width' | 'page' | 'custom'>('width');
  const [containerWidth, setContainerWidth] = useState<number>(0);
  const [pageInputValue, setPageInputValue] = useState<string>('1');
  const [error, setError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width - 40);
      }
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const onDocumentLoadSuccess = useCallback(({ numPages }: { numPages: number }) => {
    setNumPages(numPages);
    setPageNumber(1);
    setPageInputValue('1');
    setError(null);
  }, []);

  const onDocumentLoadError = useCallback((err: Error) => {
    setError(`Failed to load PDF: ${err.message}`);
  }, []);

  const goToPage = useCallback((page: number) => {
    const clamped = Math.max(1, Math.min(page, numPages));
    setPageNumber(clamped);
    setPageInputValue(String(clamped));
  }, [numPages]);

  const handlePageInputBlur = useCallback(() => {
    const p = parseInt(pageInputValue);
    if (p >= 1 && p <= numPages) {
      goToPage(p);
    } else {
      setPageInputValue(String(pageNumber));
    }
  }, [pageInputValue, numPages, pageNumber, goToPage]);

  const handlePageInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      (e.target as HTMLInputElement).blur();
    }
  }, []);

  const zoomIn = useCallback(() => {
    if (scale < 3.0) {
      setScale((s) => Math.min(s + 0.25, 3.0));
      setFitMode('custom');
    }
  }, [scale]);

  const zoomOut = useCallback(() => {
    if (scale > 0.5) {
      setScale((s) => Math.max(s - 0.25, 0.5));
      setFitMode('custom');
    }
  }, [scale]);

  const handleFitMode = useCallback((_: React.MouseEvent<HTMLElement>, val: 'width' | 'page' | null) => {
    if (val) {
      setFitMode(val);
      setScale(1.0);
    }
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        goToPage(pageNumber - 1);
      } else if (e.key === 'ArrowRight') {
        goToPage(pageNumber + 1);
      }
    };

    el.addEventListener('keydown', handleKeyDown);
    return () => el.removeEventListener('keydown', handleKeyDown);
  }, [goToPage, pageNumber]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 400 }}>
      <Paper
        variant="outlined"
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          px: 1,
          py: 0.5,
          flexWrap: 'wrap',
          borderBottom: 'none',
          borderRadius: '4px 4px 0 0'
        }}
      >
        <Tooltip title="Previous page">
          <span>
            <IconButton size="small" onClick={() => goToPage(pageNumber - 1)} disabled={pageNumber <= 1}>
              <NavigateBefore />
            </IconButton>
          </span>
        </Tooltip>

        <TextField
          size="small"
          value={pageInputValue}
          onChange={(e) => setPageInputValue(e.target.value)}
          onBlur={handlePageInputBlur}
          onKeyDown={handlePageInputKeyDown}
          sx={{ width: 50, '& input': { textAlign: 'center', py: 0.5, fontSize: '0.875rem' } }}
          inputProps={{ 'aria-label': 'Page number' }}
        />

        <Typography variant="body2" color="text.secondary" sx={{ mr: 1 }}>
          / {numPages}
        </Typography>

        <Tooltip title="Next page">
          <span>
            <IconButton size="small" onClick={() => goToPage(pageNumber + 1)} disabled={pageNumber >= numPages}>
              <NavigateNext />
            </IconButton>
          </span>
        </Tooltip>

        <Box sx={{ borderLeft: '1px solid', borderColor: 'divider', height: 24, mx: 0.5 }} />

        <Tooltip title="Zoom out">
          <span>
            <IconButton size="small" onClick={zoomOut} disabled={scale <= 0.5 && fitMode === 'custom'}>
              <ZoomOut />
            </IconButton>
          </span>
        </Tooltip>

        <Typography variant="body2" sx={{ minWidth: 45, textAlign: 'center' }}>
          {fitMode === 'custom' ? `${Math.round(scale * 100)}%` : fitMode === 'width' ? 'Fit W' : 'Fit P'}
        </Typography>

        <Tooltip title="Zoom in">
          <span>
            <IconButton size="small" onClick={zoomIn} disabled={scale >= 3.0 && fitMode === 'custom'}>
              <ZoomIn />
            </IconButton>
          </span>
        </Tooltip>

        <Box sx={{ borderLeft: '1px solid', borderColor: 'divider', height: 24, mx: 0.5 }} />

        <ToggleButtonGroup
          size="small"
          value={fitMode === 'custom' ? null : fitMode}
          exclusive
          onChange={handleFitMode}
          sx={{ '& .MuiToggleButton-root': { py: 0.25, px: 1, fontSize: '0.75rem' } }}
        >
          <ToggleButton value="width">
            <Tooltip title="Fit to width"><span>Width</span></Tooltip>
          </ToggleButton>
          <ToggleButton value="page">
            <Tooltip title="Fit to page"><span>Page</span></Tooltip>
          </ToggleButton>
        </ToggleButtonGroup>
      </Paper>

      <Box
        ref={containerRef}
        tabIndex={0}
        sx={{
          flex: 1,
          overflow: 'auto',
          display: 'flex',
          justifyContent: 'center',
          alignItems: fitMode === 'page' ? 'center' : 'flex-start',
          bgcolor: '#525659',
          border: '1px solid',
          borderColor: 'divider',
          borderRadius: '0 0 4px 4px',
          minHeight: 400,
          outline: 'none',
          '& .react-pdf__Page': { display: 'flex', justifyContent: 'center' }
        }}
      >
        {error ? (
          <Box sx={{ textAlign: 'center', p: 4 }}>
            <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>
            <Button variant="contained" startIcon={<DownloadIcon />} href={url} download={fileName}>
              Download Instead
            </Button>
          </Box>
        ) : (
          <Document
            file={url}
            onLoadSuccess={onDocumentLoadSuccess}
            onLoadError={onDocumentLoadError}
            loading={
              <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 400 }}>
                <CircularProgress />
              </Box>
            }
          >
            <Page
              pageNumber={pageNumber}
              {...(fitMode !== 'custom'
                ? { width: fitMode === 'page' ? containerWidth * 0.9 : containerWidth }
                : { scale })}
              loading={
                <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 400 }}>
                  <CircularProgress size={30} />
                </Box>
              }
            />
          </Document>
        )}
      </Box>
    </Box>
  );
}
