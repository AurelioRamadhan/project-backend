import { createMiddleware } from "hono/factory";
import type { Role } from "../../generated/prisma/client";
import type { AppEnv } from "../types/auth";

export function requireRole(...roles: Role[]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const user = c.get("user");
    if (!user || !roles.includes(user.role)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    await next();
  });
}