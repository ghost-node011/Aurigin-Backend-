import { Router } from "express";
import { Employee } from "../models/Employee.js";
import { OnboardingTask } from "../models/OnboardingTask.js";
import {
  slugify,
  uniqueEmployeeId,
  uniqueEmail,
  todayISO,
  leaveBalances,
  defaultProbationEnd,
} from "../lib/helpers.js";
import { buildOnboardingTasks, DEPARTMENT_COLOR } from "../lib/constants.js";
import { LeaveRequest } from "../models/LeaveRequest.js";
import { hashPassword, generateTempPassword } from "../lib/auth.js";
import { requireRole } from "../middleware/auth.js";
import { getSettings } from "../models/Settings.js";

export const employeesRouter = Router();

// Leave is earned monthly (Handbook §6.5–6.8), so balances are derived
// from the joining date and approved requests on every read rather than
// maintained by a scheduled job — there's nothing to drift or catch up on
// if the app sits idle, and the leave year rolls over on its own.
employeesRouter.get("/", async (_req, res) => {
  const [employees, settings, requests] = await Promise.all([
    Employee.find().sort({ createdAt: 1 }),
    getSettings(),
    LeaveRequest.find({ status: "Approved" }),
  ]);
  res.json(
    employees.map((e) => ({
      ...e.toJSON(),
      leaveBalances: leaveBalances(e, requests.filter((r) => r.employeeId === e.id), undefined, settings),
    })),
  );
});

employeesRouter.post("/", requireRole("admin", "hr"), async (req, res) => {
  const { name, title, department, managerId, employmentType, location, dateOfJoining, role, email: requestedEmail } =
    req.body;
  if (!name || !title || !department) {
    return res.status(400).json({ error: "name, title, and department are required" });
  }

  // HR may give the company address outright; otherwise one is generated.
  let email;
  if (requestedEmail) {
    email = String(requestedEmail).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Invalid email address" });
    if (await Employee.exists({ email })) return res.status(409).json({ error: `${email} is already in use` });
  } else {
    email = await uniqueEmail(name, Employee);
  }

  const workReporterIds = await validEmployeeIds(req.body.workReporterIds);
  if (workReporterIds === null) return res.status(400).json({ error: "workReporterIds contains an unknown employee" });

  // Without an explicit manager, new hires report to the administrator.
  const reportsTo = managerId || (await Employee.findOne({ role: "admin" }).sort({ createdAt: 1 }))?.id || null;

  const id = await uniqueEmployeeId(slugify(name), Employee);
  const tempPassword = generateTempPassword();

  const employee = await Employee.create({
    _id: id,
    name,
    email,
    passwordHash: await hashPassword(tempPassword),
    mustChangePassword: true,
    role: role || "employee",
    title,
    department,
    managerId: reportsTo,
    workReporterIds,
    location: location || "",
    employmentType: employmentType || "Full-time",
    status: "Onboarding",
    dateOfJoining: dateOfJoining || todayISO(),
    employmentStatus: "Probation",
    probationEndDate: defaultProbationEnd(dateOfJoining || todayISO(), await getSettings()),
    color: DEPARTMENT_COLOR[department] ?? "#013fd2",
  });

  await OnboardingTask.insertMany(buildOnboardingTasks(id));

  // Only time the plaintext temp password exists — the caller (HR/admin)
  // is responsible for relaying it to the new hire out of band.
  res.status(201).json({ ...employee.toJSON(), tempPassword });
});

/** Unique, existing employee ids from `value`; `[]` when absent, `null` if any is unknown. */
async function validEmployeeIds(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) return null;
  const ids = [...new Set(value.map(String))];
  const found = await Employee.countDocuments({ _id: { $in: ids } });
  return found === ids.length ? ids : null;
}

/**
 * Sets who oversees an employee's work besides admins and their manager
 * (who are always included). HR/admin only.
 */
employeesRouter.patch("/:id/work-reporters", requireRole("admin", "hr"), async (req, res) => {
  const ids = await validEmployeeIds(req.body?.workReporterIds);
  if (ids === null) return res.status(400).json({ error: "workReporterIds must be a list of existing employee ids" });
  const employee = await Employee.findById(req.params.id);
  if (!employee) return res.status(404).json({ error: "Employee not found" });
  employee.workReporterIds = ids.filter((id) => id !== employee.id);
  await employee.save();
  res.json(employee);
});

