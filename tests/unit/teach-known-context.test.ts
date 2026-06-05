/**
 * Unit tests for the "don't re-teach what's already known" background section
 * threaded into the three teach prompt builders (functions/lib/teach/qwen.ts).
 *
 * The shared renderKnownContext block:
 *   - is OMITTED entirely when both tenantContext and existingInstructions are
 *     empty/undefined,
 *   - renders an "ALREADY-ESTABLISHED CONTEXT" header + a don't-re-ask /
 *     don't-restate directive + the provided text when present,
 *   - omits each sub-block independently when its piece is empty.
 *
 * Pure-function tests — no DB, no live model.
 */

import { describe, it, expect } from 'vitest';
import {
  buildQuestionsPrompt,
  buildFollowupPrompt,
  buildSynthesisPrompt,
  type ConversationTurn,
  type TeachBackground,
} from '../../functions/lib/teach/qwen';

const HEADER = 'ALREADY-ESTABLISHED CONTEXT';
const DONT_REASK = 'Do NOT ask the SME about anything covered here';
const ORG_BLOCK = '[Organization context]';
const COMBO_BLOCK = '[Existing instructions for this supplier + document type]';

const issues = [] as Parameters<typeof buildFollowupPrompt>[1];
const convo: ConversationTurn[] = [
  { role: 'ai', content: 'opening' },
  { role: 'sme', content: 'answer' },
];

const TENANT_TEXT = 'ORG_LEVEL_DAIRY_RULES_XYZ';
const COMBO_TEXT = 'SUPPLIER_COMBO_RULES_ABC';

/** Extract the user-message content from a builder's output. */
function userOf(msgs: { role: string; content: string }[]): string {
  return msgs.find((m) => m.role === 'user')!.content;
}

interface Builder {
  name: string;
  build: (bg?: TeachBackground) => { role: string; content: string }[];
}

const builders: Builder[] = [
  { name: 'buildQuestionsPrompt', build: (bg) => buildQuestionsPrompt(issues, undefined, bg) },
  { name: 'buildFollowupPrompt', build: (bg) => buildFollowupPrompt(convo, issues, bg) },
  { name: 'buildSynthesisPrompt', build: (bg) => buildSynthesisPrompt(convo, issues, bg) },
];

for (const { name, build } of builders) {
  describe(`${name} known-context section`, () => {
    it('renders header + directive + both texts when both pieces present', () => {
      const user = userOf(build({ tenantContext: TENANT_TEXT, existingInstructions: COMBO_TEXT }));
      expect(user).toContain(HEADER);
      expect(user).toContain(DONT_REASK);
      expect(user).toContain(ORG_BLOCK);
      expect(user).toContain(TENANT_TEXT);
      expect(user).toContain(COMBO_BLOCK);
      expect(user).toContain(COMBO_TEXT);
    });

    it('omits the section entirely when both pieces empty/undefined', () => {
      const undef = userOf(build(undefined));
      const empty = userOf(build({ tenantContext: '', existingInstructions: '   ' }));
      for (const user of [undef, empty]) {
        expect(user).not.toContain(HEADER);
        expect(user).not.toContain(DONT_REASK);
        expect(user).not.toContain(ORG_BLOCK);
        expect(user).not.toContain(COMBO_BLOCK);
      }
    });

    it('renders only the org sub-block when existingInstructions empty', () => {
      const user = userOf(build({ tenantContext: TENANT_TEXT, existingInstructions: '' }));
      expect(user).toContain(HEADER);
      expect(user).toContain(ORG_BLOCK);
      expect(user).toContain(TENANT_TEXT);
      expect(user).not.toContain(COMBO_BLOCK);
      expect(user).not.toContain(COMBO_TEXT);
    });

    it('renders only the combo sub-block when tenantContext empty', () => {
      const user = userOf(build({ tenantContext: '', existingInstructions: COMBO_TEXT }));
      expect(user).toContain(HEADER);
      expect(user).toContain(COMBO_BLOCK);
      expect(user).toContain(COMBO_TEXT);
      expect(user).not.toContain(ORG_BLOCK);
      expect(user).not.toContain(TENANT_TEXT);
    });

    it('places the known-context section before the issues/transcript body', () => {
      const user = userOf(build({ tenantContext: TENANT_TEXT, existingInstructions: '' }));
      // The header must precede the per-builder body marker.
      const headerIdx = user.indexOf(HEADER);
      const bodyIdx = Math.min(
        ...['I have analyzed', 'Here is the interview so far', 'Interview transcript']
          .map((m) => user.indexOf(m))
          .filter((i) => i >= 0),
      );
      expect(headerIdx).toBeGreaterThanOrEqual(0);
      expect(bodyIdx).toBeGreaterThan(headerIdx);
    });
  });
}

describe('buildSynthesisPrompt restate directive', () => {
  it('instructs the model not to restate established context when background present', () => {
    const user = userOf(buildSynthesisPrompt(convo, issues, { tenantContext: TENANT_TEXT }));
    expect(user).toContain('Do not restate the established context');
  });
});

describe('buildQuestionsPrompt skip directive', () => {
  it('tells the model to skip issues already answered by established context', () => {
    const user = userOf(buildQuestionsPrompt(issues, undefined, { tenantContext: TENANT_TEXT }));
    expect(user).toContain('Skip any issue already answered by the established context');
  });
});
