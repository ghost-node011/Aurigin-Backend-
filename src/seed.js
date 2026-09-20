// Seeds the database with the real Aurigin Media org and nothing else.
//
// There is deliberately no generated attendance, leave, kudos or
// announcement content here: the portal is in real use, so invented rows
// would be indistinguishable from what people actually record. The app
// starts empty and fills up as the team uses it.
import "dotenv/config";
import { connectDB } from "./db.js";
import mongoose from "mongoose";
import { Employee } from "./models/Employee.js";
import { LeaveRequest } from "./models/LeaveRequest.js";
import { WfhRequest } from "./models/WfhRequest.js";
import { AttendanceRecord } from "./models/AttendanceRecord.js";
import { OnboardingTask } from "./models/OnboardingTask.js";
import { Kudos } from "./models/Kudos.js";
import { Announcement } from "./models/Announcement.js";
import { emptyLeaveBalances } from "./lib/constants.js";
import { defaultProbationEnd } from "./lib/helpers.js";
import { hashPassword, generateTempPassword } from "./lib/auth.js";

// `employmentStatus` follows Handbook §4.5: everyone starts on probation
// and is confirmed by an explicit HR action. Arjun and HR are already
// confirmed; anyone whose six months aren't up is left on probation, which
// is what gates leave (§6.4) and tightens the WFH allowance (§1.13).
const SEED_EMPLOYEES = [
  {
    id: "arjun",
    name: "Arjun",
    email: "arjun@auriginmedia.com",
    role: "admin",
    title: "Administrator",
    department: "leadership",
    managerId: null,
    location: "Remote",
    employmentType: "Full-time",
    status: "Active",
    dateOfJoining: "2026-08-10",
    employmentStatus: "Confirmed",
    color: "#013fd2",
  },
  {
    id: "aurigin-media-hr",
    name: "Aurigin Media HR",
    email: "hr@auriginmedia.com",
    role: "hr",
    title: "HR",
    department: "hr",
    managerId: "arjun",
    location: "Remote",
    employmentType: "Full-time",
    status: "Active",
    dateOfJoining: "2026-08-10",
    employmentStatus: "Confirmed",
    color: "#be3a0a",
  },
  {
    id: "gaurank-sharma",
    name: "Gaurank Sharma",
    email: "sharmagaurank63@gmail.com",
    role: "employee",
    title: "Full Stack Developer",
    department: "engineering",
    managerId: "arjun",
    location: "Remote",
    employmentType: "Full-time",
    status: "Active",
    dateOfJoining: "2026-08-10",
    employmentStatus: "Probation",
    color: "#0e7490",
  },
];

async function seed() {
  await connectDB();

  console.log("Clearing existing collections…");
  await Promise.all([
    Employee.deleteMany({}),
    LeaveRequest.deleteMany({}),
    WfhRequest.deleteMany({}),
    AttendanceRecord.deleteMany({}),
    OnboardingTask.deleteMany({}),
    Kudos.deleteMany({}),
    Announcement.deleteMany({}),
  ]);

  console.log("Inserting employees…");
  const credentials = [];
  const employeeDocs = [];
  for (const e of SEED_EMPLOYEES) {
    const tempPassword = generateTempPassword();
    credentials.push({ email: e.email, password: tempPassword });
    employeeDocs.push({
      _id: e.id,
      ...e,
      phone: "",
      // Quotas are recomputed from the joining date on every read, so the
      // stored balances only need to carry `used`.
      leaveBalances: emptyLeaveBalances(),
      probationEndDate: e.employmentStatus === "Probation" ? defaultProbationEnd(e.dateOfJoining) : null,
      confirmedOn: e.employmentStatus === "Confirmed" ? e.dateOfJoining : null,
      passwordHash: await hashPassword(tempPassword),
      mustChangePassword: true,
    });
  }
  await Employee.insertMany(employeeDocs);

  console.log("\nSeed complete. Temporary passwords (shown once — not stored anywhere in plaintext):\n");
  for (const c of credentials) {
    console.log(`  ${c.email.padEnd(30)} ${c.password}`);
  }
  console.log("\nEveryone is flagged mustChangePassword: true — prompt them to change it after first login.\n");

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
