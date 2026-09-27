import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const TOKEN_TTL = "30d";

export function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

export function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function signToken(employee) {
  const secret = requireSecret();
  return jwt.sign({ sub: employee.id ?? employee._id, role: employee.role }, secret, { expiresIn: TOKEN_TTL });
}

export function verifyToken(token) {
  const secret = requireSecret();
  return jwt.verify(token, secret); // throws if invalid/expired
}

function requireSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set — check your .env file");
  return secret;
}

/** Generates a readable random temporary password, e.g. "swift-otter-4821". */
export function generateTempPassword() {
  const words = ["amber", "cedar", "coral", "delta", "ember", "falcon", "granite", "harbor", "ivory", "jasper", "lumen", "otter", "quartz", "raven", "swift", "willow"];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  const digits = Math.floor(1000 + Math.random() * 9000);
  return `${pick()}-${pick()}-${digits}`;
}
