import mongoose from "mongoose";
import { withIdJSON } from "./plugins.js";

/**
 * One employee's working day: the morning overview the AI turned into
 * tickets, and the end-of-day summary it used to close them and assess the
 * day. One per employee per date.
 */
const reviewSchema = new mongoose.Schema(
  {
    score: { type: Number, min: 0, max: 100, default: null }, // out of 100
    rating: { type: String, default: "" }, // e.g. "Strong", "Steady", "Needs attention"
    completed: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    minutesLogged: { type: Number, default: 0 },
    highlights: { type: [String], default: [] },
    improvements: { type: [String], default: [] },
    feedback: { type: String, default: "" },
  },
  { _id: false },
);

const dayPlanSchema = new mongoose.Schema(
  {
    employeeId: { type: String, required: true, ref: "Employee" },
    date: { type: String, required: true },

    overview: { type: String, default: "" },
    plannedAt: { type: Date, default: null },
    planSource: { type: String, enum: ["ai", "fallback"], default: "ai" },

    summary: { type: String, default: "" },
    closedAt: { type: Date, default: null },
    reviewSource: { type: String, enum: ["ai", "fallback", null], default: null },
    review: { type: reviewSchema, default: null },

    // Issues this day sent to the backlog — later work from the overview,
    // unfinished work and follow-ups from the summary.
    backlogKeys: { type: [String], default: [] },
  },
  { timestamps: true },
);

dayPlanSchema.index({ employeeId: 1, date: 1 }, { unique: true });

withIdJSON(dayPlanSchema);

export const DayPlan = mongoose.model("DayPlan", dayPlanSchema);
