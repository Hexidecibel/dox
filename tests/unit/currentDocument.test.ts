/**
 * "The current document of type T for supplier S and item P" (migration 0138),
 * the pure ranking, and the pure judgement of one document line.
 *
 * What is pinned is the rule in shared/currentDocument.ts, in its own order:
 * who a candidate is about, item before supplier, newest, expired stays the
 * answer, a tie is broken the same way every time and said.
 */
import { describe, it, expect } from 'vitest';
import {
  isPastDue,
  resolveCurrentDocument,
  type CurrentDocumentCandidate,
} from '../../shared/currentDocument';
import {
  ORDER_DOCUMENT_LINK_DAYS,
  judgeOrderDocumentLine,
  privateLabelAdvisory,
  type OrderDocumentLineFacts,
} from '../../shared/orderDocuments';
import type { ExitActor } from '../../shared/sharingRule';

const TODAY = '2026-10-08';
const P = 'product-cream-cheese';
const OTHER = 'product-heavy-cream';

function doc(id: string, over: Partial<CurrentDocumentCandidate> = {}): CurrentDocumentCandidate {
  return {
    document_id: id,
    title: `Document ${id}`,
    version_number: 1,
    effective_at: '2026-01-01 00:00:00',
    created_at: '2026-01-01 00:00:00',
    product_ids: [],
    due_date: null,
    ...over,
  };
}

describe('resolveCurrentDocument', () => {
  it('answers missing when nothing is on file', () => {
    const r = resolveCurrentDocument([], P, TODAY);
    expect(r.resolution).toBe('missing');
    expect(r.document_id).toBeNull();
    expect(r.basis).toBeNull();
  });

  it('takes the supplier\'s own document when none is about the item', () => {
    const r = resolveCurrentDocument([doc('a')], P, TODAY);
    expect(r).toMatchObject({ resolution: 'found', document_id: 'a', basis: 'supplier', note: null });
  });

  it('never offers a document linked only to OTHER items', () => {
    const r = resolveCurrentDocument([doc('heavy-cream-spec', { product_ids: [OTHER] })], P, TODAY);
    expect(r.resolution).toBe('missing');
  });

  it('prefers the item\'s own document over a NEWER supplier-level one', () => {
    const r = resolveCurrentDocument(
      [
        doc('supplier-wide', { effective_at: '2026-09-01 00:00:00' }),
        doc('for-the-item', { effective_at: '2025-03-01 00:00:00', product_ids: [P, OTHER] }),
      ],
      P,
      TODAY,
    );
    expect(r).toMatchObject({ resolution: 'found', document_id: 'for-the-item', basis: 'product' });
  });

  it('takes the newest within a tier, across both timestamp shapes the database holds', () => {
    const r = resolveCurrentDocument(
      [
        doc('older', { effective_at: '2026-03-01 10:00:00' }),
        // approved_at is written as ISO; created_at as SQLite's datetime('now').
        doc('newer', { effective_at: '2026-03-01T10:00:01.000Z' }),
        doc('oldest', { effective_at: '2025-12-31 23:59:59' }),
      ],
      P,
      TODAY,
    );
    expect(r.document_id).toBe('newer');
    expect(r.tied_with).toEqual([]);
  });

  it('reports EXPIRED when the newest has expired, and does not fall back to an older one in date', () => {
    const r = resolveCurrentDocument(
      [
        doc('current-but-lapsed', { effective_at: '2026-02-01 00:00:00', due_date: '2026-09-30' }),
        doc('superseded-in-date', { effective_at: '2025-02-01 00:00:00', due_date: '2027-01-31', title: 'Old plan' }),
      ],
      P,
      TODAY,
    );
    expect(r.resolution).toBe('expired');
    expect(r.document_id).toBe('current-but-lapsed');
    expect(r.due_date).toBe('2026-09-30');
    // The older one is SAID, not used.
    expect(r.in_date_alternative).toBe('superseded-in-date');
    expect(r.note).toContain('still in date');
    expect(r.note).toContain('Old plan');
  });

  it('is expired only the day AFTER the due date, and never when the document does not renew', () => {
    expect(isPastDue('2026-10-08', TODAY)).toBe(false);
    expect(isPastDue('2026-10-07', TODAY)).toBe(true);
    expect(isPastDue(null, TODAY)).toBe(false);
    expect(resolveCurrentDocument([doc('a', { due_date: TODAY })], P, TODAY).resolution).toBe('found');
    expect(resolveCurrentDocument([doc('a', { due_date: null })], P, TODAY).resolution).toBe('found');
  });

  it('breaks a tie by the later-created document, then the higher id, and says there was a tie', () => {
    const same = '2026-05-05 12:00:00';
    const byCreated = resolveCurrentDocument(
      [
        doc('aaa', { effective_at: same, created_at: '2026-05-01 00:00:00' }),
        doc('bbb', { effective_at: same, created_at: '2026-05-03 00:00:00' }),
      ],
      P,
      TODAY,
    );
    expect(byCreated.document_id).toBe('bbb');
    expect(byCreated.tied_with).toEqual(['aaa']);
    expect(byCreated.note).toContain('2 documents of this type share the same date');

    // Everything equal: the higher id, whichever order they arrive in.
    const one = [doc('aaa', { effective_at: same, created_at: same }), doc('zzz', { effective_at: same, created_at: same })];
    expect(resolveCurrentDocument(one, P, TODAY).document_id).toBe('zzz');
    expect(resolveCurrentDocument([...one].reverse(), P, TODAY).document_id).toBe('zzz');
  });

  it('does not call it a tie across tiers', () => {
    const same = '2026-05-05 12:00:00';
    const r = resolveCurrentDocument(
      [doc('supplier', { effective_at: same }), doc('item', { effective_at: same, product_ids: [P] })],
      P,
      TODAY,
    );
    expect(r.document_id).toBe('item');
    expect(r.tied_with).toEqual([]);
    expect(r.note).toBeNull();
  });
});

