import { Hono } from "hono";
import { prisma } from "../lib/prisma";
import { authGuard } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import type { AppEnv } from "../types/auth";

export const auditRoutes = new Hono<AppEnv>();
auditRoutes.use("*", authGuard);

auditRoutes.get("/task/:taskId", async (c) => {
  const user = c.get("user");
  if (user.role === "CLIENT") return c.json({ error: "Forbidden" }, 403);

  const logs = await prisma.auditLog.findMany({
    where: { taskId: c.req.param("taskId") },
    include: { actor: { select: { id: true, name: true, role: true } } },
    orderBy: { timestamp: "desc" },
  });
  return c.json(logs);
});

auditRoutes.get("/project/:projectId", requireRole("PM"), async (c) => {
  const logs = await prisma.auditLog.findMany({
    where: { task: { projectId: c.req.param("projectId") } },
    include: { actor: { select: { name: true } }, task: { select: { title: true } } },
    orderBy: { timestamp: "desc" },
    take: 100,
  });
  return c.json(logs);
});