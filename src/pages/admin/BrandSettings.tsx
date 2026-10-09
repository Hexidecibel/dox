/**
 * Settings > Brand -- the tenant brand record (migration 0140).
 *
 * What people OUTSIDE the organisation see of it: the display name, the logo,
 * two colours and a support line, on every page they open from a link and in
 * every mail the portal sends them.
 *
 * THE PREVIEW IS THE POINT. The one real exposure in this record is what an
 * admin types into the support line -- it is shown to suppliers and customers.
 * So the page header and the mail header are drawn live from the DRAFT, with
 * the same palette function the real surfaces use (`brandPalette`), and
 * nothing is saved until the admin presses Save.
 *
 * The logo is the exception: choosing a file uploads it at once, because the
 * server decides what the file is (PNG, JPEG or WebP by its bytes, 512 KB,
 * 16-2000 px) and the honest preview is the stored one.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  CircularProgress,
  Divider,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';
import { api } from '../../lib/api';
import { BrandHeader, BrandSupport } from '../../components/brand/BrandHeader';
import {
  BRAND_DISPLAY_NAME_MAX,
  BRAND_LOGO_MAX_BYTES,
  BRAND_SUPPORT_PHONE_MAX,
  BRAND_SUPPORT_TEXT_MAX,
  BRAND_SURFACES,
  DEFAULT_BRAND_COLOR,
  brandPalette,
  contrastRatio,
  parseBrandColor,
  readableTextOn,
  resolveSupportLine,
} from '../../../shared/tenantBrand';
import type { BrandSurface } from '../../../shared/tenantBrand';
import type { BrandSupportLine, PublicBrand, TenantBrandResponse } from '../../../shared/types';

interface Draft {
  display_name: string;
  primary_color: string;
  accent_color: string;
  support: { text: string; email: string; phone: string };
  overrides: Record<string, { text: string; email: string; phone: string }>;
}

const emptyLine = () => ({ text: '', email: '', phone: '' });
const lineToDraft = (l: BrandSupportLine | null | undefined) => ({
  text: l?.text ?? '',
  email: l?.email ?? '',
  phone: l?.phone ?? '',
});
const draftToLine = (l: { text: string; email: string; phone: string }): BrandSupportLine => ({
  text: l.text.trim() || null,
  email: l.email.trim() || null,
  phone: l.phone.trim() || null,
});

function toDraft(b: TenantBrandResponse): Draft {
  const overrides: Draft['overrides'] = {};
  for (const s of BRAND_SURFACES) overrides[s.key] = lineToDraft(b.support_overrides[s.key]);
  return {
    display_name: b.display_name ?? '',
    primary_color: b.primary_color ?? '',
    accent_color: b.accent_color ?? '',
    support: lineToDraft(b.support),
    overrides,
  };
}

/** A colour field is fine when it is empty or a full #RRGGBB. */
function colorError(value: string): string | null {
  if (value.trim() === '') return null;
  return parseBrandColor(value.trim()) ? null : 'Use a six-digit hex colour such as #1A365D';
}

function ColorField({
  label,
  value,
  onChange,
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  testId: string;
}) {
  const parsed = parseBrandColor(value.trim());
  const error = colorError(value);
  return (
    <Stack direction="row" spacing={1.5} alignItems="flex-start">
      <Box
        component="input"
        type="color"
        aria-label={`${label} picker`}
        value={(parsed ?? DEFAULT_BRAND_COLOR).toLowerCase()}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value.toUpperCase())}
        sx={{ width: 48, height: 40, p: 0, border: '1px solid', borderColor: 'divider', borderRadius: 1, cursor: 'pointer', mt: 0.25 }}
      />
      <TextField
        label={label}
        size="small"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="#1A365D"
        error={!!error}
        helperText={error ?? 'Leave empty for the default navy'}
        inputProps={{ maxLength: 7, 'data-testid': testId }}
        sx={{ width: 220 }}
      />
    </Stack>
  );
}

function SupportFields({
  value,
  onChange,
  idPrefix,
  textLabel,
}: {
  value: { text: string; email: string; phone: string };
  onChange: (v: { text: string; email: string; phone: string }) => void;
  idPrefix: string;
  textLabel: string;
}) {
  return (
    <Stack spacing={1.5}>
      <TextField
        label={textLabel}
        size="small"
        fullWidth
        value={value.text}
        onChange={(e) => onChange({ ...value, text: e.target.value })}
        inputProps={{ maxLength: BRAND_SUPPORT_TEXT_MAX, 'data-testid': `${idPrefix}-text` }}
      />
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
        <TextField
          label="Email (optional)"
          size="small"
          fullWidth
          value={value.email}
          onChange={(e) => onChange({ ...value, email: e.target.value })}
          inputProps={{ 'data-testid': `${idPrefix}-email` }}
        />
        <TextField
          label="Phone (optional)"
          size="small"
          fullWidth
          value={value.phone}
          onChange={(e) => onChange({ ...value, phone: e.target.value })}
          inputProps={{ maxLength: BRAND_SUPPORT_PHONE_MAX, 'data-testid': `${idPrefix}-phone` }}
        />
      </Stack>
    </Stack>
  );
}

