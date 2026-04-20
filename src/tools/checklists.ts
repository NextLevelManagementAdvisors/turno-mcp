import { z } from "zod";
import { jsonContent, tool, type AnyToolDef } from "./_shared.js";

export const checklistTools: AnyToolDef[] = [
  tool({
    name: "turno_list_checklists",
    description: "List all checklists available in the account. GET /v2/checklists.",
    inputShape: {},
    handler: async (_args, ctx) => {
      const res = await ctx.client.get("/checklists");
      return jsonContent(res);
    },
  }),
];
