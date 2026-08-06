import { z } from "zod";
import { jsonContent, tool, type AnyToolDef } from "./_shared.js";

const chargeType = z.enum(["FLAT", "HOURLY"]);

export const projectTools: AnyToolDef[] = [
  tool({
    name: "turno_list_projects",
    description:
      "List cleaning/turnover projects with flexible filters. GET /v2/projects. " +
      "Use `start`/`end` to bound the date range — there is no separate date_range_start/date_range_end filter upstream.",
    inputShape: {
      time_type: z.enum(["DAY", "WEEK", "MONTH", "YEAR"]).optional(),
      time_value: z.number().int().optional(),
      properties: z.string().optional().describe("Comma-separated property IDs, e.g. '1,2,3'"),
      property_groups: z.string().optional().describe("Comma-separated property group IDs"),
      cleaners: z.string().optional().describe("Comma-separated contractor IDs"),
      customers: z.string().optional().describe("Comma-separated customer IDs"),
      project_ids: z.string().optional().describe("Comma-separated project IDs"),
      start: z.string().optional().describe("Y-m-d. Filters to projects on or after this date."),
      end: z.string().optional().describe("Y-m-d. Filters to projects on or before this date."),
      none: z.boolean().optional(),
      limit: z.number().int().optional(),
      page: z.number().int().optional(),
      integration_only: z.number().int().optional().describe("1 to restrict to this integration"),
      integration_uid: z.string().optional().describe("UUID of a specific integration"),
    },
    handler: async (args, ctx) => {
      const res = await ctx.client.get("/projects", { query: args });
      return jsonContent(res);
    },
  }),
  tool({
    name: "turno_get_project",
    description: "Get a project by id. GET /v2/projects/:id.",
    inputShape: { id: z.number().int() },
    handler: async (args, ctx) => {
      const res = await ctx.client.get(`/projects/${args.id}`);
      return jsonContent(res);
    },
  }),
  tool({
    name: "turno_create_project",
    description:
      "Create a cleaning/turnover project. POST /v2/projects. DESTRUCTIVE: creates a billable job.",
    destructive: true,
    inputShape: {
      property_id: z.number().int(),
      begin_time: z.string().describe("Y-m-d H:i:s"),
      end_time: z.string().describe("Y-m-d H:i:s"),
      project_type_id: z.number().int(),
      charge_type: chargeType,
      cleaning_price: z.number().nonnegative(),
      publish: z.boolean().default(true),
      summary: z.string().optional(),
      cleaner_description: z.string().optional(),
      use_default_checklist: z.boolean().optional(),
    },
    handler: async (args, ctx) => {
      const res = await ctx.client.post("/projects", { body: args });
      return jsonContent(res);
    },
  }),
  tool({
    name: "turno_update_project",
    description:
      "Update a project. PATCH /v2/projects/:id. DESTRUCTIVE: overwrites the project record.",
    destructive: true,
    inputShape: {
      id: z.number().int(),
      begin_time: z.string().optional().describe("Y-m-d H:i:s"),
      end_time: z.string().optional().describe("Y-m-d H:i:s"),
      project_type_id: z.number().int().optional(),
      charge_type: chargeType.optional(),
      cleaning_price: z.number().nonnegative().optional(),
      publish: z.boolean().optional(),
      summary: z.string().optional(),
      cleaner_description: z.string().optional(),
    },
    handler: async (args, ctx) => {
      const { id, ...body } = args;
      const res = await ctx.client.patch(`/projects/${id}`, { body });
      return jsonContent(res);
    },
  }),
  tool({
    name: "turno_delete_project",
    description:
      "Delete a project. DELETE /v2/projects/:id. DESTRUCTIVE: permanently cancels and removes the project.",
    destructive: true,
    inputShape: { id: z.number().int() },
    handler: async (args, ctx) => {
      const res = await ctx.client.delete(`/projects/${args.id}`);
      return jsonContent(res ?? { deleted: true });
    },
  }),
  tool({
    name: "turno_notify_early_checkout",
    description:
      "Notify an assigned cleaner that guests have checked out early. POST /v2/projects/:id/notify-early-checkout. DESTRUCTIVE: sends notifications to cleaners.",
    destructive: true,
    inputShape: { id: z.number().int() },
    handler: async (args, ctx) => {
      const res = await ctx.client.post(`/projects/${args.id}/notify-early-checkout`);
      return jsonContent(res ?? { notified: true });
    },
  }),
  tool({
    name: "turno_list_project_types",
    description:
      "List project types available to this account. GET /v2/projects/available-types.",
    inputShape: {},
    handler: async (_args, ctx) => {
      const res = await ctx.client.get("/projects/available-types");
      return jsonContent(res);
    },
  }),
  tool({
    name: "turno_get_project_checklist",
    description: "Get a project's checklist. GET /v2/projects/:id/checklist.",
    inputShape: { id: z.number().int() },
    handler: async (args, ctx) => {
      const res = await ctx.client.get(`/projects/${args.id}/checklist`);
      return jsonContent(res);
    },
  }),
];
