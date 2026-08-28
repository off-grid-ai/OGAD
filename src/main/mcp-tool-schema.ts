// Convert a native action tool's JSON-Schema `parameters` into the Zod raw shape
// the MCP SDK's registerTool expects, so the desktop's action tools (calendar,
// mail, web_use, computer_task, ...) can be exposed over /mcp WITHOUT
// re-declaring their schemas - the NATIVE_TOOL_SPECS catalog stays the single
// source of truth. Handles the subset those tools use: an object of
// string/number/boolean/enum/array properties with `required` + `description`.
import { z } from 'zod'

interface JsonSchemaProp {
  type?: string
  description?: string
  enum?: string[]
  items?: { type?: string }
}

export interface JsonObjectSchema {
  type?: string
  properties?: Record<string, JsonSchemaProp>
  required?: string[]
}

function propToZod(prop: JsonSchemaProp): z.ZodTypeAny {
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    return z.enum(prop.enum as [string, ...string[]])
  }
  switch (prop.type) {
    case 'number':
    case 'integer':
      return z.number()
    case 'boolean':
      return z.boolean()
    case 'array':
      return z.array(prop.items?.type === 'number' ? z.number() : z.string())
    default:
      return z.string()
  }
}

/** The Zod raw shape for a tool's parameters. Optional keys (not in `required`)
 *  become `.optional()`; descriptions carry through to the MCP tool schema. */
export function jsonSchemaToZodShape(schema: JsonObjectSchema): Record<string, z.ZodTypeAny> {
  const required = new Set(schema.required ?? [])
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    let zt = propToZod(prop)
    if (prop.description) {
      zt = zt.describe(prop.description)
    }
    if (!required.has(key)) {
      zt = zt.optional()
    }
    shape[key] = zt
  }
  return shape
}