/** Grants or removes the permission to manage work projects. Admin only. */
employeesRouter.patch("/:id/project-manager", requireRole("admin"), async (req, res) => {
  const employee = await Employee.findByIdAndUpdate(
    req.params.id,
    { canManageProjects: Boolean(req.body?.canManageProjects) },
    { returnDocument: "after" },
  );
  if (!employee) return res.status(404).json({ error: "Employee not found" });
  res.json(employee);
});

/** Grants or removes access to the BNI directory (view and remove members). Admin only. */
employeesRouter.patch("/:id/bni-access", requireRole("admin"), async (req, res) => {
  const employee = await Employee.findByIdAndUpdate(
    req.params.id,
    { canManageBni: Boolean(req.body?.canManageBni) },
    { returnDocument: "after" },
  );
  if (!employee) return res.status(404).json({ error: "Employee not found" });
  res.json(employee);
});

/** Marks an account as a test account that policy rules don't block. Admin only. */
employeesRouter.patch("/:id/policy-exempt", requireRole("admin"), async (req, res) => {
  const employee = await Employee.findByIdAndUpdate(
    req.params.id,
    { policyExempt: Boolean(req.body?.policyExempt) },
    { returnDocument: "after" },
  );
  if (!employee) return res.status(404).json({ error: "Employee not found" });
  res.json(employee);
});

/**
 * Marks someone fully onboarded (HR/admin): any checklist tasks still open
 * are ticked off with a note saying who closed them, and the person becomes
 * an active employee — so it works whether or not every task was done.
 */
employeesRouter.patch("/:id/complete-onboarding", requireRole("admin", "hr"), async (req, res) => {
  const employee = await Employee.findById(req.params.id);
  if (!employee) return res.status(404).json({ error: "Employee not found" });
  const closer = await Employee.findById(req.employeeId, { name: 1 }).lean();
  const { modifiedCount } = await OnboardingTask.updateMany(
    { newHireId: employee.id, status: { $ne: "Done" } },
    // A pipeline update so an existing note is kept rather than overwritten.
    [
      {
        $set: {
          status: "Done",
          updatedBy: req.employeeId,
          updatedAt: new Date(),
          note: {
            $cond: [
              { $gt: [{ $strLenCP: { $ifNull: ["$note", ""] } }, 0] },
              "$note",
              `Closed when ${closer?.name ?? "HR"} marked onboarding complete`,
            ],
          },
        },
      },
    ],
    { updatePipeline: true },
  );
  employee.status = "Active";
  await employee.save();
  res.json({ ...employee.toJSON(), tasksClosed: modifiedCount });
});

/**
 * HR/admin set or lift probation (Handbook §4.5). Confirmation is an
 * explicit action — nothing flips an employee to Confirmed automatically
 * when `probationEndDate` passes, because the handbook makes confirmation
 * subject to assessment and formal communication.
 */
employeesRouter.patch("/:id/probation", requireRole("admin", "hr"), async (req, res) => {
  const { employmentStatus, probationEndDate } = req.body;
  if (!["Probation", "Confirmed"].includes(employmentStatus)) {
    return res.status(400).json({ error: "employmentStatus must be Probation or Confirmed" });
  }
  if (probationEndDate && !/^\d{4}-\d{2}-\d{2}$/.test(probationEndDate)) {
    return res.status(400).json({ error: "probationEndDate must be an ISO date (YYYY-MM-DD)" });
  }

  const [employee, settings] = await Promise.all([Employee.findById(req.params.id), getSettings()]);
  if (!employee) return res.status(404).json({ error: "Employee not found" });

  employee.employmentStatus = employmentStatus;
  if (employmentStatus === "Confirmed") {
    employee.confirmedOn = todayISO();
    employee.probationEndDate = probationEndDate ?? employee.probationEndDate;
  } else {
    employee.confirmedOn = null;
    employee.probationEndDate = probationEndDate ?? defaultProbationEnd(employee.dateOfJoining, settings);
  }
  await employee.save();

  const requests = await LeaveRequest.find({ employeeId: employee.id, status: "Approved" });
  res.json({ ...employee.toJSON(), leaveBalances: leaveBalances(employee, requests, undefined, settings) });
});
