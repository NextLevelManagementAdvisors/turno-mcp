import { z } from "zod";
import type { Logger } from "../logger.js";
import type { TurnoClient } from "../turno-client.js";
import { TurnoApiError } from "../turno-client.js";

export interface ToolContext {
  client: TurnoClient;
  logger: Logger;
  tenantId?: string;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function jsonContent(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

export function textContent(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function formatToolError(err: unknown): ToolResult {
  if (err instanceof TurnoApiError) {
    return {
      content: [
        {
          type: "text",
          text: `Turno API error ${err.status} on ${err.method} ${err.path}\n${JSON.stringify(err.body, null, 2)}`,
        },
      ],
      isError: true,
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

/**
 * A single tool definition. Each resource file exports an array of these.
 * `inputSchema` is a Zod object whose shape drives both the MCP JSON schema
 * and runtime validation inside the handler.
 */
export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  destructive?: boolean;
  inputShape: S;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<ToolResult>;
}

/**
 * Type-erased tool used by the registry. Each resource file builds its
 * tools with `tool({...})` (which preserves narrow types for local safety)
 * and exports `AnyToolDef[]`, so the central array isn't forced into a
 * single concrete shape.
 */
export interface AnyToolDef {
  name: string;
  description: string;
  destructive?: boolean;
  inputShape: z.ZodRawShape;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

export function tool<S extends z.ZodRawShape>(def: ToolDef<S>): AnyToolDef {
  return def as unknown as AnyToolDef;
}

/** Convert a Zod object shape to a JSON Schema tool schema the MCP SDK understands. */
export function shapeToJsonSchema(shape: z.ZodRawShape): {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: boolean;
} {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, schema] of Object.entries(shape)) {
    const { property, isRequired } = zodToJsonProperty(schema as z.ZodTypeAny);
    properties[key] = property;
    if (isRequired) required.push(key);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

function zodToJsonProperty(schema: z.ZodTypeAny): {
  property: Record<string, unknown>;
  isRequired: boolean;
} {
  let inner = schema;
  let isRequired = true;
  const description = schema.description;

  // Unwrap .optional() / .nullable() / .default()
  while (
    inner instanceof z.ZodOptional ||
    inner instanceof z.ZodNullable ||
    inner instanceof z.ZodDefault
  ) {
    if (inner instanceof z.ZodOptional) isRequired = false;
    if (inner instanceof z.ZodDefault) isRequired = false;
    inner = (inner as z.ZodOptional<z.ZodTypeAny>).unwrap?.() ?? (inner as { _def: { innerType: z.ZodTypeAny } })._def.innerType;
  }

  const property: Record<string, unknown> = {};
  if (description) property.description = description;

  if (inner instanceof z.ZodString) {
    property.type = "string";
  } else if (inner instanceof z.ZodNumber) {
    property.type = "number";
  } else if (inner instanceof z.ZodBoolean) {
    property.type = "boolean";
  } else if (inner instanceof z.ZodEnum) {
    property.type = "string";
    property.enum = [...(inner.options as readonly string[])];
  } else if (inner instanceof z.ZodArray) {
    property.type = "array";
    const { property: itemProp } = zodToJsonProperty(inner.element as z.ZodTypeAny);
    property.items = itemProp;
  } else if (inner instanceof z.ZodObject) {
    const nested = shapeToJsonSchema(inner.shape);
    property.type = "object";
    property.properties = nested.properties;
    property.required = nested.required;
    property.additionalProperties = false;
  } else {
    // Fallback: allow anything.
    property.type = "string";
  }
  return { property, isRequired };
}
