import { Hono } from "hono";
import { prisma } from "../lib/prisma";
import { authGuard } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import type { AppEnv } from "../types/auth";

export const userRoutes = new Hono<AppEnv>();
userRoutes.use("*", authGuard);

// PM: daftar client yang tersedia
userRoutes.get("/clients", requireRole("PM"), async (c) => {
  const clients = await prisma.user.findMany({
    where: { role: "CLIENT", deletedAt: null },
    select: { id: true, name: true, email: true },
  });
  return c.json(clients);
});

// PM: daftar internal team (untuk pilih member saat create project)
userRoutes.get("/internal", requireRole("PM"), async (c) => {
  const users = await prisma.user.findMany({
    where: { role: "INTERNAL", deletedAt: null },
    select: { id: true, name: true, email: true, department: true },
    orderBy: { department: "asc" },
  });
  return c.json(users);
});