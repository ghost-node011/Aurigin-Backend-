// Seeds the database with the real Aurigin Media org — mirrors the shape
// (and generation logic) of the frontend's former in-memory seed data, so
// numbers look the same as what the app showed before it had a backend.
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
import { emptyLeaveBalances, LEAVE_TYPE_QUOTAS, buildOnboardingTasks } from "./lib/constants.js";
import { todayISO, daysBetweenInclusive } from "./lib/helpers.js";
import { hashPassword, generateTempPassword } from "./lib/auth.js";

function seededRandom(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function toISODate(date) {
  return date.toISOString().slice(0, 10);
}

function isWeekend(date) {
  const day = date.getDay();
  return day === 0 || day === 6;
}

function iso(offsetDays) {
  return toISODate(addDays(new Date(), offsetDays));
}

function minutesToTime(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

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
    color: "#be3a0a",
  },
  {
    id: "avantika",
    name: "Avantika",
    email: "avantika@auriginmedia.com",
    role: "employee",
    title: "Team Member",
    department: "leadership",
    managerId: "arjun",
    location: "Remote",
    employmentType: "Full-time",
    status: "Active",
    dateOfJoining: "2026-08-10",
    color: "#013fd2",
  },
  {
    id: "gaurank-sharma",
    name: "Gaurank Sharma",
    email: "gaurank@auriginmedia.com",
    role: "employee",
    title: "Full Stack Developer",
    department: "engineering",
    managerId: "arjun",
    location: "Remote",
    employmentType: "Full-time",
    status: "Active",
    dateOfJoining: "2026-08-10",
    color: "#0e7490",
  },
  {
    id: "sam-demo",
    name: "Sam",
    email: "sam@auriginmedia.com",
    role: "employee",
    title: "New Team Member",
    department: "leadership",
    managerId: "arjun",
    location: "Remote",
    employmentType: "Full-time",
    status: "Onboarding",
    dateOfJoining: todayISO(),
    color: "#013fd2",
  },
];

function generateLeaveBalances(employeeId) {
  const rand = seededRandom(employeeId + ":leave");
  const balances = emptyLeaveBalances();
  for (const type of Object.keys(LEAVE_TYPE_QUOTAS)) {
    balances[type].used = Math.round(rand() * LEAVE_TYPE_QUOTAS[type] * 0.55);
  }
  return balances;
}

function generateAttendanceFor(employee, leaveRequests) {
  const rand = seededRandom(employee.id + ":attendance");
  const records = [];

  for (let offset = -14; offset < 0; offset++) {
    const date = addDays(new Date(), offset);
    if (isWeekend(date)) continue;
    const dateIso = toISODate(date);

    if (employee.status === "Onboarding" && dateIso < employee.dateOfJoining) continue;

    const onLeave = leaveRequests.find(
      (r) => r.employeeId === employee.id && r.status === "Approved" && r.startDate <= dateIso && dateIso <= r.endDate,
    );
    if (onLeave) {
      records.push({ employeeId: employee.id, date: dateIso, status: "Leave", checkIn: null, checkOut: null, hours: 0 });
      continue;
    }

    const roll = rand();
    let status = "Present";
    if (roll > 0.97) status = "Absent";
    else if (roll > 0.88) status = "Half Day";
    else if (roll > 0.72) status = "WFH";

    if (status === "Absent") {
      records.push({ employeeId: employee.id, date: dateIso, status, checkIn: null, checkOut: null, hours: 0 });
      continue;
    }

    const checkInMinute = 9 * 60 + Math.round(rand() * 45);
    const isHalf = status === "Half Day";
    const checkOutMinute = isHalf ? 13 * 60 + Math.round(rand() * 30) : 18 * 60 + Math.round(rand() * 75);
    const hours = Math.round(((checkOutMinute - checkInMinute) / 60) * 10) / 10;

    records.push({
      employeeId: employee.id,
      date: dateIso,
      status,
      checkIn: minutesToTime(checkInMinute),
      checkOut: minutesToTime(checkOutMinute),
      hours,
    });
  }

  return records;
}

