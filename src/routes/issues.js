import { Router } from "express";
import mongoose from "mongoose";
import { Issue, ISSUE_TYPES, ISSUE_STATUSES, ISSUE_PRIORITIES, LINK_TYPES } from "../models/Issue.js";
import { Project, ensureDefaultProject } from "../models/Project.js";
import { Sprint } from "../models/Sprint.js";
import { Comment } from "../models/Comment.js";
import { Employee } from "../models/Employee.js";
import { nextSequence } from "../models/Counter.js";
import { canViewWorkOf, workReportersFor } from "../lib/workday.js";
import { cleanAttachment, destroyUpload } from "../lib/cloudinary.js";
import * as notify from "../lib/notify.js";

export const issuesRouter = Router();

// --- Shared helpers (also used by My Day) ----------------------------------

export async function newIssueKey(projectKey) {
  return `${projectKey}-${await nextSequence(`issue:${projectKey}`)}`;
}

const KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}-\d+$/;

/** Finds an issue by key ("WEB-12") or id; null if neither matches. */
export async function findIssue(idOrKey) {
  const value = String(idOrKey);
  if (KEY_PATTERN.test(value)) return Issue.findOne({ key: value });
  return mongoose.isValidObjectId(value) ? Issue.findById(value) : null;
}

/**
 * Who may change an issue: its assignee, reporters and watchers, the
 * project lead, HR/admin, and the assignee's managers or work reporters.
 * Anyone can read, comment and watch.
 */
async function canEdit(req, issue) {
  if (["admin", "hr"].includes(req.role)) return true;
  const me = req.employeeId;
  if (issue.assigneeId === me || issue.reporterIds.includes(me) || issue.watcherIds.includes(me)) return true;
  const project = await Project.findOne({ key: issue.projectKey }, { leadId: 1 }).lean();
  if (project?.leadId === me) return true;
  return issue.assigneeId ? canViewWorkOf(me, req.role, issue.assigneeId) : false;
}

/**
 * Two quick edits to the same issue (say a status change and a label a
 * moment later) can both load version N and race to save. The loser gets a
 * VersionError; re-running the handler reloads the issue and applies the
 * edit on top of the winner's. Handlers only respond after saving, so a
 * retry never sends twice.
 */
const retryOnConflict = (handler) => async (req, res) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await handler(req, res);
    } catch (err) {
      if (err.name !== "VersionError" || attempt >= 3 || res.headersSent) throw err;
    }
  }
};

const summaryFields = "key title type status priority assigneeId projectKey storyPoints parentId";

const uniq = (list) => [...new Set(list.filter(Boolean))];

// Mentions are written as @[Name](employee-id).
const MENTION = /@\[[^\]]+\]\(([a-z0-9-]+)\)/g;
const mentionIdsIn = (text) => uniq([...String(text).matchAll(MENTION)].map((m) => m[1]));

function cleanLabels(value) {
  if (!Array.isArray(value)) return [];
  return uniq(value.map((l) => String(l).trim().replace(/\s+/g, "-").slice(0, 40))).slice(0, 20);
}

/**
 * Validates a parent for an issue of `type`: sub-tasks need a non-sub-task
 * parent, other issues can only sit under an epic, epics have none.
 * Returns the parent's id, null for "no parent", or an error string.
 */
async function resolveParent(type, parentRef, projectKey) {
  if (!parentRef) return type === "Sub-task" ? "A sub-task needs a parent issue" : null;
  if (type === "Epic") return "An epic can't have a parent";
  const parent = await findIssue(parentRef);
  if (!parent) return "Parent issue not found";
  if (parent.projectKey !== projectKey) return "The parent must be in the same project";
  if (type === "Sub-task" && parent.type === "Sub-task") return "A sub-task can't be the parent of a sub-task";
  if (type !== "Sub-task" && parent.type !== "Epic") return "Only an epic can be the parent of a story, task or bug";
  return parent._id;
}

async function resolveSprint(sprintRef, projectKey) {
  if (!sprintRef) return null;
  if (!mongoose.isValidObjectId(sprintRef)) return "Sprint not found";
  const sprint = await Sprint.findById(sprintRef);
  if (!sprint || sprint.projectKey !== projectKey) return "Sprint not found in this project";
  if (sprint.state === "closed") return "That sprint is already complete";
  return sprint._id;
}

