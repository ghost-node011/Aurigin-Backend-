import mongoose from "mongoose";
import { withIdJSON } from "./plugins.js";

const onboardingTaskSchema = new mongoose.Schema({
  newHireId: { type: String, required: true, ref: "Employee" },
  category: { type: String, required: true },
  title: { type: String, required: true },
  owner: { type: String, enum: ["self", "hr", "it", "manager"], required: true },
  status: { type: String, enum: ["Pending", "In Progress", "Done"], default: "Pending" },
  // What was done, by whom — e.g. "Dell Latitude 5440, S/N 7XK2…" or
  // "PAN verified against original". No documents or ID numbers are stored.
  note: { type: String, default: "" },
  updatedBy: { type: String, default: null },
  updatedAt: { type: Date, default: null },
});

withIdJSON(onboardingTaskSchema);

export const OnboardingTask = mongoose.model("OnboardingTask", onboardingTaskSchema);
