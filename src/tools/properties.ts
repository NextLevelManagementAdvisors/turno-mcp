import { z } from "zod";
import { jsonContent, tool, type AnyToolDef } from "./_shared.js";

const chargeType = z.enum(["FLAT", "HOURLY"]);

export const propertyTools: AnyToolDef[] = [
  tool({
    name: "turno_list_properties",
    description: "List properties. GET /v2/properties.",
    inputShape: {
      page: z.number().int().optional(),
      limit: z.number().int().optional(),
      sort: z.string().optional(),
      order: z.enum(["asc", "desc"]).optional(),
    },
    handler: async (args, ctx) => {
      const res = await ctx.client.get("/properties", { query: args });
      return jsonContent(res);
    },
  }),
  tool({
    name: "turno_get_property",
    description: "Get a property by id. GET /v2/properties/:id.",
    inputShape: { id: z.number().int() },
    handler: async (args, ctx) => {
      const res = await ctx.client.get(`/properties/${args.id}`);
      return jsonContent(res);
    },
  }),
  tool({
    name: "turno_create_property",
    description: "Create a property. POST /v2/properties. DESTRUCTIVE: creates a new property in Turno.",
    destructive: true,
    inputShape: {
      external_property_id: z.string(),
      alias: z.string(),
      bedrooms: z.string().optional(),
      bathrooms: z.string().optional(),
      checkin_hour: z.string().optional().describe("HH:MM"),
      checkout_hour: z.string().optional().describe("HH:MM"),
      additional_information: z.string().optional(),
      latitude: z.string().optional(),
      longitude: z.string().optional(),
      address: z.string().optional(),
      zip_code: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      country: z.string().optional(),
      publish_projects: z.boolean().optional(),
      property_image_url: z.string().optional(),
      currency: z.string().optional().describe("ISO currency, e.g. USD"),
      early_checkout_enabled: z.boolean().optional(),
    },
    handler: async (args, ctx) => {
      const res = await ctx.client.post("/properties", { body: args });
      return jsonContent(res);
    },
  }),
  tool({
    name: "turno_update_property",
    description: "Update a property. PATCH /v2/properties/:id. DESTRUCTIVE: overwrites the property record.",
    destructive: true,
    inputShape: {
      id: z.number().int(),
      alias: z.string().optional(),
      access_code: z.string().optional(),
      additional_information: z.string().optional(),
      early_checkout_enabled: z.boolean().optional(),
      bedrooms: z.string().optional(),
      bathrooms: z.string().optional(),
      checkin_hour: z.string().optional(),
      checkout_hour: z.string().optional(),
      address: z.string().optional(),
      zip_code: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      country: z.string().optional(),
      publish_projects: z.boolean().optional(),
      property_image_url: z.string().optional(),
      currency: z.string().optional(),
    },
    handler: async (args, ctx) => {
      const { id, ...body } = args;
      const res = await ctx.client.patch(`/properties/${id}`, { body });
      return jsonContent(res);
    },
  }),
  tool({
    name: "turno_disconnect_property",
    description:
      "Disconnect a property from its integration. POST /v2/properties/:id/disconnect. DESTRUCTIVE: unlinks the property from its PMS connection.",
    destructive: true,
    inputShape: { id: z.number().int() },
    handler: async (args, ctx) => {
      const res = await ctx.client.post(`/properties/${args.id}/disconnect`);
      return jsonContent(res ?? { disconnected: true });
    },
  }),

  // ── Property checklists ────────────────────────────────────────────────
  tool({
    name: "turno_get_property_checklists",
    description: "Get a property's checklists. GET /v2/properties/:id/checklists.",
    inputShape: { id: z.number().int() },
    handler: async (args, ctx) => {
      const res = await ctx.client.get(`/properties/${args.id}/checklists`);
      return jsonContent(res);
    },
  }),
  tool({
    name: "turno_delete_property_checklist",
    description:
      "Delete a property's checklist. DELETE /v2/properties/:id/checklists. DESTRUCTIVE: removes the custom checklist.",
    destructive: true,
    inputShape: { id: z.number().int() },
    handler: async (args, ctx) => {
      const res = await ctx.client.delete(`/properties/${args.id}/checklists`);
      return jsonContent(res ?? { deleted: true });
    },
  }),
  tool({
    name: "turno_update_property_checklist",
    description:
      "Update a property's specific checklist item. PATCH /v2/properties/:property_id/checklists/:checklist_id. DESTRUCTIVE.",
    destructive: true,
    inputShape: {
      property_id: z.number().int(),
      checklist_id: z.number().int(),
      body: z.record(z.any()).optional().describe("Raw PATCH body forwarded to Turno"),
    },
    handler: async (args, ctx) => {
      const res = await ctx.client.patch(
        `/properties/${args.property_id}/checklists/${args.checklist_id}`,
        { body: args.body ?? {} },
      );
      return jsonContent(res);
    },
  }),

  // ── Property contractors (mirror of cleaner-side endpoints) ────────────
  tool({
    name: "turno_get_property_contractors",
    description:
      "Get the cleaners assigned to a property. GET /v2/properties/:id/contractors.",
    inputShape: { id: z.number().int() },
    handler: async (args, ctx) => {
      const res = await ctx.client.get(`/properties/${args.id}/contractors`);
      return jsonContent(res);
    },
  }),
  tool({
    name: "turno_add_contractor_to_property",
    description:
      "Attach a cleaner to a property from the property side. POST /v2/properties/:property_id/contractors/:contractor_id. DESTRUCTIVE.",
    destructive: true,
    inputShape: {
      property_id: z.number().int(),
      contractor_id: z.number().int(),
      primary: z.boolean(),
      charge_type: chargeType,
      auto_assign: z.boolean(),
      price_override: z.number().positive().optional(),
      project_types: z.array(z.number().int()).optional(),
    },
    handler: async (args, ctx) => {
      const { property_id, contractor_id, ...body } = args;
      const res = await ctx.client.post(
        `/properties/${property_id}/contractors/${contractor_id}`,
        { body },
      );
      return jsonContent(res);
    },
  }),
  tool({
    name: "turno_update_property_contractor",
    description:
      "Update a cleaner's config on a property (property side). PATCH /v2/properties/:property_id/contractors/:contractor_id. DESTRUCTIVE.",
    destructive: true,
    inputShape: {
      property_id: z.number().int(),
      contractor_id: z.number().int(),
      primary: z.boolean().optional(),
      charge_type: chargeType.optional(),
      auto_assign: z.boolean().optional(),
      price_override: z.number().positive().optional(),
      project_types: z.array(z.number().int()).optional(),
    },
    handler: async (args, ctx) => {
      const { property_id, contractor_id, ...body } = args;
      const res = await ctx.client.patch(
        `/properties/${property_id}/contractors/${contractor_id}`,
        { body },
      );
      return jsonContent(res);
    },
  }),
  tool({
    name: "turno_remove_contractor_from_property",
    description:
      "Remove a cleaner from a property (property side). DELETE /v2/properties/:property_id/contractors/:contractor_id. DESTRUCTIVE.",
    destructive: true,
    inputShape: {
      property_id: z.number().int(),
      contractor_id: z.number().int(),
    },
    handler: async (args, ctx) => {
      const res = await ctx.client.delete(
        `/properties/${args.property_id}/contractors/${args.contractor_id}`,
      );
      return jsonContent(res ?? { deleted: true });
    },
  }),
];
