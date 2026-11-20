import { Hono } from "hono";
import { prisma } from "../lib/prisma";
import { authGuard } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import type { AppEnv } from "../types/auth";
import { canViewProject } from "../utils/permissions";

export const auditRoutes = new Hono<AppEnv>();
auditRoutes.use("*", authGuard);

async function presentAuditLogs(logs: any[]) {
  const ids = new Set<string>();
  const legacyDependencyTitles = new Set<string>();
  for (const log of logs) {
    if (log.changedColumn === "assigneeId") {
      if (log.oldValue) ids.add(log.oldValue);
      if (log.newValue) ids.add(log.newValue);
    }
    if (log.changedColumn === "dependencies") {
      for (const raw of `${log.oldValue || ""},${log.newValue || ""}`.split(",")) {
        const token = raw.trim();
        if (!token) continue;
        if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(token)) ids.add(token);
        else legacyDependencyTitles.add(token);
      }
    }
  }
  const [users, tasks, legacyTasks] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true } }),
    prisma.task.findMany({ where: { id: { in: [...ids] } }, select: { id: true, title: true } }),
    prisma.task.findMany({ where: { title: { in: [...legacyDependencyTitles] } }, select: { id: true, title: true } }),
  ]);
  const userNames = new Map(users.map((user) => [user.id, user.name]));
  const taskNames = new Map([...tasks, ...legacyTasks].map((task) => [task.id, task.title]));
  for (const task of legacyTasks) taskNames.set(task.title, task.title);
  return logs.map((log) => {
    if (log.changedColumn === "assigneeId") {
      return { ...log, oldValue: log.oldValue ? userNames.get(log.oldValue) || "User tidak ditemukan" : null, newValue: log.newValue ? userNames.get(log.newValue) || "User tidak ditemukan" : null };
    }
    if (log.changedColumn === "dependencies") {
      const names = (value: string | null) => value ? value.split(",").map((raw) => {
        const token = raw.trim();
        if (!token) return "";
        if (taskNames.has(token)) return taskNames.get(token)!;
        return /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(token) ? "Task tidak ditemukan" : token;
      }).filter(Boolean).join(", ") : null;
      return { ...log, oldValue: names(log.oldValue), newValue: names(log.newValue) };
    }
    return log;
  });
}

auditRoutes.get("/", requireRole("PM"), async (c) => {
  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const rows = Math.max(1, Math.min(100, Number(c.req.query("rows")) || 20));
  const q = c.req.query("q")?.trim() || "";
  const actorRole = c.req.query("actorRole");
  const projectId = c.req.query("projectId");
  const where: any = { task: { deletedAt: null } };
  if (projectId && projectId !== "ALL") where.task.projectId = projectId;
  if (q) where.AND = [{ OR: [
    { changedColumn: { contains: q, mode: "insensitive" } },
    { task: { title: { contains: q, mode: "insensitive" } } },
    { actor: { name: { contains: q, mode: "insensitive" } } },
  ] }];
  if (actorRole && actorRole !== "ALL") where.actor = { role: actorRole };
  const [total, logs] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({ where, include: {
      actor: { select: { name: true, role: true } },
      task: { select: { id: true, title: true, project: { select: { id: true, name: true } } } },
    }, orderBy: { timestamp: "desc" }, skip: (page - 1) * rows, take: rows }),
  ]);
  return c.json({ data: await presentAuditLogs(logs), meta: { page, rows, total, totalPages: Math.max(1, Math.ceil(total / rows)) } });
});

auditRoutes.get("/task/:taskId", async (c) => {
  const user = c.get("user");
  const taskId = c.req.param("taskId");
  if (user.role === "CLIENT") return c.json({ error: "Forbidden" }, 403);
  const task = await prisma.task.findFirst({ where: { id: taskId, deletedAt: null }, select: { projectId: true } });
  if (!task) return c.json({ error: "Task tidak ditemukan" }, 404);
  if (!(await canViewProject(user, task.projectId))) return c.json({ error: "Forbidden" }, 403);
  const logs = await prisma.auditLog.findMany({ where: { taskId }, include: { actor: { select: { id: true, name: true, role: true } } }, orderBy: { timestamp: "desc" }, take: 100 });
  return c.json(await presentAuditLogs(logs));
});

auditRoutes.get("/project/:projectId", requireRole("PM"), async (c) => {
  const projectId = c.req.param("projectId");
  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const rows = Math.max(1, Math.min(100, Number(c.req.query("rows")) || 20));
  const q = c.req.query("q")?.trim() || "";
  const actorRole = c.req.query("actorRole");
  const where: any = { task: { projectId, deletedAt: null } };
  if (q) where.AND = [{ OR: [
    { changedColumn: { contains: q, mode: "insensitive" } },
    { task: { title: { contains: q, mode: "insensitive" } } },
    { actor: { name: { contains: q, mode: "insensitive" } } },
  ] }];
  if (actorRole && actorRole !== "ALL") where.actor = { role: actorRole };
  const [total, logs] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({ where, include: { actor: { select: { name: true, role: true } }, task: { select: { id: true, title: true } } }, orderBy: { timestamp: "desc" }, skip: (page - 1) * rows, take: rows }),
  ]);
  return c.json({ data: await presentAuditLogs(logs), meta: { page, rows, total, totalPages: Math.max(1, Math.ceil(total / rows)) } });
});
