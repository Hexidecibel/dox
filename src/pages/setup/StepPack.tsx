/**
 * Screen 1 — "What do you make or handle?"
 *
 * One card per starter pack, and every number and example on it comes out of
 * the pack JSON (`GET /api/starter-packs` builds them; nothing is written as
 * copy here). A card that says "27 document types, e.g. Certificate of
 * Analysis, Specification Sheet, HACCP Plan" tells an admin what they are about
 * to get. A card that says "comprehensive food-safety coverage" tells them
 * nothing and cannot be wrong, which is worse — and if the real examples read
 * badly, the pack is wrong and this is where that becomes visible.
 *
 * APPLYING WRITES THROUGH, NOW. `POST /api/starter-packs/apply` performs the
 * same seeding as `bin/create-tenant --pack fsqa`: the same tables, the same
 * deterministic ids, the same `INSERT OR IGNORE`. Screens 2-6 then render from
 * the tenant rather than from a staged blob, which is the whole reason this
 * step is not deferred to a commit at the end.
 *
 * ALREADY-SEEDED TENANTS RENDER AS A SUMMARY, NOT A CHOOSER. A tenant created
 * with `bin/create-tenant --pack fsqa` arrives with everything in place before
 * a run exists, so the screen detects it two ways — the run's `applied` ledger,
 * and (for a tenant seeded before any run) the vocabulary already sitting in the
 * tables — and switches to a read-only receipt with the pack chooser collapsed
 * behind "seed a different pack as well".
 */

import { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  Stack,
  Typography,
} from '@mui/material';
import {
  CheckCircle as AppliedIcon,
  Inventory2 as PackIcon,
  PlayArrow as ApplyIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';
import type { StarterPackCatalogEntry } from '../../lib/types';
import type { SetupStepProps } from './stepProps';

/** The scratch key holding the card somebody clicked but has not applied. */
const SELECTED_KEY = 'selected_pack';

interface PackCardProps {
  entry: StarterPackCatalogEntry;
  selected: boolean;
  onSelect: () => void;
}

function PackCard({ entry, selected, onSelect }: PackCardProps) {
  return (
    <Card
      variant="outlined"
      sx={{
        borderColor: selected ? 'primary.main' : undefined,
        borderWidth: selected ? 2 : 1,
        height: '100%',
      }}
    >
      <CardActionArea onClick={onSelect} sx={{ height: '100%', alignItems: 'stretch' }}>
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
            <PackIcon fontSize="small" color={selected ? 'primary' : 'disabled'} />
            <Typography variant="h6" fontWeight={700}>
              {entry.label}
            </Typography>
          </Box>

          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            {entry.description}
          </Typography>

          <Stack spacing={0.75}>
            {entry.sections.map((section) => (
              <Box key={section.key}>
                <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75, flexWrap: 'wrap' }}>
                  <Typography variant="body2" fontWeight={700}>
                    {section.count}
                  </Typography>
                  <Typography variant="body2">{section.label}</Typography>
                  {!section.seeded && (
                    <Chip size="small" variant="outlined" label="defined, not applied" />
                  )}
                </Box>
                {section.examples.length > 0 && (
                  <Typography variant="caption" color="text.secondary">
                    {section.examples.join(' · ')}
                    {section.count > section.examples.length ? ' …' : ''}
                  </Typography>
                )}
                {!section.seeded && section.not_seeded_reason && (
                  <Typography variant="caption" color="text.secondary" display="block">
                    {section.not_seeded_reason}
                  </Typography>
                )}
              </Box>
            ))}
          </Stack>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}

export function StepPack({
  run,
  tenantId,
  catalog,
  preSeeded,
  patchState,
  refreshRun,
}: SetupStepProps) {
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');

  const applied = run.applied.pack ?? null;

  const selectedName =
    (typeof run.state[SELECTED_KEY] === 'string' ? (run.state[SELECTED_KEY] as string) : null) ??
    run.pack ??
    applied?.name ??
    catalog?.default_pack ??
    null;

  const selected = useMemo(
    () => catalog?.packs.find((p) => p.pack === selectedName) ?? null,
    [catalog, selectedName],
  );

  // A tenant with document types AND checklist items already has the
  // vocabulary a pack supplies, whoever put it there — so either the ledger or
  // the tenant's own tables can answer "already seeded".
  const alreadySeeded =
    applied !== null || (preSeeded !== null && preSeeded.types > 0 && preSeeded.requirements > 0);

  const apply = useCallback(
    async (packName: string) => {
      setApplying(true);
      setError('');
      try {
        await api.starterPacks.apply({ pack: packName, tenantId, runId: run.id });
        await refreshRun();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not apply the pack');
      } finally {
        setApplying(false);
      }
    },
    [tenantId, run.id, refreshRun],
  );

  if (!catalog) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="body1" sx={{ mb: 2 }}>
        A starter pack fills the tenant with the vocabulary the rest of the system reasons about:
        what a document <strong>is</strong>, what it <strong>satisfies</strong>, and what it{' '}
        <strong>triggers</strong>. Everything it writes is editable afterwards, and everything on
        these cards is counted from the pack itself.
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {alreadySeeded && (
        <Alert severity="success" icon={<AppliedIcon />} sx={{ mb: 2 }}>
          <AlertTitle>This tenant is already seeded</AlertTitle>
          {applied ? (
            <>
              The <strong>{applied.name}</strong> pack was applied{' '}
              {applied.already_seeded
                ? 'and found everything already present'
                : `and added ${Object.values(applied.counts).reduce((a, b) => a + b, 0)} rows`}
              .
            </>
          ) : (
            <>
              The vocabulary is already in place — {preSeeded?.types} document types and{' '}
              {preSeeded?.requirements} requirements — which is what{' '}
              <code>bin/create-tenant --pack</code> leaves behind. Nothing to do here.
            </>
          )}{' '}
          Re-running a pack <strong>adds what is missing and never overwrites an edit</strong>:
          every row is written with a deterministic id and ignored if it already exists.
        </Alert>
      )}

      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr', md: 'repeat(auto-fit, minmax(320px, 1fr))' },
          mb: 2,
        }}
      >
        {catalog.packs.map((entry) => (
          <PackCard
            key={entry.pack}
            entry={entry}
            selected={entry.pack === selectedName}
            onSelect={() => patchState({ [SELECTED_KEY]: entry.pack })}
          />
        ))}
      </Box>

      <Divider sx={{ my: 2 }} />

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <Button
          variant="contained"
          startIcon={applying ? <CircularProgress size={16} color="inherit" /> : <ApplyIcon />}
          disabled={!selected || applying}
          onClick={() => selected && apply(selected.pack)}
        >
          {applying
            ? 'Applying…'
            : alreadySeeded
              ? `Re-run ${selected?.label ?? 'this pack'}`
              : `Apply ${selected?.label ?? 'this pack'}`}
        </Button>
        {selected && (
          <Typography variant="body2" color="text.secondary">
            {selected.total_rows} rows, written straight to this tenant. You can carry on and edit
            any of them later.
          </Typography>
        )}
      </Box>
    </Box>
  );
}

export default StepPack;
