import type { AuthUser } from "../types/auth";
import type { Task, TaskStatus } from "../../generated/prisma/client";
import { prisma } from "../lib/prisma";

export async function canViewProject(user: AuthUser, projectId: string): Promise<boolean> {
  if (user.role === "PM") return true;
  if (user.role === "CLIENT") {
    const project = await prisma.project.findFirst({
      where: { id: projectId, clientId: user.id, deletedAt: null },
    });
    return !!project;
  }
  const member = await prisma.projectMember.findFirst({
    where: { projectId, userId: user.id, deletedAt: null },
  });
  return !!member;
}

export function canChangeStatusTo(
  user: AuthUser,
  task: Pick<Task, "assigneeId" | "status" | "department"> & { id: string },
  targetStatus: TaskStatus,
  dependenciesSatisfied: boolean
): { allowed: boolean; reason?: string } {
  if (user.role === "CLIENT") {
    return { allowed: false, reason: "Hanya eksekutor yang boleh mengubah status" };
  }

  if (user.role === "PM" && targetStatus === "DONE") {
    return { allowed: false, reason: "Hanya executor yang ditugaskan yang boleh menyelesaikan task" };
  }

  if (user.role === "INTERNAL" && task.assigneeId !== user.id) {
    return { allowed: false, reason: "Hanya assignee yang boleh mengubah status" };
  }

  if (targetStatus === "IN_PROGRESS" && !dependenciesSatisfied) {
    return { allowed: false, reason: "Dependencies belum selesai. Task masih blocked." };
  }

  if (targetStatus === "DONE" && !dependenciesSatisfied) {
    return { allowed: false, reason: "Dependencies belum selesai." };
  }

  return { allowed: true };
}

export async function areDependenciesSatisfied(taskId: string): Promise<boolean> {
  const deps = await prisma.taskDependency.findMany({
    where: { taskId, deletedAt: null },
    include: { dependsOnTask: true },
  });
  return deps.every((d) => d.dependsOnTask.status === "DONE" && !d.dependsOnTask.deletedAt);
}

export async function recordAudit(
  taskId: string,
  actorId: string,
  changedColumn: string,
  oldValue: string | null,
  newValue: string | null
) {
  await prisma.auditLog.create({
    data: { taskId, actorId, changedColumn, oldValue, newValue },
  });
}