import { z } from "zod";
import { jsonContent, tool, type AnyToolDef } from "./_shared.js";

const problemStatus = z.enum(["solved", "unresolved"]);

export const problemTools: AnyToolDef[] = [
  tool({
    name: "turno_list_problems",
    description: "List reported problems. GET /v2/problems.",
    inputShape: {
      property_id: z.number().int().optional().describe("Filter by property (maps to `property-id` query param)"),
      status: problemStatus.optional(),
      limit: z.number().int().optional(),
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
      return jsonContent(res);
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
