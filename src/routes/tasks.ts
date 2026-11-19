import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authGuard } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import type { AppEnv } from "../types/auth";
import {
  areDependenciesSatisfied,
  canChangeStatusTo,
  recordAudit,
  canViewProject,
} from "../utils/permissions";
import { parseQuery, buildWhere, buildOrder, buildPagination } from "../lib/query";

export const taskRoutes = new Hono<AppEnv>();
taskRoutes.use("*", authGuard);

const TASK_FIELDS = new Set([
  "title",
  "description",
  "status",
  "priority",
  "department",
  "assigneeId",
  "projectId",
  "isClientVisible",
  "startDate",
  "dueDate",
  "createdAt",
  "updatedAt",
]);

const createTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  department: z.enum(["UIUX", "FRONTEND", "BACKEND"]),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]).default("MEDIUM"),
  assigneeId: z.string().uuid().optional(),
  startDate: z.string().datetime().optional(),
  dueDate: z.string().datetime().optional(),
  isClientVisible: z.boolean().default(false),
  dependencyIds: z.array(z.string().uuid()).optional(),
});

const updateTaskSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  department: z.enum(["UIUX", "FRONTEND", "BACKEND"]).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  startDate: z.string().datetime().nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  isClientVisible: z.boolean().optional(),
  dependencyIds: z.array(z.string().uuid()).optional(),
  version: z.number().int().optional(),
});

async function enrichTasksForUser(tasks: any[], user: any) {
  return Promise.all(
    tasks.map(async (task) => {
      const deps = await prisma.taskDependency.findMany({
        where: { taskId: task.id, deletedAt: null },
        include: { dependsOnTask: { select: { id: true, title: true, status: true } } },
      });
      const isBlocked = deps.some(
        (d) => d.dependsOnTask.status !== "DONE" && !d.dependsOnTask.deletedAt
      );

      if (user.role === "CLIENT") {
        return {
          id: task.id,
          title: task.title,
          description: task.description,
          status: task.status,
          dueDate: task.dueDate,
          projectId: task.projectId,
          project: task.project ? { id: task.project.id, name: task.project.name } : undefined,
        };
      }

      return {
        ...task,
        dependencies: deps,
        isBlocked,
      };
    })
  );
}

taskRoutes.get("/", async (c) => {
  const user = c.get("user");
  const q = parseQuery(new URL(c.req.url).searchParams);

  const dynamic = buildWhere(q, TASK_FIELDS);
  const baseWhere: any = { deletedAt: null, ...dynamic };

  if (user.role === "CLIENT") {
    baseWhere.isClientVisible = true;
    baseWhere.project = { clientId: user.id, deletedAt: null };
  } else if (user.role === "INTERNAL") {
    baseWhere.assigneeId = user.id;
  }

  const order = buildOrder(q, TASK_FIELDS, "createdAt");
  const { skip, take } = buildPagination(q);

  const [total, tasks] = await Promise.all([
    prisma.task.count({ where: baseWhere }),
    prisma.task.findMany({
      where: baseWhere,
      skip,
      take,
      orderBy: order,
      include: {
        assignee:
          user.role === "CLIENT"
            ? false
            : { select: { id: true, name: true, department: true } },
        project: { select: { id: true, name: true } },
        dependencies: {
          include: { dependsOnTask: { select: { id: true, title: true, status: true } } },
        },
        attachments: user.role === "CLIENT" ? false : { where: { deletedAt: null } },
      },
    }),
  ]);

  const enriched = await enrichTasksForUser(tasks, user);

  return c.json({
    data: enriched,
    meta: {
      page: q.page || 1,
      rows: q.rows || 20,
      total,
      totalPages: Math.max(1, Math.ceil(total / (q.rows || 20))),
    },
  });
});

taskRoutes.get("/project/:projectId", async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("projectId");

  if (!(await canViewProject(user, projectId))) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const q = parseQuery(new URL(c.req.url).searchParams);
  const dynamic = buildWhere(q, TASK_FIELDS);
  const baseWhere: any = { projectId, deletedAt: null, ...dynamic };
  if (user.role === "CLIENT") baseWhere.isClientVisible = true;

  const order = buildOrder(q, TASK_FIELDS, "createdAt");
  const { skip, take } = buildPagination(q);

  const [total, tasks] = await Promise.all([
    prisma.task.count({ where: baseWhere }),
    prisma.task.findMany({
      where: baseWhere,
      skip,
      take,
      orderBy: order,
      include: {
        assignee:
          user.role === "CLIENT"
            ? false
            : { select: { id: true, name: true, department: true } },
        project: { select: { id: true, name: true } },
        dependencies: {
          include: { dependsOnTask: { select: { id: true, title: true, status: true } } },
        },
        attachments: user.role === "CLIENT" ? false : { where: { deletedAt: null } },
      },
    }),
  ]);

  const enriched = await enrichTasksForUser(tasks, user);

  return c.json({
    data: enriched,
    meta: {
      page: q.page || 1,
      rows: q.rows || 20,
      total,
      totalPages: Math.max(1, Math.ceil(total / (q.rows || 20))),
    },
  });
});

