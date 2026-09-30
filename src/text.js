const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

const monthIndex = (s) => MONTHS[s.slice(0, 3).toLowerCase()];
const utc = (y, m, d) => new Date(Date.UTC(y, m, d));
export const isoDate = (d) => d.toISOString().slice(0, 10);

const OWNER_POSITIVE = [
  /owner[\s-]*occup(?:ied|ier|ant)/i,
  /(?:live|lives|living|resident)[\s-]*in[\s-]*(?:landlord|owner|host)/i,
  /resident\s+(?:landlord|owner)/i,
  /(?:landlord|owner|homeowner)\s+(?:also\s+)?(?:lives|resides|is\s+living|is\s+resident)/i,
  /(?:share|sharing|live|living|lodge|lodging)\s+with\s+(?:the\s+|our\s+|my\s+)?(?:owner|landlord|homeowner|host|family|couple)/i,
  /host\s+family/i,
  /room\s+in\s+(?:a|our|my|the)\s+(?:\w+\s+)?family\s+(?:home|house)/i,
];
const OWNER_NEGATIVE = [
  /non[\s-]*owner[\s-]*occup/i,
  /no\s+live[\s-]*in\s+(?:landlord|owner)/i,
  /(?:landlord|owner)\s+(?:does\s*n[o']?t|doesn['’]t|do\s+not|is\s+not|isn['’]t|will\s+not)\s+(?:live|reside|be\s+living|be\s+resident)/i,
];
const NEGATION_BEFORE = /(?:\bnot|\bnon|\bno|\bnever|n['’]t)[\s-]*(?:an?\s+)?$/i;

// true = owner lives there, false = explicitly not, null = no signal
export function ownerOccupiedFromText(text) {
  const t = String(text ?? "");
  if (OWNER_NEGATIVE.some((re) => re.test(t))) return false;
  for (const re of OWNER_POSITIVE) {
    const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
    const g = new RegExp(re.source, flags);
    for (const m of t.matchAll(g)) {
      if (!NEGATION_BEFORE.test(t.slice(Math.max(0, m.index - 22), m.index))) return true;
    }
  }
  return null;
}

const WEEKDAY_ONLY = [
  /\bmon(?:day)?\.?\s*(?:to|-|–|—|till|until|through|thru)\s*fri(?:day)?\b/i,
  /\bsun(?:day)?\.?\s*(?:evening|night|eve|pm)?\s*(?:to|-|–|—|till|until)\s*(?:fri(?:day)?|thu(?:rsday)?)\b/i,
  /\b(?:5|five)[\s-]*day[s]?\s*(?:week|let|rental|rent|stay|tenan|basis|only)/i,
  /\b(?:5|five)[\s-]*day[s]?\s+(?:a|per)\s+week\b/i,
  /\bweek[\s-]*days?\s+only\b/i,
  /\bmid[\s-]?week\b/i,
  /\b(?:no|not)\s+weekends?\b/i,
  /\bweekends?\s+(?:not|un)\s*available\b/i,
];

export function weekdayOnlyFromText(text) {
  const t = String(text ?? "");
  return WEEKDAY_ONLY.some((re) => re.test(t));
}

// Picks the occurrence of the month (and optional day) nearest to `ref`.
function nearestOccurrence(month, day, ref) {
  let best = null;
  for (const y of [ref.getUTCFullYear() - 1, ref.getUTCFullYear(), ref.getUTCFullYear() + 1]) {
    const d = utc(y, month, day);
    if (!best || Math.abs(d - ref) < Math.abs(best - ref)) best = d;
  }
  return best;
}

function firstOnOrAfter(month, day, year, ref) {
  if (year) return utc(year, month, day);
  for (let y = ref.getUTCFullYear(); y <= ref.getUTCFullYear() + 2; y++) {
    const d = utc(y, month, day);
    if (d >= ref) return d;
  }
  return utc(ref.getUTCFullYear() + 1, month, day);
}

const endOfMonth = (y, m) => utc(y, m + 1, 0);

export function parseAvailability(text, now = new Date()) {
  const t = String(text ?? "").replace(/\s+/g, " ");
  const today = utc(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let from = null;
  let to = null;
  let immediate = false;

  const range = new RegExp(`\\b${MONTH}\\.?\\s*(\\d{4})?\\s*(?:to|until|till|through|thru|-|–|—)\\s*${MONTH}\\.?\\s*(\\d{4})?\\b`, "i").exec(t);
  if (range) {
    const sm = monthIndex(range[1]);
    const em = monthIndex(range[3]);
    const sy = range[2] ? Number(range[2]) : null;
    const ey = range[4] ? Number(range[4]) : null;
    from = sy ? utc(sy, sm, 1) : nearestOccurrence(sm, 1, today);
    let y = ey ?? from.getUTCFullYear();
    if (!ey && em < sm) y += 1;
    to = endOfMonth(y, em);
    if (to < from) to = endOfMonth(y + 1, em);
  }

  if (!from) {
    const dated = /avail\w*\s*(?:from|on|date)?\s*[:\-]?\s*(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/i.exec(t) ||
      /\bfrom\s+(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/i.exec(t);
    if (dated) {
      const y = Number(dated[3]) < 100 ? 2000 + Number(dated[3]) : Number(dated[3]);
      const d = utc(y, Number(dated[2]) - 1, Number(dated[1]));
      if (d.getUTCMonth() === Number(dated[2]) - 1) from = d;
    }
  }

  if (!from) {
    const named = new RegExp(
      `(?:avail\\w*|from|starting|starts?|commenc\\w*)\\s*(?:from\\s*)?(?:the\\s*)?(?:(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s*)?)?${MONTH}\\b\\.?\\s*(\\d{4})?`,
      "i",
    ).exec(t);
    if (named) {
      const day = named[1] ? Number(named[1]) : 1;
      from = named[3] ? utc(Number(named[3]), monthIndex(named[2]), day) : nearestOccurrence(monthIndex(named[2]), day, today);
    }
  }

  if (/avail\w*\s+(?:now|immediately|asap|straight\s*away)|immediate(?:ly)?\s+(?:avail\w*|move[\s-]*in)|move\s*in\s+(?:now|immediately|asap)|available\s+(?:right\s+)?now/i.test(t)) {
    immediate = true;
    if (!from || from > today) from = today;
  }

  if (!to) {
    const until = new RegExp(
      `(?:until|till|through|thru|ending|ends?|end\\s+of)\\s+(?:the\\s+)?(?:end\\s+of\\s+)?(?:(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s*)?)?${MONTH}\\b\\.?\\s*(\\d{4})?`,
      "i",
    ).exec(t);
    if (until) {
      const m = monthIndex(until[2]);
      const base = from ?? today;
      const first = until[3] ? Number(until[3]) : firstOnOrAfter(m, 1, null, base).getUTCFullYear();
      to = until[1] ? utc(first, m, Number(until[1])) : endOfMonth(first, m);
    }
  }

  return {
    availableFrom: from ? isoDate(from) : null,
    availableTo: to ? isoDate(to) : null,
    immediate,
    academicYear: /academic\s+year|semester|term[\s-]*time|\b2[0-9]\s*\/\s*2[0-9]\b|20\d\d\s*\/\s*20\d\d/i.test(t),
  };
}

export function analyzeText(text, now = new Date()) {
  return {
    ownerOccupied: ownerOccupiedFromText(text),
    weekdayOnly: weekdayOnlyFromText(text),
    ...parseAvailability(text, now),
  };
}

export function parsePriceMonthly(text) {
  const s = String(text ?? "");
  const m = /€\s*([\d,]+(?:\.\d+)?)/.exec(s);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  const weekly = /(?:per|a|\/)\s*(?:week|wk)\b|\bp\/?w\b|\bweekly\b/i.test(s);
  return weekly ? Math.round((n * 52) / 12) : Math.round(n);
}
