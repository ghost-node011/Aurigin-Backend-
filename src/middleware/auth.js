import { verifyToken } from "../lib/auth.js";
import { Employee } from "../models/Employee.js";

/**
 * Requires a valid `Authorization: Bearer <token>` header. Sets
 * req.employeeId / req.role.
 *
 * The role is read from the employee record, not the token: a token lives
 * for weeks, so trusting its role would leave a promotion (or a demotion)
 * ineffective until the person signed in again. An account that no longer
 * exists is signed out.
 */
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing or invalid Authorization header" });

  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
  const employee = await Employee.findById(payload.sub, { role: 1 }).lean();
  if (!employee) return res.status(401).json({ error: "This account no longer exists" });
  req.employeeId = payload.sub;
  req.role = employee.role;
  next();
}

/** Must run after requireAuth. Only lets the given roles through. */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.role)) return res.status(403).json({ error: "Not allowed for your role" });
    next();
  };
}

/** Must run after requireAuth. Only lets the request through if `req.body[field]` is the caller's own id. */
export function requireSelf(field) {
  return (req, res, next) => {
    if (req.body[field] !== req.employeeId) {
      return res.status(403).json({ error: "You can only do this for yourself" });
    }
    next();
  };
}
