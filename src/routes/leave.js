import { Router } from "express";
import { LeaveRequest } from "../models/LeaveRequest.js";
import { Employee } from "../models/Employee.js";
import { daysBetweenInclusive, todayISO, leaveBalances, leaveYearStart } from "../lib/helpers.js";
import { LEAVE_TYPES, LEAVE_LABELS, LEAVE_RULES } from "../lib/constants.js";
import { requireRole, requireSelf } from "../middleware/auth.js";
import { getSettings } from "../models/Settings.js";

export const leaveRouter = Router();

leaveRouter.get("/", async (_req, res) => {
  const requests = await LeaveRequest.find().sort({ appliedOn: -1 });
  res.json(requests);
});

leaveRouter.post("/", requireSelf("employeeId"), async (req, res) => {
  const { employeeId, type, startDate, endDate, reason, emergency } = req.body;
  if (!employeeId || !type || !startDate || !endDate) {
    return res.status(400).json({ error: "employeeId, type, startDate, and endDate are required" });
  }
  if (!LEAVE_TYPES.includes(type)) {
    return res.status(400).json({ error: `Unknown leave type "${type}"` });
  }
  if (endDate < startDate) {
    return res.status(400).json({ error: "endDate must be on or after startDate" });
  }
  const employee = await Employee.findById(employeeId);
  if (!employee) return res.status(404).json({ error: "Employee not found" });

  const settings = await getSettings();

  // Handbook §6.4 — leave accrues during probation but is availed only
  // after confirmation. HR can turn this off in settings.
  if (employee.employmentStatus === "Probation" && !settings.leaveAllowedDuringProbation) {
    return res.status(403).json({
      error: "Leave can be availed after successful completion of probation (Handbook §6.4).",
    });
  }

  const days = daysBetweenInclusive(startDate, endDate);

  // Handbook §6.5 — at most 15 days of earned leave at a stretch.
  if (type === "earned" && days > LEAVE_RULES.earned.maxStretch) {
    return res.status(400).json({
      error: `Earned leave can be taken for at most ${LEAVE_RULES.earned.maxStretch} days at a stretch (Handbook §6.5).`,
    });
  }

  // Handbook §6.5–6.6 notice periods. Leave inside the notice period is
  // still possible in a genuine emergency (§6.12), flagged for the manager.
  const notice = requiredNoticeDays(type, days);
  const noticeGiven = daysBetweenInclusive(todayISO(), startDate) - 1;
  if (noticeGiven < notice && !emergency) {
    return res.status(400).json({
      error: `${LEAVE_LABELS[type]} of ${days} day(s) needs ${notice} days' notice (Handbook §6.5–6.6). Mark it as an emergency if it can't wait.`,
    });
  }

  // Available this year — accrued to date for monthly types, so you can't
  // spend leave you haven't earned yet. Pending requests are counted too,
  // so the same days can't be requested twice before either is decided.
  const requests = await LeaveRequest.find({ employeeId, status: { $in: ["Approved", "Pending"] } });
  const asApproved = requests.map((r) => ({ type: r.type, startDate: r.startDate, days: r.days, status: "Approved" }));
  const balance = leaveBalances(employee, asApproved, balanceDate(startDate, settings), settings)[type];
  const remaining = balance.quota - balance.used;
  if (days > remaining) {
    return res.status(400).json({
      error: `Only ${Math.max(remaining, 0)} day(s) of ${LEAVE_LABELS[type]} available; you requested ${days}.`,
    });
  }

  const request = await LeaveRequest.create({
    employeeId,
    type,
    startDate,
    endDate,
    days,
    status: "Pending",
    reason: reason || "",
    emergency: noticeGiven < notice,
    appliedOn: todayISO(),
    approverId: employee.managerId ?? null,
  });

  res.status(201).json(request);
});

/**
 * The day to measure the balance on: today for leave this leave year (you
 * can't spend what hasn't accrued yet), the leave's own date for leave in
 * the past, and the opening day of a future leave year.
 */
function balanceDate(startDate, settings) {
  const today = todayISO();
  if (startDate <= today) return startDate;
  const yearStart = leaveYearStart(startDate, settings);
  return yearStart > today ? yearStart : today;
}

function requiredNoticeDays(type, days) {
  if (type === "earned") return LEAVE_RULES.earned.noticeDays;
  if (type === "casual") {
    const rule = LEAVE_RULES.casual;
    return days > rule.longRequestOver ? rule.longNoticeDays : rule.noticeDays;
  }
  return 0;
}

leaveRouter.patch("/:id", requireRole("admin", "hr", "manager"), async (req, res) => {
  const { status, comment } = req.body;
  if (!["Approved", "Rejected"].includes(status)) {
    return res.status(400).json({ error: "status must be Approved or Rejected" });
  }

  const request = await LeaveRequest.findById(req.params.id);
  if (!request) return res.status(404).json({ error: "Leave request not found" });

  request.status = status;
  request.approverComment = comment ?? null;
  await request.save();
  res.json(request);
});
