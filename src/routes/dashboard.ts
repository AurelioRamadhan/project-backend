import { Hono } from "hono";
import { prisma } from "../lib/prisma";
import { authGuard } from "../middleware/auth";
import type { AppEnv } from "../types/auth";

export const dashboardRoutes = new Hono<AppEnv>();
dashboardRoutes.use("*", authGuard);

dashboardRoutes.get("/", async (c) => {
  const user = c.get("user");

  if (user.role === "PM") {
    const [totalProjects, totalTasks, completedTasks, inProgressTasks, allTasks] =
      await Promise.all([
        prisma.project.count({ where: { deletedAt: null } }),
        prisma.task.count({ where: { deletedAt: null } }),
        prisma.task.count({ where: { deletedAt: null, status: "DONE" } }),
        prisma.task.count({ where: { deletedAt: null, status: "IN_PROGRESS" } }),
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

    const recentCompleted = await prisma.task.findMany({
      where: { deletedAt: null, status: "DONE" },
      orderBy: { updatedAt: "desc" },
      take: 5,
      include: { project: { select: { name: true } }, assignee: { select: { name: true } } },
    });

    return c.json({
      totalProjects,
      totalTasks,
      completedTasks,
      inProgressTasks,
      blockedTasks: blocked,
      recentProjects: recentProjects.map((p) => {
        const done = p.tasks.filter((t) => t.status === "DONE").length;
        return {
          id: p.id,
          name: p.name,
          progress: p.tasks.length ? Math.round((done / p.tasks.length) * 100) : 0,
          done,
          total: p.tasks.length,
        };
      }),
      recentCompleted: recentCompleted.map((t) => ({
        id: t.id,
        title: t.title,
        projectName: t.project?.name,
        assigneeName: t.assignee?.name,
        updatedAt: t.updatedAt,
      })),
    });
  }

  if (user.role === "INTERNAL") {
    const tasks = await prisma.task.findMany({
      where: { assigneeId: user.id, deletedAt: null },
      include: {
        project: { select: { name: true } },
        dependencies: { include: { dependsOnTask: true } },
      },
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

    const recentCompleted = tasks
      .filter((t) => t.status === "DONE")
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, 5)
      .map((t) => ({
        id: t.id,
        title: t.title,
        projectName: t.project?.name,
        updatedAt: t.updatedAt,
      }));

    return c.json({ tasks, byStatus, blocked, recentCompleted });
  }

  const projects = await prisma.project.findMany({
    where: { clientId: user.id, deletedAt: null },
    include: {
      tasks: {
        where: { deletedAt: null, isClientVisible: true },
        select: { id: true, title: true, status: true, dueDate: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return c.json({
    projects: projects.map((p) => {
      const done = p.tasks.filter((t) => t.status === "DONE").length;
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        startDate: p.startDate,
        dueDate: p.dueDate,
        totalTasks: p.tasks.length,
        doneTasks: done,
        progress: p.tasks.length ? Math.round((done / p.tasks.length) * 100) : 0,
        tasks: p.tasks.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          dueDate: t.dueDate,
        })),
      };
    }),
  });
});