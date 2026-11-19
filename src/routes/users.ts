import { Hono } from "hono";
import { prisma } from "../lib/prisma";
import { authGuard } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import type { AppEnv } from "../types/auth";

export const userRoutes = new Hono<AppEnv>();
userRoutes.use("*", authGuard);

userRoutes.get("/clients", requireRole("PM"), async (c) => {
  const clients = await prisma.user.findMany({
    where: { role: "CLIENT", deletedAt: null },
    select: { id: true, name: true, email: true },
    orderBy: { name: "asc" },
  });
  return c.json(clients);
});

userRoutes.get("/internal", requireRole("PM"), async (c) => {
  const users = await prisma.user.findMany({
    where: { role: "INTERNAL", deletedAt: null },
    select: { id: true, name: true, email: true, department: true },
    orderBy: { department: "asc" },
  });
  return c.json(users);
});

userRoutes.get("/by-ids", async (c) => {
  const ids = (c.req.query("ids") || "").split(",").filter(Boolean);
  if (!ids.length) return c.json([]);
  const users = await prisma.user.findMany({
    where: { id: { in: ids }, deletedAt: null },
    select: { id: true, name: true, email: true, role: true, department: true },
  });
  return c.json(users);
});

userRoutes.get("/search", requireRole("PM"), async (c) => {
  const q = c.req.query("q")?.trim() || "";
  const role = c.req.query("role") as "INTERNAL" | "CLIENT" | undefined;
  const selectedRaw = c.req.query("selected") || "";
  const selectedIds = selectedRaw.split(",").filter(Boolean);
  const department = c.req.query("department");

  const where: any = { deletedAt: null };
  if (role) where.role = role;
  if (department && department !== "ALL") where.department = department;
  if (q) {
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { email: { contains: q, mode: "insensitive" } },
    ];
  }

  const users = await prisma.user.findMany({
    where,
    select: { id: true, name: true, email: true, role: true, department: true },
    orderBy: { name: "asc" },
    take: 100,
  });

  const selectedSet = new Set(selectedIds);
  return c.json({
    assignees: users.filter((u) => selectedSet.has(u.id)),
    people: users.filter((u) => !selectedSet.has(u.id)),
    all: users,
  });
});

userRoutes.get("/project-members/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
  const q = c.req.query("q")?.trim() || "";
  const department = c.req.query("department");
  const selectedRaw = c.req.query("selected") || "";
  const selectedIds = selectedRaw.split(",").filter(Boolean);

  const memberRows = await prisma.projectMember.findMany({
    where: { projectId, deletedAt: null },
    select: { userId: true },
  });
  const memberIds = memberRows.map((m) => m.userId);
  if (!memberIds.length) {
    return c.json({ assignees: [], people: [], all: [] });
  }

  const where: any = { id: { in: memberIds }, deletedAt: null };
  if (department && department !== "ALL") where.department = department;
  if (q) {
    where.AND = [
      {
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
        ],
      },
    ];
  }

  const users = await prisma.user.findMany({
    where,
    select: { id: true, name: true, email: true, role: true, department: true },
    orderBy: { name: "asc" },
    take: 200,
  });

  const selectedSet = new Set(selectedIds);
  return c.json({
    assignees: users.filter((u) => selectedSet.has(u.id)),
    people: users.filter((u) => !selectedSet.has(u.id)),
    all: users,
  });
});