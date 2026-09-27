import mongoose from "mongoose";
import { withIdJSON } from "./plugins.js";

// One issue as it stood when its sprint closed. `type` needs the explicit
// { type: String } form — a bare `type: String` key would be read as the
// subdocument's own type.
const snapshotSchema = new mongoose.Schema(
  {
    issueId: mongoose.Schema.Types.ObjectId,
    key: String,
    title: String,
    type: { type: String },
    status: String,
    storyPoints: Number,
    assigneeId: String,
    completedAt: Date,
  },
  { _id: false },
);

/** A Scrum sprint within a project. At most one is active per project. */
const sprintSchema = new mongoose.Schema(
  {
    projectKey: { type: String, required: true },
    name: { type: String, required: true },
    goal: { type: String, default: "" },
    state: { type: String, enum: ["future", "active", "closed"], default: "future" },
    startDate: { type: String, default: null },
    endDate: { type: String, default: null },
    completedAt: { type: Date, default: null },
    // Snapshot on completion, for the sprint report.
    completedIssueCount: { type: Number, default: 0 },
    incompleteIssueCount: { type: Number, default: 0 },
    // What was in the sprint when it closed — unfinished issues move on, so
    // this is the only record of them for the report.
    snapshot: { type: [snapshotSchema], default: [] },
  },
  { timestamps: true },
);

sprintSchema.index({ projectKey: 1, state: 1 });

withIdJSON(sprintSchema);

export const Sprint = mongoose.model("Sprint", sprintSchema);
