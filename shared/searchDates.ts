/**
 * Date reading for coverage-aware search — the query side and the stored side.
 *
 * WHY THE TWO SIDES ARE NOT READ THE SAME WAY. A person typing "9/2" into a
 * search box can see what we understood ("read as September 2") and correct it
 * on the next keystroke, so the query side takes the US month/day reading and
 * SAYS so. A date stored on a document cannot be asked: "02/07/2026" on a COA is
 * February 7 or July 2, and picking one silently is exactly how a certificate
 * for the wrong production day gets sent to a customer. So the stored side
 * returns BOTH readings, and the matcher refuses to call an ambiguous value a
 * verified match — it says the value could not be verified instead.
 *
 * One narrowing is allowed on the stored side, and it is evidence rather than a
 * guess: if the same document writes another date in the same shape whose day
 * is unmistakable ("03/17/26" can only be month/day), that document's order is
 * known. `inferDocumentDateOrder` does that, and the reason names it.
 *
 * Pure, no imports. Shared by the Workers functions and the frontend.
 */

export type DateOrder = 'mdy' | 'dmy';

/** A single calendar day, ISO `YYYY-MM-DD`. */
export type IsoDate = string;

export type StoredDateReading =
  /** Exactly one reading is possible. */
  | { kind: 'exact'; iso: IsoDate; raw: string; order?: DateOrder }
  /** Two readings are possible (day and month both ≤ 12 and different). */
  | { kind: 'ambiguous'; readings: [IsoDate, IsoDate]; raw: string; mdy: IsoDate; dmy: IsoDate };

export type QueryDate =
  | { kind: 'day'; iso: IsoDate; raw: string; note: string | null }
  /** A month/day with no year ("9/2", "Jul 31"): matches that day in any year. */
  | { kind: 'month_day'; month: number; day: number; raw: string; note: string | null };

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December',
];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const MONTH_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function expandYear(y: string): number {
  const n = parseInt(y, 10);
  if (y.length === 4) return n;
  // Two-digit years: documents in this system are from this century.
  return 2000 + n;
}

export function isValidYmd(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return false;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= dim;
}

function iso(y: number, m: number, d: number): IsoDate {
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** "2026-07-31" → "Jul 31, 2026" — the one human rendering used in reasons. */
export function formatIsoHuman(isoDate: IsoDate): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return isoDate;
  return `${MONTH_SHORT[parseInt(m[2], 10) - 1]} ${parseInt(m[3], 10)}, ${m[1]}`;
}

export function formatMonthDay(month: number, day: number): string {
  return `${MONTH_NAMES[month - 1]} ${day}`;
}

export function formatQueryDate(q: QueryDate): string {
  return q.kind === 'day' ? formatIsoHuman(q.iso) : `${formatMonthDay(q.month, q.day)} (any year)`;
}

/** Whole days between two ISO dates (b - a). */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  const pa = Date.parse(`${a}T00:00:00Z`);
  const pb = Date.parse(`${b}T00:00:00Z`);
  return Math.round((pb - pa) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Pattern table. Order matters: a longer, more specific shape must be tried
// before a shorter one that would match a piece of it.
// ---------------------------------------------------------------------------

interface Hit {
  index: number;
  length: number;
  raw: string;
  /** Resolved against the reading rules of the caller. */
  parts:
    | { shape: 'ymd'; y: number; a: number; b: number }
    | { shape: 'numeric'; a: number; b: number; y: number | null }
    | { shape: 'named'; m: number; d: number; y: number | null };
}

const PATTERNS: Array<{ re: RegExp; build: (m: RegExpExecArray) => Hit['parts'] | null }> = [
  // 2026-07-31, 2026/07/31, 2026.07.31
  {
    re: /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g,
    build: (m) => ({ shape: 'ymd', y: parseInt(m[1], 10), a: parseInt(m[2], 10), b: parseInt(m[3], 10) }),
  },
  // 31-Jul-2026, 31 Jul 2026, 31JUL2026, 31-July-26
  {
    re: new RegExp(`\\b(\\d{1,2})[-\\s.]?(${MONTH_ALT})\\.?[-\\s.,]*(\\d{4}|\\d{2})(?![\\d])`, 'gi'),
    build: (m) => ({ shape: 'named', d: parseInt(m[1], 10), m: MONTHS[m[2].toLowerCase()], y: expandYear(m[3]) }),
  },
  // Jul 31 2026, July 31, 2026, Jul-31-26
  {
    re: new RegExp(`\\b(${MONTH_ALT})\\.?[-\\s]*(\\d{1,2})(?:st|nd|rd|th)?[-\\s,]+(\\d{4}|\\d{2})(?![\\d])`, 'gi'),
    build: (m) => ({ shape: 'named', m: MONTHS[m[1].toLowerCase()], d: parseInt(m[2], 10), y: expandYear(m[3]) }),
  },
  // 7/31/2026, 07-31-2026, 7.31.26
  {
    re: /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?![\d/.-]\d)/g,
    build: (m) => ({ shape: 'numeric', a: parseInt(m[1], 10), b: parseInt(m[2], 10), y: expandYear(m[3]) }),
  },
];

