import { Hono } from "hono";
import { prisma } from "../lib/prisma";
import { authGuard } from "../middleware/auth";
import type { AppEnv } from "../types/auth";

export const dashboardRoutes = new Hono<AppEnv>();
dashboardRoutes.use("*", authGuard);

dashboardRoutes.get("/", async (c) => {
  const user = c.get("user");

  if (user.role === "PM") {
    const [totalProjects, totalTasks, completedTasks, allTasks] = await Promise.all([
      prisma.project.count({ where: { deletedAt: null } }),
      prisma.task.count({ where: { deletedAt: null } }),
      prisma.task.count({ where: { deletedAt: null, status: "DONE" } }),
      prisma.task.findMany({
        where: { deletedAt: null, status: { not: "DONE" } },
        include: { dependencies: { include: { dependsOnTask: true } } },
      }),
    ]);

    const blocked = allTasks.filter((t) =>
      t.dependencies.some((d) => d.dependsOnTask.status !== "DONE" && !d.dependsOnTask.deletedAt)
    ).length;

    const recentProjects = await prisma.project.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 5,
      include: { tasks: { where: { deletedAt: null }, select: { status: true } } },
    });

    return c.json({
      totalProjects,
      totalTasks,
      completedTasks,
      blockedTasks: blocked,
      recentProjects: recentProjects.map((p) => {
        const done = p.tasks.filter((t) => t.status === "DONE").length;
        return {
          id: p.id,
          name: p.name,
          progress: p.tasks.length ? Math.round((done / p.tasks.length) * 100) : 0,
        };
      }),
    });
  }

  if (user.role === "INTERNAL") {
    const tasks = await prisma.task.findMany({
      where: { assigneeId: user.id, deletedAt: null },
      include: { project: { select: { name: true } }, dependencies: { include: { dependsOnTask: true } } },
      orderBy: { dueDate: "asc" },
    });

    const byStatus = {
      TODO: tasks.filter((t) => t.status === "TODO").length,
      IN_PROGRESS: tasks.filter((t) => t.status === "IN_PROGRESS").length,
      DONE: tasks.filter((t) => t.status === "DONE").length,
    };

    const blocked = tasks.filter(
      (t) => t.status !== "DONE" && t.dependencies.some((d) => d.dependsOnTask.status !== "DONE")
    ).length;

    return c.json({ tasks, byStatus, blocked });
  }

  // CLIENT
  const projects = await prisma.project.findMany({
    where: { clientId: user.id, deletedAt: null },
    include: {
      tasks: { where: { deletedAt: null, isClientVisible: true }, select: { status: true } },
    },
  });

  return c.json({
    projects: projects.map((p) => {
      const done = p.tasks.filter((t) => t.status === "DONE").length;
      return {
        id: p.id,
        name: p.name,
        totalTasks: p.tasks.length,
        doneTasks: done,
        progress: p.tasks.length ? Math.round((done / p.tasks.length) * 100) : 0,
      };
    }),
  });
});