// --- Search -----------------------------------------------------------------

const csv = (v) => (v ? String(v).split(",").map((s) => s.trim()).filter(Boolean) : []);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SORTS = {
  rank: { rank: 1 },
  updated: { updatedAt: -1 },
  created: { createdAt: -1 },
  due: { dueDate: 1 },
  key: { createdAt: 1 },
};

/**
 * Issue search. All params optional and combinable:
 * project, type, status, priority (comma lists), assignee (id, "me" or
 * "unassigned"), reporter, watcher ("me"), label, sprint ("backlog",
 * "active" or an id), parent (key or id), text, sort, limit.
 */
issuesRouter.get("/", async (req, res) => {
  const q = req.query;
  const me = req.employeeId;
  const filter = {};

  const projects = csv(q.project);
  if (projects.length) filter.projectKey = { $in: projects };
  for (const [param, field, allowed] of [
    ["type", "type", ISSUE_TYPES],
    ["status", "status", ISSUE_STATUSES],
    ["priority", "priority", ISSUE_PRIORITIES],
  ]) {
    const values = csv(q[param]).filter((v) => allowed.includes(v));
    if (values.length) filter[field] = { $in: values };
  }
  if (q.assignee) {
    const ids = csv(q.assignee).map((a) => (a === "me" ? me : a === "unassigned" ? null : a));
    filter.assigneeId = { $in: ids };
  }
  if (q.reporter) filter.reporterIds = q.reporter === "me" ? me : String(q.reporter);
  if (q.watcher) filter.watcherIds = q.watcher === "me" ? me : String(q.watcher);
  const labels = csv(q.label);
  if (labels.length) filter.labels = { $in: labels };

  if (q.sprint === "backlog") filter.sprintId = null;
  else if (q.sprint === "active") {
    const active = await Sprint.find({ state: "active", ...(projects.length && { projectKey: { $in: projects } }) }, { _id: 1 });
    filter.sprintId = { $in: active.map((s) => s._id) };
  } else if (q.sprint && mongoose.isValidObjectId(q.sprint)) filter.sprintId = q.sprint;

  if (q.parent) {
    const parent = await findIssue(q.parent);
    filter.parentId = parent?._id ?? null;
  }
  if (q.text) {
    const re = new RegExp(escapeRegex(String(q.text).trim()).slice(0, 100), "i");
    filter.$or = [{ key: re }, { title: re }, { description: re }];
  }

  const limit = Math.min(Math.max(Number(q.limit) || 300, 1), 1000);
  const issues = await Issue.find(filter)
    .select("-activity -description -links")
    .sort(SORTS[q.sort] ?? SORTS.rank)
    .limit(limit);
  res.json(issues);
});

/** Every label in use, for autocomplete. */
issuesRouter.get("/labels", async (_req, res) => {
  res.json((await Issue.distinct("labels")).sort());
});

// --- Read one ---------------------------------------------------------------

/** The full issue with its parent, children, links and sprint resolved. */
async function expand(issue) {
  const [parent, children, linked, sprint] = await Promise.all([
    issue.parentId ? Issue.findById(issue.parentId).select(summaryFields) : null,
    Issue.find({ parentId: issue._id }).select(summaryFields).sort({ rank: 1 }),
    Issue.find({ _id: { $in: issue.links.map((l) => l.issueId) } }).select(summaryFields),
    issue.sprintId ? Sprint.findById(issue.sprintId) : null,
  ]);
  const byId = new Map(linked.map((i) => [i.id, i]));
  return {
    ...issue.toJSON(),
    parent,
    children,
    sprint,
    links: issue.links
      .map((l) => ({ id: l.id, type: l.type, issue: byId.get(String(l.issueId)) }))
      .filter((l) => l.issue),
  };
}

issuesRouter.get("/:ref", async (req, res) => {
  const issue = await findIssue(req.params.ref);
  if (!issue) return res.status(404).json({ error: "Issue not found" });
  res.json(await expand(issue));
});

// --- Create -----------------------------------------------------------------

