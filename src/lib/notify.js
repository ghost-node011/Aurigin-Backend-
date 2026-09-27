import { Employee } from "../models/Employee.js";
import { sendMail, renderEmail, appUrl } from "./mailer.js";
import { workReportersFor } from "./workday.js";
import { formatDay } from "./constants.js";

// Every email the portal sends, in one place. Each function works out its
// recipients, skips whoever caused the event, and never throws — callers
// await it so serverless functions don't freeze mid-send, but a mail
// failure never fails the request.

async function people(ids) {
  const list = await Employee.find({ _id: { $in: [...new Set(ids.filter(Boolean))] } }, { name: 1, email: 1, role: 1 }).lean();
  return new Map(list.map((e) => [e._id, e]));
}

const firstName = (e) => e?.name?.split(" ")[0] ?? "there";
// Mentions are stored as @[Name](id); emails show them as plain @Name.
const plain = (text) => String(text ?? "").replace(/@\[([^\]]+)\]\([a-z0-9-]+\)/g, "@$1");
const clip = (text, n = 600) => {
  const t = plain(text).trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

async function safely(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`Notification failed (${label}):`, err.message);
  }
}

async function sendEach(recipients, build) {
  await Promise.all(recipients.map((r) => sendMail({ to: r.email, ...build(r) })));
}

// --- Issues -------------------------------------------------------------------

function issueRows(issue, byId) {
  return [
    ["Type", issue.type],
    ["Status", issue.status],
    ["Priority", issue.priority],
    ["Assignee", issue.assigneeId ? byId.get(issue.assigneeId)?.name : "Unassigned"],
    ["Due", issue.dueDate ? formatDay(issue.dueDate) : null],
  ];
}

const issueAction = (issue) => ({ label: `Open ${issue.key}`, url: appUrl(`/browse/${issue.key}`) });

/** A new issue: its assignee and reporters hear about it (not whoever created it). */
export function issueCreated(issue, actorId) {
  return safely("issue created", async () => {
    const byId = await people([actorId, issue.assigneeId, ...issue.reporterIds]);
    const actor = byId.get(actorId);
    const recipients = [...new Set([issue.assigneeId, ...issue.reporterIds])]
      .filter((id) => id && id !== actorId)
      .map((id) => byId.get(id))
      .filter(Boolean);
    await sendEach(recipients, (r) => {
      const role = r._id === issue.assigneeId ? "It's assigned to you." : "You're a reporter on it.";
      return {
        subject: `[${issue.key}] ${issue.title}`,
        ...renderEmail({
          heading: `${actor?.name ?? "Someone"} created ${issue.key}`,
          intro: `Hi ${firstName(r)}, a new ${issue.type.toLowerCase()} was created: "${issue.title}". ${role}`,
          rows: issueRows(issue, byId),
          quote: clip(issue.description),
          action: issueAction(issue),
        }),
      };
    });
  });
}

/** Someone was made assignee or added as a reporter on an existing issue. */
export function issuePeopleAdded(issue, actorId, { assigneeId, reporterIds = [] }) {
  return safely("issue people added", async () => {
    const byId = await people([actorId, issue.assigneeId, assigneeId, ...reporterIds]);
    const actor = byId.get(actorId);
    const sends = [];
    if (assigneeId && assigneeId !== actorId && byId.get(assigneeId)) {
      const r = byId.get(assigneeId);
      sends.push(
        sendMail({
          to: r.email,
          subject: `[${issue.key}] Assigned to you: ${issue.title}`,
          ...renderEmail({
            heading: `${issue.key} is now assigned to you`,
            intro: `Hi ${firstName(r)}, ${actor?.name ?? "someone"} assigned "${issue.title}" to you.`,
            rows: issueRows(issue, byId),
            action: issueAction(issue),
          }),
        }),
      );
    }
    for (const id of reporterIds) {
      const r = byId.get(id);
      if (!r || id === actorId || id === assigneeId) continue;
      sends.push(
        sendMail({
          to: r.email,
          subject: `[${issue.key}] You're a reporter on: ${issue.title}`,
          ...renderEmail({
            heading: `You were added to ${issue.key}`,
            intro: `Hi ${firstName(r)}, ${actor?.name ?? "someone"} added you as a reporter on "${issue.title}".`,
            rows: issueRows(issue, byId),
            action: issueAction(issue),
          }),
        }),
      );
    }
    await Promise.all(sends);
  });
}

/** A manual status change: the assignee and reporters are told (not whoever moved it). */
export function issueStatusChanged(issue, actorId, from) {
  return safely("issue status", async () => {
    const byId = await people([actorId, issue.assigneeId, ...issue.reporterIds]);
    const actor = byId.get(actorId);
    const recipients = [...new Set([issue.assigneeId, ...issue.reporterIds])]
      .filter((id) => id && id !== actorId)
      .map((id) => byId.get(id))
      .filter(Boolean);
    await sendEach(recipients, (r) => ({
      subject: `[${issue.key}] ${from} → ${issue.status}: ${issue.title}`,
      ...renderEmail({
        heading: `${issue.key} moved to ${issue.status}`,
        intro: `Hi ${firstName(r)}, ${actor?.name ?? "someone"} moved "${issue.title}" from ${from} to ${issue.status}.`,
        rows: issueRows(issue, byId),
        action: issueAction(issue),
      }),
    }));
  });
}

