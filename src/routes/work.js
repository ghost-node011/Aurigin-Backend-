import { Router } from "express";
import { DayPlan } from "../models/DayPlan.js";
import { Issue } from "../models/Issue.js";
import { Comment } from "../models/Comment.js";
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
  // Opening your own day reviews any recent day you forgot to summarise.
  if (employeeId === req.employeeId) {
    const me = await Employee.findById(employeeId);
    if (me) await catchUpReviews(me);
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

  const employee = await Employee.findById(employeeId);
  await finishDay({ employee, date, plan, summary });
  res.json(await dayResponse(employeeId, date, plan));
});

/**
 * Closes a day: applies the review of `summary` to the day's tickets, moves
 * unfinished work to the backlog, files follow-ups, stores the review and
 * notifies reporters. Shared by the end-of-day summary and the automatic
 * review of a day nobody summarised (`auto`), where the summary is compiled
 * from ticket activity and the tickets' recorded statuses are kept as fact.
 */
export async function finishDay({ employee, date, plan, summary, auto = false, extraTickets = [] }) {
  const employeeId = employee.id;
  const [todays, carried] = await Promise.all([
    ticketsForDay(employeeId, date),
    Issue.find({
      assigneeId: employeeId,
      plannedDate: { $ne: date },
      status: { $in: ["In Progress", "In Review", "Blocked"] },
    }).limit(20),
  ]);
  const seen = new Set();
  const tickets = [...todays, ...carried, ...extraTickets].filter((t) => !seen.has(t.key) && seen.add(t.key));
  const { updates, review, newItems = [], source } = await closeDay({ employee, plan, summary, tickets, auto });

  let minutesLogged = 0;
  const movedToBacklog = [];
  for (const ticket of tickets) {
    const u = updates[ticket.key] ?? { status: null, minutes: 0, note: "" };
    // In an automatic review the recorded status is what happened; only a
    // written summary can say otherwise.
    if (!auto && u.status && u.status !== ticket.status) {
      ticket.activity.push({ by: null, type: "status", text: `${ticket.status} → ${u.status} (end-of-day summary)` });
      ticket.status = u.status;
      ticket.completedAt = u.status === "Done" ? new Date() : null;
    }
    if (u.minutes > 0 || (!auto && u.note)) {
      ticket.timeSpentMinutes += u.minutes;
      if (ticket.remainingMinutes != null) ticket.remainingMinutes = Math.max(0, ticket.remainingMinutes - u.minutes);
      minutesLogged += u.minutes;
      ticket.activity.push({ by: null, type: u.minutes > 0 ? "worklog" : "note", text: u.note, minutes: u.minutes });
    }
    // Unfinished planned work — including anything the summary didn't
    // mention — goes to the backlog for another day. "In Review" is finished
    // work waiting on someone else, so it stays active. Only when the AI read
    // the day: without it no status was decided, and everything would be parked.
    const planned = ticket.plannedDate === date || !auto;
    if (source === "ai" && planned && ["To Do", "In Progress", "Blocked"].includes(ticket.status) && !ticket.inBacklog) {
      ticket.inBacklog = true;
      movedToBacklog.push(ticket.key);
      ticket.activity.push({ by: null, type: "note", text: `Not finished on ${date} — moved to the backlog` });
    }
    await ticket.save();
  }

  // Bugs and follow-ups the summary raised become backlog items.
  const reporterIds = await workReportersFor(employee);
  const defaultProject = await ensureDefaultProject();
  const followUps = [];
  for (const item of auto ? [] : newItems) {
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
  plan.reviewSource = auto ? (source === "ai" ? "auto" : "fallback") : source;
  plan.review = {
    ...review,
    completed: todays.filter((t) => t.status === "Done").length,
    total: todays.length,
    minutesLogged,
  };
  await plan.save();
  await dayClosed(employee, plan, tickets, { auto });
}

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

// --- Automatic review of days nobody summarised ------------------------------
//
// People who just work their tickets and never write an end-of-day summary
// still get a day reviewed: the summary is compiled from what they actually
// did on their tickets that day. Runs at 6:30 pm IST from Vercel Cron, and catches
// up on any missed day (the last week) whenever someone opens My Day.

/** The UTC instants bounding a company-time (IST) calendar day. */
function dayBounds(date) {
  const start = new Date(`${date}T00:00:00+05:30`);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

function previousDays(date, n) {
  const out = [];
  const d = new Date(`${date}T00:00:00Z`);
  for (let i = 1; i <= n; i++) {
    d.setUTCDate(d.getUTCDate() - 1);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

const minutesText = (m) => [Math.floor(m / 60) && `${Math.floor(m / 60)}h`, m % 60 && `${m % 60}m`].filter(Boolean).join(" ");

/**
 * What `employee` did on their own tickets on `date`: their status changes,
 * time logged, notes and issues they created, and comments they wrote on
 * them. Other people's actions don't count as this person's day — a
 * manager creating a task for someone is the manager's doing, and isn't by
 * itself a reason to review the manager's day. Returns the log lines and
 * the issues involved.
 */
async function activityOn(employee, date) {
  const { start, end } = dayBounds(date);
  const inDay = { $gte: start, $lt: end };
  const [issues, comments] = await Promise.all([
    Issue.find({ assigneeId: employee.id, activity: { $elemMatch: { at: inDay, by: employee.id } } }),
    Comment.find({ authorId: employee.id, createdAt: inDay }, { issueId: 1 }).lean(),
  ]);
  const lines = [];
  for (const issue of issues) {
    const entries = issue.activity.filter((a) => a.at >= start && a.at < end && a.by === employee.id);
    for (const a of entries) {
      if (a.type === "created") lines.push(`Created ${issue.key} "${issue.title}"`);
      else if (a.type === "status") lines.push(`${issue.key} "${issue.title}": ${a.text}`);
      else if (a.type === "worklog") lines.push(`${issue.key}: logged ${minutesText(a.minutes)}${a.text ? ` — ${a.text}` : ""}`);
      else if (a.type === "note" && a.text) lines.push(`${issue.key}: ${a.text}`);
    }
  }
  // Comments count on their own tickets (including ones with no other activity today).
  const commented = comments.length
    ? await Issue.find({ _id: { $in: comments.map((c) => c.issueId) }, assigneeId: employee.id })
    : [];
  const mine = comments.filter((c) => commented.some((i) => String(i._id) === String(c.issueId)));
  if (mine.length) {
    const keys = commented;
    lines.push(`Commented ${mine.length} time${mine.length === 1 ? "" : "s"} on ${[...new Set(keys.map((k) => k.key))].join(", ")}`);
  }
  const all = new Map([...issues, ...commented].map((i) => [i.key, i]));
  return { lines, issues: [...all.values()] };
}

/**
 * Reviews `date` for `employee` from their ticket activity, unless the day
 * was already closed or there's nothing to review (no plan and no activity).
 * Returns true when a review was made.
 */
export async function autoReviewDay(employee, date) {
  const existing = await DayPlan.findOne({ employeeId: employee.id, date });
  if (existing?.closedAt) return false;
  const { lines, issues } = await activityOn(employee, date);
  if (!existing && lines.length === 0) return false;
  const plan = existing ?? new DayPlan({ employeeId: employee.id, date, planSource: "fallback" });
  const summary = lines.length ? lines.join("\n") : "No ticket activity was recorded on this day.";
  await finishDay({ employee, date, plan, summary, auto: true, extraTickets: issues });
  return true;
}

/** Catches up on the last week of unreviewed days for one employee (not today). */
export async function catchUpReviews(employee, today = todayISO()) {
  for (const date of previousDays(today, 7)) {
    try {
      await autoReviewDay(employee, date);
    } catch (err) {
      console.error(`Auto review failed for ${employee.id} on ${date}:`, err.message);
    }
  }
}

/**
 * Daily job at 6:30 pm IST (Vercel Cron → GET /api/cron/auto-review): reviews today for
 * everyone who didn't close it, plus any missed days. Protected by
 * CRON_SECRET, which Vercel sends as a bearer token.
 */
export const cronRouter = Router();

cronRouter.get("/auto-review", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const today = todayISO();
  const employees = await Employee.find();
  let reviewed = 0;
  for (const employee of employees) {
    try {
      if (await autoReviewDay(employee, today)) reviewed++;
      await catchUpReviews(employee, today);
    } catch (err) {
      console.error(`Auto review failed for ${employee.id}:`, err.message);
    }
  }
  res.json({ ok: true, date: today, reviewed });
});
