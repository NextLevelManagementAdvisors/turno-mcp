import { describe, it, expect } from "vitest";
import { z } from "zod";
import { shapeToJsonSchema } from "../../src/tools/_shared.js";

describe("shapeToJsonSchema", () => {
  it("maps the four primitive types with correct required[]", () => {
    const schema = shapeToJsonSchema({
      s: z.string(),
      n: z.number(),
      b: z.boolean(),
      e: z.enum(["a", "b", "c"]),
    });
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["s", "n", "b", "e"]);
    expect(schema.properties).toEqual({
      s: { type: "string" },
      n: { type: "number" },
      b: { type: "boolean" },
      e: { type: "string", enum: ["a", "b", "c"] },
    });
  });

  it("excludes `.optional()` and `.default()` fields from required[]", () => {
    const schema = shapeToJsonSchema({
      needed: z.string(),
      opt: z.string().optional(),
      def: z.number().default(42),
    });
    expect(schema.required).toEqual(["needed"]);
    expect(Object.keys(schema.properties).sort()).toEqual(["def", "needed", "opt"]);
  });

  it("emits array type with nested item schema", () => {
    const schema = shapeToJsonSchema({
      ids: z.array(z.number().int()),
      tags: z.array(z.string()).optional(),
    });
    expect(schema.properties.ids).toMatchObject({
      type: "array",
      items: { type: "number" },
    });
    expect(schema.properties.tags).toMatchObject({
      type: "array",
      items: { type: "string" },
    });
    expect(schema.required).toEqual(["ids"]);
  });

  it("preserves .describe() as the JSON-schema `description`", () => {
    const schema = shapeToJsonSchema({
      partner_id: z.string().describe("UUID from Turno dashboard"),
    });
    expect((schema.properties.partner_id as { description?: string }).description).toBe(
      "UUID from Turno dashboard",
    );
  });
});
