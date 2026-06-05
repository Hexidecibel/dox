/**
 * Unit tests for transcript capping in functions/lib/teach/qwen.ts.
 *
 * Teach sessions re-send the whole conversation to the model every turn, so
 * renderConversation bounds both axes:
 *   - per-message: content > MAX_TURN_CHARS (2000) is truncated + marked.
 *   - windowing:   conversations > MAX_TURNS_WINDOW (30) render the first turn
 *     (AI opening) + the most-recent turns, with one synthetic omission line.
 *
 * Pure-function tests — no DB, no live model. We also assert via
 * buildFollowupPrompt / buildSynthesisPrompt that both builders inherit the cap
 * (they share renderConversation).
 */

import { describe, it, expect } from 'vitest';
import {
  renderConversation,
  buildFollowupPrompt,
  buildSynthesisPrompt,
  type ConversationTurn,
} from '../../functions/lib/teach/qwen';

const MARKER = '…[truncated]';
const OMISSION = 'earlier turns omitted to keep this chat within budget';

describe('renderConversation transcript capping', () => {
  it('truncates a single >2000-char message and carries the marker', () => {
    const long = 'x'.repeat(5000);
    const out = renderConversation([{ role: 'sme', content: long }]);

    expect(out).toContain(MARKER);
    // Truncated body is 2000 chars; full 5000-char body must NOT survive.
    expect(out).not.toContain('x'.repeat(2001));
    expect(out).toContain('x'.repeat(2000));
    expect(out.length).toBeLessThan(long.length);
  });

  it('windows a long conversation: first + most-recent kept, middle elided', () => {
    // 50 turns: opener + 49 numbered turns.
    const turns: ConversationTurn[] = [
      { role: 'ai', content: 'OPENING_GROUNDING_QUESTION' },
    ];
    for (let i = 1; i <= 49; i++) {
      turns.push({ role: i % 2 ? 'sme' : 'ai', content: `TURN_${i}` });
    }

    const out = renderConversation(turns);

    // First turn kept.
    expect(out).toContain('OPENING_GROUNDING_QUESTION');
    // Most-recent turns kept (window is 30 → last 29 turns).
    expect(out).toContain('TURN_49');
    expect(out).toContain('TURN_48');
    // The omission marker is present, with the omitted count.
    expect(out).toContain(OMISSION);
    // 50 turns − 1 opener − 29 recent = 20 omitted.
    expect(out).toContain('20 earlier turns omitted');
  });

  it('elides the actual middle turns (not just adds a marker)', () => {
    const turns: ConversationTurn[] = [{ role: 'ai', content: 'OPENING' }];
    for (let i = 1; i <= 49; i++) {
      turns.push({ role: 'sme', content: `MID_${i}` });
    }
    const out = renderConversation(turns);
    // Early middle turn dropped.
    expect(out).not.toContain('MID_1');
    expect(out).not.toContain('MID_5');
    // Recent retained.
    expect(out).toContain('MID_49');
  });

  it('renders a short conversation in full with no markers', () => {
    const turns: ConversationTurn[] = [
      { role: 'ai', content: 'What is the lot number format?' },
      { role: 'sme', content: 'It is always LOT- followed by 6 digits.' },
      { role: 'ai', content: 'Thanks, got it.' },
    ];
    const out = renderConversation(turns);

    expect(out).not.toContain(MARKER);
    expect(out).not.toContain(OMISSION);
    expect(out).toContain('COACH: What is the lot number format?');
    expect(out).toContain('SME: It is always LOT- followed by 6 digits.');
  });

  it('keeps existing role labels and drops system turns', () => {
    const out = renderConversation([
      { role: 'system', content: 'SECRET_SYSTEM' },
      { role: 'ai', content: 'hi' },
      { role: 'sme', content: 'hello' },
    ]);
    expect(out).not.toContain('SECRET_SYSTEM');
    expect(out).toContain('COACH: hi');
    expect(out).toContain('SME: hello');
  });

  it('renders exactly at the window boundary without omission', () => {
    const turns: ConversationTurn[] = [];
    for (let i = 0; i < 30; i++) {
      turns.push({ role: i % 2 ? 'sme' : 'ai', content: `B_${i}` });
    }
    const out = renderConversation(turns);
    expect(out).not.toContain(OMISSION);
    expect(out).toContain('B_0');
    expect(out).toContain('B_29');
  });
});

describe('prompt builders inherit the cap', () => {
  const issues = [] as Parameters<typeof buildFollowupPrompt>[1];

  it('buildFollowupPrompt truncates long turns', () => {
    const long = 'y'.repeat(5000);
    const msgs = buildFollowupPrompt([{ role: 'sme', content: long }], issues);
    const user = msgs.find((m) => m.role === 'user')!.content;
    expect(user).toContain(MARKER);
    expect(user).not.toContain('y'.repeat(2001));
  });

  it('buildSynthesisPrompt windows long conversations', () => {
    const turns: ConversationTurn[] = [{ role: 'ai', content: 'OPENER' }];
    for (let i = 1; i <= 49; i++) {
      turns.push({ role: 'sme', content: `S_${i}` });
    }
    const msgs = buildSynthesisPrompt(turns, issues);
    const user = msgs.find((m) => m.role === 'user')!.content;
    expect(user).toContain(OMISSION);
    expect(user).toContain('OPENER');
    expect(user).toContain('S_49');
    // S_5 is in the elided middle (retained window is the last 29: S_21..S_49).
    expect(user).not.toContain('SME: S_5');
  });
});
