import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLM } from "../src/index.js"
import { OpenAIChat } from "../src/protocols.js"
import { ToolSchemaProjection } from "../src/protocols/utils/tool-schema.js"
import { Auth } from "../src/route.js"
import { compileRequest } from "../src/route/client.js"
import { it } from "./lib/effect.js"

describe("tool schema projections", () => {
  test("moonshot keeps $ref siblings and converts tuples to one items schema", () => {
    expect(
      ToolSchemaProjection.moonshot({
        type: "object",
        properties: {
          linked: { $ref: "#/$defs/Linked", description: "keep me" },
          tuple: { type: "array", items: [{ type: "string" }, { type: "number" }] },
          tupleRest: { type: "array", items: [{ type: "string" }], additionalItems: { type: "integer" } },
          prefixTuple: { type: "array", prefixItems: [{ type: "boolean" }, { type: "string" }] },
          closedTuple: { type: "array", prefixItems: [{ type: "boolean" }, { type: "string" }], items: false },
          closedDraft07: { type: "array", items: [{ type: "boolean" }], additionalItems: false },
          prefixRest: { type: "array", prefixItems: [true, { type: "number" }], items: { type: "string" } },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        linked: { $ref: "#/$defs/Linked", description: "keep me" },
        tuple: { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } },
        tupleRest: { type: "array", items: { anyOf: [{ type: "string" }, { type: "integer" }] } },
        prefixTuple: { type: "array", items: { anyOf: [{ type: "boolean" }, { type: "string" }] } },
        closedTuple: { type: "array", items: { anyOf: [{ type: "boolean" }, { type: "string" }] } },
        closedDraft07: { type: "array", items: { type: "boolean" } },
        prefixRest: { type: "array", items: { anyOf: [{}, { type: "number" }, { type: "string" }] } },
      },
    })
  })

  test("moonshot rewrites literals, described references, and boolean schemas it drops or rejects", () => {
    expect(
      ToolSchemaProjection.moonshot({
        type: "object",
        properties: {
          kind: { type: "string", const: "a" },
          untyped: { const: 1 },
          parent: { allOf: [{ $ref: "#/$defs/Parent" }], description: "The parent" },
          closed: { allOf: [{ $ref: "#/$defs/Parent" }], additionalProperties: false },
          anything: true,
          list: { type: "array", items: true },
        },
        $defs: { Parent: { type: "object", properties: { name: { type: "string" } } }, Any: true },
      }),
    ).toEqual({
      type: "object",
      properties: {
        kind: { type: "string", enum: ["a"] },
        untyped: { type: "number", enum: [1] },
        parent: { $ref: "#/$defs/Parent", description: "The parent" },
        closed: { allOf: [{ $ref: "#/$defs/Parent" }], additionalProperties: false },
        anything: {},
        list: { type: "array", items: {} },
      },
      $defs: { Parent: { type: "object", properties: { name: { type: "string" } } }, Any: {} },
    })
  })

  test("moonshot moves a $ref beside anyOf into each branch", () => {
    expect(
      ToolSchemaProjection.moonshot({
        type: "object",
        properties: {
          bounded: { $ref: "#/$defs/Name", description: "Name", anyOf: [{ minLength: 1 }, { maxLength: 3 }] },
          mixed: { $ref: "#/$defs/Name", enum: ["a", 1] },
        },
        $defs: { Name: { type: "string" } },
      }),
    ).toEqual({
      type: "object",
      properties: {
        bounded: {
          description: "Name",
          anyOf: [
            { $ref: "#/$defs/Name", minLength: 1 },
            { $ref: "#/$defs/Name", maxLength: 3 },
          ],
        },
        mixed: {
          anyOf: [
            { $ref: "#/$defs/Name", type: "string", enum: ["a"] },
            { $ref: "#/$defs/Name", type: "number", enum: [1] },
          ],
        },
      },
      $defs: { Name: { type: "string" } },
    })
  })

  test("moonshot leaves property names and literal values alone", () => {
    const schema = {
      type: "object",
      properties: {
        const: { type: "string" },
        prefixItems: { type: "string" },
        allOf: { type: "string" },
        enum: { type: "string" },
        list: { type: "array", items: { type: "number" }, default: { items: [1, 2] }, examples: [{ const: 1 }] },
        sample: { type: "object", example: { enum: ["a", 1] } },
      },
    }
    expect(ToolSchemaProjection.moonshot(schema)).toEqual(schema)
  })

  test("moonshot types enums and splits mixed ones", () => {
    expect(
      ToolSchemaProjection.moonshot({
        type: "object",
        properties: {
          kind: { description: "The kind of flag", enum: ["boolean", "string"] },
          level: { enum: [1, 2.5] },
          optional: { enum: [null, "a"] },
          choice: { anyOf: [{ enum: [true, false] }, { type: "null" }] },
          list: { type: "array", items: { enum: ["x"] } },
          map: { type: "object", additionalProperties: { enum: ["y"] } },
          typed: { type: "string", enum: ["a", null] },
          mixed: { enum: ["a", 1] },
          mixedNullable: { description: "Mixed", enum: ["a", 1, null] },
          typeList: { type: ["string", "integer"], enum: ["a", 1] },
          nullableList: { type: ["integer", "null"], enum: [1, null] },
          narrowedList: { type: ["string", "null"], enum: ["a", 1] },
          onlyNull: { enum: [null] },
          empty: { enum: [] },
        },
        $defs: { Mode: { enum: ["fast"] } },
      }),
    ).toEqual({
      type: "object",
      properties: {
        kind: { type: "string", description: "The kind of flag", enum: ["boolean", "string"] },
        level: { type: "number", enum: [1, 2.5] },
        optional: { type: ["string", "null"], enum: [null, "a"] },
        choice: { anyOf: [{ type: "boolean", enum: [true, false] }, { type: "null" }] },
        list: { type: "array", items: { type: "string", enum: ["x"] } },
        map: { type: "object", additionalProperties: { type: "string", enum: ["y"] } },
        typed: { type: "string", enum: ["a", null] },
        mixed: {
          anyOf: [
            { type: "string", enum: ["a"] },
            { type: "number", enum: [1] },
          ],
        },
        mixedNullable: {
          description: "Mixed",
          anyOf: [{ type: "string", enum: ["a"] }, { type: "number", enum: [1] }, { type: "null" }],
        },
        typeList: {
          anyOf: [
            { type: "string", enum: ["a"] },
            { type: "number", enum: [1] },
          ],
        },
        nullableList: { type: ["integer", "null"], enum: [1, null] },
        narrowedList: { type: ["string", "null"], enum: ["a", 1] },
        onlyNull: { type: "null", enum: [null] },
        empty: { enum: [] },
      },
      $defs: { Mode: { type: "string", enum: ["fast"] } },
    })
  })

  it.effect("selects tool schema handling from the model name unless compatibility is explicit", () =>
    Effect.gen(function* () {
      const route = OpenAIChat.route.with({
        endpoint: { baseURL: "https://api.openai.test/v1/" },
        auth: Auth.bearer("test"),
      })
      const original = {
        type: "object",
        required: ["mode", "missing"],
        properties: { mode: { enum: ["fast", "safe"] } },
      }
      const parameters = (model: ReturnType<typeof route.model>) =>
        compileRequest(
          LLM.request({
            model,
            prompt: "Use the tool.",
            tools: [{ name: "lookup", description: "Lookup data.", inputSchema: original }],
          }),
        ).pipe(Effect.map((prepared) => prepared.body.tools?.[0]?.function.parameters))
      const gemini = { ...original, required: ["mode"] }
      const moonshot = { ...original, properties: { mode: { type: "string", enum: ["fast", "safe"] } } }

      expect(yield* parameters(route.model({ id: "google/Gemini-3.8-Flash" }))).toEqual(gemini)
      expect(
        yield* parameters(route.model({ id: "my-tuned-endpoint", compatibility: { sanitizer: "gemini" } })),
      ).toEqual(gemini)
      expect(
        yield* parameters(route.model({ id: "google/gemini-3.8-flash", compatibility: { sanitizer: "moonshot" } })),
      ).toEqual(moonshot)
      expect(yield* parameters(route.model({ id: "moonshotai/Kimi-K3" }))).toEqual(moonshot)
      expect(
        yield* parameters(route.model({ id: "google/gemini-3.8-flash", compatibility: { sanitizer: "none" } })),
      ).toEqual(original)
      expect(
        yield* parameters(route.model({ id: "moonshotai/Kimi-K3", compatibility: { sanitizer: "none" } })),
      ).toEqual(original)
      expect(yield* parameters(route.model({ id: "gpt-6-luna" }))).toEqual(original)
    }),
  )

  it.effect("applies model compatibility without changing schema semantics", () =>
    Effect.gen(function* () {
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
        .model({ id: "kimi-k2", compatibility: { sanitizer: "moonshot" } })
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          prompt: "Use the tool.",
          tools: [
            {
              name: "lookup",
              description: "Lookup data.",
              inputSchema: {
                type: "object",
                anyOf: [
                  {
                    type: "object",
                    properties: {
                      tuple: { type: "array", items: [{ type: "string" }, { type: "number" }] },
                      linked: { $ref: "#/$defs/Linked", description: "keep me" },
                    },
                  },
                ],
              },
            },
          ],
        }),
      )

      expect(prepared.body.tools?.[0]?.function.parameters).toEqual({
        type: "object",
        anyOf: [
          {
            type: "object",
            properties: {
              tuple: { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } },
              linked: { $ref: "#/$defs/Linked", description: "keep me" },
            },
          },
        ],
      })
    }),
  )
})
