import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { projectTools } from "../../src/tools/projects.js";

const listProjects = projectTools.find((t) => t.name === "turno_list_projects")!;

describe("turno_list_projects date filtering", () => {
  it("does not expose date_range_start/date_range_end — only start/end filter upstream", () => {
    expect(listProjects.inputShape).not.toHaveProperty("date_range_start");
    expect(listProjects.inputShape).not.toHaveProperty("date_range_end");
    expect(listProjects.inputShape).toHaveProperty("start");
    expect(listProjects.inputShape).toHaveProperty("end");
  });

  it("strips unknown date_range_start/date_range_end from input rather than silently ignoring them upstream", () => {
    const parsed = z.object(listProjects.inputShape).parse({
      start: "2026-08-08",
      end: "2026-08-23",
      date_range_start: "2020-01-01",
      date_range_end: "2020-01-02",
    });
    expect(parsed).toEqual({ start: "2026-08-08", end: "2026-08-23" });
  });

  it("forwards start/end straight through to the upstream GET /v2/projects query", async () => {
    const get = vi.fn().mockResolvedValue({ total: 25, data: [] });
    const ctx = { client: { get }, logger: { info: vi.fn(), debug: vi.fn() } } as any;

    await listProjects.handler({ start: "2026-08-08", end: "2026-08-23", limit: 20 }, ctx);

    expect(get).toHaveBeenCalledWith("/projects", {
      query: { start: "2026-08-08", end: "2026-08-23", limit: 20 },
    });
  });
});
