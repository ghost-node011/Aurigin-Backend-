import { Router } from "express";
import { DayPlan } from "../models/DayPlan.js";
import { Issue } from "../models/Issue.js";
import { Project, ensureDefaultProject } from "../models/Project.js";
import { Employee } from "../models/Employee.js";
import { AttendanceRecord } from "../models/AttendanceRecord.js";
import { getSettings } from "../models/Settings.js";
import { todayISO, nowMinutes } from "../lib/helpers.js";
import { planDay, closeDay, canViewWorkOf, workReportersFor, hhmmToMinutes, minutesToHHMM } from "../lib/workday.js";
import { newIssueKey } from "./issues.js";
import { dayPlanned, dayClosed } from "../lib/notify.js";

/**
 * "My Day": the morning overview the AI turns into scheduled tickets, and
 * the end-of-day summary it uses to close them and assess the day.
 *
 * Planning and closing are always for the caller's own today. Reading a
 * day or the performance history is allowed for the employee, their
 * managers, their work reporters and HR/admin.
 */
export const workRouter = Router();

async function ticketsForDay(employeeId, date) {
  return Issue.find({ assigneeId: employeeId, plannedDate: date }).sort({ plannedStart: 1, createdAt: 1 });
}

/** What every My Day endpoint returns: the plan, today's timeline, and what the day sent to the backlog. */
async function dayResponse(employeeId, date, plan) {
  const [tickets, backlog] = await Promise.all([
    ticketsForDay(employeeId, date),
    plan?.backlogKeys?.length ? Issue.find({ key: { $in: plan.backlogKeys } }).sort({ createdAt: 1 }) : [],
  ]);
  return { date, plan, tickets, backlog };
}

workRouter.get("/day", async (req, res) => {
  const employeeId = String(req.query.employeeId || req.employeeId);
  const date = String(req.query.date || todayISO());
  if (!(await canViewWorkOf(req.employeeId, req.role, employeeId))) {
    return res.status(403).json({ error: "You can't view this person's work" });
  }
  const plan = await DayPlan.findOne({ employeeId, date });
  res.json(await dayResponse(employeeId, date, plan));
});

/**
 * Morning overview -> tickets on today's timeline. Calling it again later
 * the same day adds to the plan: the new overview is appended and its tasks
 * are scheduled after what's already there.
 *
 * `projectKey` files every new task under that project; without it the AI
 * picks the right project for each task.
 */
