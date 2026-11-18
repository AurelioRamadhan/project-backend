import { createMiddleware } from "hono/factory";
import { verifyToken } from "../utils/jwt";
import { prisma } from "../lib/prisma";
import type { AppEnv } from "../types/auth";

export const authGuard = createMiddleware<AppEnv>(async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Token tidak ditemukan" }, 401);
  }

  try {
    const payload = verifyToken(authHeader.slice(7));
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, name: true, role: true, department: true, deletedAt: true },
    });

    if (!user || user.deletedAt) {
      return c.json({ error: "User tidak valid" }, 401);
    }

    c.set("user", {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      department: user.department,
    });
    await next();
  } catch {
    return c.json({ error: "Token tidak valid" }, 401);
  }
});