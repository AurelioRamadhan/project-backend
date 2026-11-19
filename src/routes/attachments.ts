// src/routes/attachments.ts
import { Hono } from "hono";
import { prisma } from "../lib/prisma";
import { authGuard } from "../middleware/auth";
import type { AppEnv } from "../types/auth";
import { recordAudit } from "../utils/permissions";

export const attachmentRoutes = new Hono<AppEnv>();

async function saveFile(file: File, taskId: string, userId: string) {
  const ext = file.name.split(".").pop() || "bin";
  const filename = `${crypto.randomUUID()}.${ext}`;
  await Bun.write(`./uploads/${filename}`, file);

  const attachment = await prisma.attachment.create({
    data: {
      taskId,
      uploadedById: userId,
      filename,
      originalName: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
    },
  });
  await recordAudit(taskId, userId, "attachment", null, file.name);
  return attachment;
}

function validateUpload(
  user: { role: string; id: string },
  task: { assigneeId: string | null; status: string }
) {
  if (user.role === "CLIENT") return "Client tidak boleh upload";
  if (user.role === "INTERNAL" && task.assigneeId !== user.id)
    return "Hanya assignee yang boleh upload";
  if (task.status === "DONE") return "Task sudah selesai, tidak dapat upload";
  return null;
}

attachmentRoutes.post("/task/:taskId", authGuard, async (c) => {
  const user = c.get("user");
  const taskId = c.req.param("taskId");

  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task || task.deletedAt) return c.json({ error: "Task tidak ditemukan" }, 404);

  const err = validateUpload(user, task);
  if (err) return c.json({ error: err }, 403);

  const body = await c.req.parseBody();
  const file = body.file as File;
  if (!file) return c.json({ error: "File wajib diisi" }, 400);

  const attachment = await saveFile(file, taskId, user.id);
  return c.json(attachment, 201);
});

attachmentRoutes.post("/task/:taskId/batch", authGuard, async (c) => {
  const user = c.get("user");
  const taskId = c.req.param("taskId");

  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task || task.deletedAt) return c.json({ error: "Task tidak ditemukan" }, 404);

  const err = validateUpload(user, task);
  if (err) return c.json({ error: err }, 403);

  const body = await c.req.parseBody({ all: true });
  const rawFiles = body.file;
  const files: File[] = Array.isArray(rawFiles)
    ? (rawFiles as File[])
    : rawFiles instanceof File
      ? [rawFiles]
      : [];

  if (files.length === 0) return c.json({ error: "Minimal 1 file" }, 400);
  if (files.length > 20) return c.json({ error: "Maksimal 20 file per upload" }, 400);

  const created = await Promise.all(files.map((f) => saveFile(f, taskId, user.id)));
  return c.json(created, 201);
});

attachmentRoutes.get("/task/:taskId", authGuard, async (c) => {
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

attachmentRoutes.get("/:id/download", authGuard, async (c) => {
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

// PUBLIK — supaya <img>/<iframe>/pdf.js bisa load tanpa header Authorization.
// Aman karena ID = UUID acak & filename = UUID acak.
attachmentRoutes.get("/:id/preview", async (c) => {
  const id = c.req.param("id");
  const att = await prisma.attachment.findUnique({ where: { id } });
  if (!att || att.deletedAt) return c.json({ error: "Tidak ditemukan" }, 404);

  const file = Bun.file(`./uploads/${att.filename}`);
  if (!(await file.exists())) return c.json({ error: "File hilang" }, 404);

  return new Response(file, {
    headers: {
      "Content-Type": att.mimeType,
      "Content-Disposition": "inline",
      "Cache-Control": "private, max-age=3600",
    },
  });
});

attachmentRoutes.delete("/:id", authGuard, async (c) => {
  const user = c.get("user");
  if (user.role === "CLIENT") return c.json({ error: "Forbidden" }, 403);

  const id = c.req.param("id");
  const att = await prisma.attachment.findUnique({ where: { id } });
  if (!att || att.deletedAt) return c.json({ error: "Tidak ditemukan" }, 404);

  const task = await prisma.task.findUnique({ where: { id: att.taskId } });
  if (!task || task.deletedAt) return c.json({ error: "Task tidak ditemukan" }, 404);

  const isOwner = att.uploadedById === user.id;
  const isPM = user.role === "PM";
  const isAssignee = task.assigneeId === user.id;
  if (!isOwner && !isPM && !isAssignee) {
    return c.json({ error: "Tidak berhak menghapus attachment ini" }, 403);
  }
  if (task.status === "DONE" && !isPM) {
    return c.json({ error: "Task sudah selesai, tidak dapat menghapus" }, 400);
  }

  await prisma.attachment.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
  await recordAudit(att.taskId, user.id, "attachment_deleted", att.originalName, null);
  return c.json({ ok: true });
});