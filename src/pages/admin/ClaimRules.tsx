/**
 * Claim Rules — the primary surface for the claim -> requirement mapping.
 *
 * This page is written for the QA manager who will actually fill it in, not
 * for an engineer. It renders the whole configuration as a list of SENTENCES:
 *
 *     Organic  →  requires  Organic Certificate on file
 *     GFSI-Certified Facility  →  requires  3rd Party Audit REPORT,
 *                                           3rd Party Audit CERTIFICATE
 *     Kosher  →  not configured yet
 *
 * Two deliberate choices:
 *   1. Unconfigured claims sort to the TOP and are visibly flagged. A claim
 *      with no rule is inert — nothing is ever reported missing for it — and
 *      that is exactly the failure that would otherwise go unnoticed until the
 *      gap report came back empty. Progress ("8 of 12 configured") makes the
 *      remaining work finite and visible.
 *   2. Editing is one click into the same dialog used everywhere else, so
 *      there is one way to set a rule, not two.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  LinearProgress,
  Paper,
  Typography,
} from '@mui/material';
import { Edit as EditIcon, ArrowForward as ArrowIcon } from '@mui/icons-material';
import { api } from '../../lib/api';
import type { ApiClaimRule, ApiClaimType, ApiRequirement } from '../../lib/types';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';
import { HelpWell } from '../../components/HelpWell';
import { EmptyState } from '../../components/EmptyState';
import { ClaimRequirementsDialog } from '../../components/ClaimRequirementsDialog';

export function ClaimRules() {
  const [claimTypes, setClaimTypes] = useState<ApiClaimType[]>([]);
  const [requirements, setRequirements] = useState<ApiRequirement[]>([]);
  const [rules, setRules] = useState<ApiClaimRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<ApiClaimType | null>(null);

  const { user, isSuperAdmin } = useAuth();
  const { selectedTenantId } = useTenant();

  const tenantId = isSuperAdmin
    ? selectedTenantId || undefined
    : user?.tenant_id || undefined;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [claims, reqs, ruleList] = await Promise.all([
        api.claimTypes.list({ tenant_id: tenantId }),
        api.requirements.list({ tenant_id: tenantId }),
        api.claimRules.list({ tenant_id: tenantId }),
      ]);
      setClaimTypes(claims.claimTypes);
      setRequirements(reqs.requirements);
      setRules(ruleList.rules);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load claim rules');
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    load();
  }, [load]);

  /** claim_type_id -> its rules, split by required vs advisory. */
  const byClaim = useMemo(() => {
    const map = new Map<string, { required: ApiClaimRule[]; recommended: ApiClaimRule[] }>();
    for (const rule of rules) {
      if (!map.has(rule.claim_type_id)) map.set(rule.claim_type_id, { required: [], recommended: [] });
      const bucket = map.get(rule.claim_type_id)!;
      if (rule.is_required) bucket.required.push(rule);
      else bucket.recommended.push(rule);
    }
    return map;
  }, [rules]);

  // Unconfigured first — that is the work queue; then alphabetical-by-config order.
  const ordered = useMemo(() => {
    return [...claimTypes].sort((a, b) => {
      const aHas = byClaim.has(a.id) ? 1 : 0;
      const bHas = byClaim.has(b.id) ? 1 : 0;
      if (aHas !== bHas) return aHas - bHas;
      return a.name.localeCompare(b.name);
    });
  }, [claimTypes, byClaim]);

  const configured = claimTypes.filter((c) => byClaim.has(c.id)).length;
  const pct = claimTypes.length ? Math.round((configured / claimTypes.length) * 100) : 0;

  if (loading && claimTypes.length === 0) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="h4" fontWeight={700} sx={{ mb: 3 }}>
        Claim Rules
      </Typography>

      <HelpWell id="registry.claim_rules" title="If a document claims this, what do we need?">
        Set this up once per claim and it applies to every document from then on. If a spec sheet
        says a product is organic, the organic certificate becomes required — and shows up as
        missing until somebody sends it. <strong>Required</strong> items are reported as gaps;{' '}
        <strong>recommended</strong> ones are advisory.
      </HelpWell>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {claimTypes.length === 0 ? (
        <EmptyState
          title="No claims to configure"
          description="Add claims under Settings → Claims first. A rule connects a claim to the documents that prove it."
        />
      ) : (
        <>
          <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
              <Typography variant="body2" fontWeight={600}>
                {configured} of {claimTypes.length} claims configured
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {pct}%
              </Typography>
            </Box>
            <LinearProgress variant="determinate" value={pct} />
            {configured < claimTypes.length && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                Claims without a rule are listed first. Until a claim has one, nothing is ever
                reported as missing for it.
              </Typography>
            )}
          </Paper>

          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {ordered.map((ct) => {
              const bucket = byClaim.get(ct.id);
              const unconfigured = !bucket;
              return (
                <Paper
                  key={ct.id}
                  variant="outlined"
                  sx={{
                    p: 2,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1.5,
                    flexWrap: 'wrap',
                    borderColor: unconfigured ? 'warning.main' : undefined,
                  }}
                >
                  <Box sx={{ minWidth: 180 }}>
                    <Typography variant="body1" fontWeight={700}>
                      {ct.name}
                    </Typography>
                    {!ct.active && (
                      <Chip size="small" label="Inactive" variant="outlined" sx={{ mt: 0.5 }} />
                    )}
                  </Box>

                  <ArrowIcon fontSize="small" color="disabled" />

                  <Box sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                    {unconfigured ? (
                      <Typography variant="body2" color="warning.main" fontWeight={600}>
                        Not configured — this claim requires nothing yet
                      </Typography>
                    ) : (
                      <>
                        {bucket!.required.length > 0 && (
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
                            <Typography variant="body2" color="text.secondary">
                              requires
                            </Typography>
                            {bucket!.required.map((r) => (
                              <Chip
                                key={r.id}
                                size="small"
                                color="primary"
                                label={r.requirement_name || r.requirement_slug}
                              />
                            ))}
                          </Box>
                        )}
                        {bucket!.recommended.length > 0 && (
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
                            <Typography variant="body2" color="text.secondary">
                              recommends
                            </Typography>
                            {bucket!.recommended.map((r) => (
                              <Chip
                                key={r.id}
                                size="small"
                                variant="outlined"
                                label={r.requirement_name || r.requirement_slug}
                              />
                            ))}
                          </Box>
                        )}
                      </>
                    )}
                  </Box>

                  <Button
                    size="small"
                    startIcon={<EditIcon />}
                    variant={unconfigured ? 'contained' : 'outlined'}
                    onClick={() => setEditing(ct)}
                  >
                    {unconfigured ? 'Set rule' : 'Edit'}
                  </Button>
                </Paper>
              );
            })}
          </Box>
        </>
      )}

      <ClaimRequirementsDialog
        open={!!editing}
        claimType={editing}
        requirements={requirements}
        onClose={() => setEditing(null)}
        onSaved={() => load()}
      />
    </Box>
  );
}

export default ClaimRules;
