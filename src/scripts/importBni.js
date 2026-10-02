// Imports BNI member leads from the forwardly-leads databases into the
// portal's BNI section.
//
//   node src/scripts/importBni.js --source-env /path/to/forwardly-leads/server/.env
//        [--per-category 1000] [--fraction 0.5] [--fill-email-to 1000] [--dry-run]
//
// Reads both forwardly clusters (BNI_MONGODB_URI, the current one, then
// MONGODB_URI, the original), de-duplicated by BNI userId. Only members
// whose Indian origin is provable are taken — country recorded as India,
// an Indian mobile number, or an .in email — because the source's isIndian
// flag defaults to true and is set on members with no location at all.
// Within each category, members with both phone and email come first, then
// phone, then email, up to --per-category, or --fraction of the verified
// pool (e.g. 0.5 for the best half). --fill-email-to then tops each
// category up to that many with email contacts whose country isn't
// recorded — never anyone with a recorded foreign country or a foreign
// email domain — marked verifiedIndian: false. Re-running updates in place.
import "dotenv/config";
import mongoose from "mongoose";
import dotenv from "dotenv";
import { connectDB } from "../db.js";
import { BniContact, BNI_CATEGORIES } from "../models/BniContact.js";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const sourceEnv = arg("--source-env");
const perCategory = Number(arg("--per-category", 1000));
const fraction = arg("--fraction") ? Number(arg("--fraction")) : null;
const fillEmailTo = arg("--fill-email-to") ? Number(arg("--fill-email-to")) : null;

// Country-code TLDs of other countries: an email on one of these isn't an
// Indian member's, whatever else the record says. (.com, .net etc. are
// neutral and allowed.)
const FOREIGN_TLD = /\.(us|uk|co\.uk|au|com\.au|ca|de|fr|it|es|nl|be|ch|at|se|no|dk|fi|ie|pt|pl|br|com\.br|mx|ar|cl|co|za|ae|sa|qa|kw|om|bh|sg|com\.sg|my|com\.my|th|ph|id|vn|cn|hk|tw|jp|kr|nz|pk|bd|lk|np|ng|ke|eg|ma|tr|ru|ua|il|gr|ro|hu|cz)$/i;
const dryRun = process.argv.includes("--dry-run");
if (!sourceEnv) {
  console.error("Usage: node src/scripts/importBni.js --source-env <forwardly .env> [--per-category N] [--dry-run]");
  process.exit(1);
}
const source = dotenv.parse(await import("node:fs").then((fs) => fs.readFileSync(sourceEnv)));
const sourceUris = [source.BNI_MONGODB_URI, source.MONGODB_URI].filter(Boolean);

const digits = (s) => String(s ?? "").replace(/\D/g, "");
const indianMobile = (s) => /^(91|0)?[6-9]\d{9}$/.test(digits(s));
const formatIndian = (s) => {
  if (!s) return "";
  const d = digits(s);
  return indianMobile(s) ? `+91 ${d.slice(-10, -5)} ${d.slice(-5)}` : String(s).trim();
};
const indianEmail = (s) => /\.(in|co\.in|org\.in|net\.in|ac\.in|gov\.in)$/i.test(String(s ?? "").trim());

function indianEvidence(d) {
  const by = [];
  if (d.country === "India") by.push("country");
  if (indianMobile(d.mobileNumber) || indianMobile(d.phoneNumber)) by.push("phone");
  if (indianEmail(d.emailAddress)) by.push("email");
  // A recorded foreign country outweighs anything else.
  return d.country && d.country !== "India" ? [] : by;
}

const recordedForeign = (d) => (d.country && d.country !== "India") || FOREIGN_TLD.test(String(d.emailAddress ?? "").trim());

const projection = {
  userId: 1, industryKeyword: 1, displayName: 1, firstName: 1, lastName: 1, roleInfo: 1, companyName: 1,
  phoneNumber: 1, mobileNumber: 1, emailAddress: 1, websiteUrl: 1, city: 1, state: 1, country: 1,
  memberChapter: 1, business: 1, keywords: 1,
};

async function run() {
  const conns = [];
  for (const uri of sourceUris) conns.push(await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 20000, family: 4 }).asPromise());

  const picked = [];
  for (const category of BNI_CATEGORIES) {
    const byId = new Map();
    for (const c of conns) {
      for (const d of await c.db.collection("bnileads").find({ industryKeyword: category }, { projection }).toArray()) {
        if (!byId.has(d.userId)) byId.set(d.userId, d);
      }
    }
    const toContact = ({ d, by }) => {
        const mobile = formatIndian(d.mobileNumber);
        const phone = formatIndian(d.phoneNumber);
        const email = String(d.emailAddress ?? "").trim().toLowerCase();
        return {
          sourceId: d.userId,
          category,
          name: (d.displayName || `${d.firstName ?? ""} ${d.lastName ?? ""}`).trim(),
          company: d.companyName ?? "",
          role: d.roleInfo ?? "",
          mobile,
          phone: phone === mobile ? "" : phone,
          email,
          website: d.websiteUrl ?? "",
          city: d.city ?? "",
          state: d.state ?? "",
          country: "India",
          chapter: d.memberChapter ?? "",
          business: d.business ?? "",
          keywords: d.keywords ?? "",
          hasPhone: Boolean(mobile || phone),
          hasEmail: Boolean(email),
          indianBy: by,
          verifiedIndian: by.length > 0,
        };
      };
    const all = [...byId.values()].map((d) => ({ d, by: indianEvidence(d) }));
    const verified = all.filter((x) => x.by.length > 0).map(toContact);
    const rank = (x) => (x.hasPhone && x.hasEmail ? 0 : x.hasPhone ? 1 : x.hasEmail ? 2 : 3);
    verified.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    const limit = fraction ? Math.round(verified.length * fraction) : perCategory;
    const take = verified.slice(0, limit);
    if (fillEmailTo && take.length < fillEmailTo) {
      const taken = new Set(take.map((t) => t.sourceId));
      const fill = all
        .filter((x) => x.by.length === 0 && !taken.has(x.d.userId) && String(x.d.emailAddress ?? "").includes("@") && !recordedForeign(x.d))
        .map(toContact)
        // Fuller records first: a company name, then a website.
        .sort((a, b) => Boolean(b.company) - Boolean(a.company) || Boolean(b.website) - Boolean(a.website) || a.name.localeCompare(b.name));
      take.push(...fill.slice(0, fillEmailTo - take.length));
    }
    const pct = (n) => (take.length ? `${Math.round((n / take.length) * 100)}%` : "—");
    const v = take.filter((x) => x.verifiedIndian).length;
    console.log(
      `${category.padEnd(18)} ${String(take.length).padStart(4)} total = ${String(v).padStart(4)} verified Indian + ${String(take.length - v).padStart(4)} email fill-ins` +
        ` | phone ${pct(take.filter((x) => x.hasPhone).length)} | email ${pct(take.filter((x) => x.hasEmail).length)}`,
    );
    picked.push(...take);
  }
  for (const c of conns) await c.close();

  if (dryRun) {
    console.log(`\nDry run — ${picked.length} contacts would be imported.`);
    return;
  }
  await connectDB();
  const ops = picked.map((p) => ({ updateOne: { filter: { sourceId: p.sourceId }, update: { $set: p }, upsert: true } }));
  for (let i = 0; i < ops.length; i += 500) await BniContact.bulkWrite(ops.slice(i, i + 500));
  console.log(`\nImported ${picked.length} contacts (${await BniContact.countDocuments()} in the BNI section now).`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("BNI import failed:", err.message);
  process.exit(1);
});
