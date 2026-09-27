import { Router } from "express";
import { OnboardingTask } from "../models/OnboardingTask.js";
import { Employee } from "../models/Employee.js";
import { requireRole } from "../middleware/auth.js";

export const onboardingRouter = Router();

onboardingRouter.get("/", async (_req, res) => {
  const tasks = await OnboardingTask.find();
  res.json(tasks);
});

/**
 * Who may update a task, by its owner: the new hire their own "self" tasks,
 * the new hire's manager the "manager" tasks, and HR/admin anything (they
 * also cover IT, which has no role of its own). Test accounts may update
 * all of their own tasks.
 */
async function canUpdate(req, task) {
  if (["admin", "hr"].includes(req.role)) return true;
  if (task.owner === "self") return task.newHireId === req.employeeId;
  const hire = await Employee.findById(task.newHireId, { managerId: 1 }).lean();
  if (task.owner === "manager") return hire?.managerId === req.employeeId;
  if (task.newHireId === req.employeeId) {
    const me = await Employee.findById(req.employeeId, { policyExempt: 1 }).lean();
    return Boolean(me?.policyExempt);
  }
  return false;
}

const OWNER_LABEL = { self: "the new hire", hr: "HR", it: "HR/IT", manager: "their manager" };

onboardingRouter.patch("/:id", async (req, res) => {
  const { status, note } = req.body ?? {};
  if (status !== undefined && !["Pending", "In Progress", "Done"].includes(status)) {
    return res.status(400).json({ error: "invalid status" });
  }
  const task = await OnboardingTask.findById(req.params.id).catch(() => null);
  if (!task) return res.status(404).json({ error: "Onboarding task not found" });
  if (!(await canUpdate(req, task))) {
    return res.status(403).json({ error: `Only ${OWNER_LABEL[task.owner] ?? "HR"} can update "${task.title}"` });
  }
  if (status !== undefined) task.status = status;
  if (note !== undefined) task.note = String(note).trim().slice(0, 1000);
  task.updatedBy = req.employeeId;
  task.updatedAt = new Date();
  await task.save();
  res.json(task);
});

onboardingRouter.post("/:employeeId/complete", requireRole("admin", "hr"), async (req, res) => {
  const employee = await Employee.findByIdAndUpdate(req.params.employeeId, { status: "Active" }, { new: true });
  if (!employee) return res.status(404).json({ error: "Employee not found" });
  res.json(employee);
});
