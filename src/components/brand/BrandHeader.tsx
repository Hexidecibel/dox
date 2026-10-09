/**
 * The organisation's brand on a page an outsider opens (migration 0140).
 *
 * Every public page gets its brand the same way: the `brand` object inside the
 * payload its own token route returned (`PublicBrand`, or null). These two
 * components draw it, so no page works out a colour or a support line itself.
 *
 *   <BrandHeader brand={view.brand}>   the band: logo, display name
 *     ...what the page drew before...   <- drawn INSTEAD when there is no brand
 *   </BrandHeader>
 *   <BrandSupport brand={view.brand} /> the support line; nothing without one
 *
 * NO BRAND DRAWS THE CHILDREN AND NOTHING ELSE, so an organisation that has
 * not set a brand sees the page exactly as it was.
 *
 * The band is the tenant's primary colour with black or white on it,
 * whichever is readable (`brandPalette`); the logo sits on a white plate
 * because a logo is drawn for a white page. Body text is never painted.
 * Everything is rendered as React text or a validated value -- no HTML from
 * the payload is ever injected.
 */

import type { ReactNode } from 'react';
import { Box, Link, Typography } from '@mui/material';
import type { SxProps, Theme } from '@mui/material';
import { pageBrand } from '../../../shared/tenantBrand';
import type { PublicBrand } from '../../../shared/types';

export function BrandHeader({
  brand,
  children,
  sx,
}: {
  brand: PublicBrand | null | undefined;
  /** The page's own unbranded header, drawn when there is no brand. */
  children?: ReactNode;
  sx?: SxProps<Theme>;
}) {
  if (!brand) return <>{children ?? null}</>;
  const b = pageBrand(brand, null);
  return (
    <Box
      data-testid="brand-header"
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        px: 2,
        py: 1.5,
        mb: 2,
        borderRadius: 1.5,
        bgcolor: b.band,
        color: b.onBand,
        borderBottom: brand.accent_color ? `4px solid ${b.stripe}` : undefined,
        ...((sx as object) ?? {}),
      }}
    >
      {b.logoSrc && (
        <Box
          component="img"
          src={b.logoSrc}
          alt={`${b.name} logo`}
          data-testid="brand-logo"
          sx={{
            display: 'block',
            height: 44,
            maxWidth: 200,
            objectFit: 'contain',
            bgcolor: '#ffffff',
            borderRadius: 1,
            p: 0.5,
            flexShrink: 0,
          }}
        />
      )}
      <Typography
        component="div"
        data-testid="brand-name"
        sx={{ fontWeight: 700, fontSize: 18, lineHeight: 1.25, color: 'inherit', overflowWrap: 'anywhere' }}
      >
        {b.name}
      </Typography>
    </Box>
  );
}

export function BrandSupport({
  brand,
  sx,
}: {
  brand: PublicBrand | null | undefined;
  sx?: SxProps<Theme>;
}) {
  const b = pageBrand(brand, null);
  if (!b.branded || !b.support) return null;
  const { text, email, phone } = b.support;
  const parts: ReactNode[] = [];
  if (text) parts.push(<span key="text">{text}</span>);
  if (email) {
    parts.push(
      <Link key="email" href={`mailto:${email}`} color="inherit">
        {email}
      </Link>,
    );
  }
  if (phone) parts.push(<span key="phone">{phone}</span>);
  return (
    <Typography
      variant="caption"
      color="text.secondary"
      data-testid="brand-support"
      sx={{ display: 'block', mt: 2, ...((sx as object) ?? {}) }}
    >
      <strong>{b.name}</strong>
      {parts.map((part, i) => (
        <span key={i}>
          {' · '}
          {part}
        </span>
      ))}
    </Typography>
  );
}