/**
 * A new comment. People @mentioned get a "you were mentioned" email; the
 * assignee and reporters get the comment. Nobody gets both, and the author
 * gets neither.
 */
export function commentAdded(issue, comment, { mentionIds = comment.mentionIds, isEdit = false } = {}) {
  return safely("comment", async () => {
    const authorId = comment.authorId;
    const involved = isEdit ? [] : [issue.assigneeId, ...issue.reporterIds];
    const byId = await people([authorId, ...mentionIds, ...involved]);
    const author = byId.get(authorId);
    const mentioned = new Set(mentionIds.filter((id) => id !== authorId));
    const sends = [];
    for (const id of mentioned) {
      const r = byId.get(id);
      if (!r) continue;
      sends.push(
        sendMail({
          to: r.email,
          subject: `[${issue.key}] ${author?.name ?? "Someone"} mentioned you`,
          ...renderEmail({
            heading: `${author?.name ?? "Someone"} mentioned you on ${issue.key}`,
            intro: `Hi ${firstName(r)}, you were mentioned on "${issue.title}".`,
            quote: clip(comment.body),
            action: issueAction(issue),
          }),
        }),
      );
    }
    for (const id of new Set(involved)) {
      const r = byId.get(id);
      if (!r || id === authorId || mentioned.has(id)) continue;
      sends.push(
        sendMail({
          to: r.email,
          subject: `[${issue.key}] New comment from ${author?.name ?? "someone"}`,
          ...renderEmail({
            heading: `New comment on ${issue.key}`,
            intro: `Hi ${firstName(r)}, ${author?.name ?? "someone"} commented on "${issue.title}".`,
            quote: clip(comment.body) || (comment.attachments?.length ? `(${comment.attachments.length} attachment(s))` : ""),
            action: issueAction(issue),
          }),
        }),
      );
    }
    await Promise.all(sends);
  });
}

// --- My Day -----------------------------------------------------------------

/** One digest to the employee's work reporters instead of an email per AI-made issue. */
export function dayPlanned(employee, tickets, { added = false } = {}) {
  return safely("day planned", async () => {
    const reporterIds = await workReportersFor(employee);
    const byId = await people(reporterIds);
    const list = tickets
      .map((t) => `${t.plannedStart ?? ""}${t.plannedEnd ? `–${t.plannedEnd}` : ""}  ${t.key}  ${t.title}`.trim())
      .join("\n");
    await sendEach([...byId.values()], (r) => ({
      subject: `${employee.name} ${added ? "added to" : "planned"} their day — ${tickets.length} task${tickets.length === 1 ? "" : "s"}`,
      ...renderEmail({
        heading: `${employee.name}'s plan for today`,
        intro: `Hi ${firstName(r)}, ${employee.name} ${added ? "added work to" : "planned"} their day in My Day. You're getting this as one of their work reporters.`,
        quote: list,
        action: { label: "View their day", url: appUrl(`/performance`) },
      }),
    }));
  });
}

/** The end-of-day review, to the employee's work reporters. */
export function dayClosed(employee, plan, tickets) {
  return safely("day closed", async () => {
    const reporterIds = await workReportersFor(employee);
    const byId = await people(reporterIds);
    const review = plan.review ?? {};
    const list = tickets.map((t) => `[${t.status}]  ${t.key}  ${t.title}`).join("\n");
    await sendEach([...byId.values()], (r) => ({
      subject: `${employee.name} closed their day — ${review.completed ?? 0}/${review.total ?? 0} done${review.score != null ? `, ${review.score}/10` : ""}`,
      ...renderEmail({
        heading: `${employee.name}'s day in review`,
        intro: `Hi ${firstName(r)}, ${employee.name} wrapped up today.${review.feedback ? ` ${review.feedback}` : ""}`,
        rows: [
          ["Score", review.score != null ? `${review.score} / 10${review.rating ? ` (${review.rating})` : ""}` : null],
          ["Tickets done", `${review.completed ?? 0} of ${review.total ?? 0}`],
          ["Time logged", review.minutesLogged ? `${Math.floor(review.minutesLogged / 60)}h ${review.minutesLogged % 60}m` : null],
        ],
        quote: `${clip(plan.summary, 800)}\n\n${list}`,
        action: { label: "See performance", url: appUrl(`/performance`) },
      }),
    }));
  });
}

// --- Leave & work from home -------------------------------------------------