issuesRouter.post("/", async (req, res) => {
  const body = req.body ?? {};
  const title = String(body.title ?? "").trim();
  if (!title) return res.status(400).json({ error: "Summary is required" });

  const projectKey = body.projectKey || (await ensureDefaultProject()).key;
  const project = await Project.findOne({ key: projectKey, archived: false });
  if (!project) return res.status(404).json({ error: "Project not found" });

  const type = ISSUE_TYPES.includes(body.type) ? body.type : "Task";
  const parentId = await resolveParent(type, body.parentId, projectKey);
  if (typeof parentId === "string") return res.status(400).json({ error: parentId });
  // Sub-tasks travel with their parent's sprint; epics span sprints, so they're never in one.
  let sprintId = null;
  if (type === "Epic") sprintId = null;
  else if (type === "Sub-task") sprintId = (await Issue.findById(parentId, { sprintId: 1 }))?.sprintId ?? null;
  else sprintId = await resolveSprint(body.sprintId, projectKey);
  if (typeof sprintId === "string") return res.status(400).json({ error: sprintId });

  const assignee = body.assigneeId ? await Employee.findById(body.assigneeId) : null;
  if (body.assigneeId && !assignee) return res.status(404).json({ error: "Assignee not found" });

  const attachments = (Array.isArray(body.attachments) ? body.attachments : [])
    .map((a) => cleanAttachment(a, req.employeeId))
    .filter(Boolean);

  const issue = await Issue.create({
    key: await newIssueKey(projectKey),
    projectKey,
    type,
    title: title.slice(0, 255),
    description: String(body.description ?? "").trim(),
    priority: ISSUE_PRIORITIES.includes(body.priority) ? body.priority : "Medium",
    labels: cleanLabels(body.labels),
    storyPoints: body.storyPoints === "" || body.storyPoints == null ? null : Math.max(0, Number(body.storyPoints) || 0),
    assigneeId: assignee?.id ?? null,
    reporterIds: uniq([req.employeeId, ...(assignee ? await workReportersFor(assignee) : [])]),
    watcherIds: uniq([req.employeeId, assignee?.id, ...mentionIdsIn(body.description)]),
    parentId,
    sprintId,
    dueDate: body.dueDate || null,
    estimateMinutes: Math.max(0, Math.round(Number(body.estimateMinutes) || 0)),
    remainingMinutes: body.estimateMinutes ? Math.max(0, Math.round(Number(body.estimateMinutes))) : null,
    attachments,
    activity: [{ by: req.employeeId, type: "created", text: `Created ${type.toLowerCase()}` }],
  });
  await notify.issueCreated(issue, req.employeeId);
  res.status(201).json(await expand(issue));
});

// --- Update -----------------------------------------------------------------

/**
 * Applies one edit to an issue, saves it and sends the notifications the
 * change calls for. Shared by the single-issue PATCH and bulk edit.
 * Returns null on success, or { status, error }.
 */
