import { Hono } from "hono";
import { cors } from "hono/cors";
import { authRoutes } from "./routes/auth";
import { projectRoutes } from "./routes/projects";
import { taskRoutes } from "./routes/tasks";
import { attachmentRoutes } from "./routes/attachments";
import { auditRoutes } from "./routes/audit";
import { dashboardRoutes } from "./routes/dashboard";
import { clientRoutes } from "./routes/client";
import { userRoutes } from "./routes/users";

const app = new Hono();

app.use("*", cors({ origin: process.env.FRONTEND_URL || "http://localhost:3000", credentials: true }));

app.get("/", (c) => c.text("Project Management API aktif"));
app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/api/auth", authRoutes);
app.route("/api/projects", projectRoutes);
app.route("/api/tasks", taskRoutes);
app.route("/api/attachments", attachmentRoutes);
app.route("/api/audit", auditRoutes);
app.route("/api/dashboard", dashboardRoutes);
app.route("/api/client", clientRoutes);
app.route("/api/users", userRoutes);

export default {
  port: Number(process.env.PORT) || 4000,
  fetch: app.fetch,
};