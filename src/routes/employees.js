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
  const { name, title, department, managerId, employmentType, location, dateOfJoining, role } = req.body;
  if (!name || !title || !department) {
    return res.status(400).json({ error: "name, title, and department are required" });
  }

  const id = await uniqueEmployeeId(slugify(name), Employee);
  const email = await uniqueEmail(name, Employee);
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
    managerId: managerId || null,
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

employeesRouter.patch("/:id/complete-onboarding", requireRole("admin", "hr"), async (req, res) => {
  const employee = await Employee.findByIdAndUpdate(req.params.id, { status: "Active" }, { new: true });
  if (!employee) return res.status(404).json({ error: "Employee not found" });
  res.json(employee);
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