workRouter.post("/day/plan", async (req, res) => {
  const overview = String(req.body?.overview ?? "").trim();
  if (overview.length < 10) return res.status(400).json({ error: "Write a few words about today's work first." });
  if (overview.length > 5000) return res.status(400).json({ error: "Keep the overview under 5,000 characters." });

  const employeeId = req.employeeId;
  const date = todayISO();
  const [employee, settings, existing] = await Promise.all([
    Employee.findById(employeeId),
    getSettings(),
    DayPlan.findOne({ employeeId, date }),
  ]);
  if (existing?.closedAt) return res.status(409).json({ error: "Today's day is already closed." });
  // The day starts at check-in; test accounts can plan any time.
  if (!employee.policyExempt && !(await AttendanceRecord.exists({ employeeId, date, checkIn: { $ne: null } }))) {
    return res.status(400).json({ error: "Check in first — My Day starts once you've checked in." });
  }

  const defaultProject = await ensureDefaultProject();
  const projects = await Project.find({ archived: false }).lean();
  const chosen = req.body?.projectKey ? projects.find((p) => p.key === req.body.projectKey) : null;
  if (req.body?.projectKey && !chosen) return res.status(404).json({ error: "Project not found" });

  const [openTickets, todays] = await Promise.all([
    Issue.find({ assigneeId: employeeId, status: { $ne: "Done" }, plannedDate: { $ne: date } }).limit(30),
    ticketsForDay(employeeId, date),
  ]);
  // New work goes after whatever is already scheduled today.
  const lastEnd = Math.max(0, ...todays.map((t) => hhmmToMinutes(t.plannedEnd) ?? 0));
  const { tasks, source } = await planDay({
    employee,
    overview,
    openTickets,
    // With a project picked, offer only that one so everything lands there.
    projects: chosen ? [chosen] : projects,
    defaultProjectKey: chosen?.key ?? defaultProject.key,
    nowMinutes: Math.max(nowMinutes(), lastEnd),
    settings,
  });

  const reporterIds = await workReportersFor(employee);
  const byKey = new Map(openTickets.map((t) => [t.key, t]));
  const scheduled = [];
  const backlogged = [];
  for (const task of tasks) {
    const today = task.when !== "backlog";
    // Today's work gets a slot on the timeline and is an active task;
    // later work and unfixed bugs go to the backlog without one.
    const placement = today
      ? {
          inBacklog: false,
          plannedDate: date,
          plannedStart: minutesToHHMM(task.start),
          plannedEnd: minutesToHHMM(task.end),
          estimateMinutes: task.end - task.start,
          remainingMinutes: task.end - task.start,
        }
      : { inBacklog: true };
    const carried = task.existingKey && byKey.get(task.existingKey);
    if (carried) {
      if (!today && carried.inBacklog) continue; // mentioned as still "later": nothing to change
      Object.assign(carried, placement);
      carried.reporterIds = [...new Set([...carried.reporterIds, ...reporterIds])];
      carried.activity.push({ by: null, type: "note", text: today ? `Scheduled for ${date}` : "Moved to the backlog from the morning overview" });
      (today ? scheduled : backlogged).push(await carried.save());
    } else {
      const issue = await Issue.create({
        key: await newIssueKey(task.projectKey),
        projectKey: task.projectKey,
        type: task.type ?? "Task",
        title: task.title,
        description: task.description,
        priority: task.priority,
        assigneeId: employeeId,
        reporterIds,
        watcherIds: [employeeId],
        dueDate: today ? date : null,
        source: source === "ai" ? "ai" : "manual",
        ...placement,
        activity: [
          { by: null, type: "created", text: today ? "Created from the morning overview" : "Added to the backlog from the morning overview" },
        ],
      });
      (today ? scheduled : backlogged).push(issue);
    }
  }

  const plan = existing ?? new DayPlan({ employeeId, date });
  plan.overview = existing?.overview ? `${existing.overview}\n\n${overview}` : overview;
  plan.plannedAt = plan.plannedAt ?? new Date();
  plan.planSource = source;
  plan.backlogKeys = [...new Set([...plan.backlogKeys, ...backlogged.map((i) => i.key)])];
  await plan.save();

  // One digest to their reporters rather than an email per AI-made issue.
  await dayPlanned(employee, scheduled, { added: Boolean(existing?.plannedAt) });

  res.json(await dayResponse(employeeId, date, plan));
});

/**
 * End-of-day summary -> each ticket updated (status, time, note), then the
 * day is assessed and stored. Tickets from earlier days still In Progress
 * or Blocked are included so carried-over work gets closed too.
 */