async function applyUpdate(req, issue, body) {
  const by = req.employeeId;
  const log = (text, type = "field") => issue.activity.push({ by, type, text });
  // Who was involved before this edit, to email only the newly added.
  const before = {
    assigneeId: issue.assigneeId,
    reporterIds: [...issue.reporterIds],
    status: issue.status,
    mentionIds: mentionIdsIn(issue.description),
  };

  if (body.title !== undefined) {
    const title = String(body.title).trim();
    if (!title) return { status: 400, error: "Summary can't be empty" };
    if (title !== issue.title) log(`Summary changed to "${title.slice(0, 80)}"`);
    issue.title = title.slice(0, 255);
  }
  if (body.description !== undefined) {
    issue.description = String(body.description).trim();
    issue.watcherIds = uniq([...issue.watcherIds, ...mentionIdsIn(issue.description)]);
    log("Description updated");
  }
  if (body.type !== undefined && body.type !== issue.type) {
    if (!ISSUE_TYPES.includes(body.type)) return { status: 400, error: "Invalid issue type" };
    // Changing type can invalidate the parent, so re-check it.
    const parentId = await resolveParent(body.type, body.parentId !== undefined ? body.parentId : issue.parentId, issue.projectKey);
    if (typeof parentId === "string") return { status: 400, error: parentId };
    log(`Type ${issue.type} → ${body.type}`);
    issue.type = body.type;
    issue.parentId = parentId;
  } else if (body.parentId !== undefined) {
    const parentId = await resolveParent(issue.type, body.parentId, issue.projectKey);
    if (typeof parentId === "string") return { status: 400, error: parentId };
    if (parentId && String(parentId) === issue.id) return { status: 400, error: "An issue can't be its own parent" };
    log(parentId ? "Parent changed" : "Parent removed");
    issue.parentId = parentId;
  }
  if (body.status !== undefined && body.status !== issue.status) {
    if (!ISSUE_STATUSES.includes(body.status)) return { status: 400, error: "Invalid status" };
    log(`${issue.status} → ${body.status}`, "status");
    issue.status = body.status;
    issue.completedAt = body.status === "Done" ? new Date() : null;
    if (body.status === "Done" && issue.remainingMinutes != null) issue.remainingMinutes = 0;
  }
  if (body.priority !== undefined && body.priority !== issue.priority) {
    if (!ISSUE_PRIORITIES.includes(body.priority)) return { status: 400, error: "Invalid priority" };
    log(`Priority ${issue.priority} → ${body.priority}`);
    issue.priority = body.priority;
  }
  if (body.labels !== undefined) {
    issue.labels = cleanLabels(body.labels);
    log(`Labels: ${issue.labels.join(", ") || "none"}`);
  }
  if (body.storyPoints !== undefined) {
    issue.storyPoints = body.storyPoints === "" || body.storyPoints == null ? null : Math.max(0, Number(body.storyPoints) || 0);
    log(`Story points: ${issue.storyPoints ?? "none"}`);
  }
  if (body.dueDate !== undefined) {
    issue.dueDate = body.dueDate || null;
    log(`Due date: ${issue.dueDate ?? "none"}`);
  }
  if (body.estimateMinutes !== undefined) {
    issue.estimateMinutes = Math.max(0, Math.round(Number(body.estimateMinutes) || 0));
    if (issue.remainingMinutes == null) issue.remainingMinutes = Math.max(0, issue.estimateMinutes - issue.timeSpentMinutes);
    log(`Original estimate: ${issue.estimateMinutes}m`);
  }
  if (body.remainingMinutes !== undefined) {
    issue.remainingMinutes = body.remainingMinutes == null ? null : Math.max(0, Math.round(Number(body.remainingMinutes) || 0));
  }
  if (body.assigneeId !== undefined && body.assigneeId !== issue.assigneeId) {
    const next = body.assigneeId ? await Employee.findById(body.assigneeId) : null;
    if (body.assigneeId && !next) return { status: 404, error: "Assignee not found" };
    // The new assignee and their overseers join; nobody already involved is dropped.
    if (next) {
      issue.reporterIds = uniq([...issue.reporterIds, ...(await workReportersFor(next))]);
      issue.watcherIds = uniq([...issue.watcherIds, next.id]);
    }
    log(next ? `Assigned to ${next.name}` : "Unassigned");
    issue.assigneeId = next?.id ?? null;
  }
  if (body.reporterIds !== undefined) {
    const ids = uniq(Array.isArray(body.reporterIds) ? body.reporterIds.map(String) : []);
    if ((await Employee.countDocuments({ _id: { $in: ids } })) !== ids.length) {
      return { status: 400, error: "Unknown reporter" };
    }
    issue.reporterIds = ids;
    log("Reporters updated");
  }
  if (issue.type === "Epic") issue.sprintId = null;
  else if (body.sprintId !== undefined && issue.type !== "Sub-task") {
    const sprintId = await resolveSprint(body.sprintId, issue.projectKey);
    if (typeof sprintId === "string") return { status: 400, error: sprintId };
    if (String(sprintId) !== String(issue.sprintId)) {
      log(sprintId ? "Moved to a sprint" : "Moved to the backlog");
      issue.sprintId = sprintId;
      await Issue.updateMany({ parentId: issue._id, type: "Sub-task" }, { sprintId });
    }
  }
  if (body.rank !== undefined && Number.isFinite(Number(body.rank))) issue.rank = Number(body.rank);

  const minutes = Math.round(Number(body.logMinutes) || 0);
  if (minutes < 0 || minutes > 24 * 60) return { status: 400, error: "Logged time must be 0–1440 minutes" };
  if (minutes > 0 || body.note?.trim()) {
    issue.timeSpentMinutes += minutes;
    if (issue.remainingMinutes != null) issue.remainingMinutes = Math.max(0, issue.remainingMinutes - minutes);
    issue.activity.push({ by, type: minutes > 0 ? "worklog" : "note", text: String(body.note ?? "").trim().slice(0, 500), minutes });
  }

  await issue.save();

  const newAssignee = issue.assigneeId !== before.assigneeId ? issue.assigneeId : null;
  const newReporters = issue.reporterIds.filter((id) => !before.reporterIds.includes(id));
  const newMentions = mentionIdsIn(issue.description).filter((id) => !before.mentionIds.includes(id));
  await Promise.all([
    (newAssignee || newReporters.length) &&
      notify.issuePeopleAdded(issue, by, { assigneeId: newAssignee, reporterIds: newReporters }),
    issue.status !== before.status && notify.issueStatusChanged(issue, by, before.status),
    newMentions.length &&
      notify.commentAdded(issue, { authorId: by, body: issue.description, attachments: [] }, { mentionIds: newMentions, isEdit: true }),
  ]);
  return null;
}

