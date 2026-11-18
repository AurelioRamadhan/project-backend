import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function upsertUser(email: string, name: string, role: any, department: any) {
  const passwordHash = await bcrypt.hash("password123", 10);
  return prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, name, passwordHash, role, department },
  });
}

async function main() {
  const pm = await upsertUser("pm@gmail.com", "Aurelio PM", "PM", "PRODUCT");
  const uiux = await upsertUser("uiux@gmail.com", "Budi UIUX", "INTERNAL", "UIUX");
  const fe = await upsertUser("frontend@gmail.com", "Andi Frontend", "INTERNAL", "FRONTEND");
  const be = await upsertUser("backend@gmail.com", "Dimas Backend", "INTERNAL", "BACKEND");
  const client = await upsertUser("client@gmail.com", "Client A", "CLIENT", "CLIENT");

  const project = await prisma.project.upsert({
    where: { id: "project-a-fixed-id" },
    update: {},
    create: {
      id: "project-a-fixed-id",
      name: "Website Development – Company Profile",
      description: "Development of company profile website",
      clientId: client.id,
      startDate: new Date("2026-11-18"),
      dueDate: new Date("2026-12-30"),
      members: {
        create: [{ userId: pm.id }, { userId: uiux.id }, { userId: fe.id }, { userId: be.id }],
      },
    },
  });

  const tDesign = await prisma.task.upsert({
    where: { id: "task-design" },
    update: {},
    create: {
      id: "task-design",
      title: "UI/UX – Website Design",
      description: "Buat desain Figma company profile",
      department: "UIUX",
      priority: "HIGH",
      projectId: project.id,
      assigneeId: uiux.id,
      createdById: pm.id,
      status: "TODO",
      isClientVisible: true,
    },
  });

  const tApi = await prisma.task.upsert({
    where: { id: "task-api" },
    update: {},
    create: {
      id: "task-api",
      title: "Backend – Create REST API",
      description: "REST API untuk company profile",
      department: "BACKEND",
      priority: "HIGH",
      projectId: project.id,
      assigneeId: be.id,
      createdById: pm.id,
      status: "TODO",
      isClientVisible: false,
    },
  });

  const tFront = await prisma.task.upsert({
    where: { id: "task-frontend" },
    update: {},
    create: {
      id: "task-frontend",
      title: "Frontend – Slicing Website",
      description: "Implement website UI berdasarkan Figma",
      department: "FRONTEND",
      priority: "HIGH",
      projectId: project.id,
      assigneeId: fe.id,
      createdById: pm.id,
      status: "TODO",
      isClientVisible: true,
    },
  });

  // Dependencies: frontend depends on design + api
  for (const dep of [
    { taskId: tFront.id, dependsOnTaskId: tDesign.id },
    { taskId: tFront.id, dependsOnTaskId: tApi.id },
  ]) {
    const existing = await prisma.taskDependency.findFirst({ where: { ...dep, deletedAt: null } });
    if (!existing) await prisma.taskDependency.create({ data: dep });
  }

  console.log("✅ Seed selesai.");
  console.log("Akun: pm@gmail.com, uiux@gmail.com, frontend@gmail.com, backend@gmail.com, client@gmail.com");
  console.log("Password: password123");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());