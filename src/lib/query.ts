import type { PrismaClient } from "../../generated/prisma/client";

type FilterValue = string | number | boolean | (string | number | boolean)[];

export interface QueryParams {
  filters?: Record<string, FilterValue>;
  searchFilters?: Record<string, string>;
  rangedFilters?: { key: string; start: any; end: any }[];
  page?: number;
  rows?: number;
  orderKey?: string;
  orderRule?: "asc" | "desc";
}

const STRING_FIELDS = new Set([
  "name",
  "title",
  "description",
  "email",
  "originalName",
]);

export function parseQuery(searchParams: URLSearchParams): QueryParams {
  const out: QueryParams = {};
  const f = searchParams.get("filters");
  if (f) {
    try {
      out.filters = JSON.parse(f);
    } catch {}
  }
  const sf = searchParams.get("searchFilters");
  if (sf) {
    try {
      out.searchFilters = JSON.parse(sf);
    } catch {}
  }
  const rf = searchParams.get("rangedFilters");
  if (rf) {
    try {
      out.rangedFilters = JSON.parse(rf);
    } catch {}
  }
  const page = searchParams.get("page");
  if (page) out.page = Math.max(1, Number(page) || 1);
  const rows = searchParams.get("rows");
  if (rows) out.rows = Math.max(1, Math.min(100, Number(rows) || 10));
  const orderKey = searchParams.get("orderKey");
  if (orderKey) out.orderKey = orderKey;
  const orderRule = searchParams.get("orderRule");
  if (orderRule === "asc" || orderRule === "desc") out.orderRule = orderRule;
  return out;
}

export function buildWhere(
  q: QueryParams,
  allowedFields: Set<string>
): Record<string, any> {
  const where: Record<string, any> = {};
  if (q.filters) {
    for (const [key, val] of Object.entries(q.filters)) {
      if (!allowedFields.has(key)) continue;
      if (Array.isArray(val)) {
        where[key] = { in: val };
      } else {
        where[key] = val;
      }
    }
  }
  if (q.searchFilters) {
    const or: any[] = [];
    for (const [key, val] of Object.entries(q.searchFilters)) {
      if (!allowedFields.has(key) || !STRING_FIELDS.has(key)) continue;
      or.push({ [key]: { contains: val, mode: "insensitive" } });
    }
    if (or.length) where.OR = or;
  }
  if (q.rangedFilters) {
    for (const r of q.rangedFilters) {
      if (!allowedFields.has(r.key)) continue;
      where[r.key] = {
        ...(where[r.key] || {}),
        gte: r.start,
        lte: r.end,
      };
    }
  }
  return where;
}

export function buildOrder(
  q: QueryParams,
  allowedFields: Set<string>,
  fallback: string
): Record<string, "asc" | "desc"> {
  if (q.orderKey && allowedFields.has(q.orderKey)) {
    return { [q.orderKey]: q.orderRule || "asc" };
  }
  return { [fallback]: q.orderRule || "desc" };
}

export function buildPagination(q: QueryParams) {
  const page = q.page || 1;
  const rows = q.rows || 20;
  return { skip: (page - 1) * rows, take: rows };
}