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
  department: z.enum(["PRODUCT", "UIUX", "FRONTEND", "BACKEND", "CLIENT"]).optional(),
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
  department: z.enum(["PRODUCT", "UIUX", "FRONTEND", "BACKEND", "CLIENT"]).optional(),
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
        include: { dependsOnTask: { select: { id: true, title: true, status: true, deletedAt: true } } },
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
  if (!parsed.success) return c.json({ error: "Validasi gagal", details: parsed.error.issues }, 400);
  const data = parsed.data;
  const project = await prisma.project.findFirst({ where: { id: projectId, deletedAt: null } });
  if (!project) return c.json({ error: "Project tidak ditemukan" }, 404);
  if (data.startDate && data.dueDate && data.startDate > data.dueDate) return c.json({ error: "Due Date tidak boleh lebih awal dari Start Date." }, 400);
  if (data.assigneeId) {
    const assignee = await prisma.user.findFirst({ where: { id: data.assigneeId, role: "INTERNAL", deletedAt: null } });
    if (!assignee) return c.json({ error: "Assignee tidak valid" }, 400);
    const member = await prisma.projectMember.findFirst({ where: { projectId, userId: data.assigneeId, deletedAt: null } });
    if (!member) return c.json({ error: "Assignee harus menjadi anggota project" }, 400);

  }
  const dependencyIds = [...new Set(data.dependencyIds || [])];
  if (dependencyIds.length !== (data.dependencyIds || []).length) return c.json({ error: "Dependency duplikat tidak diperbolehkan" }, 400);
  if (dependencyIds.length) {
    const count = await prisma.task.count({ where: { id: { in: dependencyIds }, projectId, deletedAt: null } });
    if (count !== dependencyIds.length) return c.json({ error: "Semua dependency harus merupakan task aktif dalam project yang sama" }, 400);
  }
  const task = await prisma.$transaction(async (tx) => {
    const created = await tx.task.create({
      data: {
        title: data.title, description: data.description, department: data.assigneeId
          ? (await tx.user.findUniqueOrThrow({ where: { id: data.assigneeId }, select: { department: true } })).department
          : (data.department ?? "PRODUCT"),
        priority: data.priority, assigneeId: data.assigneeId || null,
        startDate: data.startDate ? new Date(data.startDate) : null,
        dueDate: data.dueDate ? new Date(data.dueDate) : null,
        isClientVisible: data.isClientVisible, projectId, createdById: user.id,
        dependencies: dependencyIds.length ? { create: dependencyIds.map((dependsOnTaskId) => ({ dependsOnTaskId })) } : undefined,
      }, include: { dependencies: true },
    });
    await tx.auditLog.create({ data: { taskId: created.id, actorId: user.id, changedColumn: "TASK_CREATED", oldValue: null, newValue: created.title } });
    return created;
  });
  return c.json(task, 201);
});
taskRoutes.put("/:id", requireRole("PM"), async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const parsed = updateTaskSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Validasi gagal", details: parsed.error.issues }, 400);
  const { version, dependencyIds, ...updates } = parsed.data;
  if (version === undefined) return c.json({ error: "Versi task wajib disertakan untuk mencegah perubahan tertimpa" }, 400);
  const existing = await prisma.task.findFirst({ where: { id, deletedAt: null } });
  if (!existing) return c.json({ error: "Task tidak ditemukan" }, 404);
  if (existing.version !== version) return c.json({ error: "Data sudah diperbarui oleh pengguna lain. Muat ulang data sebelum menyimpan.", code: "CONFLICT" }, 409);
  if (updates.startDate && updates.dueDate && updates.startDate > updates.dueDate) return c.json({ error: "Due Date tidak boleh lebih awal dari Start Date." }, 400);
  const nextAssignee = updates.assigneeId === undefined ? existing.assigneeId : updates.assigneeId;
  if (nextAssignee) {
    const assignee = await prisma.user.findFirst({ where: { id: nextAssignee, role: "INTERNAL", deletedAt: null } });
    if (!assignee) return c.json({ error: "Assignee tidak valid" }, 400);
    const member = await prisma.projectMember.findFirst({ where: { projectId: existing.projectId, userId: nextAssignee, deletedAt: null } });
    if (!member) return c.json({ error: "Assignee harus menjadi anggota project" }, 400);
    if (updates.assigneeId !== undefined && updates.assigneeId !== existing.assigneeId) updates.department = assignee.department;
  }
  const uniqueDependencies = dependencyIds === undefined ? undefined : [...new Set(dependencyIds)];
  if (uniqueDependencies && uniqueDependencies.length !== dependencyIds!.length) return c.json({ error: "Dependency duplikat tidak diperbolehkan" }, 400);
  if (uniqueDependencies?.includes(id)) return c.json({ error: "Task tidak dapat menjadi dependency dirinya sendiri" }, 400);
  if (uniqueDependencies?.length) {
    const count = await prisma.task.count({ where: { id: { in: uniqueDependencies }, projectId: existing.projectId, deletedAt: null } });
    if (count !== uniqueDependencies.length) return c.json({ error: "Semua dependency harus merupakan task aktif dalam project yang sama" }, 400);
  }
  const data: any = { ...updates, version: { increment: 1 } };
  if (updates.startDate !== undefined) data.startDate = updates.startDate ? new Date(updates.startDate) : null;
  if (updates.dueDate !== undefined) data.dueDate = updates.dueDate ? new Date(updates.dueDate) : null;
  const auditValue = (value: unknown) => {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (typeof value === "string" && !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value)) return new Date(value).toISOString().slice(0, 10);
    return String(value ?? "");
  };
  const changedFields = ["title", "description", "assigneeId", "priority", "isClientVisible", "department", "startDate", "dueDate"];
  const changed = changedFields.filter((key) => {
    if (key === "department" && updates.assigneeId !== undefined && updates.assigneeId !== existing.assigneeId) return false;
    return updates[key as keyof typeof updates] !== undefined && auditValue((existing as any)[key]) !== auditValue((data as any)[key]);
  });
  const result = await prisma.$transaction(async (tx) => {
    const claimed = await tx.task.updateMany({ where: { id, version, deletedAt: null }, data });
    if (claimed.count !== 1) return null;
    let oldDependencyIds: string[] = [];
    let oldDependencyNames: string[] = [];
    let newDependencyNames: string[] = [];
    if (uniqueDependencies !== undefined) {
      const activeDependencies = await tx.taskDependency.findMany({ where: { taskId: id, deletedAt: null }, select: { dependsOnTaskId: true } });
      oldDependencyIds = activeDependencies.map((dependency) => dependency.dependsOnTaskId);
      const oldTasks = await tx.task.findMany({ where: { id: { in: oldDependencyIds } }, select: { id: true, title: true } });
      const oldTitles = new Map(oldTasks.map((dependency) => [dependency.id, dependency.title]));
      oldDependencyNames = oldDependencyIds.map((dependencyId) => oldTitles.get(dependencyId) || "Task dihapus");
      const newTasks = await tx.task.findMany({ where: { id: { in: uniqueDependencies }, deletedAt: null }, select: { id: true, title: true } });
      const newTitles = new Map(newTasks.map((dependency) => [dependency.id, dependency.title]));
      newDependencyNames = uniqueDependencies.map((dependencyId) => newTitles.get(dependencyId) || "Task tidak ditemukan");
      const activeIds = new Set(activeDependencies.map((dependency) => dependency.dependsOnTaskId));
      await tx.taskDependency.updateMany({ where: { taskId: id, deletedAt: null, dependsOnTaskId: { notIn: uniqueDependencies } }, data: { deletedAt: new Date() } });
      for (const dependsOnTaskId of uniqueDependencies) {
        if (activeIds.has(dependsOnTaskId)) continue;
        await tx.taskDependency.upsert({
          where: { taskId_dependsOnTaskId: { taskId: id, dependsOnTaskId } },
          create: { taskId: id, dependsOnTaskId },
          update: { deletedAt: null },
        });
      }
    }
    const updated = await tx.task.findUniqueOrThrow({ where: { id } });
    for (const key of changed) {
      await tx.auditLog.create({ data: { taskId: id, actorId: user.id, changedColumn: key, oldValue: auditValue((existing as any)[key]), newValue: auditValue((updated as any)[key]) } });
    }
    if (uniqueDependencies !== undefined && (oldDependencyIds.length !== uniqueDependencies.length || oldDependencyIds.some((dependencyId) => !uniqueDependencies.includes(dependencyId)))) {
      await tx.auditLog.create({ data: { taskId: id, actorId: user.id, changedColumn: "dependencies", oldValue: oldDependencyNames.join(", "), newValue: newDependencyNames.join(", ") } });
    }
    return updated;
  });
  if (!result) return c.json({ error: "Data berubah saat disimpan. Muat ulang data sebelum mencoba lagi.", code: "CONFLICT" }, 409);
  return c.json(result);
});
taskRoutes.patch("/:id/status", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const statusSchema = z.object({ status: z.enum(["TODO", "IN_PROGRESS", "DONE"]), version: z.number().int() });
  const parsed = statusSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Validasi gagal", details: parsed.error.issues }, 400);
  const { status, version } = parsed.data;
  const task = await prisma.task.findFirst({ where: { id, deletedAt: null } });
  if (!task) return c.json({ error: "Task tidak ditemukan" }, 404);
  if (task.version !== version) return c.json({ error: "Data sudah diperbarui pengguna lain. Muat ulang sebelum mencoba lagi.", code: "CONFLICT" }, 409);
  if (user.role === "INTERNAL") {
    const member = await prisma.projectMember.findFirst({ where: { projectId: task.projectId, userId: user.id, deletedAt: null } });
    if (!member || task.assigneeId !== user.id) return c.json({ error: "Anda bukan executor yang berwenang pada task ini" }, 403);
  }
  const depsSatisfied = status === "TODO" ? true : await areDependenciesSatisfied(id);
  const check = canChangeStatusTo(user, task, status, depsSatisfied);
  if (!check.allowed) return c.json({ error: check.reason }, 403);
  const updated = await prisma.$transaction(async (tx) => {
    const claimed = await tx.task.updateMany({ where: { id, version, deletedAt: null }, data: { status, version: { increment: 1 } } });
    if (claimed.count !== 1) return null;
    await tx.auditLog.create({ data: { taskId: id, actorId: user.id, changedColumn: "status", oldValue: task.status, newValue: status } });
    return tx.task.findUniqueOrThrow({ where: { id } });
  });
  if (!updated) return c.json({ error: "Data berubah saat status disimpan. Muat ulang sebelum mencoba lagi.", code: "CONFLICT" }, 409);
  return c.json(updated);
});
taskRoutes.delete("/:id", requireRole("PM"), async (c) => {
  const id = c.req.param("id");
  const result = await prisma.task.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: new Date(), version: { increment: 1 } } });
  if (!result.count) return c.json({ error: "Task tidak ditemukan" }, 404);
  return c.json({ ok: true });
});