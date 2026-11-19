import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authGuard } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import type { AppEnv } from "../types/auth";
import { parseQuery, buildWhere, buildOrder, buildPagination } from "../lib/query";

export const projectRoutes = new Hono<AppEnv>();
projectRoutes.use("*", authGuard);

const PROJECT_FIELDS = new Set([
  "name",
  "description",
  "startDate",
  "dueDate",
  "clientId",
  "createdAt",
  "updatedAt",
]);

const projectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  startDate: z.string().datetime().optional(),
  dueDate: z.string().datetime().optional(),
  clientId: z.string().uuid().optional(),
  memberIds: z.array(z.string().uuid()).optional(),
});

projectRoutes.get("/", async (c) => {
  const user = c.get("user");
  const q = parseQuery(new URL(c.req.url).searchParams);

  const baseWhere: any = { deletedAt: null };
  if (user.role === "CLIENT") baseWhere.clientId = user.id;
  else if (user.role === "INTERNAL") {
    baseWhere.members = { some: { userId: user.id, deletedAt: null } };
  }

  const dynamic = buildWhere(q, PROJECT_FIELDS);
  const where = { ...baseWhere, ...dynamic };

  const order = buildOrder(q, PROJECT_FIELDS, "createdAt");
  const { skip, take } = buildPagination(q);

  const [total, projects] = await Promise.all([
    prisma.project.count({ where }),
    prisma.project.findMany({
      where,
      skip,
      take,
      orderBy: order,
      include: {
        client: { select: { id: true, name: true, email: true } },
        members: {
          include: {
            user: {
              select: { id: true, name: true, email: true, role: true, department: true },
            },
          },
        },
        tasks: {
          where: { deletedAt: null },
          select: { id: true, status: true },
        },
      },
    }),
  ]);

  const enriched = projects.map((p) => {
    const totalTasks = p.tasks.length;
    const doneTasks = p.tasks.filter((t) => t.status === "DONE").length;
    const progress = totalTasks ? Math.round((doneTasks / totalTasks) * 100) : 0;
    const { tasks, ...rest } = p;
    return {
      ...rest,
      stats: { totalTasks, doneTasks, progress },
    };
  });

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

projectRoutes.post("/", requireRole("PM"), async (c) => {
  const parsed = projectSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Validasi gagal", details: parsed.error.issues }, 400);
  }
  const { name, description, startDate, dueDate, clientId, memberIds } = parsed.data;

  if (clientId) {
    const client = await prisma.user.findFirst({
      where: { id: clientId, role: "CLIENT", deletedAt: null },
    });
    if (!client) return c.json({ error: "Client tidak valid" }, 400);
  }

  if (memberIds?.length) {
    const valid = await prisma.user.count({
      where: { id: { in: memberIds }, role: "INTERNAL", deletedAt: null },
    });
    if (valid !== memberIds.length) {
      return c.json({ error: "Member tidak valid" }, 400);
    }
  }

  const project = await prisma.project.create({
    data: {
      name,
      description,
      startDate: startDate ? new Date(startDate) : null,
      dueDate: dueDate ? new Date(dueDate) : null,
      clientId: clientId || null,
      members: memberIds?.length
        ? { create: memberIds.map((userId) => ({ userId })) }
        : undefined,
    },
    include: {
      client: { select: { id: true, name: true, email: true } },
      members: { include: { user: true } },
    },
  });
  return c.json({ ...project, stats: { totalTasks: 0, doneTasks: 0, progress: 0 } }, 201);
});

projectRoutes.put("/:id", requireRole("PM"), async (c) => {
  const id = c.req.param("id");
  const parsed = projectSchema.partial().safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Validasi gagal", details: parsed.error.issues }, 400);
  }

  const existing = await prisma.project.findFirst({ where: { id, deletedAt: null } });
  if (!existing) return c.json({ error: "Project tidak ditemukan" }, 404);

  const { name, description, startDate, dueDate, clientId, memberIds } = parsed.data;

  if (clientId) {
    const client = await prisma.user.findFirst({
      where: { id: clientId, role: "CLIENT", deletedAt: null },
    });
    if (!client) return c.json({ error: "Client tidak valid" }, 400);
  }

  if (memberIds?.length) {
    const valid = await prisma.user.count({
      where: { id: { in: memberIds }, role: "INTERNAL", deletedAt: null },
    });
    if (valid !== memberIds.length) {
      return c.json({ error: "Member tidak valid" }, 400);
    }
  }

  const data: any = {};
  if (name !== undefined) data.name = name;
  if (description !== undefined) data.description = description;
  if (startDate !== undefined) data.startDate = startDate ? new Date(startDate) : null;
  if (dueDate !== undefined) data.dueDate = dueDate ? new Date(dueDate) : null;
  if (clientId !== undefined) data.clientId = clientId || null;

  await prisma.project.update({ where: { id }, data });

  if (memberIds !== undefined) {
    await prisma.projectMember.updateMany({
      where: { projectId: id, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (memberIds.length) {
      await prisma.projectMember.createMany({
        data: memberIds.map((userId) => ({ projectId: id, userId })),
      });
    }
  }

  const fresh = await prisma.project.findUnique({
    where: { id },
    include: {
      client: { select: { id: true, name: true, email: true } },
      members: { include: { user: true } },
      tasks: { where: { deletedAt: null }, select: { id: true, status: true } },
    },
  });

  if (!fresh) return c.json({ error: "Project tidak ditemukan" }, 404);
  const totalTasks = fresh.tasks.length;
  const doneTasks = fresh.tasks.filter((t) => t.status === "DONE").length;
  const progress = totalTasks ? Math.round((doneTasks / totalTasks) * 100) : 0;
  const { tasks, ...rest } = fresh;
  return c.json({ ...rest, stats: { totalTasks, doneTasks, progress } });
});

projectRoutes.delete("/:id", requireRole("PM"), async (c) => {
  await prisma.project.update({
    where: { id: c.req.param("id") },
    data: { deletedAt: new Date() },
  });
  return c.json({ ok: true });
});

projectRoutes.post("/:id/members", requireRole("PM"), async (c) => {
  const projectId = c.req.param("id");
  const { userId } = await c.req.json();
  const member = await prisma.projectMember.create({ data: { projectId, userId } });
  return c.json(member, 201);
});

projectRoutes.delete("/:id/members/:userId", requireRole("PM"), async (c) => {
  const { id: projectId, userId } = c.req.param();
  await prisma.projectMember.updateMany({
    where: { projectId, userId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  return c.json({ ok: true });
});