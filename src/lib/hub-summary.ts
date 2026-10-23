// The Tuft Life hub's mini dashboard (tuftlife.com): a few good-news cards about the support desk.
// The hub's Worker calls GET /api/hub-summary over a service binding with a bearer token.
// Everything here is pure (no D1) so the rules can be tested: auth, store-time weeks and months,
// and which cards and comparisons are shown — only true wins, never a "down" trend, never a zero.

const TZ = "America/New_York";
const DAY = 86400_000;

export const HUB_APP = "help";
export const HUB_BASE_URL = "https://help.tuftlife.com";

export type HubUnit = "count" | "usd" | "percent" | "hours" | "minutes";
export interface HubCard {
  id: string;
  label: string;
  value: number;
  unit: HubUnit;
  detail?: string;
  trend?: "up" | "flat";
  href?: string;
}

// ---------- Store time (Philadelphia) ----------

/** Midnight at the start of a calendar day in store time, as epoch ms — EDT or EST as the date has it.
 *  Clocks change at 2am, so midnight always exists exactly once. Days overflow like Date.UTC (d = 0 is the day before the 1st). */
export function midnightNY(y: number, m: number, d: number): number {
  const edt = Date.UTC(y, m - 1, d, 4); // midnight EDT
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(new Date(edt)));
  return hour === 0 ? edt : edt + 3600_000; // EST: an hour later
}

/** Midnight on the 1st of a month in store time. */
export const monthStartNY = (y: number, m: number) => midnightNY(y, m, 1);

/** The store-time calendar date (and weekday, 0 = Sunday) of an instant. */
export function dateNY(ms: number): { y: number; m: number; d: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "numeric", day: "numeric", weekday: "short" }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { y: Number(get("year")), m: Number(get("month")), d: Number(get("day")), weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")) };
}

export interface HubPeriods {
  now: number;
  weekStart: number; // Monday 00:00 ET
  prevWeekStart: number;
  prevWeekUntil: number; // the same stretch of last week
  monthStart: number; // the 1st, 00:00 ET
  prevMonthStart: number;
  prevMonthUntil: number; // the same stretch of last month (capped at its end)
}

/** This week (since Monday) and this month (since the 1st) in store time, each with last period "at this point". */
export function hubPeriods(now: number): HubPeriods {
  const { y, m, d, weekday } = dateNY(now);
  const back = (weekday + 6) % 7; // days since Monday
  const weekStart = midnightNY(y, m, d - back);
  const prevWeekStart = midnightNY(y, m, d - back - 7); // 167 or 169 hours earlier across a clock change
  const monthStart = monthStartNY(y, m);
  const prevMonthStart = m === 1 ? monthStartNY(y - 1, 12) : monthStartNY(y, m - 1);
  return {
    now,
    weekStart,
    prevWeekStart,
    prevWeekUntil: Math.min(weekStart, prevWeekStart + (now - weekStart)),
    monthStart,
    prevMonthStart,
    prevMonthUntil: Math.min(monthStart, prevMonthStart + (now - monthStart)),
  };
}

// ---------- Auth ----------

/** Constant-time string equality: both sides are hashed first, so neither length nor content leaks through timing. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const ua = new Uint8Array(x);
  const ub = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
}

/** 503 when the hub token isn't set on this Worker, 401 for a missing or wrong bearer, 200 when it matches. */
export async function hubAuthStatus(configured: string | undefined, authorization: string | undefined | null): Promise<200 | 401 | 503> {
  const token = configured?.trim();
  if (!token) return 503;
  const match = /^Bearer\s+(.+)$/i.exec(authorization?.trim() ?? "");
  if (!match) return 401;
  return (await safeEqual(match[1].trim(), token)) ? 200 : 401;
}

// ---------- Cards ----------

export interface HubStats {
  solvedWeek: number; // tickets closed this week
  solvedPrevWeek: number; // tickets closed in the same stretch of last week
  firstReplyHours: number[]; // per email ticket opened this week: hours to the first teammate reply
  chatsMonth: number; // live chats started this month that got a reply
  chatsPrevMonth: number; // the same, same stretch of last month
  labelsWeek: number; // shipping labels bought this week (one per box)
}

export const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** A first-reply time is only worth a card when it's built on a few tickets and is a genuine win. */
export const FIRST_REPLY_MIN_TICKETS = 3;
export const FIRST_REPLY_MAX_HOURS = 24;

/** "Up 18% on last week at this point" when ahead, "Level with…" when even; nothing when behind, new, or barely moved. */
export function upOnly(cur: number, prev: number, period: "week" | "month"): Pick<HubCard, "detail" | "trend"> {
  if (prev <= 0 || cur < prev) return {};
  if (cur === prev) return { detail: `Level with last ${period} at this point`, trend: "flat" };
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (pct < 1) return {};
  return { detail: `Up ${pct}% on last ${period} at this point`, trend: "up" };
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

export function buildHubCards(s: HubStats): HubCard[] {
  const cards: HubCard[] = [];
  const href = `${HUB_BASE_URL}/dashboard`;

  if (s.solvedWeek > 0) {
    cards.push({ id: "tickets-solved-this-week", label: "Tickets solved this week", value: s.solvedWeek, unit: "count", ...upOnly(s.solvedWeek, s.solvedPrevWeek, "week"), href });
  }

  const replies = s.firstReplyHours.filter((h) => Number.isFinite(h) && h >= 0);
  const med = median(replies);
  if (med !== null && replies.length >= FIRST_REPLY_MIN_TICKETS && med <= FIRST_REPLY_MAX_HOURS) {
    const detail = `Median across ${plural(replies.length, "email")} answered`;
    const minutes = Math.round(med * 60);
    if (minutes < 60) {
      // Under a minute rounds up to 1 so the card never shows a zero
      cards.push({ id: "first-reply-this-week", label: "Typical first reply this week", value: Math.max(1, minutes), unit: "minutes", detail, href });
    } else {
      cards.push({ id: "first-reply-this-week", label: "Typical first reply this week", value: Math.round(med * 10) / 10, unit: "hours", detail, href });
    }
  }

  if (s.chatsMonth > 0) {
    cards.push({ id: "chats-answered-this-month", label: "Live chats answered this month", value: s.chatsMonth, unit: "count", ...upOnly(s.chatsMonth, s.chatsPrevMonth, "month"), href });
  }

  if (s.labelsWeek > 0) {
    cards.push({ id: "labels-this-week", label: "Shipping labels bought this week", value: s.labelsWeek, unit: "count", href: `${HUB_BASE_URL}/shipping` });
  }

  return cards.slice(0, 4);
}
