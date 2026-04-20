import { z } from "zod";
import { jsonContent, tool, type AnyToolDef } from "./_shared.js";

const bookingStatus = z.enum(["confirmed", "new", "canceled"]);

export const bookingTools: AnyToolDef[] = [
  tool({
    name: "turno_list_bookings",
    description: "List bookings. GET /v2/bookings.",
    inputShape: {
      page: z.number().int().optional(),
      limit: z.number().int().optional(),
      sort: z.string().optional(),
      order: z.enum(["asc", "desc"]).optional(),
      checkin_from: z.string().optional().describe("Y-m-d"),
      checkin_to: z.string().optional().describe("Y-m-d"),
      checkout_from: z.string().optional().describe("Y-m-d"),
      checkout_to: z.string().optional().describe("Y-m-d"),
      properties: z.array(z.number().int()).optional(),
    },
    handler: async (args, ctx) => {
      const res = await ctx.client.get("/bookings", { query: args });
      return jsonContent(res);
    },
  }),
  tool({
    name: "turno_get_booking",
    description: "Get a booking by id. GET /v2/bookings/:id.",
    inputShape: { id: z.number().int() },
    handler: async (args, ctx) => {
      const res = await ctx.client.get(`/bookings/${args.id}`);
      return jsonContent(res);
    },
  }),
  tool({
    name: "turno_create_booking",
    description: "Create a booking. POST /v2/bookings. DESTRUCTIVE: creates a guest reservation in Turno.",
    destructive: true,
    inputShape: {
      property_id: z.number().int(),
      external_booking_id: z.string(),
      status: bookingStatus,
      checkin: z.string().describe("Y-m-d H:i:s"),
      checkout: z.string().describe("Y-m-d H:i:s"),
      guest_name: z.string().max(255).optional(),
      description: z.string().max(255).optional(),
      summary: z.string().max(255).optional(),
      adults_count: z.number().int().positive().optional(),
      children_count: z.number().int().nonnegative().optional(),
      infants_count: z.number().int().nonnegative().optional(),
    },
    handler: async (args, ctx) => {
      const res = await ctx.client.post("/bookings", { body: args });
      return jsonContent(res);
    },
  }),
  tool({
    name: "turno_update_booking",
    description: "Update a booking. PATCH /v2/bookings/:id. DESTRUCTIVE: overwrites the reservation record.",
    destructive: true,
    inputShape: {
      id: z.number().int(),
      property_id: z.number().int(),
      external_booking_id: z.string(),
      status: bookingStatus,
      checkin: z.string().describe("Y-m-d H:i:s"),
      checkout: z.string().describe("Y-m-d H:i:s"),
      guest_name: z.string().max(255).optional(),
      description: z.string().max(255).optional(),
      summary: z.string().max(255).optional(),
      adults_count: z.number().int().positive().optional(),
      children_count: z.number().int().nonnegative().optional(),
      infants_count: z.number().int().nonnegative().optional(),
    },
    handler: async (args, ctx) => {
      const { id, ...body } = args;
      const res = await ctx.client.patch(`/bookings/${id}`, { body });
      return jsonContent(res);
    },
  }),
  tool({
    name: "turno_delete_booking",
    description: "Delete a booking. DELETE /v2/bookings/:id. DESTRUCTIVE: permanently removes the reservation.",
    destructive: true,
    inputShape: { id: z.number().int() },
    handler: async (args, ctx) => {
      const res = await ctx.client.delete(`/bookings/${args.id}`);
      return jsonContent(res ?? { deleted: true });
    },
  }),
];
