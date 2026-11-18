import type { Role, Department } from "../../generated/prisma/client";

export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
  department: Department;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  department: Department;
}

export type AppEnv = {
  Variables: { user: AuthUser };
};