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
  | { kind: 'month_day'; month: number; day: number; raw: string; note: string | null }
  /**
   * A span of days WITH years ("April 2026", "Apr 1–15, 2026", "since Mar 1,
   * 2026", "last month"). An open end is null; both ends inclusive.
   */
  | { kind: 'range'; from: IsoDate | null; to: IsoDate | null; raw: string; note: string | null }
  /**
   * A span of month/days in ANY year ("in April", "early May", "Apr 1-15").
   * `from` after `to` wraps the year end ("Dec 15 to Jan 15"). Both inclusive.
   */
  | { kind: 'month_range'; from: MonthDay; to: MonthDay; raw: string; note: string | null };

export interface MonthDay {
  month: number;
  day: number;
}

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
  return formatQueryDateWords(q);
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
export function findQueryDates(
  text: string,
  opts: { allowYearless?: (index: number) => boolean; taken?: Array<[number, number]> } = {},
): QueryDateHit[] {
  const taken: Array<[number, number]> = [...(opts.taken ?? [])];
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

// ---------------------------------------------------------------------------
// Periods: months and ranges typed into a search ("produced in April",
// "best by early May", "Apr 1-15", "since March", "last month").
// ---------------------------------------------------------------------------

/** Days in a month; a year-less February has 29 (Feb 29 exists in some year). */
export function daysInMonth(month: number, year: number | null): number {
  return new Date(Date.UTC(year ?? 2024, month, 0)).getUTCDate();
}

function mdKey(md: MonthDay): string {
  return `${pad(md.month)}-${pad(md.day)}`;
}

/** "--04-01" — the clause encoding of a month/day in any year. */
export function monthDayValue(md: MonthDay): string {
  return `--${mdKey(md)}`;
}

/** Is `mmdd` ("04-17") inside a year-less span? A span whose start is after its end wraps the year end. */
export function inMonthDayRange(mmdd: string, from: MonthDay, to: MonthDay): boolean {
  const a = mdKey(from);
  const b = mdKey(to);
  return a <= b ? mmdd >= a && mmdd <= b : mmdd >= a || mmdd <= b;
}

function addDaysIso(isoDate: IsoDate, n: number): IsoDate {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * A span of days in words: "April 2026", "Apr 1–15, 2026", "Mar 20 – Apr 5,
 * 2026", "on or after Mar 1, 2026". Null for an unbounded span.
 */
export function describeDaySpan(from: IsoDate | null, to: IsoDate | null): string | null {
  if (from && to) {
    if (from === to) return formatIsoHuman(from);
    const [fy, fm, fd] = from.split('-').map(Number);
    const [ty, tm, td] = to.split('-').map(Number);
    if (fy === ty && fm === tm) {
      if (fd === 1 && td === daysInMonth(fm, fy)) return `${MONTH_NAMES[fm - 1]} ${fy}`;
      return `${MONTH_SHORT[fm - 1]} ${fd}–${td}, ${fy}`;
    }
    if (fy === ty) {
      if (fd === 1 && td === daysInMonth(tm, ty)) return `${MONTH_SHORT[fm - 1]} – ${MONTH_SHORT[tm - 1]} ${fy}`;
      return `${MONTH_SHORT[fm - 1]} ${fd} – ${MONTH_SHORT[tm - 1]} ${td}, ${fy}`;
    }
    return `${formatIsoHuman(from)} – ${formatIsoHuman(to)}`;
  }
  if (from) return `on or after ${formatIsoHuman(from)}`;
  if (to) return `on or before ${formatIsoHuman(to)}`;
  return null;
}

/** A year-less span in words, without the "(any year)" suffix: "April", "Apr 1–15", "Dec 15 – Jan 15". */
export function describeMonthDaySpan(from: MonthDay, to: MonthDay): string {
  if (from.month === to.month && from.day === to.day) return formatMonthDay(from.month, from.day);
  if (from.month === to.month && from.day <= to.day) {
    if (from.day === 1 && to.day === daysInMonth(to.month, null)) return MONTH_NAMES[from.month - 1];
    return `${MONTH_SHORT[from.month - 1]} ${from.day}–${to.day}`;
  }
  if (from.day === 1 && to.day === daysInMonth(to.month, null)) return `${MONTH_SHORT[from.month - 1]} – ${MONTH_SHORT[to.month - 1]}`;
  return `${MONTH_SHORT[from.month - 1]} ${from.day} – ${MONTH_SHORT[to.month - 1]} ${to.day}`;
}

/** Any query date in words: "Jul 31, 2026", "Sep 2 (any year)", "April 2026", "April (any year)". */
export function formatQueryDateWords(q: QueryDate): string {
  switch (q.kind) {
    case 'day': return formatIsoHuman(q.iso);
    case 'month_day': return `${formatMonthDay(q.month, q.day)} (any year)`;
    case 'range': return describeDaySpan(q.from, q.to) ?? q.raw;
    case 'month_range': return `${describeMonthDaySpan(q.from, q.to)} (any year)`;
  }
}

const MON = `\\b(${MONTH_ALT})\\b\\.?`;
/** A month name NOT written after a day number ("31 Jul 2026" is a day, not July). */
const MON_FREE = `(?<!\\d[-\\s.]?)${MON}`;
const DAY = `(\\d{1,2})(?:st|nd|rd|th)?`;
const YEAR = `(\\d{4})`;
const PREP = `(?:\\b(in|during)\\s+)?`;
const TO = `\\s*(?:-|–|—|\\bto\\b|\\bthrough\\b|\\bthru\\b|\\buntil\\b|\\btill\\b)\\s*`;

export interface QueryPeriodHit {
  date: QueryDate;
  index: number;
  length: number;
}

export interface PeriodOptions {
  /** Today, for "last month", "this month" and a year-less "since March". */
  now?: Date;
  /** Is a date ROLE typed just before this position ("produced", "best by")? */
  roleBefore?: (index: number) => boolean;
}

function monthOf(word: string | undefined): number | null {
  if (!word) return null;
  return MONTHS[word.toLowerCase().replace(/\.$/, '')] ?? null;
}

/**
 * Months and ranges in a search query. A period with no year matches those
 * days in ANY year ("produced in April" is every April), except an open-ended
 * one ("since March"), which has no sensible any-year meaning and is read as
 * the most recent such month — and says so.
 *
 * A month typed with no year is read only when something says it is a date:
 * a role word ("produced", "best by") or a period word typed with it ("in",
 * "during", "early", "between", "from", "since" ...). That is what keeps
 * "what may cover lot 104" from becoming a date in May, and it is the rule a
 * year-less day ("produced 9/2") already follows.
 */
export function findQueryPeriods(text: string, opts: PeriodOptions = {}): QueryPeriodHit[] {
  const now = opts.now ?? new Date();
  const nowY = now.getUTCFullYear();
  const nowM = now.getUTCMonth() + 1;
  const nowD = now.getUTCDate();
  const roleBefore = (i: number) => opts.roleBefore?.(i) ?? false;
  const taken: Array<[number, number]> = [];
  const out: QueryPeriodHit[] = [];
  const free = (s: number, e: number) => !taken.some(([a, b]) => s < b && e > a);
  const run = (re: RegExp, build: (m: RegExpExecArray, raw: string) => QueryDate | null) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const raw = m[0].replace(/\s+$/, '');
      if (!raw || !free(m.index, m.index + raw.length)) continue;
      const date = build(m, raw);
      if (!date) continue;
      taken.push([m.index, m.index + raw.length]);
      out.push({ date, index: m.index, length: raw.length });
    }
  };

  /** Two ends, each maybe with a year; one typed year serves both ends. */
  const span = (
    raw: string,
    a: { m: number; d: number; y: number | null },
    b: { m: number; d: number; y: number | null },
    endMonthTyped: boolean,
  ): QueryDate | null => {
    if (!endMonthTyped && b.d < a.d) return null;
    let ay = a.y;
    let by = b.y;
    if (ay === null && by !== null) ay = (a.m > b.m || (a.m === b.m && a.d > b.d)) ? by - 1 : by;
    if (by === null && ay !== null) by = (b.m < a.m || (b.m === a.m && b.d < a.d)) ? ay + 1 : ay;
    if (ay !== null && by !== null) {
      if (!isValidYmd(ay, a.m, a.d) || !isValidYmd(by, b.m, b.d)) return null;
      const from = iso(ay, a.m, a.d);
      const to = iso(by, b.m, b.d);
      if (from > to) return null;
      return from === to ? { kind: 'day', iso: from, raw, note: null } : { kind: 'range', from, to, raw, note: null };
    }
    if (!isValidYmd(2024, a.m, a.d) || !isValidYmd(2024, b.m, b.d)) return null;
    const from = { month: a.m, day: a.d };
    const to = { month: b.m, day: b.d };
    if (from.month === to.month && from.day === to.day) {
      return { kind: 'month_day', month: a.m, day: a.d, raw, note: 'No year given — matches that day in any year.' };
    }
    const wraps = mdKey(from) > mdKey(to);
    return {
      kind: 'month_range', from, to, raw,
      note: wraps
        ? `No year given — matches ${describeMonthDaySpan(from, to)} across any year end.`
        : 'No year given — matches those days in any year.',
    };
  };

  const monthSpan = (raw: string, m: number, y: number | null, dayFrom = 1, dayTo?: number): QueryDate => {
    const last = dayTo ?? daysInMonth(m, y);
    if (y !== null) return { kind: 'range', from: iso(y, m, dayFrom), to: iso(y, m, last), raw, note: null };
    return {
      kind: 'month_range', from: { month: m, day: dayFrom }, to: { month: m, day: last }, raw,
      note: 'No year given — matches that month in any year.',
    };
  };

  // 1. "between Apr 1 and Apr 15[, 2026]"
  run(new RegExp(`\\bbetween\\s+${MON}\\s*${DAY}(?:,?\\s+${YEAR})?\\s+and\\s+(?:${MON}\\s*)?${DAY}(?:,?\\s+${YEAR})?\\b`, 'gi'), (m, raw) => {
    const am = monthOf(m[1]);
    const bm = monthOf(m[4]) ?? am;
    if (!am || !bm) return null;
    return span(raw, { m: am, d: +m[2], y: m[3] ? +m[3] : null }, { m: bm, d: +m[5], y: m[6] ? +m[6] : null }, !!m[4]);
  });
  // 2. "[from] Apr 1-15", "April 1 to April 15, 2026", "Dec 15 to Jan 15"
  run(new RegExp(`${PREP}(?:\\b(from)\\s+)?${MON}\\s*${DAY}(?:,?\\s+${YEAR})?${TO}(?:${MON}\\s*)?${DAY}(?:,?\\s+${YEAR})?\\b(?![/.\\-]\\d)`, 'gi'), (m, raw) => {
    const am = monthOf(m[3]);
    const bm = monthOf(m[6]) ?? am;
    if (!am || !bm) return null;
    const ay = m[5] ? +m[5] : null;
    const by = m[8] ? +m[8] : null;
    if (ay === null && by === null && !m[1] && !m[2] && !roleBefore(m.index)) return null;
    return span(raw, { m: am, d: +m[4], y: ay }, { m: bm, d: +m[7], y: by }, !!m[6]);
  });
  // 3. "early May", "mid-April 2026", "late February"
  run(new RegExp(`${PREP}\\b(early|mid|late)[-\\s]+${MON}(?:,?\\s+${YEAR})?\\b(?!\\s*\\d)`, 'gi'), (m, raw) => {
    const mo = monthOf(m[3]);
    if (!mo) return null;
    const y = m[4] ? +m[4] : null;
    const part = m[2].toLowerCase();
    const [a, b] = part === 'early' ? [1, 10] : part === 'mid' ? [11, 20] : [21, daysInMonth(mo, y)];
    const d = monthSpan(raw, mo, y, a, b);
    d.note = y === null ? `No year given — "${part}" is days ${a}–${b}, in any year.` : `"${part}" is days ${a}–${b}.`;
    return d;
  });
  // 4. "since March", "after March 3", "before May", "from April 1, 2026"
  run(new RegExp(`\\b(since|after|before|from)\\s+${MON}(?:\\s*${DAY})?(?:,?\\s+${YEAR})?\\b(?![/.\\-]\\d)`, 'gi'), (m, raw) => {
    const kw = m[1].toLowerCase();
    const mo = monthOf(m[2]);
    if (!mo) return null;
    const day = m[3] ? +m[3] : null;
    let y = m[4] ? +m[4] : null;
    let note: string | null = null;
    if (y === null) {
      // An open end has no any-year meaning: the most recent such month (or day), never a future one.
      y = mo > nowM || (mo === nowM && day !== null && day > nowD) ? nowY - 1 : nowY;
      note = `No year given — read as ${day !== null ? `${formatMonthDay(mo, day)}, ${y}` : `${MONTH_NAMES[mo - 1]} ${y}`}, the most recent one.`;
    }
    if (day !== null && !isValidYmd(y, mo, day)) return null;
    let from: IsoDate | null = null;
    let to: IsoDate | null = null;
    if (kw === 'since' || kw === 'from') from = iso(y, mo, day ?? 1);
    else if (kw === 'after') from = addDaysIso(iso(y, mo, day ?? daysInMonth(mo, y)), 1);
    else to = addDaysIso(iso(y, mo, day ?? 1), -1);
    return { kind: 'range', from, to, raw, note };
  });
  // 5. "April 2026", "in Apr 2026", "4/2026"
  run(new RegExp(`${PREP}${MON_FREE},?\\s+${YEAR}\\b(?![/.\\-]\\d)`, 'gi'), (m, raw) => {
    const mo = monthOf(m[2]);
    return mo ? monthSpan(raw, mo, +m[3]) : null;
  });
  run(/(?:\b(in|during)\s+)?(?<![\d/.-])(\d{1,2})\/(\d{4})\b(?![/.-]\d)/g, (m, raw) => {
    const mo = +m[2];
    return mo >= 1 && mo <= 12 ? monthSpan(raw, mo, +m[3]) : null;
  });
  // 6. "last month", "this month"
  run(/\b(last|this)\s+month\b/gi, (m, raw) => {
    const last = m[1].toLowerCase() === 'last';
    const mo = last ? (nowM === 1 ? 12 : nowM - 1) : nowM;
    const y = last && nowM === 1 ? nowY - 1 : nowY;
    const d = monthSpan(raw, mo, y);
    d.note = `Read as ${MONTH_NAMES[mo - 1]} ${y}.`;
    return d;
  });
  // 7. A month name alone: "in April", "produced Apr" — only with "in"/"during" or a role word.
  run(new RegExp(`${PREP}${MON_FREE}(?!\\s*\\d)`, 'gi'), (m, raw) => {
    const mo = monthOf(m[2]);
    if (!mo) return null;
    if (!m[1] && !roleBefore(m.index)) return null;
    return monthSpan(raw, mo, null);
  });

  return out.sort((a, b) => a.index - b.index);
}

/**
 * A `between` clause's two values in words when they read as one period:
 * "April" / "Apr 1–15" / "Dec 15 – Jan 15" (year-less, any year) or "April
 * 2026" / "Apr 1–15, 2026" (one calendar month). Null otherwise.
 */
export function describeSpanValues(a: string, b: string): { text: string; anyYear: boolean } | null {
  const ma = /^--(\d{2})-(\d{2})$/.exec(a);
  const mb = /^--(\d{2})-(\d{2})$/.exec(b);
  if (ma && mb) {
    return { text: describeMonthDaySpan({ month: +ma[1], day: +ma[2] }, { month: +mb[1], day: +mb[2] }), anyYear: true };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(a) && /^\d{4}-\d{2}-\d{2}$/.test(b) && a.slice(0, 7) === b.slice(0, 7) && a <= b) {
    return { text: describeDaySpan(a, b) ?? a, anyYear: false };
  }
  return null;
}

/** An `after` value that is the last day of a month reads as "since" the next month's first day. */
export function sinceWords(afterValue: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(afterValue)) return null;
  const next = addDaysIso(afterValue, 1);
  return next.endsWith('-01') ? `since ${formatIsoHuman(next)}` : null;
}
