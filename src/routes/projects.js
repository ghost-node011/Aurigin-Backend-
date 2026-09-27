import { Router } from "express";
import { Project, ensureDefaultProject } from "../models/Project.js";
import { Employee } from "../models/Employee.js";

export const projectsRouter = Router();

/** Admins, plus anyone an admin has given the project-manager permission. */
export async function canManageProjects(req) {
  if (req.role === "admin") return true;
  const me = await Employee.findById(req.employeeId, { canManageProjects: 1 }).lean();
  return Boolean(me?.canManageProjects);
}

projectsRouter.get("/", async (_req, res) => {
  await ensureDefaultProject();
  res.json(await Project.find().sort({ archived: 1, createdAt: 1 }));
});

/** Project managers create projects. The key is fixed once chosen — it's in every issue key. */
projectsRouter.post("/", async (req, res) => {
  if (!(await canManageProjects(req))) {
    return res.status(403).json({ error: "Only project managers can create projects — ask an admin for access" });
  }
  const key = String(req.body?.key ?? "").trim().toUpperCase();
  const name = String(req.body?.name ?? "").trim();
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(key)) {
    return res.status(400).json({ error: "Key must be 2–10 letters or digits, starting with a letter (e.g. WEB)" });
  }
  if (!name) return res.status(400).json({ error: "Project name is required" });
  if (await Project.exists({ key })) return res.status(409).json({ error: `A project with key ${key} already exists` });
  const leadId = req.body?.leadId || req.employeeId;
  if (!(await Employee.exists({ _id: leadId }))) return res.status(404).json({ error: "Project lead not found" });

  const project = await Project.create({ key, name, description: String(req.body?.description ?? "").trim(), leadId });
  res.status(201).json(project);
});

projectsRouter.patch("/:key", async (req, res) => {
  const project = await Project.findOne({ key: req.params.key });
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (project.leadId !== req.employeeId && !(await canManageProjects(req))) {
    return res.status(403).json({ error: "Only the project lead or a project manager can edit this project" });
  }
  const { name, description, leadId, archived } = req.body ?? {};
  if (name !== undefined) {
    if (!String(name).trim()) return res.status(400).json({ error: "Project name can't be empty" });
    project.name = String(name).trim();
  }
  if (description !== undefined) project.description = String(description).trim();
  if (leadId !== undefined) {
    if (!(await Employee.exists({ _id: leadId }))) return res.status(404).json({ error: "Project lead not found" });
    project.leadId = leadId;
  }
  if (archived !== undefined) project.archived = Boolean(archived);
  await project.save();
  res.json(project);
});
