import { Router } from "express";
import mongoose from "mongoose";
import { Sprint } from "../models/Sprint.js";
import { Issue } from "../models/Issue.js";
import { Project } from "../models/Project.js";
import { todayISO } from "../lib/helpers.js";
import { canManageProjects } from "./projects.js";

export const sprintsRouter = Router();

/** Managers, HR, project managers and the project's lead run sprints. */
async function canRunSprints(req, projectKey) {
  if (["admin", "hr", "manager"].includes(req.role) || (await canManageProjects(req))) return true;
  const project = await Project.findOne({ key: projectKey }, { leadId: 1 }).lean();
  return project?.leadId === req.employeeId;
}

async function loadSprint(req, res) {
  const sprint = mongoose.isValidObjectId(req.params.id) ? await Sprint.findById(req.params.id) : null;
  if (!sprint) {
    res.status(404).json({ error: "Sprint not found" });
    return null;
  }
  if (!(await canRunSprints(req, sprint.projectKey))) {
    res.status(403).json({ error: "Only managers, HR/admin or the project lead can manage sprints" });
    return null;
  }
  return sprint;
}

const addDays = (iso, days) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Open sprints for a project, plus the five most recently completed. */
sprintsRouter.get("/", async (req, res) => {
  const projectKey = String(req.query.project ?? "");
  if (!projectKey) return res.status(400).json({ error: "project is required" });
  const [open, closed] = await Promise.all([
    Sprint.find({ projectKey, state: { $ne: "closed" } }).sort({ state: 1, createdAt: 1 }),
    Sprint.find({ projectKey, state: "closed" }).sort({ completedAt: -1 }).limit(5),
  ]);
  // "active" sorts before "future" alphabetically, which is the order we want.
  res.json([...open, ...closed]);
});

sprintsRouter.post("/", async (req, res) => {
  const projectKey = String(req.body?.projectKey ?? "");
  if (!(await Project.exists({ key: projectKey }))) return res.status(404).json({ error: "Project not found" });
  if (!(await canRunSprints(req, projectKey))) {
    return res.status(403).json({ error: "Only managers, HR/admin or the project lead can create sprints" });
  }
  const count = await Sprint.countDocuments({ projectKey });
  const sprint = await Sprint.create({
    projectKey,
    name: String(req.body?.name ?? "").trim() || `${projectKey} Sprint ${count + 1}`,
    goal: String(req.body?.goal ?? "").trim(),
  });
  res.status(201).json(sprint);
});

sprintsRouter.patch("/:id", async (req, res) => {
  const sprint = await loadSprint(req, res);
  if (!sprint) return;
  const { name, goal, startDate, endDate } = req.body ?? {};
  if (name !== undefined && String(name).trim()) sprint.name = String(name).trim();
  if (goal !== undefined) sprint.goal = String(goal).trim();
  if (startDate !== undefined) sprint.startDate = startDate || null;
  if (endDate !== undefined) sprint.endDate = endDate || null;
  await sprint.save();
  res.json(sprint);
});

/** Starts a future sprint. Only one sprint per project can be active. */
sprintsRouter.post("/:id/start", async (req, res) => {
  const sprint = await loadSprint(req, res);
  if (!sprint) return;
  if (sprint.state !== "future") return res.status(400).json({ error: "Only a future sprint can be started" });
  if (await Sprint.exists({ projectKey: sprint.projectKey, state: "active" })) {
    return res.status(409).json({ error: "Complete the active sprint before starting another" });
  }
  const startDate = req.body?.startDate || todayISO();
  sprint.state = "active";
  sprint.startDate = startDate;
  sprint.endDate = req.body?.endDate || addDays(startDate, 13); // two weeks by default
  if (req.body?.goal !== undefined) sprint.goal = String(req.body.goal).trim();
  await sprint.save();
  res.json(sprint);
});

/**
 * Completes the active sprint. Unfinished issues move to `moveTo`: another
 * open sprint's id, "new" for a freshly created next sprint, or the
 * backlog (default).
 */
sprintsRouter.post("/:id/complete", async (req, res) => {
  const sprint = await loadSprint(req, res);
  if (!sprint) return;
  if (sprint.state !== "active") return res.status(400).json({ error: "Only the active sprint can be completed" });

  let target = null;
  const moveTo = req.body?.moveTo;
  if (moveTo === "new") {
    const count = await Sprint.countDocuments({ projectKey: sprint.projectKey });
    target = (await Sprint.create({ projectKey: sprint.projectKey, name: `${sprint.projectKey} Sprint ${count + 1}` }))._id;
  } else if (moveTo && moveTo !== "backlog") {
    const next = mongoose.isValidObjectId(moveTo) ? await Sprint.findById(moveTo) : null;
    if (!next || next.projectKey !== sprint.projectKey || next.state !== "future") {
      return res.status(400).json({ error: "Unfinished issues can only move to a future sprint in this project" });
    }
    target = next._id;
  }

  const [done, notDone] = await Promise.all([
    Issue.countDocuments({ sprintId: sprint._id, status: "Done", type: { $ne: "Sub-task" } }),
    Issue.countDocuments({ sprintId: sprint._id, status: { $ne: "Done" }, type: { $ne: "Sub-task" } }),
  ]);
  await Issue.updateMany({ sprintId: sprint._id, status: { $ne: "Done" } }, { sprintId: target });

  sprint.state = "closed";
  sprint.completedAt = new Date();
  sprint.completedIssueCount = done;
  sprint.incompleteIssueCount = notDone;
  await sprint.save();
  res.json({ sprint, movedTo: target });
});

/** Deletes a future sprint; its issues go back to the backlog. */
sprintsRouter.delete("/:id", async (req, res) => {
  const sprint = await loadSprint(req, res);
  if (!sprint) return;
  if (sprint.state !== "future") return res.status(400).json({ error: "Only a sprint that hasn't started can be deleted" });
  await Issue.updateMany({ sprintId: sprint._id }, { sprintId: null });
  await sprint.deleteOne();
  res.status(204).end();
});