issuesRouter.patch("/:ref", retryOnConflict(async (req, res) => {
  const issue = await findIssue(req.params.ref);
  if (!issue) return res.status(404).json({ error: "Issue not found" });
  if (!(await canEdit(req, issue))) {
    return res.status(403).json({ error: "Only the assignee, reporters, watchers, project lead, their manager or HR can edit this issue" });
  }

  const failed = await applyUpdate(req, issue, req.body ?? {});
  if (failed) return res.status(failed.status).json({ error: failed.error });
  res.json(await expand(issue));
}));

const BULK_FIELDS = ["status", "priority", "assigneeId", "sprintId", "labels", "dueDate"];

/**
 * Bulk edit: the same change applied to many issues. Each issue gets the
 * normal permission check and edit; the result lists what succeeded and
 * why anything didn't.
 */
issuesRouter.post("/bulk", async (req, res) => {
  const { issueIds, changes } = req.body ?? {};
  if (!Array.isArray(issueIds) || issueIds.length === 0 || issueIds.length > 200) {
    return res.status(400).json({ error: "Pick between 1 and 200 issues" });
  }
  const body = Object.fromEntries(Object.entries(changes ?? {}).filter(([k]) => BULK_FIELDS.includes(k)));
  if (Object.keys(body).length === 0) return res.status(400).json({ error: "Nothing to change" });

  const results = [];
  for (const id of issueIds) {
    const result = await retryOnConflict(async () => {
      const issue = await findIssue(id);
      if (!issue) return { id, error: "Not found" };
      if (!(await canEdit(req, issue))) return { id, key: issue.key, error: "You can't edit this issue" };
      const failed = await applyUpdate(req, issue, body);
      return failed ? { id, key: issue.key, error: failed.error } : { id, key: issue.key, ok: true };
    })(req, res);
    results.push(result);
  }
  res.json({ updated: results.filter((r) => r.ok).length, results });
});

/** Reorders issues and moves them between the backlog and sprints in one go (backlog drag-and-drop). */
issuesRouter.post("/rank", async (req, res) => {
  const { issueIds, sprintId } = req.body ?? {};
  if (!Array.isArray(issueIds) || issueIds.length === 0 || issueIds.length > 500) {
    return res.status(400).json({ error: "issueIds must be a non-empty list" });
  }
  const issues = await Issue.find({ _id: { $in: issueIds.filter((id) => mongoose.isValidObjectId(id)) } });
  if (issues.length !== issueIds.length) return res.status(404).json({ error: "Some issues weren't found" });
  const projectKey = issues[0].projectKey;
  if (issues.some((i) => i.projectKey !== projectKey)) return res.status(400).json({ error: "Issues must be in one project" });
  const target = sprintId === undefined ? undefined : await resolveSprint(sprintId, projectKey);
  if (typeof target === "string") return res.status(400).json({ error: target });

  // Spread ranks out so a single later move can slot between two neighbours.
  const base = Date.now();
  await Promise.all(
    issueIds.map(async (id, i) => {
      const update = { rank: base + i * 1000 };
      if (target !== undefined) update.sprintId = target;
      await Issue.updateOne({ _id: id }, update);
      if (target !== undefined) await Issue.updateMany({ parentId: id, type: "Sub-task" }, { sprintId: target });
    }),
  );
  res.json({ ok: true });
});

// --- Delete -----------------------------------------------------------------

