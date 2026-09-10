import { z } from "zod";
import { jsonContent, tool, type AnyToolDef } from "./_shared.js";

const problemStatus = z.enum(["solved", "unresolved"]);

/** Undocumented upstream default when `limit` is omitted (see issue #11). */
const DEFAULT_PROBLEMS_LIMIT = 100;

/**
 * `GET /v2/projects` returns a Laravel-paginator envelope (current_page /
 * last_page / per_page / total) alongside its list. `GET /v2/problems` does
 * not, so a caller has no way to tell "165 items, that's all of them" from
 * "165 items, truncated at the limit". If upstream ever starts including its
 * own paginator fields, pass them through untouched; otherwise synthesize the
 * minimum a caller needs to detect truncation without a second round-trip.
 */
function withPaginationEnvelope(res: unknown, limitApplied: number): unknown {
  if (res === null || typeof res !== "object" || Array.isArray(res)) {
    return res;
  }
  const obj = res as Record<string, unknown>;
  const hasUpstreamPagination =
    "current_page" in obj || "last_page" in obj || "per_page" in obj || "total" in obj;
  if (hasUpstreamPagination) {
    return obj;
  }
  const itemsKey = Array.isArray(obj.data) ? "data" : Array.isArray(obj.items) ? "items" : null;
  if (!itemsKey) {
    return obj;
  }
  const items = obj[itemsKey] as unknown[];
  return {
    ...obj,
    returned: items.length,
    limit_applied: limitApplied,
    has_more: items.length === limitApplied,
  };
}

export const problemTools: AnyToolDef[] = [
  tool({
    name: "turno_list_problems",
    description:
      "List reported problems. GET /v2/problems. Upstream defaults to limit=100 when omitted " +
      "(undocumented). The response has no upstream pagination envelope, so this tool adds " +
      "`returned`/`limit_applied`/`has_more` — if `returned === limit_applied`, pass a larger " +
      "`limit` or increment `page` to check for more.",
    inputShape: {
      property_id: z.number().int().optional().describe("Filter by property (maps to `property-id` query param)"),
      status: problemStatus.optional(),
      limit: z.number().int().optional().describe("Max results per page. Upstream defaults to 100 if omitted."),
      page: z.number().int().optional(),
    },
    handler: async (args, ctx) => {
      const query: Record<string, unknown> = {
        status: args.status,
        limit: args.limit,
        page: args.page,
      };
      if (args.property_id !== undefined) query["property-id"] = args.property_id;
      const res = await ctx.client.get("/problems", { query: query as Record<string, string | number | boolean | null | undefined> });
      return jsonContent(withPaginationEnvelope(res, args.limit ?? DEFAULT_PROBLEMS_LIMIT));
    },
  }),
  tool({
    name: "turno_create_problem",
    description: "Report a new problem for a property. POST /v2/problems. DESTRUCTIVE: creates a problem record visible to the host.",
    destructive: true,
    inputShape: {
      property_id: z.number().int(),
      title: z.string().optional(),
      description: z.string().optional(),
    },
    handler: async (args, ctx) => {
      const res = await ctx.client.post("/problems", { body: args });
      return jsonContent(res);
    },
  }),
  tool({
    name: "turno_update_problem",
    description: "Update a problem (title/description/status). PATCH /v2/problems/:id. DESTRUCTIVE: overwrites the report.",
    destructive: true,
    inputShape: {
      id: z.number().int(),
      title: z.string().optional(),
      description: z.string().optional(),
      status: problemStatus.optional(),
    },
    handler: async (args, ctx) => {
      const { id, ...body } = args;
      const res = await ctx.client.patch(`/problems/${id}`, { body });
      return jsonContent(res);
    },
  }),
];
