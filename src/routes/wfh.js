import { Router } from "express";
import { WfhRequest } from "../models/WfhRequest.js";
import { Employee } from "../models/Employee.js";
import { todayISO } from "../lib/helpers.js";
import { probationWfhBlock } from "../lib/wfh.js";
import { requireRole, requireSelf } from "../middleware/auth.js";

export const wfhRouter = Router();

wfhRouter.get("/", async (_req, res) => {
  const requests = await WfhRequest.find().sort({ appliedOn: -1 });
  res.json(requests);
});

wfhRouter.post("/", requireSelf("employeeId"), async (req, res) => {
  const { employeeId, date, reason } = req.body;
  if (!employeeId || !date) {
    return res.status(400).json({ error: "employeeId and date are required" });
  }
  const employee = await Employee.findById(employeeId);
  if (!employee) return res.status(404).json({ error: "Employee not found" });

  const blocked = await probationWfhBlock(employee, date);
  if (blocked) return res.status(400).json({ error: blocked });

  const request = await WfhRequest.create({
    employeeId,
    date,
    status: "Pending",
    reason: reason || "",
    appliedOn: todayISO(),
    approverId: employee.managerId ?? null,
  });

  res.status(201).json(request);
});

wfhRouter.patch("/:id", requireRole("admin", "hr", "manager"), async (req, res) => {
  const { status, comment } = req.body;
  if (!["Approved", "Rejected"].includes(status)) {
    return res.status(400).json({ error: "status must be Approved or Rejected" });
  }

  const request = await WfhRequest.findByIdAndUpdate(
    req.params.id,
    { status, approverComment: comment ?? null },
    { new: true },
  );
  if (!request) return res.status(404).json({ error: "WFH request not found" });

  res.json(request);
});
