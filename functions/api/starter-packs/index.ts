import { requireRole, errorToResponse } from '../../lib/permissions';
import { DEFAULT_WINDOW_DAYS } from '../../lib/expirations';
import {
  STARTER_PACKS,
  STARTER_PACK_NAMES,
  DEFAULT_STARTER_PACK,
} from '../../lib/starterPacks.generated';
import type { StarterPack } from '../../lib/starterPacks.generated';
import type { Env, User } from '../../lib/types';
import type {
  StarterPackCatalogEntry,
  StarterPackCatalogResponse,
  StarterPackSection,
} from '../../../shared/types';

/**
 * GET /api/starter-packs — the catalog screen 1 renders.
 *
 * THE PACKS REACH THE BROWSER THROUGH A GENERATED MODULE, NOT THE FILESYSTEM.
 * Pages Functions have no `fs`, which is why `npm run build:packs` compiles
 * `starter-packs/*.json` into `functions/lib/starterPacks.generated.ts`. Adding
 * a vertical is still a new JSON file plus a build; this endpoint knows nothing
 * about any particular vertical.
 *
 * EVERY NUMBER AND EVERY EXAMPLE COMES OUT OF THE PACK. No blurbs are written
 * here. A card that says "27 document types, e.g. Certificate of Analysis,
 * Specification Sheet, HACCP Plan" tells an admin what they are about to get;
 * one that says "comprehensive food-safety coverage" tells them nothing and
 * cannot be wrong, which is worse. If the examples read badly, the pack is
 * wrong and that is worth finding out before it is applied.
 *
 * THE TWO UNSEEDED SECTIONS ARE STILL LISTED, flagged `seeded: false` with the
 * reason attached. Dropping them would make the card read as the whole pack and
 * hide the single most important fact about a requirement packet: that it is
 * applied to one supplier at a time, by a person, later.
 *
 * Role: super_admin, org_admin. The catalog is configuration, and the only
 * screen that consumes it is already admin-gated.
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Three names, verbatim, in pack order. Three because a card fits three. */
function examples(names: readonly string[]): string[] {
  return names.slice(0, 3);
}

function sectionsFor(pack: StarterPack): StarterPackSection[] {
  const claimRuleLinks = pack.claim_rules.reduce(
    (n, rule) => n + rule.requires.length + rule.recommends.length,
    0,
  );
  const typeRequirementLinks = pack.document_types.reduce((n, dt) => n + dt.closes.length, 0);
  const specLimits = pack.spec_tests.filter((t) => t.limit !== null).length;

  const all: StarterPackSection[] = [
    {
      key: 'document_types',
      label: 'document types',
      count: pack.document_types.length,
      examples: examples(pack.document_types.map((d) => d.name)),
      seeded: true,
    },
    {
      key: 'requirements',
      label: 'checklist items',
      count: pack.requirements.length,
      examples: examples(pack.requirements.map((r) => r.name)),
      seeded: true,
    },
    {
      key: 'document_type_requirements',
      label: 'type → checklist defaults',
      count: typeRequirementLinks,
      examples: examples(
        pack.document_types
          .filter((d) => d.closes.length > 0)
          .map((d) => `${d.name} closes ${d.closes.length}`),
      ),
      seeded: true,
    },
    {
      key: 'claim_types',
      label: 'claims',
      count: pack.claim_types.length,
      examples: examples(pack.claim_types.map((c) => c.name)),
      seeded: true,
    },
    {
      key: 'claim_rules',
      label: 'claim rules',
      count: claimRuleLinks,
      examples: examples(
        pack.claim_rules.map(
          (r) => `${r.claim} needs ${r.requires.length + r.recommends.length}`,
        ),
      ),
      seeded: true,
    },
    {
      key: 'owner_labels',
      label: 'departments',
      count: pack.owner_labels.length,
      examples: examples(pack.owner_labels.map((o) => o.label)),
      seeded: true,
    },
    {
      key: 'spec_tests',
      label: 'lab tests',
      count: pack.spec_tests.length,
      examples: examples(pack.spec_tests.map((t) => t.name)),
      seeded: true,
    },
    {
      key: 'spec_limits',
      label: 'acceptance limits',
      count: specLimits,
      examples: examples(
        pack.spec_tests
          .filter((t) => t.limit)
          .map((t) => `${t.name} ${t.limit!.operator} ${t.limit!.value_max ?? t.limit!.value_min ?? ''}`.trim()),
      ),
      seeded: true,
    },
    {
      key: 'requirement_packets',
      label: 'supplier packets',
      count: pack.requirement_packets.length,
      examples: examples(pack.requirement_packets.map((p) => p.name)),
      seeded: false,
      not_seeded_reason:
        'A packet is a starting point for one supplier, not a rule for all of them. It is defined here and applied to each supplier as they arrive.',
    },
    {
      key: 'extraction_instructions',
      label: 'reading instructions',
      count: pack.document_types.filter((d) => d.extraction_instructions).length,
      examples: examples(
        pack.document_types.filter((d) => d.extraction_instructions).map((d) => d.name),
      ),
      seeded: true,
    },
  ];

  // A section a pack simply does not have (finance ships no spec tests) is
  // dropped rather than shown as a zero — an empty row reads as a missing
  // feature, and the pack made a decision, not an omission.
  return all.filter((s) => s.count > 0);
}

export function catalogEntry(pack: StarterPack): StarterPackCatalogEntry {
  const sections = sectionsFor(pack);
  return {
    pack: pack.pack,
    label: pack.label,
    description: pack.description,
    sections,
    owner_labels: pack.owner_labels.map((owner) => ({
      label: owner.label,
      owner_key: owner.owner_key,
      description: owner.description,
      // The types whose renewals this department would be told about. Screen 3
      // turns this into a sentence, so a person routing 'Insurance' can see
      // exactly which certificates they are signing up for.
      document_types: pack.document_types
        .filter((dt) => dt.owner === owner.label)
        .map((dt) => dt.name),
    })),
    total_rows: sections.filter((s) => s.seeded).reduce((n, s) => n + s.count, 0),
  };
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const packs: StarterPackCatalogEntry[] = STARTER_PACK_NAMES.filter(
      (name) => STARTER_PACKS[name] !== undefined,
    ).map((name) => catalogEntry(STARTER_PACKS[name]));

    const body: StarterPackCatalogResponse = {
      packs,
      default_pack: DEFAULT_STARTER_PACK,
      renewal_window_days: DEFAULT_WINDOW_DAYS,
    };
    return json(body);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('starter-packs list error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