taskRoutes.get("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");

  const task = await prisma.task.findUnique({
    where: { id },
    include: {
      assignee: { select: { id: true, name: true, department: true } },
      project: { select: { id: true, name: true, clientId: true } },
      dependencies: {
        include: { dependsOnTask: { select: { id: true, title: true, status: true } } },
      },
      attachments: {
        where: { deletedAt: null },
        include: { uploadedBy: { select: { id: true, name: true } } },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!task || task.deletedAt) return c.json({ error: "Task tidak ditemukan" }, 404);

  if (!(await canViewProject(user, task.projectId))) {
    return c.json({ error: "Forbidden" }, 403);
  }
  if (user.role === "CLIENT" && !task.isClientVisible) {
    return c.json({ error: "Forbidden" }, 403);
  }
  if (user.role === "CLIENT") {
    return c.json({
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      dueDate: task.dueDate,
    });
  }

  const deps = await prisma.taskDependency.findMany({
    where: { taskId: task.id, deletedAt: null },
    include: { dependsOnTask: true },
  });
  const isBlocked = deps.some(
    (d) => d.dependsOnTask.status !== "DONE" && !d.dependsOnTask.deletedAt
  );

  return c.json({ ...task, isBlocked });
});

taskRoutes.post("/project/:projectId", requireRole("PM"), async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("projectId");
  const parsed = createTaskSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Validasi gagal", details: parsed.error.issues }, 400);
  }

  const data = parsed.data;
  const task = await prisma.task.create({
    data: {
      title: data.title,
      description: data.description,
      department: data.department,
      priority: data.priority,
      assigneeId: data.assigneeId || null,
      startDate: data.startDate ? new Date(data.startDate) : null,
      dueDate: data.dueDate ? new Date(data.dueDate) : null,
      isClientVisible: data.isClientVisible,
      projectId,
      createdById: user.id,
      dependencies: data.dependencyIds?.length
        ? { create: data.dependencyIds.map((dependsOnTaskId) => ({ dependsOnTaskId })) }
        : undefined,
    },
    include: { dependencies: true },
  });

  await recordAudit(task.id, user.id, "TASK_CREATED", null, task.title);
  return c.json(task, 201);
});

taskRoutes.put("/:id", requireRole("PM"), async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const parsed = updateTaskSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Validasi gagal", details: parsed.error.issues }, 400);
  }

  const { version, dependencyIds, ...updates } = parsed.data;
  const existing = await prisma.task.findUnique({ where: { id } });
  if (!existing || existing.deletedAt) return c.json({ error: "Task tidak ditemukan" }, 404);

  if (version !== undefined && existing.version !== version) {
    return c.json(
      {
        error: "Data sudah diperbarui oleh pengguna lain. Muat ulang data sebelum menyimpan.",
        code: "CONFLICT",
      },
      409
    );
  }

  const data: any = { ...updates, version: { increment: 1 } };
  if (updates.startDate !== undefined) {
    data.startDate = updates.startDate ? new Date(updates.startDate) : null;
  }
  if (updates.dueDate !== undefined) {
    data.dueDate = updates.dueDate ? new Date(updates.dueDate) : null;
  }

  if (dependencyIds !== undefined) {
    await prisma.taskDependency.updateMany({
      where: { taskId: id, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (dependencyIds.length) {
      await prisma.taskDependency.createMany({
        data: dependencyIds.map((dependsOnTaskId) => ({ taskId: id, dependsOnTaskId })),
      });
    }
  }

  const task = await prisma.task.update({ where: { id }, data });

  for (const key of [
    "title",
    "description",
    "assigneeId",
    "priority",
    "isClientVisible",
    "department",
  ]) {
    const newVal = (task as any)[key];
    const oldVal = (existing as any)[key];
    if (newVal !== oldVal) {
      await recordAudit(id, user.id, key, String(oldVal ?? ""), String(newVal ?? ""));
    }
  }

  return c.json(task);
});

taskRoutes.patch("/:id/status", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");

  const statusSchema = z.object({
    status: z.enum(["TODO", "IN_PROGRESS", "DONE"]),
    version: z.number().int().optional(),
  });
  const parsed = statusSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Validasi gagal", details: parsed.error.issues }, 400);
  }
  const { status, version } = parsed.data;

  const task = await prisma.task.findUnique({ where: { id } });
  if (!task || task.deletedAt) return c.json({ error: "Task tidak ditemukan" }, 404);

  if (version !== undefined && task.version !== version) {
    return c.json({ error: "Data sudah diperbarui pengguna lain", code: "CONFLICT" }, 409);
  }

  const needsDependencyCheck = status === "IN_PROGRESS" || status === "DONE";
  const depsSatisfied = needsDependencyCheck ? await areDependenciesSatisfied(id) : true;
  const check = canChangeStatusTo(user, task, status, depsSatisfied);
  if (!check.allowed) return c.json({ error: check.reason }, 403);

  const updated = await prisma.task.update({
    where: { id },
    data: { status, version: { increment: 1 } },
  });

  await recordAudit(id, user.id, "status", task.status, status);
  return c.json(updated);
});

taskRoutes.delete("/:id", requireRole("PM"), async (c) => {
  await prisma.task.update({
    where: { id: c.req.param("id") },
    data: { deletedAt: new Date() },
  });
  return c.json({ ok: true });
});