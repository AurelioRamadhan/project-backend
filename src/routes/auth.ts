import { Hono } from "hono";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma";
import { signToken } from "../utils/jwt";

export const authRoutes = new Hono();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().min(1),
  role: z.enum(["PM", "INTERNAL", "CLIENT"]),
  department: z.enum(["PRODUCT", "UIUX", "FRONTEND", "BACKEND", "CLIENT"]),
});

authRoutes.post("/register", async (c) => {
  const parsed = registerSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Validasi gagal", details: parsed.error.issues }, 400);

  const { email, password, name, role, department } = parsed.data;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return c.json({ error: "Email sudah terdaftar" }, 409);

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { email, passwordHash, name, role, department },
    select: { id: true, email: true, name: true, role: true, department: true },
  });

  const token = signToken({ sub: user.id, email: user.email, role: user.role, department: user.department });
  return c.json({ user, token }, 201);
});

authRoutes.post("/login", async (c) => {
  const parsed = z.object({ email: z.string().email(), password: z.string() }).safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Validasi gagal" }, 400);

  const user = await prisma.user.findUnique({
    where: { email: parsed.data.email },
    select: { id: true, email: true, name: true, role: true, department: true, passwordHash: true, deletedAt: true },
  });

  if (!user || user.deletedAt || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
    return c.json({ error: "Email atau password salah" }, 401);
  }

  const token = signToken({ sub: user.id, email: user.email, role: user.role, department: user.department });
  return c.json({
    user: { id: user.id, email: user.email, name: user.name, role: user.role, department: user.department },
    token,
  });
});