/**
 * Qwen helper + prompt builders for the Learning Interface (teach-chat).
 *
 * The teach flow drives Qwen through three phases:
 *   1. buildQuestionsPrompt — turn clustered UncertaintyIssue[] into a small set
 *      of grounded, plain-language interview questions for the SME.
 *   2. buildFollowupPrompt — given the running conversation, ask one clarifying
 *      follow-up OR signal that we know enough (DONE).
 *   3. buildSynthesisPrompt — synthesize the conversation into proposed
 *      extraction instructions + few-shot examples to write to the profile.
 *
 * `callQwenChat` reuses the exact Pages->Qwen fetch pattern from
 * functions/lib/llm.ts (OpenAI-compatible /v1/chat/completions, optional bearer
 * auth, AbortController timeout, <think> stripping). Prompt builders are pure
 * functions so they're unit-testable without a live model.
 *
 * Prompts are deliberately model-agnostic: they work on a 7B but scale to
 * bigger models. JSON output is parsed defensively (fences + <think> stripped,
 * graceful fallbacks on malformed output).
 */

import { resolveModel, noteServedModel, invalidateModelCache } from '../models';
import type { UncertaintyIssue } from './uncertainty';

export interface QwenEnv {
  QWEN_URL?: string;
  QWEN_SECRET?: string;
  [k: string]: string | undefined;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CallQwenOpts {
  /** Semantic model tag — defaults to 'best' (the reasoning-heavy path). */
  model?: 'best' | 'fast' | 'vision';
  temperature?: number;
  maxTokens?: number;
  /** Request timeout in ms. Defaults to 60s. */
  timeoutMs?: number;
}

/**
 * Low-level Qwen chat call. Returns the assistant message content with Qwen3
 * <think> blocks and markdown code fences stripped. Throws on transport errors
 * or timeouts (callers decide how to surface that to the SME).
 */
export async function callQwenChat(
  env: QwenEnv,
  messages: ChatMessage[],
  opts: CallQwenOpts = {},
): Promise<string> {
  const baseUrl = (env.QWEN_URL || 'http://127.0.0.1:9600').replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 300_000;

  const tag = opts.model ?? 'best';
  const resolution = await resolveModel(tag, env);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.QWEN_SECRET ? { Authorization: `Bearer ${env.QWEN_SECRET}` } : {}),
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: resolution.model,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 2048,
        messages,
      }),
    });
  } catch (err: unknown) {
    clearTimeout(timeout);
    invalidateModelCache(env);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Qwen request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw new Error(`Qwen server not reachable at ${baseUrl}. Is Qwen running?`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Qwen returned HTTP ${response.status}`);
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
    model?: string;
  };
  noteServedModel(tag, resolution.model, data.model);
  return stripModelArtifacts(data.choices?.[0]?.message?.content || '');
}

/** Strip Qwen3 <think>...</think> blocks and surrounding markdown fences. */
export function stripModelArtifacts(content: string): string {
  let out = content.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
  const fence = out.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fence) out = fence[1].trim();
  return out.trim();
}

/**
 * Defensive JSON parse. Strips fences/think blocks first, then tries to parse.
 * Falls back to extracting the first balanced {...} or [...] span if the model
 * wrapped the JSON in prose. Returns `null` on total failure.
 */
export function parseJsonLoose<T = unknown>(raw: string): T | null {
  const cleaned = stripModelArtifacts(raw);
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Try to locate the first balanced object/array.
    const start = cleaned.search(/[{[]/);
    if (start === -1) return null;
    const open = cleaned[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inStr) {
        if (ch === '\\') i++;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(cleaned.slice(start, i + 1)) as T;
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Prompt builders (pure)
// ---------------------------------------------------------------------------

/** Sentinel the follow-up phase emits when the interview has enough signal. */
export const DONE_SIGNAL = 'KNOW_ENOUGH';

const TEACH_PERSONA = [
  'You are an expert document-extraction coach interviewing a domain expert',
  '(SME) about how to read one supplier\'s documents of one type (e.g. a',
  'Certificate of Analysis). Your goal is to elicit the tacit rules the SME',
  'uses so the extraction model can apply them automatically.',
  '',
  'Style: warm, concise, plain language. No jargon, no model-internal terms',
  '("token", "field_mapping", "prompt"). Ground every question in concrete',
  'values you were given — quote the actual example text. Ask about ONE thing',
  'at a time. Never invent document content you were not shown.',
].join(' ');

/** Render a compact, model-friendly summary of one uncertainty issue. */
function renderIssue(issue: UncertaintyIssue, idx: number): string {
  // UncertaintyIssue shape is owned by the parallel module; we read defensively
  // so this stays robust to additive field changes there.
  const i = issue as unknown as Record<string, unknown>;
  const field = (i.field ?? i.field_name ?? 'unknown field') as string;
  const kind = (i.kind ?? i.type ?? 'ambiguity') as string;
  const desc = (i.description ?? i.summary ?? i.message ?? '') as string;
  const examples = Array.isArray(i.examples)
    ? (i.examples as unknown[])
        .slice(0, 4)
        .map((e) => {
          if (typeof e === 'string') return e;
          // UncertaintyExample is { queue_item_id, file_name, value }.
          if (e && typeof e === 'object' && 'value' in (e as object)) {
            const v = (e as { value?: unknown }).value;
            return v == null ? '(empty)' : String(v);
          }
          return JSON.stringify(e);
        })
    : Array.isArray(i.example_values)
      ? (i.example_values as unknown[]).slice(0, 4).map(String)
      : [];
  const parts = [`${idx + 1}. [${kind}] field "${field}"`];
  if (desc) parts.push(`   issue: ${desc}`);
  if (examples.length) parts.push(`   example values seen: ${examples.map((e) => `"${e}"`).join(', ')}`);
  return parts.join('\n');
}

function renderIssues(issues: UncertaintyIssue[]): string {
  if (!issues || issues.length === 0) {
    return '(no specific ambiguities were detected — ask broadly about how to read this document type)';
  }
  return issues.map((iss, i) => renderIssue(iss, i)).join('\n');
}

/**
 * Read-only "already-known" context fed into every teach prompt so the model
 * doesn't re-ask / re-teach what the system already has. Both pieces optional;
 * when both are empty the section is omitted entirely.
 */
export interface TeachBackground {
  /** Org-level extraction context (tenants.extraction_context), or ''. */
  tenantContext?: string;
  /** Existing instructions for this exact (supplier, doctype), or ''. */
  existingInstructions?: string;
}

/**
 * Render the shared "ALREADY-ESTABLISHED CONTEXT" grounding block. Returns ''
 * when both pieces are empty/whitespace so callers can omit it cleanly. Each
 * sub-block is omitted independently when its piece is empty.
 */
function renderKnownContext(background?: TeachBackground): string {
  const tenantContext = (background?.tenantContext ?? '').trim();
  const existingInstructions = (background?.existingInstructions ?? '').trim();
  if (!tenantContext && !existingInstructions) return '';

  const parts = [
    'ALREADY-ESTABLISHED CONTEXT — this is already known and applied to every',
    'extraction. Do NOT ask the SME about anything covered here, and do NOT',
    'propose instructions that merely restate it. Only surface what is NEW or',
    "specific to THIS supplier's documents beyond the following.",
  ];
  if (tenantContext) {
    parts.push('', '[Organization context]', tenantContext);
  }
  if (existingInstructions) {
    parts.push('', '[Existing instructions for this supplier + document type]', existingInstructions);
  }
  return parts.join('\n');
}

function renderDocExamples(docExamples?: Array<{ text?: string; label?: string }>): string {
  if (!docExamples || docExamples.length === 0) return '';
  const blocks = docExamples
    .slice(0, 3)
    .map((d, i) => `Document sample ${i + 1}${d.label ? ` (${d.label})` : ''}:\n${(d.text || '').slice(0, 800)}`)
    .join('\n\n');
  return `\n\nFor context, here are excerpts from real documents of this type:\n${blocks}`;
}

/**
 * Phase 1 — turn clustered uncertainty issues into a small set (1-4) of
 * grounded, open-ended interview questions. Returns a {system, user} pair the
 * caller feeds to callQwenChat. The model is asked to reply with the questions
 * woven into a single, friendly opening message (not a JSON list) so the SME
 * sees a natural conversation, not a form.
 */
export function buildQuestionsPrompt(
  issues: UncertaintyIssue[],
  docExamples?: Array<{ text?: string; label?: string }>,
  background?: TeachBackground,
): ChatMessage[] {
  const known = renderKnownContext(background);
  const user = [
    ...(known ? [known, ''] : []),
    'I have analyzed this supplier\'s documents and found the following',
    'recurring ambiguities the extraction model struggles with:',
    '',
    renderIssues(issues),
    renderDocExamples(docExamples),
    '',
    'Write ONE short opening message to the SME (2-5 sentences) that:',
    '- briefly explains we want to learn how to read this supplier\'s documents,',
    '- asks about the MOST important 1-3 ambiguities above, grounded in the real',
    '  example values (quote them),',
    '- invites a prose answer.',
    'Skip any issue already answered by the established context above; only ask',
    'about genuine remaining ambiguities.',
    'Do NOT number the questions like a form. Do NOT output JSON. Plain text only.',
    '/no_think',
  ].join('\n');

  return [
    { role: 'system', content: TEACH_PERSONA },
    { role: 'user', content: user },
  ];
}

/** A conversation turn as stored in teach_messages, normalized for the model. */
export interface ConversationTurn {
  role: 'ai' | 'sme' | 'system';
  content: string;
}

/**
 * Transcript capping bounds. Teach sessions re-send the WHOLE conversation to
 * the model every turn, so without limits a verbose SME (paste walls) or a long
 * chat grows the prompt unbounded — slow, and timeout-prone on the 7B. We cap
 * both axes here in the single chokepoint both prompt builders share:
 *   - MAX_TURN_CHARS bounds any one message fed to the model (per-turn).
 *   - MAX_TURNS_WINDOW bounds how many messages are rendered, keeping the AI
 *     opening (it grounds the issues) + the most-recent turns, and noting the
 *     gap with one synthetic line so the model knows context was elided rather
 *     than silently dropping the SME's teaching answers.
 */
const MAX_TURN_CHARS = 2000;
const MAX_TURNS_WINDOW = 30;

/** Truncate a single message's content to the per-turn cap, marking the cut. */
function capTurnContent(content: string): string {
  if (content.length <= MAX_TURN_CHARS) return content;
  return content.slice(0, MAX_TURN_CHARS) + ' …[truncated]';
}

/** Render one (already role-filtered) turn in the model-facing format. */
function renderTurn(t: ConversationTurn): string {
  return `${t.role === 'ai' ? 'COACH' : 'SME'}: ${capTurnContent(t.content)}`;
}

/**
 * Render the conversation for the model, bounded on both axes (see
 * MAX_TURN_CHARS / MAX_TURNS_WINDOW). Exported so the capping can be unit-tested
 * directly; signature unchanged.
 */
export function renderConversation(conversation: ConversationTurn[]): string {
  const turns = conversation.filter((t) => t.role !== 'system');

  if (turns.length <= MAX_TURNS_WINDOW) {
    return turns.map(renderTurn).join('\n\n');
  }

  // Keep the first turn (AI opening) + the most-recent (window - 1) turns,
  // dropping the middle and noting how many were omitted.
  const recent = turns.slice(turns.length - (MAX_TURNS_WINDOW - 1));
  const omitted = turns.length - 1 - recent.length;
  const parts = [
    renderTurn(turns[0]),
    `[… ${omitted} earlier turns omitted to keep this chat within budget …]`,
    ...recent.map(renderTurn),
  ];
  return parts.join('\n\n');
}

/**
 * Phase 2 — decide whether to ask a clarifying follow-up or that we know
 * enough. Returns a {system,user} pair. The model is instructed to reply with
 * EITHER the literal token KNOW_ENOUGH (when the SME's answers cover the open
 * issues) OR a single short follow-up question. The endpoint detects the token.
 */
export function buildFollowupPrompt(
  conversation: ConversationTurn[],
  issues: UncertaintyIssue[],
  background?: TeachBackground,
): ChatMessage[] {
  const known = renderKnownContext(background);
  const user = [
    ...(known ? [known, ''] : []),
    'Here is the interview so far:',
    '',
    renderConversation(conversation),
    '',
    'The ambiguities we set out to resolve were:',
    renderIssues(issues),
    '',
    'Decide: do the SME\'s answers give us enough to write clear extraction',
    'rules for ALL the ambiguities above?',
    `- If YES, reply with exactly this token and nothing else: ${DONE_SIGNAL}`,
    '- If NO, reply with ONE short, grounded follow-up question (plain text)',
    '  targeting the biggest remaining gap. Do not repeat earlier questions.',
    'Do not output JSON. Do not explain your choice.',
    '/no_think',
  ].join('\n');

  return [
    { role: 'system', content: TEACH_PERSONA },
    { role: 'user', content: user },
  ];
}

/** The synthesized proposal the SME reviews before it's written to the profile. */
export interface SynthesizedProposal {
  instructions: string;
  examples: Array<{ field: string; value: string; note: string }>;
  summary: string;
}

/**
 * Phase 3 — synthesize the conversation into proposed extraction instructions +
 * few-shot examples. Returns a {system,user} pair instructing the model to emit
 * a strict JSON object: { instructions, examples:[{field,value,note}], summary }.
 * Use `parseSynthesis` on the raw response to get a SynthesizedProposal.
 */
export function buildSynthesisPrompt(
  conversation: ConversationTurn[],
  issues: UncertaintyIssue[],
  background?: TeachBackground,
): ChatMessage[] {
  const system = [
    TEACH_PERSONA,
    '',
    'You are now SYNTHESIZING the interview into machine-usable extraction',
    'guidance. Output STRICT JSON only — no prose, no markdown fences.',
  ].join('\n');

  const known = renderKnownContext(background);
  const user = [
    ...(known ? [known, ''] : []),
    'Interview transcript:',
    '',
    renderConversation(conversation),
    '',
    'Ambiguities this should resolve:',
    renderIssues(issues),
    '',
    'Produce a JSON object with exactly these keys:',
    '{',
    '  "instructions": string,   // plain-English extraction rules, written as',
    '                            // direct guidance to a document-reading model.',
    '                            // Incorporate everything the SME taught. Use',
    '                            // the canonical snake_case field names where',
    '                            // known (supplier_name, lot_number, etc.).',
    '  "examples": [             // concrete few-shot examples distilled from the',
    '                            // conversation (may be empty if none are clear)',
    '    { "field": string, "value": string, "note": string }',
    '  ],',
    '  "summary": string         // one-sentence summary of what was learned',
    '}',
    'Do not restate the established context; output only the supplier-specific',
    'deltas, and do not duplicate instructions already present above.',
    'Return ONLY that JSON object.',
    '/no_think',
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Parse a raw synthesis response into a SynthesizedProposal, defensively. */
export function parseSynthesis(raw: string): SynthesizedProposal {
  const parsed = parseJsonLoose<Record<string, unknown>>(raw);
  if (!parsed || typeof parsed !== 'object') {
    return { instructions: '', examples: [], summary: '' };
  }
  const instructions = typeof parsed.instructions === 'string' ? parsed.instructions : '';
  const summary = typeof parsed.summary === 'string' ? parsed.summary : '';
  const examples = Array.isArray(parsed.examples)
    ? (parsed.examples as unknown[])
        .map((e) => {
          if (!e || typeof e !== 'object') return null;
          const o = e as Record<string, unknown>;
          return {
            field: typeof o.field === 'string' ? o.field : '',
            value: o.value == null ? '' : String(o.value),
            note: typeof o.note === 'string' ? o.note : '',
          };
        })
        .filter((e): e is { field: string; value: string; note: string } => e !== null && e.field !== '')
    : [];
  return { instructions, examples, summary };
}
