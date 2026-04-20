import { z } from "zod";
import { jsonContent, tool, type AnyToolDef } from "./_shared.js";

/**
 * OAuth-adjacent utilities. The full OAuth authorization-code flow is a
 * scaffolded follow-up — for now we expose userinfo (handy "who am I"?)
 * and passthrough tools for partners managing their own OAuth exchange.
 */
export const oauthTools: AnyToolDef[] = [
  tool({
    name: "turno_get_userinfo",
    description: "Get info about the currently authenticated Turno user. GET /v2/userinfo.",
    inputShape: {},
    handler: async (_args, ctx) => {
      const res = await ctx.client.get("/userinfo");
      return jsonContent(res);
    },
  }),
  tool({
    name: "turno_oauth_token_exchange",
    description:
      "Exchange an OAuth authorization code for access+refresh tokens, or refresh an expired access token. POST /v2/oauth/token. For partners running their own OAuth client — this MCP's own tenant auth is separate.",
    inputShape: {
      grant_type: z.enum(["authorization_code", "refresh_token"]),
      client_id: z.string(),
      client_secret: z.string(),
      code: z.string().optional().describe("Required when grant_type=authorization_code"),
      redirect_uri: z.string().optional().describe("Required when grant_type=authorization_code"),
      refresh_token: z.string().optional().describe("Required when grant_type=refresh_token"),
    },
    handler: async (args, ctx) => {
      const res = await ctx.client.post("/oauth/token", { body: args });
      return jsonContent(res);
    },
  }),
];
