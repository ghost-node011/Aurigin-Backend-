import mongoose from "mongoose";
import { withIdJSON } from "./plugins.js";

const attendanceRecordSchema = new mongoose.Schema({
  employeeId: { type: String, required: true, ref: "Employee" },
  date: { type: String, required: true },
  status: { type: String, enum: ["Present", "WFH", "Half Day", "Absent", "Leave"], required: true },
  // Display strings ("9:15 AM") kept for the UI, alongside minutes past
  // local midnight — the display form can't be compared against a cutoff.
  checkIn: { type: String, default: null },
  checkOut: { type: String, default: null },
  checkInMinutes: { type: Number, default: null },
  checkOutMinutes: { type: Number, default: null },
  hours: { type: Number, default: 0 },

  // Punctuality: set when the recorded time misses the check-in deadline
  // or the check-out floor. `emergency` is the employee claiming one of
  // their limited monthly exceptions for this day, which excuses both.
  lateCheckIn: { type: Boolean, default: false },
  earlyCheckOut: { type: Boolean, default: false },
  emergency: { type: Boolean, default: false },
  emergencyReason: { type: String, default: "" },
});

attendanceRecordSchema.index({ employeeId: 1, date: 1 }, { unique: true });

withIdJSON(attendanceRecordSchema);

export const AttendanceRecord = mongoose.model("AttendanceRecord", attendanceRecordSchema);
