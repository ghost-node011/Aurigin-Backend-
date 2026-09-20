import { LEAVE_YEAR_START_MONTH, LEAVE_TYPE_ACCRUAL, PROBATION_MONTHS } from "./constants.js";

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
// --- Leave accrual (Handbook §6.3–6.7) -------------------------------------
// Entitlements are earned monthly, not granted as a yearly lump. A joiner is
// credited for the month they join (their first month counts in full), and
// accrual restarts each leave year on 1 April.

/** ISO date of the 1 April that opens the leave year containing `iso`. */
export function leaveYearStart(iso) {
  const d = new Date(iso + "T00:00:00");
  const year = d.getMonth() + 1 >= LEAVE_YEAR_START_MONTH ? d.getFullYear() : d.getFullYear() - 1;
  return `${year}-04-01`;
}

/**
 * Months of accrual an employee has banked in the current leave year: from
 * whichever is later of their joining date and the leave-year start, up to
 * `asOf`, counting the starting month itself. Clamped to 1..12.
 */
export function accrualMonths(dateOfJoining, asOf = todayISO()) {
  const from = dateOfJoining > leaveYearStart(asOf) ? dateOfJoining : leaveYearStart(asOf);
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

/**
 * Recomputes each leave type's `quota` as the amount accrued so far, capped
 * at the handbook's annual ceiling. `used` is left untouched.
 */
export function accruedLeaveBalances(employee, asOf = todayISO()) {
  const months = accrualMonths(employee.dateOfJoining, asOf);
  const balances = {};
  for (const [type, rule] of Object.entries(LEAVE_TYPE_ACCRUAL)) {
    const existing = employee.leaveBalances?.[type];
    balances[type] = {
      quota: round1(Math.min(rule.perMonth * months, rule.annualCap)),
      used: existing?.used ?? 0,
    };
  }
  return balances;
}

// --- Probation (Handbook §4.5) ---------------------------------------------

/** Default probation end: six months from joining. */
export function defaultProbationEnd(dateOfJoining) {
  const d = new Date(dateOfJoining + "T00:00:00");
  d.setMonth(d.getMonth() + PROBATION_MONTHS);
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
