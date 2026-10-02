// Backfills day reviews for past days nobody closed: every day (up to
// yesterday) on which someone had a plan or worked their tickets gets
// reviewed from that activity, exactly like the nightly job. No digest
// emails are sent for these — they'd be a flood of old news.
//
//   node src/scripts/backfillReviews.js [--from 2026-09-01] [--dry-run]
//
// --from defaults to each person's joining date. Days already reviewed are
// skipped, so it's safe to re-run.
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../db.js";
import { Employee } from "../models/Employee.js";
import { DayPlan } from "../models/DayPlan.js";
import { todayISO } from "../lib/helpers.js";
import { autoReviewDay } from "../routes/work.js";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};
const from = arg("--from");
const dryRun = process.argv.includes("--dry-run");

function* daysBetween(start, endExclusive) {
  const d = new Date(`${start}T00:00:00Z`);
  for (;;) {
    const iso = d.toISOString().slice(0, 10);
    if (iso >= endExclusive) return;
    yield iso;
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

await connectDB();
const today = todayISO();
let reviewed = 0;
for (const employee of await Employee.find()) {
  const start = from && from > employee.dateOfJoining ? from : employee.dateOfJoining;
  const done = [];
  for (const date of daysBetween(start, today)) {
    if (dryRun) {
      const plan = await DayPlan.findOne({ employeeId: employee.id, date }, { closedAt: 1 }).lean();
      if (plan && !plan.closedAt) done.push(`${date} (open plan)`);
      continue;
    }
    try {
      if (await autoReviewDay(employee, date, { notify: false })) done.push(date);
    } catch (err) {
      console.error(`  ${employee.id} ${date}: ${err.message}`);
    }
  }
  reviewed += done.length;
  console.log(`${employee.name.padEnd(22)} ${done.length ? done.join(", ") : "nothing to review"}`);
}
console.log(`\n${dryRun ? "Dry run — " : ""}${reviewed} day${reviewed === 1 ? "" : "s"} ${dryRun ? "with open plans" : "reviewed"}.`);
await mongoose.disconnect();
