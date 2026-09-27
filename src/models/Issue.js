import mongoose from "mongoose";
import { withIdJSON } from "./plugins.js";

export const ISSUE_TYPES = ["Epic", "Story", "Task", "Bug", "Sub-task"];
export const ISSUE_STATUSES = ["To Do", "In Progress", "In Review", "Blocked", "Done"];
export const ISSUE_PRIORITIES = ["Lowest", "Low", "Medium", "High", "Highest"];

// Jira's link types, stored from this issue's side. Adding one side adds
// its inverse on the other issue, so both pages always agree.
export const LINK_TYPES = {
  blocks: "is blocked by",
  "is blocked by": "blocks",
  "relates to": "relates to",
  duplicates: "is duplicated by",
  "is duplicated by": "duplicates",
  clones: "is cloned by",
  "is cloned by": "clones",
};

// Files live in Cloudinary; only the reference is stored here.
export const attachmentSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    publicId: { type: String, required: true },
    resourceType: { type: String, default: "image" }, // image | video | raw
    name: { type: String, required: true },
    bytes: { type: Number, default: 0 },
    mimeType: { type: String, default: "" },
    uploadedBy: { type: String, required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: true },
);
// Expose `id` like every other API object — the client deletes by it.
attachmentSchema.set("toJSON", {
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    return ret;
  },
});

// Everything that happens to an issue, oldest first.
const activitySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    by: { type: String, default: null }, // employee id, or null for the AI
    type: { type: String, enum: ["created", "status", "field", "worklog", "note", "link", "attachment"], required: true },
    text: { type: String, default: "" },
    minutes: { type: Number, default: 0 },
  },
  { _id: false },
);

const linkSchema = new mongoose.Schema(
  {
    type: { type: String, enum: Object.keys(LINK_TYPES), required: true },
    issueId: { type: mongoose.Schema.Types.ObjectId, ref: "Issue", required: true },
  },
  { _id: true },
);

/**
 * A Jira-style issue, keyed per project (WEB-1, WEB-2, …).
 *
 * `parentId` is the epic for stories/tasks/bugs and the parent issue for a
 * sub-task. Issues made by the AI from someone's "My Day" overview also
 * carry `plannedDate` and a time slot for that day's timeline.
 */
const issueSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    projectKey: { type: String, required: true },
    type: { type: String, enum: ISSUE_TYPES, default: "Task" },
    title: { type: String, required: true },
    description: { type: String, default: "" },
    status: { type: String, enum: ISSUE_STATUSES, default: "To Do" },
    priority: { type: String, enum: ISSUE_PRIORITIES, default: "Medium" },
    labels: { type: [String], default: [] },
    storyPoints: { type: Number, default: null },

    assigneeId: { type: String, default: null, ref: "Employee" },
    // Whoever raised it plus the assignee's work reporters (admins, manager, extras).
    reporterIds: { type: [String], default: [] },
    watcherIds: { type: [String], default: [] },

    parentId: { type: mongoose.Schema.Types.ObjectId, ref: "Issue", default: null },
    sprintId: { type: mongoose.Schema.Types.ObjectId, ref: "Sprint", default: null },
    // Backlog/sprint ordering — lower comes first.
    rank: { type: Number, default: () => Date.now() },
    links: { type: [linkSchema], default: [] },
    attachments: { type: [attachmentSchema], default: [] },

    dueDate: { type: String, default: null },
    // Time tracking, in minutes: estimateMinutes is Jira's original estimate.
    estimateMinutes: { type: Number, default: 0 },
    remainingMinutes: { type: Number, default: null },
    timeSpentMinutes: { type: Number, default: 0 },

    // Set when the issue belongs to someone's day plan.
    plannedDate: { type: String, default: null },
    plannedStart: { type: String, default: null }, // "HH:MM", company time
    plannedEnd: { type: String, default: null },

    completedAt: { type: Date, default: null },
    source: { type: String, enum: ["ai", "manual"], default: "manual" },
    activity: { type: [activitySchema], default: [] },
  },
  { timestamps: true },
);

issueSchema.index({ projectKey: 1, sprintId: 1, rank: 1 });
issueSchema.index({ assigneeId: 1, plannedDate: 1 });
issueSchema.index({ parentId: 1 });

withIdJSON(issueSchema);

export const Issue = mongoose.model("Issue", issueSchema);
