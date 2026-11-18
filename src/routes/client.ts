import { Hono } from "hono";
import { prisma } from "../lib/prisma";
import { authGuard } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import type { AppEnv } from "../types/auth";

export const clientRoutes = new Hono<AppEnv>();
clientRoutes.use("*", authGuard, requireRole("CLIENT"));

clientRoutes.get("/projects/:id/metrics", async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("id");

  const project = await prisma.project.findFirst({
    where: { id: projectId, clientId: user.id, deletedAt: null },
  });
  if (!project) return c.json({ error: "Forbidden" }, 403);

  const [all, done, taskList] = await Promise.all([
    prisma.task.count({ where: { projectId, deletedAt: null, isClientVisible: true } }),
    prisma.task.count({ where: { projectId, deletedAt: null, isClientVisible: true, status: "DONE" } }),
    prisma.task.findMany({
      where: { projectId, deletedAt: null, isClientVisible: true },
      select: { id: true, title: true, description: true, status: true, dueDate: true },
    }),
  ]);

  return c.json({
    projectId,
    projectName: project.name,
    description: project.description,
    totalTasks: all,
    doneTasks: done,
    remainingTasks: all - done,
    percentComplete: all === 0 ? 0 : Math.round((done / all) * 100),
    tasks: taskList,
  });
});