import { Hono } from "hono";
import { prisma } from "../lib/prisma";
import { authGuard } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import type { AppEnv } from "../types/auth";

export const auditRoutes = new Hono<AppEnv>();
auditRoutes.use("*", authGuard);

auditRoutes.get("/", requireRole("PM"), async (c) => {
  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const rows = Math.max(1, Math.min(100, Number(c.req.query("rows")) || 20));
  const q = c.req.query("q")?.trim() || "";
  const actorRole = c.req.query("actorRole");
  const projectId = c.req.query("projectId");

  const where: any = { task: { deletedAt: null } };
  if (projectId && projectId !== "ALL") {
    where.task.projectId = projectId;
  }
  if (q) {
    where.AND = [
      {
        OR: [
          { changedColumn: { contains: q, mode: "insensitive" } },
          { task: { title: { contains: q, mode: "insensitive" } } },
          { actor: { name: { contains: q, mode: "insensitive" } } },
        ],
      },
    ];
  }
  if (actorRole && actorRole !== "ALL") where.actor = { role: actorRole };

  const [total, logs] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      include: {
        actor: { select: { name: true, role: true } },
        task: { select: { id: true, title: true, project: { select: { id: true, name: true } } } },
      },
      orderBy: { timestamp: "desc" },
      skip: (page - 1) * rows,
      take: rows,
    }),
  ]);

  return c.json({
    data: logs,
    meta: { page, rows, total, totalPages: Math.max(1, Math.ceil(total / rows)) },
  });
});

auditRoutes.get("/task/:taskId", async (c) => {
  const user = c.get("user");
  if (user.role === "CLIENT") return c.json({ error: "Forbidden" }, 403);

  const logs = await prisma.auditLog.findMany({
    where: { taskId: c.req.param("taskId") },
    include: { actor: { select: { id: true, name: true, role: true } } },
    orderBy: { timestamp: "desc" },
    take: 100,
  });
  return c.json(logs);
});

auditRoutes.get("/project/:projectId", requireRole("PM"), async (c) => {
  const projectId = c.req.param("projectId");
  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const rows = Math.max(1, Math.min(100, Number(c.req.query("rows")) || 20));
  const q = c.req.query("q")?.trim() || "";
  const actorRole = c.req.query("actorRole");

  const where: any = { task: { projectId, deletedAt: null } };
  if (q) {
    where.AND = [
      {
        OR: [
          { changedColumn: { contains: q, mode: "insensitive" } },
          { task: { title: { contains: q, mode: "insensitive" } } },
          { actor: { name: { contains: q, mode: "insensitive" } } },
        ],
      },
    ];
  }
  if (actorRole && actorRole !== "ALL") where.actor = { role: actorRole };

  const [total, logs] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      include: {
        actor: { select: { name: true, role: true } },
        task: { select: { id: true, title: true } },
      },
      orderBy: { timestamp: "desc" },
      skip: (page - 1) * rows,
      take: rows,
    }),
  ]);

  return c.json({
    data: logs,
    meta: { page, rows, total, totalPages: Math.max(1, Math.ceil(total / rows)) },
  });
});