/** Approvers: the request's approver (their manager), or HR/admin when they have none. */
async function approversFor(request) {
  if (request.approverId) return [request.approverId];
  const list = await Employee.find({ role: { $in: ["admin", "hr"] } }, { _id: 1 }).lean();
  return list.map((e) => e._id);
}

const LEAVE_NAMES = {
  earned: "Earned leave",
  casual: "Casual leave",
  sick: "Sick leave",
  menstrual: "Menstrual leave",
  optional: "Optional holiday",
  marriage: "Marriage leave",
  paternity: "Paternity leave",
  lwp: "Leave without pay",
};

export function leaveRequested(request) {
  return safely("leave requested", async () => {
    const approverIds = await approversFor(request);
    const byId = await people([request.employeeId, ...approverIds]);
    const employee = byId.get(request.employeeId);
    const type = LEAVE_NAMES[request.type] ?? request.type;
    await sendEach(approverIds.map((id) => byId.get(id)).filter((r) => r && r._id !== request.employeeId), (r) => ({
      subject: `Leave request: ${employee?.name} — ${type}, ${request.days} day${request.days === 1 ? "" : "s"}${request.emergency ? " (emergency)" : ""}`,
      ...renderEmail({
        heading: `${employee?.name} requested ${type.toLowerCase()}`,
        intro: `Hi ${firstName(r)}, this is waiting for your approval.${request.emergency ? " It was raised inside the notice period as an emergency." : ""}`,
        rows: [
          ["Type", type],
          ["Dates", request.startDate === request.endDate ? formatDay(request.startDate) : `${formatDay(request.startDate)} – ${formatDay(request.endDate)}`],
          ["Days", request.days],
        ],
        quote: request.reason,
        action: { label: "Review request", url: appUrl("/leave") },
      }),
    }));
  });
}

export function leaveDecided(request, deciderId) {
  return safely("leave decided", async () => {
    const byId = await people([request.employeeId, deciderId]);
    const employee = byId.get(request.employeeId);
    if (!employee || request.employeeId === deciderId) return;
    const type = LEAVE_NAMES[request.type] ?? request.type;
    const approved = request.status === "Approved";
    await sendMail({
      to: employee.email,
      subject: `Your ${type.toLowerCase()} was ${approved ? "approved" : "declined"}`,
      ...renderEmail({
        heading: approved ? "Your leave is approved" : "Your leave request was declined",
        intro: `Hi ${firstName(employee)}, ${byId.get(deciderId)?.name ?? "your manager"} ${approved ? "approved" : "declined"} your ${type.toLowerCase()}.`,
        rows: [
          ["Dates", request.startDate === request.endDate ? formatDay(request.startDate) : `${formatDay(request.startDate)} – ${formatDay(request.endDate)}`],
          ["Days", request.days],
        ],
        quote: request.approverComment ? `Comment: ${request.approverComment}` : "",
        action: { label: "View your leave", url: appUrl("/leave") },
      }),
    });
  });
}

export function wfhRequested(request, { sameDay = false } = {}) {
  return safely("wfh requested", async () => {
    const approverIds = await approversFor(request);
    const byId = await people([request.employeeId, ...approverIds]);
    const employee = byId.get(request.employeeId);
    await sendEach(approverIds.map((id) => byId.get(id)).filter((r) => r && r._id !== request.employeeId), (r) => ({
      subject: sameDay
        ? `${employee?.name} is working from home today`
        : `WFH request: ${employee?.name} — ${formatDay(request.date)}`,
      ...renderEmail({
        heading: sameDay ? `${employee?.name} marked work from home today` : `${employee?.name} requested to work from home`,
        intro: sameDay
          ? `Hi ${firstName(r)}, ${employee?.name} marked today (${formatDay(request.date)}) as work from home${request.checkIn ? `, checking in at ${request.checkIn}` : ""}. No action is needed — this is for your information.`
          : `Hi ${firstName(r)}, this is waiting for your approval.`,
        rows: [["Date", formatDay(request.date)]],
        quote: request.reason,
        action: { label: sameDay ? "View attendance" : "Review request", url: appUrl("/attendance") },
      }),
    }));
  });
}

export function wfhDecided(request, deciderId) {
  return safely("wfh decided", async () => {
    const byId = await people([request.employeeId, deciderId]);
    const employee = byId.get(request.employeeId);
    if (!employee || request.employeeId === deciderId) return;
    const approved = request.status === "Approved";
    await sendMail({
      to: employee.email,
      subject: `Work from home on ${formatDay(request.date)} ${approved ? "approved" : "declined"}`,
      ...renderEmail({
        heading: approved ? "Your work-from-home day is approved" : "Your work-from-home request was declined",
        intro: `Hi ${firstName(employee)}, ${byId.get(deciderId)?.name ?? "your manager"} ${approved ? "approved" : "declined"} working from home on ${formatDay(request.date)}.`,
        quote: request.approverComment ? `Comment: ${request.approverComment}` : "",
        action: { label: "View attendance", url: appUrl("/attendance") },
      }),
    });
  });
}

