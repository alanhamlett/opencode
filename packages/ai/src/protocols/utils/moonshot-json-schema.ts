import type { JsonSchema } from "../../schema/index.js"
import { isRecord } from "../../utils/record.js"

// Moonshot validates tool schemas against its own JSON Schema subset, then constrains tool arguments
// to a copy of the schema without the keywords that subset lacks. Rewrite the shapes published tool
// schemas commonly contain into supported equivalents and send everything else unchanged.
const SCHEMA_MAPS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependencies",
])
const VALUES = new Set(["const", "default", "enum", "example", "examples", "required", "dependentRequired"])
const ANNOTATIONS = new Set([
  "description",
  "title",
  "default",
  "example",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "$comment",
])
const NULLABLE_ENUM_TYPES = new Set(["string", "number", "integer", "boolean"])

const mapValues = (record: Record<string, unknown>, map: (value: unknown, key: string) => unknown) =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [key, map(value, key)]))

const omit = (record: Record<string, unknown>, ...keys: string[]) =>
  Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)))

const jsonType = (value: unknown) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value)

// Moonshot rejects boolean schemas in schema maps and array items. `true` accepts anything, like `{}`.
const subschema = (value: unknown) => (value === true ? {} : normalizeNode(value))

const normalizeNode = (schema: unknown): unknown => {
  if (Array.isArray(schema)) return schema.map(normalizeNode)
  if (!isRecord(schema)) return schema
  const normalized = mapValues(schema, (value, key) => {
    if (VALUES.has(key)) return value
    if (SCHEMA_MAPS.has(key) && isRecord(value)) return mapValues(value, subschema)
    if (key === "items" || key === "prefixItems") return Array.isArray(value) ? value.map(subschema) : subschema(value)
    return normalizeNode(value)
  })
  return [unwrapAllOf, constEnum, tupleItems, enumType, refAnyOf].reduce((node, rewrite) => rewrite(node), normalized)
}

// Moonshot drops `allOf`. A lone `allOf: [{ $ref }]` beside annotations, which older generators emit
// for a described reference, means the same as the `$ref` itself.
const unwrapAllOf = (schema: Record<string, unknown>) => {
  if (!Array.isArray(schema.allOf) || schema.allOf.length !== 1) return schema
  const entry = schema.allOf[0]
  if (!isRecord(entry) || typeof entry.$ref !== "string" || Object.keys(entry).length !== 1) return schema
  if (Object.keys(schema).some((key) => key !== "allOf" && !ANNOTATIONS.has(key))) return schema
  return { ...omit(schema, "allOf"), $ref: entry.$ref }
}

// Moonshot drops `const`, so a literal becomes a one-value `enum`.
const constEnum = (schema: Record<string, unknown>) =>
  "const" in schema && !("enum" in schema) ? { ...omit(schema, "const"), enum: [schema.const] } : schema

// Moonshot's `items` is one schema for every element, so tuple positions and any rest schema become
// an `anyOf` of their schemas.
const tupleItems = (schema: Record<string, unknown>) => {
  if (Array.isArray(schema.prefixItems))
    return {
      ...omit(schema, "prefixItems"),
      items: anyOf([...schema.prefixItems, ...(isRecord(schema.items) ? [schema.items] : [])]),
    }
  if (Array.isArray(schema.items))
    return {
      ...omit(schema, "additionalItems"),
      items: anyOf([...schema.items, ...(isRecord(schema.additionalItems) ? [schema.additionalItems] : [])]),
    }
  return schema
}

const anyOf = (schemas: ReadonlyArray<unknown>) => {
  if (schemas.length === 0) return {}
  if (schemas.length === 1) return schemas[0]
  return { anyOf: schemas }
}

// Moonshot rejects an `enum` without a single `type`, and a type list beside `enum` may only pair
// "null" with one primitive type. Derive the type from the values, splitting the rest into `anyOf`.
const enumType = (schema: Record<string, unknown>) => {
  if (!Array.isArray(schema.enum) || typeof schema.type === "string" || nullableEnumType(schema.type)) return schema
  const values = schema.enum
  const types = [...new Set(values.map(jsonType))]
  const kinds = types.filter((item) => item !== "null")
  if (kinds.length === 0) return values.length === 0 ? schema : { ...schema, type: "null" }
  if (types.length === 1) return { ...schema, type: kinds[0] }
  if (kinds.length === 1 && NULLABLE_ENUM_TYPES.has(kinds[0])) return { ...schema, type: [kinds[0], "null"] }
  if ("anyOf" in schema) return schema
  return {
    ...omit(schema, "type", "enum"),
    anyOf: types.map((item) =>
      item === "null" ? { type: item } : { type: item, enum: values.filter((value) => jsonType(value) === item) },
    ),
  }
}

const nullableEnumType = (type: unknown) =>
  Array.isArray(type) &&
  (type.length === 1 ||
    (type.length === 2 && type.includes("null") && type.some((item) => NULLABLE_ENUM_TYPES.has(item))))

// After expanding a `$ref`, Moonshot rejects the target's `type` beside `anyOf`, so the reference
// moves into each branch.
const refAnyOf = (schema: Record<string, unknown>) => {
  if (typeof schema.$ref !== "string" || !Array.isArray(schema.anyOf)) return schema
  const branches = schema.anyOf.filter(isRecord)
  if (branches.length !== schema.anyOf.length || branches.some((branch) => "$ref" in branch)) return schema
  return { ...omit(schema, "$ref"), anyOf: branches.map((branch) => ({ $ref: schema.$ref, ...branch })) }
}

export const normalize = (schema: JsonSchema): JsonSchema => {
  const normalized = normalizeNode(schema)
  return isRecord(normalized) ? normalized : {}
}

export * as MoonshotJsonSchema from "./moonshot-json-schema.js"
