import mongoose from "mongoose";
import { withIdJSON } from "./plugins.js";
import { LEAVE_TYPES } from "../lib/constants.js";

const leaveRequestSchema = new mongoose.Schema({
  employeeId: { type: String, required: true, ref: "Employee" },
  type: { type: String, enum: LEAVE_TYPES, required: true },
  startDate: { type: String, required: true },
  endDate: { type: String, required: true },
  days: { type: Number, required: true },
  status: { type: String, enum: ["Pending", "Approved", "Rejected"], default: "Pending" },
  reason: { type: String, default: "" },
  // Requested inside the handbook's notice period (§6.12 "except in
  // genuine emergencies") — shown to the approver.
  emergency: { type: Boolean, default: false },
  appliedOn: { type: String, required: true },
  approverId: { type: String, default: null },
  approverComment: { type: String, default: null },
});

withIdJSON(leaveRequestSchema);

export const LeaveRequest = mongoose.model("LeaveRequest", leaveRequestSchema);
