import { z } from "zod";
import { jsonContent, tool, type AnyToolDef } from "./_shared.js";

export const assignmentTools: AnyToolDef[] = [
  tool({
    name: "turno_create_assignment",
    description:
      "Force-assign a contractor to a project. POST /v2/assignments. DESTRUCTIVE: immediately creates a billable cleaning assignment.",
    destructive: true,
    inputShape: {
      project_id: z.number().int().describe("Project ID (see turno_list_projects)"),
      contractor_id: z.number().int().describe("Contractor ID (see turno_list_cleaners)"),
    },
    handler: async (args, ctx) => {
      const res = await ctx.client.post("/assignments", { body: args });
      return jsonContent(res);
    },
  }),
  tool({
    name: "turno_cancel_assignment",
    description:
      "Cancel an existing assignment for a project. DELETE /v2/assignments. DESTRUCTIVE: detaches the contractor.",
    destructive: true,
    inputShape: {
      project_id: z.number().int().describe("Project ID whose assignment should be cancelled"),
    },
    handler: async (args, ctx) => {
      const res = await ctx.client.delete("/assignments", { body: args });
      return jsonContent(res);
    },
  }),
];
