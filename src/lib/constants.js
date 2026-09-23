// Avatar/chart colours per department, drawn around the brand cobalt and
// gold so a directory full of avatars still reads as one palette.
export const DEPARTMENT_COLOR = {
  leadership: "#114fd4",
  engineering: "#0e6f9e",
  design: "#7b3fc4",
  marketing: "#12794a",
  sales: "#b91c30",
  hr: "#c98209",
};

// Default policy settings — the values a fresh install starts from, and
// the fallback when the Settings document is unavailable. HR/admin edit
// the live values through /api/settings; nothing here is read directly by
// the rules any more, so changing a number in this file only affects new
// installs, not a running company.
//
// Handbook references: §6.3 leave year, §6.5–6.8 accrued entitlements,
// the §6 leave table for fixed allowances, §4.5 probation, §6.4 leave
// during probation, §1.12 working hours. The emergency exceptions are a
// company rule on top of the handbook. Work from home has no allowance at
// all: §1.13 only says it needs approval, so each request is the
// manager's decision.
export const DEFAULT_SETTINGS = {
  leaveYearStartMonth: 4, // 1 April
  // Earned monthly, capped at the yearly figure.
  leaveAccrual: {
    earned: { perMonth: 1.5, annualCap: 18 },
    casual: { perMonth: 7 / 12, annualCap: 7 },
    sick: { perMonth: 7 / 12, annualCap: 7 },
    menstrual: { perMonth: 1, annualCap: 12 },
  },
  // Granted in full at the start of the leave year (or on joining).
  leaveAllowances: {
    optional: 2,
    marriage: 5,
    paternity: 5,
    lwp: 15,
  },
  probationMonths: 6,
  leaveAllowedDuringProbation: false,

  // Handbook §1.12 — office hours are 10:00–19:00. Arriving after the
  // start time is recorded but not held against anyone —
  // `enforceLateCheckIn` is off by default, so a late arrival raises no
  // flag and costs no exception. Leaving before the end time is the thing
  // that's actually controlled, and that's what the monthly emergency
  // exceptions are for.
  checkInByMinutes: 10 * 60, // 10:00
  checkOutFromMinutes: 19 * 60, // 19:00
  enforceLateCheckIn: false,
  emergencyExceptionsPerMonth: 2,
};

export const ACCRUED_LEAVE_TYPES = Object.keys(DEFAULT_SETTINGS.leaveAccrual);
export const ALLOWANCE_LEAVE_TYPES = Object.keys(DEFAULT_SETTINGS.leaveAllowances);
export const LEAVE_TYPES = [...ACCRUED_LEAVE_TYPES, ...ALLOWANCE_LEAVE_TYPES];

export const LEAVE_LABELS = {
  earned: "Earned leave",
  casual: "Casual leave",
  sick: "Sick leave",
  menstrual: "Menstrual leave",
  optional: "Optional holiday",
  marriage: "Marriage leave",
  paternity: "Paternity leave",
  lwp: "Leave without pay",
};

// Handbook §6.5–6.6 and the §6 leave table: how far ahead each type must
// be requested, and the limits that aren't about the balance. Fixed by the
// handbook rather than a setting. A request inside the notice period is
// only accepted as an emergency (§6.12 "except in genuine emergencies"),
// which the manager sees when deciding.
export const LEAVE_RULES = {
  earned: { noticeDays: 7, maxStretch: 15, carryForward: 10, maxBalance: 30 },
  // 2 days' notice, or a week when asking for more than 2 days.
  casual: { noticeDays: 2, longRequestOver: 2, longNoticeDays: 7 },
};

/** Formats minutes past midnight as a display time, e.g. 660 -> "11:00 AM". */
export function minutesToLabel(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

export const WELCOME_MEET_TEAM_TITLE = "Meet the team";
export const WELCOME_POLICIES_TITLE = "Read & acknowledge company policies";

export const ONBOARDING_TASK_TEMPLATE = [
  { category: "Welcome", title: WELCOME_MEET_TEAM_TITLE, owner: "self" },
  { category: "Welcome", title: WELCOME_POLICIES_TITLE, owner: "self" },
  { category: "Documentation", title: "Sign offer letter & employment contract", owner: "hr" },
  { category: "Documentation", title: "Submit ID proof & address verification", owner: "hr" },
  { category: "Documentation", title: "Submit PAN & bank details for payroll", owner: "hr" },
  { category: "IT Setup", title: "Laptop & equipment issued", owner: "it" },
  { category: "IT Setup", title: "Company email & Slack account created", owner: "it" },
  { category: "IT Setup", title: "Access granted to internal tools", owner: "it" },
  { category: "Training", title: "Role-specific tools & process training", owner: "manager" },
  { category: "Training", title: "1:1 kickoff with reporting manager", owner: "manager" },
  { category: "Culture", title: "Buddy assigned & intro meeting", owner: "hr" },
  { category: "Culture", title: "Welcome kit delivered", owner: "hr" },
];

export function buildOnboardingTasks(newHireId) {
  return ONBOARDING_TASK_TEMPLATE.map((task) => ({ ...task, newHireId, status: "Pending" }));
}