describe('judgeOrderDocumentLine', () => {
  const user: ExitActor = { method: 'jwt', canReleaseQa: false };
  const qa: ExitActor = { method: 'jwt', canReleaseQa: true };
  const key: ExitActor = { method: 'api_key', canReleaseQa: false };

  function facts(over: Partial<OrderDocumentLineFacts> = {}): OrderDocumentLineFacts {
    return {
      has_document: true,
      document_status: 'active',
      has_file: true,
      expired: false,
      due_date: null,
      rule: 'free',
      release_status: 'none',
      decision_note: null,
      decided_at: null,
      is_coa_type: false,
      fresh_found: false,
      ...over,
    };
  }

  it('a free document goes now on the 30-day link, for anyone', () => {
    const j = judgeOrderDocumentLine(facts(), user);
    expect(j).toMatchObject({ disposition: 'goes_now', delivery: 'link', qa_cause: null, behind: false });
    expect(j.text).toContain(`${ORDER_DOCUMENT_LINK_DAYS} days`);
  });

  it('a certificate of analysis goes attached', () => {
    expect(judgeOrderDocumentLine(facts({ is_coa_type: true }), user)).toMatchObject({
      disposition: 'goes_now',
      delivery: 'attachment',
    });
  });

  it('a qa document waits for a plain user and for an API key, and goes for a QA releaser', () => {
    expect(judgeOrderDocumentLine(facts({ rule: 'qa' }), user)).toMatchObject({
      disposition: 'waits_for_qa',
      qa_cause: 'pending_qa',
      behind: true,
    });
    expect(judgeOrderDocumentLine(facts({ rule: 'qa' }), key).disposition).toBe('waits_for_qa');
    const released = judgeOrderDocumentLine(facts({ rule: 'qa' }), qa);
    expect(released.disposition).toBe('goes_now');
    expect(released.text).toContain('sending it is the approval');
  });

  it('a locked document never goes, whoever asks', () => {
    for (const actor of [user, qa, key]) {
      expect(judgeOrderDocumentLine(facts({ rule: 'locked' }), actor)).toMatchObject({
        disposition: 'will_not_go',
        reason: 'locked',
      });
    }
  });

  it('a document with no rule row is treated as locked', () => {
    expect(judgeOrderDocumentLine(facts({ rule: null }), qa).reason).toBe('locked');
  });

  it('missing and expired tell QA; a stale line asks for a refresh instead', () => {
    expect(judgeOrderDocumentLine(facts({ has_document: false, rule: null }), qa)).toMatchObject({
      reason: 'missing',
      qa_cause: 'missing',
    });
    expect(judgeOrderDocumentLine(facts({ expired: true, due_date: '2026-09-30' }), qa)).toMatchObject({
      reason: 'expired',
      qa_cause: 'expired',
    });
    expect(judgeOrderDocumentLine(facts({ has_document: false, rule: null, fresh_found: true }), qa)).toMatchObject({
      reason: 'stale',
      qa_cause: null,
    });
    expect(judgeOrderDocumentLine(facts({ expired: true, fresh_found: true }), qa)).toMatchObject({
      reason: 'stale',
      qa_cause: null,
    });
  });

  it('an archived document does not go, and expiry is not what is reported for it', () => {
    expect(judgeOrderDocumentLine(facts({ document_status: 'archived', expired: true }), qa).reason).toBe('inactive');
  });

  it('a refusal stands even for a releaser, and prints the note', () => {
    const j = judgeOrderDocumentLine(facts({ rule: 'qa', release_status: 'refused', decision_note: 'Wrong revision.' }), qa);
    expect(j).toMatchObject({ disposition: 'will_not_go', reason: 'refused' });
    expect(j.text).toContain('Wrong revision.');
  });

  it('a line QA already released is not sent again by a plain user, and is not left behind', () => {
    const j = judgeOrderDocumentLine(facts({ rule: 'qa', release_status: 'released', decided_at: '2026-10-07 09:00:00' }), user);
    expect(j).toMatchObject({ disposition: 'will_not_go', reason: 'already_released', behind: false, qa_cause: null });
  });

  it('a rule loosened while the line waited is honoured', () => {
    expect(judgeOrderDocumentLine(facts({ rule: 'free', release_status: 'pending_qa' }), user).disposition).toBe('goes_now');
  });
});

describe('privateLabelAdvisory', () => {
  it('names the producer when brand owner and producer differ', () => {
    const text = privateLabelAdvisory('Harbor Pantry', 'Northfield Creamery');
    expect(text).toContain("the producer's own and names Northfield Creamery");
    expect(text).toContain('Harbor Pantry');
  });

  it('says nothing when either party is unknown, or they are the same', () => {
    expect(privateLabelAdvisory(null, 'Northfield Creamery')).toBeNull();
    expect(privateLabelAdvisory('Harbor Pantry', '')).toBeNull();
    expect(privateLabelAdvisory('Northfield Creamery', ' northfield  creamery ')).toBeNull();
  });
});
