import mongoose from "mongoose";
import { withIdJSON } from "./plugins.js";

const employeeSchema = new mongoose.Schema(
  {
    // Slug (e.g. "gaurank-sharma") used as the primary key, matching the
    // ids the rest of the app's data (managerId, employeeId FKs) already
    // reference — avoids a second id scheme just for this collection.
    _id: { type: String },
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },
    mustChangePassword: { type: Boolean, default: true },
    role: { type: String, enum: ["admin", "hr", "manager", "employee"], default: "employee" },
    title: { type: String, required: true },
    department: { type: String, required: true },
    managerId: { type: String, default: null },
    location: { type: String, default: "" },
    employmentType: { type: String, default: "Full-time" },
    status: { type: String, enum: ["Active", "Onboarding"], default: "Active" },
    // Handbook §1.8 / §4.5 — probation is the initial assessment period
    // (six months by default); confirmation is a deliberate HR action, so
    // this never flips on its own. It gates leave (§6.4), which is why it's
    // separate from `status` (onboarding vs active) rather than folded
    // into it.
    employmentStatus: { type: String, enum: ["Probation", "Confirmed"], default: "Probation" },
    probationEndDate: { type: String, default: null },
    confirmedOn: { type: String, default: null },
    dateOfJoining: { type: String, required: true },
    phone: { type: String, default: "" },
    color: { type: String, default: "#013fd2" },
  },
  { timestamps: true, _id: false },
);

withIdJSON(employeeSchema, ["passwordHash"]);

export const Employee = mongoose.model("Employee", employeeSchema);