function leaveRequest(id, employeeId, type, startOffset, endOffset, status, reason, approverId, approverComment) {
  const startDate = iso(startOffset);
  const endDate = iso(endOffset);
  return {
    employeeId,
    type,
    startDate,
    endDate,
    days: daysBetweenInclusive(startDate, endDate),
    status,
    reason,
    appliedOn: iso(Math.min(startOffset, 0) - 2),
    approverId,
    approverComment: approverComment ?? null,
  };
}

const LEAVE_REQUESTS = [
  leaveRequest("lr-1", "gaurank-sharma", "casual", 5, 6, "Pending", "Family function back home", "arjun"),
  leaveRequest("lr-2", "avantika", "sick", 1, 1, "Pending", "Fever, resting at home", "arjun"),
  leaveRequest("lr-3", "aurigin-media-hr", "earned", -10, -8, "Approved", "Family trip", "arjun", "Enjoy the trip!"),
];

const KUDOS = [
  {
    fromId: "arjun",
    toIds: ["gaurank-sharma"],
    value: "excellence",
    message: "Gaurank shipped the new HR portal a full week early and it looks fantastic. Huge win for the team.",
    date: iso(-1),
    likedBy: ["aurigin-media-hr", "avantika"],
  },
  {
    fromId: "arjun",
    toIds: ["aurigin-media-hr"],
    value: "ownership",
    message: "HR ran onboarding for the team this month without missing a single step. Amazing ownership.",
    date: iso(-2),
    likedBy: ["avantika"],
  },
  {
    fromId: "aurigin-media-hr",
    toIds: ["avantika"],
    value: "teamwork",
    message: "Avantika jumped in to help coordinate this quarter's launch under a tight deadline. Great collaboration.",
    date: iso(-3),
    likedBy: ["arjun"],
  },
];

const ANNOUNCEMENTS = [
  {
    title: "Welcome to the new Aurigin People portal!",
    body: "This is the internal HR portal for Aurigin Media — track attendance, leave, onboarding, recognition, and more, all in one place.",
    category: "general",
    authorId: "arjun",
    date: iso(-1),
    pinned: true,
  },
  {
    title: "Updated work-from-home policy",
    body: "WFH requests can be raised directly from the Attendance tab and no longer require a separate email to HR. Full policy details are in the employee handbook.",
    category: "policy",
    authorId: "aurigin-media-hr",
    date: iso(-5),
    pinned: false,
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
      leaveBalances: generateLeaveBalances(e.id),
      passwordHash: await hashPassword(tempPassword),
      mustChangePassword: true,
    });
  }
  await Employee.insertMany(employeeDocs);

  console.log("Inserting leave requests…");
  await LeaveRequest.insertMany(LEAVE_REQUESTS);

  console.log("Inserting onboarding tasks…");
  const onboardingEmployees = SEED_EMPLOYEES.filter((e) => e.status === "Onboarding");
  for (const e of onboardingEmployees) {
    await OnboardingTask.insertMany(buildOnboardingTasks(e.id));
  }

  console.log("Generating attendance history…");
  const attendanceRecords = SEED_EMPLOYEES.flatMap((e) => generateAttendanceFor(e, LEAVE_REQUESTS));
  await AttendanceRecord.insertMany(attendanceRecords);

  console.log("Inserting kudos & announcements…");
  await Kudos.insertMany(KUDOS);
  await Announcement.insertMany(ANNOUNCEMENTS);

  console.log("\nSeed complete. Temporary passwords (shown once — not stored anywhere in plaintext):\n");
  for (const c of credentials) {
    console.log(`  ${c.email.padEnd(28)} ${c.password}`);
  }
  console.log("\nEveryone is flagged mustChangePassword: true — prompt them to change it after first login.\n");

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
