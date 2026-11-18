import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authGuard } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import type { AppEnv } from "../types/auth";

export const projectRoutes = new Hono<AppEnv>();
projectRoutes.use("*", authGuard);

const projectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  startDate: z.string().datetime().optional(),
  dueDate: z.string().datetime().optional(),
  clientId: z.string().uuid().optional(),
  memberIds: z.array(z.string().uuid()).optional(),
});

// PM: list semua project
projectRoutes.get("/", async (c) => {
  const user = c.get("user");
  let projects;
  if (user.role === "PM") {
    projects = await prisma.project.findMany({
      where: { deletedAt: null },
      include: { client: { select: { id: true, name: true } }, members: { include: { user: true } } },
    });
  } else if (user.role === "CLIENT") {
    projects = await prisma.project.findMany({
      where: { clientId: user.id, deletedAt: null },
    });
  } else {
    projects = await prisma.project.findMany({
      where: { deletedAt: null, members: { some: { userId: user.id, deletedAt: null } } },
    });
  }
  return c.json(projects);
});

projectRoutes.post("/", requireRole("PM"), async (c) => {
  const parsed = projectSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Validasi gagal", details: parsed.error.issues }, 400);

  const { name, description, startDate, dueDate, clientId, memberIds } = parsed.data;

  if (clientId) {
    const client = await prisma.user.findFirst({ where: { id: clientId, role: "CLIENT", deletedAt: null } });
    if (!client) return c.json({ error: "Client tidak valid" }, 400);
  }

  if (memberIds?.length) {
    const validMembers = await prisma.user.count({
      where: { id: { in: memberIds }, role: "INTERNAL", deletedAt: null },
    });
    if (validMembers !== memberIds.length) {
      return c.json({ error: "Ada member yang tidak valid atau bukan INTERNAL" }, 400);
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
    include: { members: { include: { user: true } }, client: true },
  });
  return c.json(project, 201);
});

// PM: update project
projectRoutes.put("/:id", requireRole("PM"), async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const project = await prisma.project.update({
    where: { id },
    data: {
      name: body.name,
      description: body.description,
      startDate: body.startDate ? new Date(body.startDate) : undefined,
      dueDate: body.dueDate ? new Date(body.dueDate) : undefined,
    },
  });
  return c.json(project);
});

// PM: soft delete project
projectRoutes.delete("/:id", requireRole("PM"), async (c) => {
  await prisma.project.update({ where: { id: c.req.param("id") }, data: { deletedAt: new Date() } });
  return c.json({ ok: true });
});

// PM: tambah member
projectRoutes.post("/:id/members", requireRole("PM"), async (c) => {
  const projectId = c.req.param("id");
  const { userId } = await c.req.json();
  const member = await prisma.projectMember.create({ data: { projectId, userId } });
  return c.json(member, 201);
});

// PM: hapus member (soft)
projectRoutes.delete("/:id/members/:userId", requireRole("PM"), async (c) => {
  const { id: projectId, userId } = c.req.param();
  await prisma.projectMember.updateMany({
    where: { projectId, userId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  return c.json({ ok: true });
});