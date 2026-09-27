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

  const inSprint = await Issue.find({ sprintId: sprint._id, type: { $nin: ["Sub-task", "Epic"] } }).lean();
  const done = inSprint.filter((i) => i.status === "Done").length;
  const notDone = inSprint.length - done;
  sprint.snapshot = inSprint.map((i) => ({
    issueId: i._id,
    key: i.key,
    title: i.title,
    type: i.type,
    status: i.status,
    storyPoints: i.storyPoints,
    assigneeId: i.assigneeId,
    completedAt: i.status === "Done" ? i.completedAt : null,
  }));
  // Unfinished work lands in the next sprint, or back in the backlog.
  await Issue.updateMany({ sprintId: sprint._id, status: { $ne: "Done" } }, { sprintId: target, inBacklog: !target });

  sprint.state = "closed";
  sprint.completedAt = new Date();
  sprint.completedIssueCount = done;
  sprint.incompleteIssueCount = notDone;
  await sprint.save();
  res.json({ sprint, movedTo: target });
});

/**
 * Sprint report: what was in it, what got done, and a burndown — remaining
 * work at the end of each day against the ideal straight line. Measured in
 * story points when the sprint's issues have them, otherwise in issues.
 * Readable by everyone.
 */
sprintsRouter.get("/:id/report", async (req, res) => {
  const sprint = mongoose.isValidObjectId(req.params.id) ? await Sprint.findById(req.params.id) : null;
  if (!sprint) return res.status(404).json({ error: "Sprint not found" });
  if (sprint.state === "future") return res.status(400).json({ error: "This sprint hasn't started" });

  const issues =
    sprint.state === "closed"
      ? sprint.snapshot.map((s) => s.toObject())
      : (await Issue.find({ sprintId: sprint._id, type: { $nin: ["Sub-task", "Epic"] } }).lean()).map((i) => ({
          issueId: i._id,
          key: i.key,
          title: i.title,
          type: i.type,
          status: i.status,
          storyPoints: i.storyPoints,
          assigneeId: i.assigneeId,
          completedAt: i.status === "Done" ? i.completedAt : null,
        }));

  const usePoints = issues.some((i) => i.storyPoints > 0);
  const size = (i) => (usePoints ? i.storyPoints ?? 0 : 1);
  const total = issues.reduce((sum, i) => sum + size(i), 0);

  const start = sprint.startDate;
  const end = sprint.endDate ?? start;
  const today = todayISO();
  const days = [];
  const span = Math.max(1, Math.round((new Date(end) - new Date(start)) / 86_400_000));
  for (let d = start, n = 0; d <= end; d = addDays(d, 1), n++) {
    // Days with no actual value yet: after today in an active sprint, or
    // after the day a sprint was completed early.
    const future = sprint.state === "active" ? d > today : d > todayOf(sprint.completedAt);
    const doneBy = issues
      .filter((i) => i.completedAt && todayOf(i.completedAt) <= d)
      .reduce((sum, i) => sum + size(i), 0);
    days.push({
      date: d,
      ideal: Math.round((total - (total * n) / span) * 10) / 10,
      remaining: future ? null : Math.round((total - doneBy) * 10) / 10,
    });
  }

  res.json({ sprint, unit: usePoints ? "points" : "issues", total, issues, days });
});

// A completion timestamp's calendar day in company time.
function todayOf(date) {
  return new Date(date).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/** Deletes a future sprint; its issues go back to the backlog. */
sprintsRouter.delete("/:id", async (req, res) => {
  const sprint = await loadSprint(req, res);
  if (!sprint) return;
  if (sprint.state !== "future") return res.status(400).json({ error: "Only a sprint that hasn't started can be deleted" });
  await Issue.updateMany({ sprintId: sprint._id }, { sprintId: null, inBacklog: true });
  await sprint.deleteOne();
  res.status(204).end();
});