workRouter.post("/day/close", async (req, res) => {
  const summary = String(req.body?.summary ?? "").trim();
  if (summary.length < 10) return res.status(400).json({ error: "Write a short summary of the day first." });
  if (summary.length > 5000) return res.status(400).json({ error: "Keep the summary under 5,000 characters." });

  const employeeId = req.employeeId;
  const date = todayISO();
  const plan = await DayPlan.findOne({ employeeId, date });
  if (!plan?.plannedAt) return res.status(400).json({ error: "Plan your day before closing it." });
  if (plan.closedAt) return res.status(409).json({ error: "Today's day is already closed." });

  const [employee, todays, carried] = await Promise.all([
    Employee.findById(employeeId),
    ticketsForDay(employeeId, date),
    Issue.find({
      assigneeId: employeeId,
      plannedDate: { $ne: date },
      status: { $in: ["In Progress", "In Review", "Blocked"] },
    }).limit(20),
  ]);
  const tickets = [...todays, ...carried];
  const { updates, review, newItems = [], source } = await closeDay({ employee, plan, summary, tickets });

  let minutesLogged = 0;
  const movedToBacklog = [];
  for (const ticket of tickets) {
    const u = updates[ticket.key] ?? { status: null, minutes: 0, note: "" };
    if (u.status && u.status !== ticket.status) {
      ticket.activity.push({ by: null, type: "status", text: `${ticket.status} → ${u.status} (end-of-day summary)` });
      ticket.status = u.status;
      ticket.completedAt = u.status === "Done" ? new Date() : null;
    }
    if (u.minutes > 0 || u.note) {
      ticket.timeSpentMinutes += u.minutes;
      if (ticket.remainingMinutes != null) ticket.remainingMinutes = Math.max(0, ticket.remainingMinutes - u.minutes);
      minutesLogged += u.minutes;
      ticket.activity.push({ by: null, type: u.minutes > 0 ? "worklog" : "note", text: u.note, minutes: u.minutes });
    }
    // Unfinished work — including anything the summary didn't mention — goes
    // to the backlog for another day. "In Review" is finished work waiting on
    // someone else, so it stays active. Only when the AI read the summary:
    // without it no status was decided, and everything would be parked.
    if (source === "ai" && ["To Do", "In Progress", "Blocked"].includes(ticket.status) && !ticket.inBacklog) {
      ticket.inBacklog = true;
      movedToBacklog.push(ticket.key);
      ticket.activity.push({ by: null, type: "note", text: "Not finished today — moved to the backlog" });
    }
    await ticket.save();
  }

  // Bugs and follow-ups the summary raised become backlog items.
  const reporterIds = await workReportersFor(employee);
  const defaultProject = await ensureDefaultProject();
  const followUps = [];
  for (const item of newItems) {
    followUps.push(
      await Issue.create({
        key: await newIssueKey(defaultProject.key),
        projectKey: defaultProject.key,
        type: item.type,
        title: item.title,
        description: item.description,
        assigneeId: employeeId,
        reporterIds,
        watcherIds: [employeeId],
        inBacklog: true,
        source: "ai",
        activity: [{ by: null, type: "created", text: "Added to the backlog from the end-of-day summary" }],
      }),
    );
  }
  plan.backlogKeys = [...new Set([...plan.backlogKeys, ...movedToBacklog, ...followUps.map((i) => i.key)])];

  plan.summary = summary;
  plan.closedAt = new Date();
  plan.reviewSource = source;
  plan.review = {
    ...review,
    completed: todays.filter((t) => t.status === "Done").length,
    total: todays.length,
    minutesLogged,
  };
  await plan.save();
  await dayClosed(employee, plan, tickets);

  res.json(await dayResponse(employeeId, date, plan));
});

/**
 * Reopens today's closed day so it can be planned and closed again — for
 * test accounts only, since a real day's review is a record. Tickets keep
 * whatever the review did to them.
 */
workRouter.post("/day/reopen", async (req, res) => {
  const employee = await Employee.findById(req.employeeId, { policyExempt: 1 }).lean();
  if (!employee?.policyExempt) return res.status(403).json({ error: "Only test accounts can reopen a day" });
  const date = todayISO();
  const plan = await DayPlan.findOne({ employeeId: req.employeeId, date });
  if (!plan?.closedAt) return res.status(400).json({ error: "Today isn't closed" });
  plan.closedAt = null;
  plan.summary = "";
  plan.review = null;
  plan.reviewSource = null;
  await plan.save();
  res.json(await dayResponse(req.employeeId, date, plan));
});

/** Day-by-day performance history, newest first. */
workRouter.get("/performance", async (req, res) => {
  const employeeId = String(req.query.employeeId || req.employeeId);
  if (!(await canViewWorkOf(req.employeeId, req.role, employeeId))) {
    return res.status(403).json({ error: "You can't view this person's performance" });
  }
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 180);
  const plans = await DayPlan.find({ employeeId, closedAt: { $ne: null } })
    .sort({ date: -1 })
    .limit(days);
  res.json(plans);
});
