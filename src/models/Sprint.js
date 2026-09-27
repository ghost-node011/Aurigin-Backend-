import mongoose from "mongoose";
import { withIdJSON } from "./plugins.js";

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
  },
  { timestamps: true },
);

sprintSchema.index({ projectKey: 1, state: 1 });

withIdJSON(sprintSchema);

export const Sprint = mongoose.model("Sprint", sprintSchema);