export function BrandSettings() {
  const { user } = useAuth();
  const { selectedTenantId } = useTenant();
  // A super_admin acts on the tenant chosen in the top bar; an org_admin's
  // selection is locked to their own tenant.
  const tenantId = selectedTenantId ?? user?.tenant_id ?? null;

  const [brand, setBrand] = useState<TenantBrandResponse | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [previewSurface, setPreviewSurface] = useState<BrandSurface>('supplier_request');
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!tenantId) {
      setLoading(false);
      setBrand(null);
      setDraft(null);
      return;
    }
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const b = await api.tenantBrand.get(tenantId);
        if (cancelled) return;
        setBrand(b);
        setDraft(toDraft(b));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load the brand.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  // The brand an outsider WOULD be given, built from the draft exactly the way
  // the server builds it: display name falls back to the organisation name, a
  // bad colour is no colour, one support line resolved for the surface shown.
  const preview: PublicBrand | null = useMemo(() => {
    if (!brand || !draft) return null;
    const overrides: Record<string, BrandSupportLine> = {};
    for (const [k, v] of Object.entries(draft.overrides)) overrides[k] = draftToLine(v);
    return {
      display_name: draft.display_name.trim() || brand.tenant_name,
      logo_url: brand.logo?.url ?? null,
      primary_color: parseBrandColor(draft.primary_color.trim()),
      accent_color: parseBrandColor(draft.accent_color.trim()),
      support: resolveSupportLine(draftToLine(draft.support), overrides, previewSurface),
    };
  }, [brand, draft, previewSurface]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }
  if (!tenantId) {
    return <Alert severity="info">Choose an organization in the top bar to edit its brand.</Alert>;
  }
  if (!brand || !draft || !preview) {
    return <Alert severity="error">{error ?? 'Could not load the brand.'}</Alert>;
  }

  const palette = brandPalette(preview.primary_color, preview.accent_color);
  const primary = preview.primary_color;
  const onPrimary = primary ? readableTextOn(primary) : null;
  const hasColorError = !!colorError(draft.primary_color) || !!colorError(draft.accent_color);
  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(brand));

  const set = (patch: Partial<Draft>) => {
    setSaved(false);
    setDraft({ ...draft, ...patch });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const overrides: Record<string, BrandSupportLine | null> = {};
      for (const s of BRAND_SURFACES) {
        const line = draftToLine(draft.overrides[s.key] ?? emptyLine());
        if (line.text || line.email || line.phone) overrides[s.key] = line;
      }
      const next = await api.tenantBrand.put(tenantId, {
        display_name: draft.display_name.trim() || null,
        primary_color: draft.primary_color.trim() || null,
        accent_color: draft.accent_color.trim() || null,
        support: draftToLine(draft.support),
        support_overrides: overrides,
      });
      setBrand(next);
      setDraft(toDraft(next));
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the brand.');
    } finally {
      setSaving(false);
    }
  };

  const onLogoChosen = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (file.size > BRAND_LOGO_MAX_BYTES) {
      setError(`The logo is too large (${Math.round(BRAND_LOGO_MAX_BYTES / 1024)} KB at most).`);
      return;
    }
    setLogoBusy(true);
    try {
      // Only the logo comes back into `brand`; the unsaved draft is kept.
      setBrand(await api.tenantBrand.uploadLogo(tenantId, file));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not upload the logo.');
    } finally {
      setLogoBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const removeLogo = async () => {
    setLogoBusy(true);
    setError(null);
    try {
      setBrand(await api.tenantBrand.removeLogo(tenantId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove the logo.');
    } finally {
      setLogoBusy(false);
    }
  };

  return (
    <Box data-testid="brand-settings">
      <Typography variant="h6" fontWeight={700}>
        Brand
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2, maxWidth: 760 }}>
        What people outside {brand.tenant_name} see: on every page they open from a link (document
        requests, sent documents, alerts, forms) and in every email the portal sends them.
        {brand.configured
          ? ''
          : ' Nothing is set yet, so those pages and emails show the organization name in the default navy.'}
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {saved && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSaved(false)}>
          Saved. New emails and pages use it from now on.
        </Alert>
      )}

      <Stack direction={{ xs: 'column', lg: 'row' }} spacing={3} alignItems="flex-start">
        {/* ── The record ─────────────────────────────────────────────── */}
        <Stack spacing={3} sx={{ flex: 1, minWidth: 0, width: '100%' }}>
          <Paper variant="outlined" sx={{ p: 2.5 }}>
            <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1.5 }}>
              Name and logo
            </Typography>
            <TextField
              label="Display name"
              size="small"
              fullWidth
              value={draft.display_name}
              onChange={(e) => set({ display_name: e.target.value })}
              placeholder={brand.tenant_name}
              helperText={`What outsiders read. Leave empty to use "${brand.tenant_name}".`}
              inputProps={{ maxLength: BRAND_DISPLAY_NAME_MAX, 'data-testid': 'brand-display-name' }}
            />
            <Stack direction="row" spacing={2} alignItems="center" sx={{ mt: 2 }}>
              <Box
                sx={{
                  width: 160,
                  height: 64,
                  border: '1px dashed',
                  borderColor: 'divider',
                  borderRadius: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  bgcolor: '#ffffff',
                  overflow: 'hidden',
                }}
              >
                {brand.logo ? (
                  <Box
                    component="img"
                    src={brand.logo.url}
                    alt="Current logo"
                    data-testid="brand-logo-preview"
                    sx={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                  />
                ) : (
                  <Typography variant="caption" color="text.secondary">
                    No logo
                  </Typography>
                )}
              </Box>
              <Stack spacing={0.5}>
                <Stack direction="row" spacing={1}>
                  <Button variant="outlined" size="small" component="label" disabled={logoBusy}>
                    {brand.logo ? 'Replace logo' : 'Upload logo'}
                    <input
                      ref={fileRef}
                      hidden
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      data-testid="brand-logo-input"
                      onChange={(e) => void onLogoChosen(e.target.files?.[0])}
                    />
                  </Button>
                  {brand.logo && (
                    <Button size="small" color="error" disabled={logoBusy} onClick={() => void removeLogo()} data-testid="brand-logo-remove">
                      Remove
                    </Button>
                  )}
                </Stack>
                <Typography variant="caption" color="text.secondary">
                  PNG, JPEG or WebP, up to {Math.round(BRAND_LOGO_MAX_BYTES / 1024)} KB. SVG is not accepted.
                  {brand.logo ? ` Current: ${brand.logo.width} x ${brand.logo.height} px.` : ''}
                </Typography>
              </Stack>
            </Stack>
          </Paper>

          <Paper variant="outlined" sx={{ p: 2.5 }}>
            <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1.5 }}>
              Colours
            </Typography>
            <Stack spacing={2}>
              <ColorField label="Primary colour" value={draft.primary_color} onChange={(v) => set({ primary_color: v })} testId="brand-primary-color" />
              <ColorField label="Accent colour" value={draft.accent_color} onChange={(v) => set({ accent_color: v })} testId="brand-accent-color" />
              {primary && onPrimary && (
                <Typography variant="body2" data-testid="brand-contrast">
                  Text on the primary colour is drawn in{' '}
                  <strong>{onPrimary.color === '#ffffff' ? 'white' : 'black'}</strong> (contrast{' '}
                  {onPrimary.ratio.toFixed(1)}:1).
                </Typography>
              )}
              {primary && palette.textFellBack && (
                <Alert severity="info" data-testid="brand-pale-warning">
                  This colour is too pale to read as text on a white page (
                  {contrastRatio(primary, '#FFFFFF').toFixed(1)}:1, needs 4.5:1). It is still used for the header
                  and buttons; links and small headings stay navy.
                </Alert>
              )}
              <Typography variant="caption" color="text.secondary">
                The primary colour paints the header and buttons; the accent is the thin rule beside them. Body
                text is never coloured.
              </Typography>
            </Stack>
          </Paper>

          <Paper variant="outlined" sx={{ p: 2.5 }}>
            <Typography variant="subtitle2" fontWeight={700}>
              Support line
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
              Shown to suppliers and customers at the foot of every page and email. Type only what you want
              people outside the organization to read.
            </Typography>
            <SupportFields
              value={draft.support}
              onChange={(support) => set({ support })}
              idPrefix="brand-support"
              textLabel="Support line (for example: Questions? Contact Purchasing)"
            />

            <Accordion disableGutters elevation={0} sx={{ mt: 2, '&:before': { display: 'none' }, border: '1px solid', borderColor: 'divider' }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />} data-testid="brand-overrides-toggle">
                <Typography variant="body2" fontWeight={600}>
                  A different line on some pages
                </Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
                  Leave a page empty to use the support line above. A line set here replaces it completely on
                  that page and its email.
                </Typography>
                <Stack spacing={2.5} divider={<Divider flexItem />}>
                  {BRAND_SURFACES.map((s) => (
                    <Box key={s.key}>
                      <Typography variant="body2" fontWeight={600}>
                        {s.label}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                        {s.description}
                      </Typography>
                      <SupportFields
                        value={draft.overrides[s.key] ?? emptyLine()}
                        onChange={(line) => set({ overrides: { ...draft.overrides, [s.key]: line } })}
                        idPrefix={`brand-override-${s.key}`}
                        textLabel="Support line on this page"
                      />
                    </Box>
                  ))}
                </Stack>
              </AccordionDetails>
            </Accordion>
          </Paper>

          <Stack direction="row" spacing={2} alignItems="center">
            <Button
              variant="contained"
              onClick={() => void save()}
              disabled={saving || hasColorError || !dirty}
              data-testid="brand-save"
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
            {dirty && (
              <Button onClick={() => setDraft(toDraft(brand))} disabled={saving}>
                Discard changes
              </Button>
            )}
            {brand.updated_at && (
              <Typography variant="caption" color="text.secondary">
                Last changed {new Date(brand.updated_at.replace(' ', 'T') + 'Z').toLocaleString()}
                {brand.updated_by_name ? ` by ${brand.updated_by_name}` : ''}
              </Typography>
            )}
          </Stack>
        </Stack>

        {/* ── What an outsider will see ──────────────────────────────── */}
        <Paper variant="outlined" sx={{ p: 2.5, width: { xs: '100%', lg: 400 }, flexShrink: 0, position: { lg: 'sticky' }, top: { lg: 16 } }}>
          <Typography variant="subtitle2" fontWeight={700}>
            Preview
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
            {dirty ? 'Not saved yet. ' : ''}This is what a supplier or customer sees.
          </Typography>

          <TextField
            select
            size="small"
            fullWidth
            label="Page"
            value={previewSurface}
            onChange={(e) => setPreviewSurface(e.target.value as BrandSurface)}
            SelectProps={{ native: true }}
            inputProps={{ 'data-testid': 'brand-preview-surface' }}
            sx={{ mb: 2 }}
          >
            {BRAND_SURFACES.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </TextField>

          <Typography variant="overline" color="text.secondary">
            On a page
          </Typography>
          <Box data-testid="brand-preview-page" sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1.5, bgcolor: '#ffffff', color: '#222' }}>
            <BrandHeader brand={preview} />
            <Typography variant="body2" sx={{ color: '#555' }}>
              The page content is shown in the normal text colour.
            </Typography>
            <Box
              sx={{
                display: 'inline-block',
                mt: 1.5,
                px: 2,
                py: 0.75,
                borderRadius: 1,
                bgcolor: palette.text,
                color: '#ffffff',
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              A button
            </Box>
            <BrandSupport brand={preview} />
          </Box>

          <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
            In an email
          </Typography>
          <Box data-testid="brand-preview-mail" sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, overflow: 'hidden', bgcolor: '#ffffff' }}>
            {preview.logo_url ? (
              <Box sx={{ p: '16px 20px 12px', borderBottom: `4px solid ${palette.stripe}` }}>
                <Box component="img" src={preview.logo_url} alt={preview.display_name} sx={{ display: 'block', height: 40, maxWidth: 220, objectFit: 'contain' }} />
              </Box>
            ) : (
              <Box
                sx={{
                  p: '16px 20px',
                  bgcolor: palette.band,
                  color: palette.onBand,
                  borderBottom: preview.accent_color ? `4px solid ${palette.stripe}` : undefined,
                  fontWeight: 600,
                  fontSize: 17,
                }}
              >
                {preview.display_name}
              </Box>
            )}
            <Box sx={{ p: '14px 20px' }}>
              <Typography variant="body2" sx={{ color: '#555' }}>
                The message is shown in the normal text colour.
              </Typography>
              <Box
                sx={{
                  display: 'inline-block',
                  mt: 1.5,
                  px: 2,
                  py: 0.75,
                  borderRadius: 1,
                  bgcolor: palette.button,
                  color: palette.onButton,
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                Open the documents
              </Box>
            </Box>
            <Box sx={{ p: '10px 20px', bgcolor: '#f8f9fa', borderTop: '1px solid #eee', textAlign: 'center' }}>
              <BrandSupport brand={preview.support ? preview : { ...preview, support: { text: null, email: null, phone: null } }} sx={{ mt: 0 }} />
              {!preview.support && (
                <Typography variant="caption" sx={{ color: '#666' }}>
                  <strong>{preview.display_name}</strong>
                </Typography>
              )}
            </Box>
          </Box>
        </Paper>
      </Stack>
    </Box>
  );
}
