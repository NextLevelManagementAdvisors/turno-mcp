import { describe, it, expect, vi } from "vitest";
import { problemTools } from "../../src/tools/problems.js";

const listProblems = problemTools.find((t) => t.name === "turno_list_problems")!;

function callWith(get: ReturnType<typeof vi.fn>, args: Record<string, unknown> = {}) {
  const ctx = { client: { get }, logger: { info: vi.fn(), debug: vi.fn() } } as any;
  return listProblems.handler(args, ctx);
}

describe("turno_list_problems pagination envelope", () => {
  it("synthesizes returned/limit_applied/has_more=true when upstream omits paginator fields and the page is full", async () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ id: i }));
    const get = vi.fn().mockResolvedValue({ data: items });

    const result = await callWith(get, { limit: 200 });
    const body = JSON.parse(result.content[0].text);

    expect(body.returned).toBe(200);
    expect(body.limit_applied).toBe(200);
    expect(body.has_more).toBe(true);
    expect(body.data).toHaveLength(200);
  });

  it("reports has_more=false when the returned count is under the applied limit", async () => {
    const items = Array.from({ length: 165 }, (_, i) => ({ id: i }));
    const get = vi.fn().mockResolvedValue({ data: items });

    const result = await callWith(get, { limit: 300 });
    const body = JSON.parse(result.content[0].text);

    expect(body.returned).toBe(165);
    expect(body.limit_applied).toBe(300);
    expect(body.has_more).toBe(false);
  });

  it("uses the undocumented upstream default of 100 as limit_applied when limit is omitted", async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const get = vi.fn().mockResolvedValue({ data: items });

    const result = await callWith(get);
    const body = JSON.parse(result.content[0].text);

    expect(body.limit_applied).toBe(100);
    expect(body.has_more).toBe(true);
  });

  it("passes an upstream paginator envelope through untouched instead of overwriting it", async () => {
    const upstream = { current_page: 1, last_page: 2, total: 276, per_page: 200, data: [{ id: 1 }] };
    const get = vi.fn().mockResolvedValue(upstream);

    const result = await callWith(get, { limit: 200 });
    const body = JSON.parse(result.content[0].text);

    expect(body).toEqual(upstream);
    expect(body.returned).toBeUndefined();
    expect(body.limit_applied).toBeUndefined();
  });

  it("forwards property_id as the property-id query param and limit/page straight through", async () => {
    const get = vi.fn().mockResolvedValue({ data: [] });

    await callWith(get, { property_id: 499646, limit: 50, page: 2, status: "unresolved" });

    expect(get).toHaveBeenCalledWith("/problems", {
      query: { "property-id": 499646, status: "unresolved", limit: 50, page: 2 },
    });
  });
});