/** HR/admin, the project lead or whoever created it. Sub-tasks go with it; epic children are unparented. */
issuesRouter.delete("/:ref", async (req, res) => {
  const issue = await findIssue(req.params.ref);
  if (!issue) return res.status(404).json({ error: "Issue not found" });
  const project = await Project.findOne({ key: issue.projectKey }, { leadId: 1 }).lean();
  const creator = issue.activity.find((a) => a.type === "created")?.by;
  if (!["admin", "hr"].includes(req.role) && req.employeeId !== creator && req.employeeId !== project?.leadId) {
    return res.status(403).json({ error: "Only the creator, project lead or HR/admin can delete an issue" });
  }

  const subtasks = await Issue.find({ parentId: issue._id, type: "Sub-task" });
  const doomed = [issue, ...subtasks];
  const ids = doomed.map((i) => i._id);
  const comments = await Comment.find({ issueId: { $in: ids } });
  for (const file of [...doomed.flatMap((i) => i.attachments), ...comments.flatMap((c) => c.attachments)]) {
    await destroyUpload(file.publicId, file.resourceType);
  }
  await Promise.all([
    Issue.updateMany({ parentId: issue._id }, { parentId: null }),
    Issue.updateMany({ "links.issueId": { $in: ids } }, { $pull: { links: { issueId: { $in: ids } } } }),
    Comment.deleteMany({ issueId: { $in: ids } }),
    Issue.deleteMany({ _id: { $in: ids } }),
  ]);
  res.status(204).end();
});

// --- Watchers, links, attachments ------------------------------------------

issuesRouter.post("/:ref/watch", retryOnConflict(async (req, res) => {
  const issue = await findIssue(req.params.ref);
  if (!issue) return res.status(404).json({ error: "Issue not found" });
  const watch = req.body?.watch !== false;
  issue.watcherIds = watch
    ? uniq([...issue.watcherIds, req.employeeId])
    : issue.watcherIds.filter((id) => id !== req.employeeId);
  await issue.save();
  res.json({ watcherIds: issue.watcherIds });
}));

issuesRouter.post("/:ref/links", retryOnConflict(async (req, res) => {
  const issue = await findIssue(req.params.ref);
  if (!issue) return res.status(404).json({ error: "Issue not found" });
  if (!(await canEdit(req, issue))) return res.status(403).json({ error: "You can't edit this issue" });
  const { type, issueKey } = req.body ?? {};
  if (!LINK_TYPES[type]) return res.status(400).json({ error: "Unknown link type" });
  const other = await findIssue(issueKey);
  if (!other) return res.status(404).json({ error: `Issue ${issueKey} not found` });
  if (other.id === issue.id) return res.status(400).json({ error: "An issue can't link to itself" });
  if (issue.links.some((l) => String(l.issueId) === other.id && l.type === type)) {
    return res.json(await expand(issue));
  }
  issue.links.push({ type, issueId: other._id });
  other.links.push({ type: LINK_TYPES[type], issueId: issue._id });
  issue.activity.push({ by: req.employeeId, type: "link", text: `${type} ${other.key}` });
  other.activity.push({ by: req.employeeId, type: "link", text: `${LINK_TYPES[type]} ${issue.key}` });
  await Promise.all([issue.save(), other.save()]);
  res.json(await expand(issue));
}));

issuesRouter.delete("/:ref/links/:linkId", retryOnConflict(async (req, res) => {
  const issue = await findIssue(req.params.ref);
  if (!issue) return res.status(404).json({ error: "Issue not found" });
  if (!(await canEdit(req, issue))) return res.status(403).json({ error: "You can't edit this issue" });
  const link = issue.links.id(req.params.linkId);
  if (!link) return res.status(404).json({ error: "Link not found" });
  await Issue.updateOne(
    { _id: link.issueId },
    { $pull: { links: { issueId: issue._id, type: LINK_TYPES[link.type] } } },
  );
  link.deleteOne();
  await issue.save();
  res.json(await expand(issue));
}));

issuesRouter.post("/:ref/attachments", retryOnConflict(async (req, res) => {
  const issue = await findIssue(req.params.ref);
  if (!issue) return res.status(404).json({ error: "Issue not found" });
  const files = (Array.isArray(req.body?.attachments) ? req.body.attachments : [])
    .map((a) => cleanAttachment(a, req.employeeId))
    .filter(Boolean);
  if (files.length === 0) return res.status(400).json({ error: "No valid attachments" });
  issue.attachments.push(...files);
  issue.activity.push({ by: req.employeeId, type: "attachment", text: `Attached ${files.map((f) => f.name).join(", ")}` });
  issue.watcherIds = uniq([...issue.watcherIds, req.employeeId]);
  await issue.save();
  res.json(await expand(issue));
}));

