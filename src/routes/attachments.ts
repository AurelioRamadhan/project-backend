import { Hono } from "hono";
import { prisma } from "../lib/prisma";
import { authGuard } from "../middleware/auth";
import type { AppEnv } from "../types/auth";
import { recordAudit } from "../utils/permissions";
import { verifyToken } from "../utils/jwt";

export const attachmentRoutes = new Hono<AppEnv>();
attachmentRoutes.use("*", authGuard);

attachmentRoutes.post("/task/:taskId", async (c) => {
  const user = c.get("user");
  const taskId = c.req.param("taskId");

  if (user.role === "PM" || user.role === "CLIENT") {
    return c.json({ error: "Role ini tidak diizinkan upload" }, 403);
  }

  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task || task.deletedAt) return c.json({ error: "Task tidak ditemukan" }, 404);
  if (user.role === "INTERNAL" && task.assigneeId !== user.id) {
    return c.json({ error: "Hanya assignee yang boleh upload" }, 403);
  }
  if (task.status === "DONE") {
    return c.json({ error: "Task sudah selesai, tidak dapat upload" }, 400);
  }

  const body = await c.req.parseBody({ all: true });
  const raw = body["file"];
  const files: File[] = Array.isArray(raw) ? (raw as File[]) : raw ? [raw as File] : [];
  if (files.length === 0) return c.json({ error: "File wajib diisi" }, 400);

  const created = [];
  for (const file of files) {
    const ext = file.name.split(".").pop() || "bin";
    const filename = `${crypto.randomUUID()}.${ext}`;
    await Bun.write(`./uploads/${filename}`, file);
    const att = await prisma.attachment.create({
      data: {
        taskId,
        uploadedById: user.id,
        filename,
        originalName: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
      },
    });
    await recordAudit(taskId, user.id, "attachment", null, file.name);
    created.push(att);
  }
  return c.json(created, 201);
});

attachmentRoutes.get("/task/:taskId", async (c) => {
  const user = c.get("user");
  if (user.role === "CLIENT") return c.json({ error: "Forbidden" }, 403);
  const taskId = c.req.param("taskId");
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task || task.deletedAt) return c.json({ error: "Task tidak ditemukan" }, 404);

  const attachments = await prisma.attachment.findMany({
    where: { taskId, deletedAt: null },
    include: { uploadedBy: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });
  return c.json(attachments);
});

attachmentRoutes.get("/:id/download", async (c) => {
  const user = c.get("user");
  if (user.role === "CLIENT") return c.json({ error: "Forbidden" }, 403);

  const id = c.req.param("id");
  const att = await prisma.attachment.findUnique({ where: { id } });
  if (!att || att.deletedAt) return c.json({ error: "Tidak ditemukan" }, 404);

  const file = Bun.file(`./uploads/${att.filename}`);
  if (!(await file.exists())) return c.json({ error: "File hilang" }, 404);

  return new Response(file, {
    headers: {
      "Content-Disposition": `attachment; filename="${att.originalName}"`,
      "Content-Type": att.mimeType,
    },
  });
});

attachmentRoutes.get("/:id/preview", async (c) => {
  const tokenQuery = c.req.query("token");
  if (!tokenQuery) return c.json({ error: "Token diperlukan" }, 401);
  let userId: string;
  try {
    const payload = verifyToken(tokenQuery);
    userId = payload.sub;
  } catch {
    return c.json({ error: "Token tidak valid" }, 401);
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, deletedAt: true },
  });
  if (!user || user.deletedAt) return c.json({ error: "User tidak valid" }, 401);
  if (user.role === "CLIENT") return c.json({ error: "Forbidden" }, 403);

  const id = c.req.param("id");
  const att = await prisma.attachment.findUnique({ where: { id } });
  if (!att || att.deletedAt) return c.json({ error: "Tidak ditemukan" }, 404);

  const file = Bun.file(`./uploads/${att.filename}`);
  if (!(await file.exists())) return c.json({ error: "File hilang" }, 404);

  return new Response(file, {
    headers: {
      "Content-Type": att.mimeType,
      "Content-Disposition": "inline",
      "Cache-Control": "private, max-age=300",
    },
  });
});

attachmentRoutes.delete("/:id", async (c) => {
  const user = c.get("user");
  if (user.role === "CLIENT") return c.json({ error: "Forbidden" }, 403);
  if (user.role === "PM") {
    const att = await prisma.attachment.findUnique({ where: { id: c.req.param("id") } });
    if (!att || att.deletedAt) return c.json({ error: "Tidak ditemukan" }, 404);
    await prisma.attachment.update({
      where: { id: att.id },
      data: { deletedAt: new Date() },
    });
    await recordAudit(att.taskId, user.id, "attachment", att.originalName, null);
    return c.json({ ok: true });
  }

  const id = c.req.param("id");
  const att = await prisma.attachment.findUnique({ where: { id } });
  if (!att || att.deletedAt) return c.json({ error: "Tidak ditemukan" }, 404);
  if (att.uploadedById !== user.id) {
    return c.json({ error: "Hanya pengunggah yang boleh menghapus" }, 403);
  }

  await prisma.attachment.update({ where: { id }, data: { deletedAt: new Date() } });
  await recordAudit(att.taskId, user.id, "attachment", att.originalName, null);
  return c.json({ ok: true });
});