import { z } from "zod";
import { jsonContent, tool, type AnyToolDef } from "./_shared.js";

const chargeType = z.enum(["FLAT", "HOURLY"]);

export const cleanerTools: AnyToolDef[] = [
  tool({
    name: "turno_list_cleaners",
    description: "List all cleaners (contractors) connected to this account. GET /v2/contractors.",
    inputShape: {},
    handler: async (_args, ctx) => {
      const res = await ctx.client.get("/contractors");
      return jsonContent(res);
    },
  }),
  tool({
    name: "turno_get_cleaner_properties",
    description:
      "Get the properties a given cleaner is assigned to. GET /v2/contractors/:id/properties.",
    inputShape: {
      contractor_id: z.number().int(),
    },
    handler: async (args, ctx) => {
      const res = await ctx.client.get(`/contractors/${args.contractor_id}/properties`);
      return jsonContent(res);
    },
  }),
  tool({
    name: "turno_add_cleaner_to_property",
    description:
      "Add a cleaner to a property via the cleaner-side endpoint. POST /v2/contractors/:contractor_id/properties/:property_id. DESTRUCTIVE: creates a contractor–property link.",
    destructive: true,
    inputShape: {
      contractor_id: z.number().int(),
      property_id: z.number().int(),
      primary: z.boolean(),
      charge_type: chargeType,
      auto_assign: z.boolean(),
      price_override: z.number().positive().optional(),
      project_types: z.array(z.number().int()).optional(),
    },
    handler: async (args, ctx) => {
      const { contractor_id, property_id, ...body } = args;
      const res = await ctx.client.post(
        `/contractors/${contractor_id}/properties/${property_id}`,
        { body },
      );
      return jsonContent(res);
    },
  }),
  tool({
    name: "turno_update_cleaner_property",
    description:
      "Update a cleaner's configuration for a property. PATCH /v2/contractors/:contractor_id/properties/:property_id. DESTRUCTIVE: overwrites the link.",
    destructive: true,
    inputShape: {
      contractor_id: z.number().int(),
      property_id: z.number().int(),
      primary: z.boolean().optional(),
      charge_type: chargeType.optional(),
      auto_assign: z.boolean().optional(),
      price_override: z.number().positive().optional(),
      project_types: z.array(z.number().int()).optional(),
    },
    handler: async (args, ctx) => {
      const { contractor_id, property_id, ...body } = args;
      const res = await ctx.client.patch(
        `/contractors/${contractor_id}/properties/${property_id}`,
        { body },
      );
      return jsonContent(res);
    },
  }),
  tool({
    name: "turno_remove_cleaner_from_property",
    description:
      "Remove a cleaner from a property via the cleaner-side endpoint. DELETE /v2/contractors/:contractor_id/properties/:property_id. DESTRUCTIVE.",
    destructive: true,
    inputShape: {
      contractor_id: z.number().int(),
      property_id: z.number().int(),
    },
    handler: async (args, ctx) => {
      const res = await ctx.client.delete(
        `/contractors/${args.contractor_id}/properties/${args.property_id}`,
      );
      return jsonContent(res ?? { deleted: true });
    },
  }),
];
