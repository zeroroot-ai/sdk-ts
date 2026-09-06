// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { ScalarType, type DescEnum, type DescField, type DescMessage } from "@bufbuild/protobuf"
import type { JsonSchema } from "./registry.js"

/**
 * A JSON Schema for a proto request message, walked from its descriptor.
 *
 * The schema describes canonical protojson, because that is what the tool
 * decodes with `fromJson`: camelCase keys, 64-bit integers as decimal
 * strings, bytes as base64, enums as their value names, timestamps as
 * RFC3339. `fromJson` also accepts the proto field name and a bare number
 * for an enum, so a model that writes either still succeeds; the schema
 * names one spelling so the model has one to copy.
 *
 * The walk is bounded. A message that reaches {@link MAX_DEPTH} or that
 * appears twice on the path becomes a bare object with its proto type named
 * in the description. Without a bound, a self-referential message (a graph
 * node, a mission definition) has no finite schema, and the daemon's larger
 * request types would each produce hundreds of kilobytes that every
 * `tools/list` then carries.
 */
export const MAX_DEPTH = 5

/** Proto types with a JSON form of their own, which no field walk can describe. */
const WELL_KNOWN: Record<string, Record<string, unknown>> = {
  "google.protobuf.Timestamp": { type: "string", format: "date-time", description: "RFC 3339 timestamp, e.g. 2026-09-01T12:00:00Z." },
  "google.protobuf.Duration": { type: "string", description: 'Seconds with up to nine fractional digits, ending in "s", e.g. "1.5s".' },
  "google.protobuf.Struct": { type: "object", description: "Free-form JSON object." },
  "google.protobuf.Value": { description: "Any JSON value." },
  "google.protobuf.ListValue": { type: "array", description: "Any JSON array." },
  "google.protobuf.Any": { type: "object", description: 'A packed message: {"@type": "type.googleapis.com/<proto type>", ...fields}.' },
  "google.protobuf.FieldMask": { type: "string", description: "Comma-separated field paths." },
  "google.protobuf.Empty": { type: "object", description: "No fields." },
  "google.protobuf.BoolValue": { type: "boolean" },
  "google.protobuf.StringValue": { type: "string" },
  "google.protobuf.BytesValue": { type: "string", contentEncoding: "base64" },
  "google.protobuf.DoubleValue": { type: "number" },
  "google.protobuf.FloatValue": { type: "number" },
  "google.protobuf.Int32Value": { type: "integer" },
  "google.protobuf.UInt32Value": { type: "integer" },
  "google.protobuf.Int64Value": { type: "string", description: "64-bit integer as a decimal string." },
  "google.protobuf.UInt64Value": { type: "string", description: "64-bit integer as a decimal string." },
  // A TypedValue is a oneof over eight kinds, and the daemon carries them in
  // free-form maps. Any JSON value is the honest description.
  "gibson.common.v1.TypedValue": { description: "Any JSON value: string, number, boolean, null, array or object." },
}

export function scalarSchema(t: ScalarType): Record<string, unknown> {
  switch (t) {
    case ScalarType.DOUBLE:
    case ScalarType.FLOAT:
      return { type: "number" }
    case ScalarType.INT32:
    case ScalarType.UINT32:
    case ScalarType.SINT32:
    case ScalarType.FIXED32:
    case ScalarType.SFIXED32:
      return { type: "integer" }
    case ScalarType.INT64:
    case ScalarType.UINT64:
    case ScalarType.SINT64:
    case ScalarType.FIXED64:
    case ScalarType.SFIXED64:
      return { type: "string", description: "64-bit integer as a decimal string. A JSON number is also accepted." }
    case ScalarType.BOOL:
      return { type: "boolean" }
    case ScalarType.STRING:
      return { type: "string" }
    case ScalarType.BYTES:
      return { type: "string", contentEncoding: "base64", description: "Base64-encoded bytes." }
    default:
      return {}
  }
}

export function enumSchema(e: DescEnum): Record<string, unknown> {
  return {
    type: "string",
    enum: e.values.map((v) => v.name),
    description: `One of ${e.typeName}. The number is also accepted.`,
  }
}

function singular(field: DescField, path: string[]): Record<string, unknown> {
  switch (field.fieldKind) {
    case "scalar":
      return scalarSchema(field.scalar)
    case "enum":
      return enumSchema(field.enum)
    case "message":
      return messageSchema(field.message, path)
    default:
      return {}
  }
}

function fieldSchema(field: DescField, path: string[]): Record<string, unknown> {
  switch (field.fieldKind) {
    case "list": {
      const items =
        field.listKind === "scalar"
          ? scalarSchema(field.scalar)
          : field.listKind === "enum"
            ? enumSchema(field.enum)
            : messageSchema(field.message, path)
      return { type: "array", items }
    }
    case "map": {
      const values =
        field.mapKind === "scalar"
          ? scalarSchema(field.scalar)
          : field.mapKind === "enum"
            ? enumSchema(field.enum)
            : messageSchema(field.message, path)
      // protojson writes every map key as a string, whatever the proto key type.
      return { type: "object", additionalProperties: values }
    }
    default:
      return singular(field, path)
  }
}

export function messageSchema(desc: DescMessage, path: string[] = []): Record<string, unknown> {
  const known = WELL_KNOWN[desc.typeName]
  if (known) return { ...known }
  if (path.includes(desc.typeName)) {
    return { type: "object", description: `${desc.typeName}, which contains itself. Pass its protojson form.` }
  }
  if (path.length >= MAX_DEPTH) {
    return { type: "object", description: `${desc.typeName}, nested past depth ${MAX_DEPTH}. Pass its protojson form.` }
  }
  const next = [...path, desc.typeName]
  const properties: Record<string, unknown> = {}
  for (const field of desc.fields) {
    const schema = fieldSchema(field, next)
    const oneof = field.oneof ? `One of the ${field.oneof.name} group; set at most one of them.` : ""
    const existing = typeof schema.description === "string" ? schema.description : ""
    const description = [existing, oneof].filter(Boolean).join(" ")
    properties[field.jsonName] = description ? { ...schema, description } : schema
  }
  return { type: "object", properties, additionalProperties: false }
}

/**
 * The tool input schema for a request message.
 *
 * `additionalProperties` stays open at the top level: `fromJson` runs with
 * `ignoreUnknownFields` off, so a wrong key is refused with the server's own
 * wording rather than by a schema check that says less.
 */
export function requestSchema(desc: DescMessage): JsonSchema {
  const body = messageSchema(desc)
  return { ...body, type: "object" }
}
