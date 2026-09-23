import { DEFAULT_SETTINGS, LEAVE_RULES } from "./constants.js";

export function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-");
}

export async function uniqueEmployeeId(baseSlug, Employee) {
  let id = baseSlug;
  let n = 2;
  while (await Employee.exists({ _id: id })) {
    id = `${baseSlug}-${n}`;
    n += 1;
  }
  return id;
}

export async function uniqueEmail(name, Employee) {
  const parts = name.toLowerCase().trim().split(/\s+/);
  const base = parts.length > 1 ? `${parts[0]}.${parts[parts.length - 1]}` : parts[0];
  const clean = base.replace(/[^a-z0-9.]/g, "");
  let email = `${clean}@auriginmedia.com`;
  let n = 2;
  while (await Employee.exists({ email })) {
    email = `${clean}${n}@auriginmedia.com`;
    n += 1;
  }
  return email;
}

/**
 * Formats a Date as YYYY-MM-DD in the *local* timezone.
 *
 * Deliberately not `toISOString().slice(0, 10)`: that converts to UTC
 * first, so at any local time behind UTC midnight (e.g. before 05:30 in
 * IST) it reports the previous day — which would stamp an early-morning
 * check-in onto yesterday and shift month boundaries by a day.
 */
export function toLocalISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function todayISO() {
  return toLocalISO(new Date());
}

export function daysBetweenInclusive(startIso, endIso) {
  const start = new Date(startIso + "T00:00:00");
  const end = new Date(endIso + "T00:00:00");
  return Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1;
}

export function nowTime() {
  return new Date().toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true });
}

/** Minutes past local midnight — the comparable form of `nowTime()`. */
export function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}
// --- Leave balances (Handbook §6.3–6.8) ------------------------------------
// Accrued types are earned monthly, not granted as a yearly lump: a joiner
// is credited for the month they join (their first month counts in full),
// and accrual restarts each leave year on 1 April. Fixed allowances
// (optional holiday, marriage, paternity, LWP) are available in full from
// the start of the year.
//
// Nothing is stored: `used` is the approved leave that starts inside the
// leave year, so balances reset on 1 April without a scheduled job, and
// earned leave carries forward by replaying the earlier years.

/** ISO date of the 1 April that opens the leave year containing `iso`. */
export function leaveYearStart(iso, settings = DEFAULT_SETTINGS) {
  const startMonth = settings.leaveYearStartMonth;
  const d = new Date(iso + "T00:00:00");
  const year = d.getMonth() + 1 >= startMonth ? d.getFullYear() : d.getFullYear() - 1;
  return `${year}-${String(startMonth).padStart(2, "0")}-01`;
}

/** The leave-year start one year after `yearStart`. */
function nextLeaveYear(yearStart) {
  return `${Number(yearStart.slice(0, 4)) + 1}${yearStart.slice(4)}`;
}

/** The last day before `nextYearStart`. */
function dayBefore(iso) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() - 1);
  return toLocalISO(d);
}

/**
 * Months of accrual an employee has banked in the current leave year: from
 * whichever is later of their joining date and the leave-year start, up to
 * `asOf`, counting the starting month itself. Clamped to 1..12.
 */
export function accrualMonths(dateOfJoining, asOf = todayISO(), settings = DEFAULT_SETTINGS) {
  const yearStart = leaveYearStart(asOf, settings);
  const from = dateOfJoining > yearStart ? dateOfJoining : yearStart;
  if (from > asOf) return 0;
  const a = new Date(from + "T00:00:00");
  const b = new Date(asOf + "T00:00:00");
  const months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) + 1;
  return Math.max(0, Math.min(12, months));
}

/** Rounds to one decimal so half-day accruals stay exact and display cleanly. */
function round1(n) {
  return Math.round(n * 10) / 10;
}

/** Approved days of `type` whose leave starts within [from, to]. */
function usedBetween(requests, type, from, to) {
  return requests
    .filter((r) => r.type === type && r.status === "Approved" && r.startDate >= from && r.startDate <= to)
    .reduce((sum, r) => sum + r.days, 0);
}

/**
 * Earned leave brought into the leave year starting `yearStart` (§6.5):
 * each earlier year's unused balance, up to 10 days, rolls into the next,
 * and the running balance never exceeds 30.
 */
function earnedCarriedInto(employee, requests, yearStart, settings) {
  const rule = settings.leaveAccrual.earned;
  const { carryForward, maxBalance } = LEAVE_RULES.earned;
  let year = leaveYearStart(employee.dateOfJoining, settings);
  let carried = 0;
  while (year < yearStart) {
    const lastDay = dayBefore(nextLeaveYear(year));
    const accrued = Math.min(rule.perMonth * accrualMonths(employee.dateOfJoining, lastDay, settings), rule.annualCap);
    const left = Math.min(carried + accrued, maxBalance) - usedBetween(requests, "earned", year, lastDay);
    carried = Math.min(Math.max(left, 0), carryForward);
    year = nextLeaveYear(year);
  }
  return carried;
}

/**
 * Every leave type's balance for the leave year containing `asOf`:
 * `quota` is what's available this year (accrued to date, or the fixed
 * allowance), `used` the approved days. Earned leave also reports
 * `carriedForward`, which is already included in its quota.
 *
 * `requests` are the employee's leave requests; only approved ones count.
 */
export function leaveBalances(employee, requests, asOf = todayISO(), settings = DEFAULT_SETTINGS) {
  const yearStart = leaveYearStart(asOf, settings);
  const yearEnd = dayBefore(nextLeaveYear(yearStart));
  const joined = employee.dateOfJoining <= asOf;
  const months = accrualMonths(employee.dateOfJoining, asOf, settings);
  const balances = {};

  for (const [type, rule] of Object.entries(settings.leaveAccrual)) {
    balances[type] = {
      quota: round1(Math.min(rule.perMonth * months, rule.annualCap)),
      used: usedBetween(requests, type, yearStart, yearEnd),
    };
  }
  for (const [type, days] of Object.entries(settings.leaveAllowances)) {
    balances[type] = { quota: joined ? days : 0, used: usedBetween(requests, type, yearStart, yearEnd) };
  }

  const carriedForward = earnedCarriedInto(employee, requests, yearStart, settings);
  balances.earned.quota = round1(Math.min(balances.earned.quota + carriedForward, LEAVE_RULES.earned.maxBalance));
  balances.earned.carriedForward = round1(carriedForward);

  return balances;
}

// --- Probation (Handbook §4.5) ---------------------------------------------

/** Default probation end: six months from joining. */
export function defaultProbationEnd(dateOfJoining, settings = DEFAULT_SETTINGS) {
  const d = new Date(dateOfJoining + "T00:00:00");
  d.setMonth(d.getMonth() + settings.probationMonths);
  return toLocalISO(d);
}

/** First and last ISO dates of the calendar month containing `iso`. */
export function monthBounds(iso) {
  const d = new Date(iso + "T00:00:00");
  const y = d.getFullYear();
  const m = d.getMonth();
  const last = new Date(y, m + 1, 0);
  return { start: `${y}-${String(m + 1).padStart(2, "0")}-01`, end: toLocalISO(last) };
}
