import { WfhRequest } from "../models/WfhRequest.js";
import { AttendanceRecord } from "../models/AttendanceRecord.js";
import { getSettings } from "../models/Settings.js";
import { monthBounds } from "./helpers.js";

/**
 * Handbook §1.13 — remote work is an arrangement, not an entitlement.
 * Employees still on probation get a monthly allowance instead of the
 * confirmed-employee weekly one.
 *
 * Lives here rather than in a route because WFH can be claimed two ways —
 * raising a request, or marking WFH on today's attendance — and the
 * allowance has to cover both or either one becomes a way around it.
 *
 * Returns an error message when the day would exceed the allowance, or
 * null when it's fine.
 */
export async function probationWfhBlock(employee, date) {
  if (employee.employmentStatus !== "Probation") return null;

  const { wfhProbationMonthlyQuota: quota } = await getSettings();
  if (quota === 0) {
    return "Work from home is not available during probation.";
  }

  const { start, end } = monthBounds(date);
  const [requests, marks] = await Promise.all([
    WfhRequest.find({
      employeeId: employee._id,
      status: { $ne: "Rejected" },
      date: { $gte: start, $lte: end },
    }).lean(),
    AttendanceRecord.find({
      employeeId: employee._id,
      status: "WFH",
      date: { $gte: start, $lte: end },
    }).lean(),
  ]);

  // Counted as distinct dates: claiming the same day through both paths is
  // still one day against the allowance.
  const taken = new Set([...requests.map((r) => r.date), ...marks.map((m) => m.date)]);
  taken.delete(date);
  if (taken.size < quota) return null;

  return `During probation you may work from home ${quota} day(s) per month; you have already used ${taken.size} this month.`;
}
