import mongoose from "mongoose";
import { withIdJSON } from "./plugins.js";

/** A Jira-style project: its key prefixes every issue in it (WEB-12). */
const projectSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, match: /^[A-Z][A-Z0-9]{1,9}$/ },
    name: { type: String, required: true },
    description: { type: String, default: "" },
    leadId: { type: String, required: true, ref: "Employee" },
    archived: { type: Boolean, default: false },
  },
  { timestamps: true },
);

withIdJSON(projectSchema);

export const Project = mongoose.model("Project", projectSchema);

// Work planned in "My Day" lands here unless someone picks another project.
export const DEFAULT_PROJECT = { key: "AUR", name: "Aurigin", description: "General work across Aurigin Media." };

/** The default project, created on first use. */
export async function ensureDefaultProject() {
  const existing = await Project.findOne({ key: DEFAULT_PROJECT.key });
  if (existing) return existing;
  const admin = await mongoose.model("Employee").findOne({ role: "admin" }).sort({ createdAt: 1 });
  return Project.create({ ...DEFAULT_PROJECT, leadId: admin?.id ?? "arjun" });
}
