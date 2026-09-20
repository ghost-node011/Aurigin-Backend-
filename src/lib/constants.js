export const DEPARTMENT_COLOR = {
  leadership: "#013fd2",
  engineering: "#0e7490",
  design: "#be185d",
  marketing: "#15803d",
  sales: "#b91c1c",
  hr: "#be3a0a",
};

// Employee Handbook §6.3 — the leave year runs 1 April to 31 March.
export const LEAVE_YEAR_START_MONTH = 4;

// Handbook §6.5–6.7 entitlements, credited month by month as they are
// earned rather than handed over as a full-year bucket on day one. Earned
// Leave is already defined per calendar month by the handbook (1.5/month);
// Casual and Sick are stated per leave year, so they accrue at a twelfth of
// that each month. `annualCap` is the handbook's yearly ceiling — accrual
// never exceeds it, so a full year of service lands exactly on the
// handbook number.
export const LEAVE_TYPE_ACCRUAL = {
  earned: { perMonth: 1.5, annualCap: 18 },
  casual: { perMonth: 7 / 12, annualCap: 7 },
  sick: { perMonth: 7 / 12, annualCap: 7 },
};

export const LEAVE_TYPES = Object.keys(LEAVE_TYPE_ACCRUAL);

export function emptyLeaveBalances() {
  return {
    casual: { quota: 0, used: 0 },
    sick: { quota: 0, used: 0 },
    earned: { quota: 0, used: 0 },
  };
}

// Handbook §4.5 — probation is six months unless the appointment letter
// says otherwise.
export const PROBATION_MONTHS = 6;

// Handbook §1.13 — remote work is an arrangement, not an entitlement.
// Confirmed employees get a weekly allowance; employees still on probation
// get a tighter monthly one.
export const WFH_WEEKLY_QUOTA = 2;
export const WFH_PROBATION_MONTHLY_QUOTA = 2;

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

// --- Attendance punctuality -------------------------------------------------
// The handbook (§1.12) states working hours of 10:00–19:00; the rule the
// company actually enforces is a check-in deadline and a check-out floor,
// with a small monthly allowance for genuine emergencies.
//
// Stored as minutes past local midnight so they can be compared directly
// against a recorded time, rather than parsing display strings.
export const CHECK_IN_BY_MINUTES = 11 * 60; // 11:00
export const CHECK_OUT_FROM_MINUTES = 18 * 60; // 18:00

// Days per calendar month on which an employee may excuse a late check-in
// or an early check-out.
export const EMERGENCY_EXCEPTIONS_PER_MONTH = 2;

export const CHECK_IN_BY_LABEL = "11:00 AM";
export const CHECK_OUT_FROM_LABEL = "6:00 PM";
