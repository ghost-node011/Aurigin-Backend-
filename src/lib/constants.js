export const DEPARTMENT_COLOR = {
  leadership: "#013fd2",
  engineering: "#0e7490",
  design: "#be185d",
  marketing: "#15803d",
  sales: "#b91c1c",
  hr: "#be3a0a",
};

// Default policy settings — the values a fresh install starts from, and
// the fallback when the Settings document is unavailable. HR/admin edit
// the live values through /api/settings; nothing here is read directly by
// the rules any more, so changing a number in this file only affects new
// installs, not a running company.
//
// Handbook references: §6.3 leave year, §6.5–6.7 entitlements,
// §4.5 probation, §6.4 leave during probation, §1.13 remote work,
// §1.12 working hours.
export const DEFAULT_SETTINGS = {
  leaveYearStartMonth: 4, // 1 April
  leaveAccrual: {
    earned: { perMonth: 1.5, annualCap: 18 },
    casual: { perMonth: 7 / 12, annualCap: 7 },
    sick: { perMonth: 7 / 12, annualCap: 7 },
  },
  probationMonths: 6,
  leaveAllowedDuringProbation: false,
  wfhWeeklyQuota: 2,
  wfhProbationMonthlyQuota: 2,
  checkInByMinutes: 11 * 60, // 11:00
  checkOutFromMinutes: 18 * 60, // 18:00
  emergencyExceptionsPerMonth: 2,
};

export const LEAVE_TYPES = Object.keys(DEFAULT_SETTINGS.leaveAccrual);

export function emptyLeaveBalances() {
  return {
    casual: { quota: 0, used: 0 },
    sick: { quota: 0, used: 0 },
    earned: { quota: 0, used: 0 },
  };
}

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