/** Year-less shapes, only honoured on the QUERY side and only when asked. */
const YEARLESS_PATTERNS: Array<{ re: RegExp; build: (m: RegExpExecArray) => Hit['parts'] | null }> = [
  {
    re: new RegExp(`\\b(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi'),
    build: (m) => ({ shape: 'named', m: MONTHS[m[1].toLowerCase()], d: parseInt(m[2], 10), y: null }),
  },
  {
    re: new RegExp(`\\b(\\d{1,2})[-\\s](${MONTH_ALT})\\b`, 'gi'),
    build: (m) => ({ shape: 'named', d: parseInt(m[1], 10), m: MONTHS[m[2].toLowerCase()], y: null }),
  },
  {
    re: /(?<![\d/.-])(\d{1,2})\/(\d{1,2})(?![\d/])/g,
    build: (m) => ({ shape: 'numeric', a: parseInt(m[1], 10), b: parseInt(m[2], 10), y: null }),
  },
];

function scan(
  text: string,
  patterns: typeof PATTERNS,
  taken: Array<[number, number]>,
): Hit[] {
  const hits: Hit[] = [];
  for (const p of patterns) {
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (taken.some(([s, e]) => start < e && end > s)) continue;
      const parts = p.build(m);
      if (!parts) continue;
      taken.push([start, end]);
      hits.push({ index: start, length: m[0].length, raw: m[0], parts });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

/**
 * Resolve a hit into the stored-side reading. `order` is a document-level
 * order learned from the document's own unambiguous dates, if any.
 */
function resolveStored(hit: Hit, order: DateOrder | null): StoredDateReading | null {
  const p = hit.parts;
  if (p.shape === 'named') {
    if (p.y === null || !isValidYmd(p.y, p.m, p.d)) return null;
    return { kind: 'exact', iso: iso(p.y, p.m, p.d), raw: hit.raw };
  }
  if (p.shape === 'ymd') {
    // ISO order is the standard reading. A middle part > 12 can only be a day
    // ("2026-25-04" is on prod), which leaves exactly one legal reading.
    if (isValidYmd(p.y, p.a, p.b)) return { kind: 'exact', iso: iso(p.y, p.a, p.b), raw: hit.raw };
    if (p.a > 12 && isValidYmd(p.y, p.b, p.a)) return { kind: 'exact', iso: iso(p.y, p.b, p.a), raw: hit.raw };
    return null;
  }
  const y = p.y;
  if (y === null) return null;
  const mdyOk = isValidYmd(y, p.a, p.b);
  const dmyOk = isValidYmd(y, p.b, p.a);
  if (mdyOk && dmyOk && p.a !== p.b) {
    if (order === 'mdy') return { kind: 'exact', iso: iso(y, p.a, p.b), raw: hit.raw, order };
    if (order === 'dmy') return { kind: 'exact', iso: iso(y, p.b, p.a), raw: hit.raw, order };
    const mdy = iso(y, p.a, p.b);
    const dmy = iso(y, p.b, p.a);
    return { kind: 'ambiguous', readings: [mdy, dmy], raw: hit.raw, mdy, dmy };
  }
  if (mdyOk) return { kind: 'exact', iso: iso(y, p.a, p.b), raw: hit.raw, order: p.a === p.b ? undefined : 'mdy' };
  if (dmyOk) return { kind: 'exact', iso: iso(y, p.b, p.a), raw: hit.raw, order: 'dmy' };
  return null;
}

/**
 * Every date a stored value holds. A field value can hold several
 * ("2026-03-17, 2026-02-20" — a multi-lot certificate collapsed into one
 * record), and noise around a date ("EXP 07/24/26LO") is tolerated.
 */
export function readStoredDates(value: unknown, order: DateOrder | null = null): StoredDateReading[] {
  if (value == null) return [];
  const text = String(value);
  if (!text.trim()) return [];
  const hits = scan(text, PATTERNS, []);
  const out: StoredDateReading[] = [];
  for (const h of hits) {
    const r = resolveStored(h, order);
    if (r) out.push(r);
  }
  return out;
}

/**
 * Every date written in a longer text, with WHERE it is. Same reading rules as
 * `readStoredDates`; shared/rowScopedText.ts uses the positions to blank one
 * lot row's dates out of the text another row is searched on.
 */
export function findStoredDateSpans(
  text: string,
  order: DateOrder | null = null,
): Array<{ index: number; length: number; reading: StoredDateReading }> {
  if (!text) return [];
  const out: Array<{ index: number; length: number; reading: StoredDateReading }> = [];
  for (const h of scan(text, PATTERNS, [])) {
    const r = resolveStored(h, order);
    if (r) out.push({ index: h.index, length: h.length, reading: r });
  }
  return out;
}

/**
 * The day/month order a document's own dates prove, or null. Only the
 * all-numeric d/m/y shapes can be ambiguous, so only those vote; a document
 * that votes both ways proves nothing.
 */
export function inferDocumentDateOrder(values: unknown[]): DateOrder | null {
  let mdy = false;
  let dmy = false;
  for (const v of values) {
    if (v == null) continue;
    for (const h of scan(String(v), PATTERNS, [])) {
      if (h.parts.shape !== 'numeric' || h.parts.y === null) continue;
      const { a, b, y } = h.parts;
      if (a === b) continue;
      if (a > 12 && isValidYmd(y, b, a)) dmy = true;
      else if (b > 12 && isValidYmd(y, a, b)) mdy = true;
    }
  }
  if (mdy && !dmy) return 'mdy';
  if (dmy && !mdy) return 'dmy';
  return null;
}

export interface QueryDateHit {
  date: QueryDate;
  index: number;
  length: number;
}

/**
 * Dates in a search query. `allowYearless` admits "9/2" and "Jul 31"; callers
 * pass it only when the phrase carries a date ROLE ("produced 9/2"), because a
 * bare "5/8" in a search box is as likely a fraction as a day.
 */
export function findQueryDates(text: string, opts: { allowYearless?: (index: number) => boolean } = {}): QueryDateHit[] {
  const taken: Array<[number, number]> = [];
  const hits = scan(text, PATTERNS, taken);
  const yearless = opts.allowYearless ? scan(text, YEARLESS_PATTERNS, taken) : [];
  const out: QueryDateHit[] = [];
  for (const h of [...hits, ...yearless].sort((a, b) => a.index - b.index)) {
    const p = h.parts;
    let date: QueryDate | null = null;
    if (p.shape === 'named') {
      if (p.y === null) {
        if (opts.allowYearless?.(h.index) && isValidYmd(2024, p.m, p.d)) {
          date = { kind: 'month_day', month: p.m, day: p.d, raw: h.raw, note: 'No year given — matches that day in any year.' };
        }
      } else if (isValidYmd(p.y, p.m, p.d)) {
        date = { kind: 'day', iso: iso(p.y, p.m, p.d), raw: h.raw, note: null };
      }
    } else if (p.shape === 'ymd') {
      if (isValidYmd(p.y, p.a, p.b)) date = { kind: 'day', iso: iso(p.y, p.a, p.b), raw: h.raw, note: null };
    } else if (p.y === null) {
      if (opts.allowYearless?.(h.index)) {
        if (isValidYmd(2024, p.a, p.b)) {
          date = {
            kind: 'month_day', month: p.a, day: p.b, raw: h.raw,
            note: `Read as month/day (${formatMonthDay(p.a, p.b)}), any year.`,
          };
        } else if (isValidYmd(2024, p.b, p.a)) {
          date = { kind: 'month_day', month: p.b, day: p.a, raw: h.raw, note: `Read as day/month (${formatMonthDay(p.b, p.a)}), any year.` };
        }
      }
    } else {
      const y = p.y;
      if (isValidYmd(y, p.a, p.b)) {
        const ambiguous = p.a !== p.b && p.b <= 12;
        date = {
          kind: 'day', iso: iso(y, p.a, p.b), raw: h.raw,
          note: ambiguous ? `Read as month/day (${formatIsoHuman(iso(y, p.a, p.b))}).` : null,
        };
      } else if (isValidYmd(y, p.b, p.a)) {
        date = { kind: 'day', iso: iso(y, p.b, p.a), raw: h.raw, note: `Read as day/month (${formatIsoHuman(iso(y, p.b, p.a))}).` };
      }
    }
    if (date) out.push({ date, index: h.index, length: h.length });
  }
  return out;
}

/** Parse one value the LLM (or an API caller) handed us as a date. */
export function parseQueryDateValue(value: string): QueryDate | null {
  const hits = findQueryDates(value);
  return hits.length === 1 ? hits[0].date : null;
}
