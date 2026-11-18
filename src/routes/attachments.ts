import { Hono } from "hono";
import { prisma } from "../lib/prisma";
import { authGuard } from "../middleware/auth";
import type { AppEnv } from "../types/auth";
import { recordAudit } from "../utils/permissions";

export const attachmentRoutes = new Hono<AppEnv>();
attachmentRoutes.use("*", authGuard);

// Upload (Internal team, assignee)
attachmentRoutes.post("/task/:taskId", async (c) => {
  const user = c.get("user");
  const taskId = c.req.param("taskId");

  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task || task.deletedAt) return c.json({ error: "Task tidak ditemukan" }, 404);
  if (user.role === "INTERNAL" && task.assigneeId !== user.id) {
    return c.json({ error: "Hanya assignee yang boleh upload" }, 403);
  }
  if (user.role === "CLIENT") return c.json({ error: "Client tidak boleh upload" }, 403);

  const body = await c.req.parseBody();
  const file = body.file as File;
  if (!file) return c.json({ error: "File wajib diisi" }, 400);

  const ext = file.name.split(".").pop() || "bin";
  const filename = `${crypto.randomUUID()}.${ext}`;
  const filepath = `./uploads/${filename}`;

  await Bun.write(filepath, file);

  const attachment = await prisma.attachment.create({
    data: {
      taskId,
      uploadedById: user.id,
      filename,
      originalName: file.name,
      mimeType: file.type,
      size: file.size,
    },
  });

  await recordAudit(taskId, user.id, "attachment", null, file.name);
  return c.json(attachment, 201);
});

// List attachments
attachmentRoutes.get("/task/:taskId", async (c) => {
  const taskId = c.req.param("taskId");
  const attachments = await prisma.attachment.findMany({
    where: { taskId, deletedAt: null },
    include: { uploadedBy: { select: { id: true, name: true } } },
  });
  return c.json(attachments);
});

// Download
attachmentRoutes.get("/:id/download", async (c) => {
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