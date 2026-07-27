import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Express } from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

// Synthetic credentials — the /token endpoint validates them by calling
// /userinfo against Turno, which is mocked out below. Nothing real ever
// leaves the test process.
const FAKE_PARTNER_ID = "3e081d7d-0413-45cb-a351-0e2c245e5671";
const FAKE_SECRET_KEY = "eyJ.synthetic.secret-key";
const CANNED_USERINFO = {
  data: {
    id: 999999,
    email: "integration-test@example.com",
    first_name: "Test",
    last_name: "User",
    full_name: "Test User from Integration Suite",
  },
};

let server: Server;
let baseUrl: string;
let originalFetch: typeof globalThis.fetch;

beforeAll(async () => {
  // Must be set BEFORE any dynamic import of http-server — crypto.ts
  // caches the HKDF key on first use.
  process.env.TURNO_ENCRYPTION_KEY = "0".repeat(64);
  process.env.LOG_LEVEL = "silent";
  process.env.TURNO_BASE_URL = "https://api.turnoverbnb.com/v2";

  // Mock globalThis.fetch to intercept Turno API calls. Our test's
  // inbound HTTP to localhost still goes through the real fetch.
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;

    if (url.startsWith("https://api.turnoverbnb.com/v2")) {
      // All Turno calls in this test return canned userinfo with 200.
      return new Response(JSON.stringify(CANNED_USERINFO), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  const { buildApp } = await import("../../src/http-server.js");
  const { logger } = await import("../../src/logger.js");
  const app: Express = buildApp({
    host: "127.0.0.1",
    port: 0,
    publicHost: "turno.test",
    enrollEnabled: true,
    logger,
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await new Promise<void>((r) => server.close(() => r()));
});

interface McpHeaders {
  Authorization: string;
  "mcp-session-id"?: string;
}

function mcpHeaders(bearer: string, sessionId?: string): HeadersInit {
  const h: Record<string, string> = {
    Authorization: `Bearer ${bearer}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (sessionId) h["mcp-session-id"] = sessionId;
  return h;
}

// The MCP streamable transport returns responses as SSE (`data: {...}`).
// Peel off the data line and JSON-parse it.
function parseSseJson(text: string): Record<string, unknown> {
  const line = text
    .split("\n")
    .find((l) => l.startsWith("data: "))
    ?.slice(6);
  if (!line) throw new Error(`no data: line in SSE response: ${text}`);
  return JSON.parse(line);
}

describe("MCP integration smoke", () => {
  let bearer: string;
  let sessionId: string;

  it("/token issues a bearer for valid-looking client_credentials", async () => {
    const res = await originalFetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: FAKE_PARTNER_ID,
        client_secret: FAKE_SECRET_KEY,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
    };
    expect(body.token_type).toBe("Bearer");
    expect(body.access_token.split(".")).toHaveLength(3); // JWT structure
    bearer = body.access_token;
  });

  it("/mcp initialize returns an mcp-session-id", async () => {
    const res = await originalFetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: mcpHeaders(bearer),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "vitest", version: "0" },
        },
      }),
    });
    expect(res.status).toBe(200);
    const sid = res.headers.get("mcp-session-id");
    expect(sid).toBeTruthy();
    sessionId = sid!;
  });

  it("/mcp tools/list returns the registered tool set", async () => {
    // notifications/initialized handshake
    await originalFetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: mcpHeaders(bearer, sessionId),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });

    const res = await originalFetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: mcpHeaders(bearer, sessionId),
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    const payload = parseSseJson(await res.text()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(payload.result.tools.length).toBeGreaterThanOrEqual(40);
    expect(payload.result.tools.some((t) => t.name === "turno_get_userinfo")).toBe(true);
    expect(payload.result.tools.some((t) => t.name === "turno_list_properties")).toBe(true);
  });

  it("/mcp tools/call turno_get_userinfo threads through the mocked fetch", async () => {
    const res = await originalFetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: mcpHeaders(bearer, sessionId),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "turno_get_userinfo", arguments: {} },
      }),
    });
    const payload = parseSseJson(await res.text()) as {
      result: { content: Array<{ type: string; text: string }> };
    };
    const toolText = payload.result.content[0].text;
    const parsed = JSON.parse(toolText) as typeof CANNED_USERINFO;
    expect(parsed.data.email).toBe(CANNED_USERINFO.data.email);
    expect(parsed.data.full_name).toBe(CANNED_USERINFO.data.full_name);
  });

  it("/mcp with unknown bearer is rejected 401", async () => {
    const res = await originalFetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: mcpHeaders("not-a-real-jwt"),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "x", version: "0" } },
      }),
    });
    expect(res.status).toBe(401);
  });

  it("/health reports ok and surfaces auth-readiness config", async () => {
    const res = await originalFetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      transport: string;
      enrollEnabled: boolean;
      encryptionKeyConfigured: boolean;
    };
    expect(body.status).toBe("ok");
    expect(body.transport).toBe("http");
    expect(body.enrollEnabled).toBe(true);
    expect(body.encryptionKeyConfigured).toBe(true);
  });
});

// TS hint for the unused local type; silences "unused" when editor doesn't read JSX.
void (0 as unknown as McpHeaders);
