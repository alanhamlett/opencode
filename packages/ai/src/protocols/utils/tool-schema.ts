import type { JsonSchema, LanguageModel, LanguageModelSanitizerCompatibility } from "../../schema/index.js"
import { GeminiJsonSchema } from "./gemini-json-schema.js"
import { MoonshotJsonSchema } from "./moonshot-json-schema.js"

const moonshot = MoonshotJsonSchema.normalize

const openAI = (schema: JsonSchema): JsonSchema => schema
const responses = openAI

const gemini = GeminiJsonSchema.normalize

const MODEL_NAMES = [
  [/gemini/i, "gemini"],
  [/kimi/i, "moonshot"],
] as const

// An explicit `sanitizer` wins, and `none` opts out. Otherwise the protocol's own default
// applies (the Gemini API always uses Gemini's rules), then the model name selects the family's rules
// so models reached through gateways and OpenAI-compatible endpoints get the same handling.
const modelCompatibility = (
  schema: JsonSchema,
  model: LanguageModel,
  protocolDefault?: LanguageModelSanitizerCompatibility,
): JsonSchema => {
  switch (model.compatibility?.sanitizer ?? protocolDefault ?? MODEL_NAMES.find(([name]) => name.test(model.id))?.[1]) {
    case "gemini":
      return gemini(schema)
    case "moonshot":
      return moonshot(schema)
    case "none":
    case undefined:
      return schema
  }
}

export const ToolSchemaProjection = {
  gemini,
  modelCompatibility,
  moonshot,
  openAI,
  responses,
} as const