issuesRouter.delete("/:ref/attachments/:attachmentId", retryOnConflict(async (req, res) => {
  const issue = await findIssue(req.params.ref);
  if (!issue) return res.status(404).json({ error: "Issue not found" });
  const file = issue.attachments.id(req.params.attachmentId);
  if (!file) return res.status(404).json({ error: "Attachment not found" });
  if (file.uploadedBy !== req.employeeId && !(await canEdit(req, issue))) {
    return res.status(403).json({ error: "You can't remove this attachment" });
  }
  await destroyUpload(file.publicId, file.resourceType);
  issue.activity.push({ by: req.employeeId, type: "attachment", text: `Removed ${file.name}` });
  file.deleteOne();
  await issue.save();
  res.json(await expand(issue));
}));

// --- Comments ---------------------------------------------------------------

issuesRouter.get("/:ref/comments", async (req, res) => {
  const issue = await findIssue(req.params.ref);
  if (!issue) return res.status(404).json({ error: "Issue not found" });
  res.json(await Comment.find({ issueId: issue._id }).sort({ createdAt: 1 }));
});

issuesRouter.post("/:ref/comments", retryOnConflict(async (req, res) => {
  const issue = await findIssue(req.params.ref);
  if (!issue) return res.status(404).json({ error: "Issue not found" });
  const body = String(req.body?.body ?? "").trim();
  const attachments = (Array.isArray(req.body?.attachments) ? req.body.attachments : [])
    .map((a) => cleanAttachment(a, req.employeeId))
    .filter(Boolean);
  if (!body && attachments.length === 0) return res.status(400).json({ error: "Write a comment or attach a file" });
  if (body.length > 10_000) return res.status(400).json({ error: "Comments are limited to 10,000 characters" });

  const mentionIds = mentionIdsIn(body);
  const comment = await Comment.create({ issueId: issue._id, authorId: req.employeeId, body, mentionIds, attachments });
  // Commenting or being mentioned means you'll want to follow the issue.
  issue.watcherIds = uniq([...issue.watcherIds, req.employeeId, ...mentionIds]);
  await issue.save();
  await notify.commentAdded(issue, comment);
  res.status(201).json(comment);
}));

export const commentsRouter = Router();

commentsRouter.patch("/:id", async (req, res) => {
  const comment = mongoose.isValidObjectId(req.params.id) ? await Comment.findById(req.params.id) : null;
  if (!comment) return res.status(404).json({ error: "Comment not found" });
  if (comment.authorId !== req.employeeId) return res.status(403).json({ error: "You can only edit your own comments" });
  const body = String(req.body?.body ?? "").trim();
  if (!body) return res.status(400).json({ error: "Comment can't be empty" });
  const previousMentions = comment.mentionIds;
  comment.body = body.slice(0, 10_000);
  comment.mentionIds = mentionIdsIn(comment.body);
  comment.editedAt = new Date();
  await comment.save();
  await Issue.updateOne({ _id: comment.issueId }, { $addToSet: { watcherIds: { $each: comment.mentionIds } } });
  // Only people newly mentioned by the edit hear about it.
  const added = comment.mentionIds.filter((id) => !previousMentions.includes(id));
  if (added.length) {
    const issue = await Issue.findById(comment.issueId);
    if (issue) await notify.commentAdded(issue, comment, { mentionIds: added, isEdit: true });
  }
  res.json(comment);
});

commentsRouter.delete("/:id", async (req, res) => {
  const comment = mongoose.isValidObjectId(req.params.id) ? await Comment.findById(req.params.id) : null;
  if (!comment) return res.status(404).json({ error: "Comment not found" });
  if (comment.authorId !== req.employeeId && !["admin", "hr"].includes(req.role)) {
    return res.status(403).json({ error: "You can only delete your own comments" });
  }
  for (const file of comment.attachments) await destroyUpload(file.publicId, file.resourceType);
  await comment.deleteOne();
  res.status(204).end();
});
