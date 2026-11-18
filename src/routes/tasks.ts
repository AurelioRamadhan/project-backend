import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authGuard } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import type { AppEnv } from "../types/auth";
import { areDependenciesSatisfied, canChangeStatusTo, recordAudit, canViewProject } from "../utils/permissions";

export const taskRoutes = new Hono<AppEnv>();
taskRoutes.use("*", authGuard);

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

// GET tasks by project (dengan masking untuk client)
taskRoutes.get("/project/:projectId", async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("projectId");

  if (!(await canViewProject(user, projectId))) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const where: any = { projectId, deletedAt: null };
  if (user.role === "CLIENT") {
    where.isClientVisible = true;
  }

  const tasks = await prisma.task.findMany({
    where,
    include: {
      assignee: user.role === "CLIENT" ? false : { select: { id: true, name: true, department: true } },
      dependencies: { include: { dependsOnTask: { select: { id: true, title: true, status: true } } } },
      attachments: user.role === "CLIENT" ? false : { where: { deletedAt: null } },
    },
    orderBy: { createdAt: "desc" },
  });

  // Hitung blocked status secara dinamis
  const enriched = await Promise.all(
    tasks.map(async (task) => {
      const deps = await prisma.taskDependency.findMany({
        where: { taskId: task.id, deletedAt: null },
        include: { dependsOnTask: true },
      });
      const blocked = deps.some((d) => d.dependsOnTask.status !== "DONE" && !d.dependsOnTask.deletedAt);
      const displayStatus = blocked && task.status === "TODO" ? "BLOCKED" : task.status;

      if (user.role === "CLIENT") {
        // Masking: hapus data internal
        return {
          id: task.id,
          title: task.title,
          description: task.description,
          status: displayStatus,
          dueDate: task.dueDate,
        };
      }
      return { ...task, displayStatus };
    })
  );

  return c.json(enriched);
});

// PM: create task + dependencies
taskRoutes.post("/project/:projectId", requireRole("PM"), async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("projectId");
  const parsed = createTaskSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Validasi gagal", details: parsed.error.issues }, 400);

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

// PM: update task (dengan optimistic locking via version)
taskRoutes.put("/:id", requireRole("PM"), async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = await c.req.json();
  const { version, ...updates } = body;

  const existing = await prisma.task.findUnique({ where: { id } });
  if (!existing || existing.deletedAt) return c.json({ error: "Task tidak ditemukan" }, 404);

  if (version !== undefined && existing.version !== version) {
    return c.json({
      error: "Data sudah diperbarui oleh pengguna lain. Muat ulang data sebelum menyimpan.",
      code: "CONFLICT",
    }, 409);
  }

  const task = await prisma.task.update({
    where: { id },
    data: {
      ...updates,
      startDate: updates.startDate ? new Date(updates.startDate) : undefined,
      dueDate: updates.dueDate ? new Date(updates.dueDate) : undefined,
      version: { increment: 1 },
    },
  });

  // Audit untuk perubahan penting
  for (const key of ["title", "description", "assigneeId", "priority", "isClientVisible"]) {
    if (updates[key] !== undefined && updates[key] !== (existing as any)[key]) {
      await recordAudit(id, user.id, key, String((existing as any)[key]), String(updates[key]));
    }
  }

  return c.json(task);
});

// Internal: update status (dengan dependency check + audit + optimistic)
taskRoutes.patch("/:id/status", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const { status, version } = await c.req.json();

  const task = await prisma.task.findUnique({ where: { id } });
  if (!task || task.deletedAt) return c.json({ error: "Task tidak ditemukan" }, 404);

  if (version !== undefined && task.version !== version) {
    return c.json({ error: "Data sudah diperbarui pengguna lain", code: "CONFLICT" }, 409);
  }

  const depsSatisfied = await areDependenciesSatisfied(id);
  const check = canChangeStatusTo(user, task, status, depsSatisfied);
  if (!check.allowed) return c.json({ error: check.reason }, 403);

  const updated = await prisma.task.update({
    where: { id },
    data: { status, version: { increment: 1 } },
  });

  await recordAudit(id, user.id, "status", task.status, status);
  return c.json(updated);
});

// PM: soft delete task
taskRoutes.delete("/:id", requireRole("PM"), async (c) => {
  await prisma.task.update({ where: { id: c.req.param("id") }, data: { deletedAt: new Date() } });
  return c.json({ ok: true });
});