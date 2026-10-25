import { expect, test } from "vitest";
import { DEFAULT_MODEL_MAP, mapModel, parseModelMap } from "../../src/core/models";

test("maps a versioned Claude model to the same OpenRouter model", () => {
  const map = DEFAULT_MODEL_MAP;
  expect(mapModel("claude-opus-5-5", map, false)).toBe("anthropic/claude-opus-5.5");
  expect(mapModel("claude-opus-4-7", map, false)).toBe("anthropic/claude-opus-4.7");
  expect(mapModel("claude-opus-5", map, false)).toBe("anthropic/claude-opus-5");
  expect(mapModel("claude-opus-5-20260723", map, false)).toBe("anthropic/claude-opus-5");
  expect(mapModel("claude-haiku-4-5-20251001", map, false)).toBe("anthropic/claude-haiku-4.5");
  expect(mapModel("claude-sonnet-4-6", map, false)).toBe("anthropic/claude-sonnet-4.6");
  expect(mapModel("claude-sonnet-5-5", map, false)).toBe("anthropic/claude-sonnet-5.5");
  expect(mapModel("claude-fable-5-1", map, false)).toBe("anthropic/claude-fable-5.1");
});

test("maps other names by family to the default map's models", () => {
  const map = DEFAULT_MODEL_MAP;
  expect(mapModel("CLAUDE-HAIKU", map, false)).toBe("anthropic/claude-haiku-4.5");
  expect(mapModel("opus", map, false)).toBe("anthropic/claude-opus-5.5");
  expect(mapModel("something-else", map, false)).toBe("anthropic/claude-sonnet-5.5");
  expect(mapModel(undefined, map, false)).toBe("anthropic/claude-sonnet-5.5");
});

test("force-default sends every model to the default entry", () => {
  expect(mapModel("claude-opus-4-8", DEFAULT_MODEL_MAP, true)).toBe("anthropic/claude-sonnet-5.5");
  expect(mapModel("claude-haiku-4-5", DEFAULT_MODEL_MAP, true)).toBe("anthropic/claude-sonnet-5.5");
});

test("parses a custom map from JSON and keeps key order", () => {
  const map = parseModelMap('{"haiku":"h","claude":"c","default":"d"}');
  expect(mapModel("claude-haiku", map, false)).toBe("h");
  expect(mapModel("claude-opus", map, false)).toBe("c");
  expect(mapModel("gpt", map, false)).toBe("d");
  expect(parseModelMap(undefined)).toBe(DEFAULT_MODEL_MAP);
  expect(parseModelMap(" ")).toBe(DEFAULT_MODEL_MAP);
});

test("a custom map serves a model other than Claude by a substring, in any case", () => {
  const map = parseModelMap('{"gpt-5.6-luna":"openai/gpt-5.6-luna","default":"d"}');
  expect(mapModel("gpt-5.6-luna", map, false)).toBe("openai/gpt-5.6-luna");
  expect(mapModel("GPT-5.6-Luna", map, false)).toBe("openai/gpt-5.6-luna");
});

test("rejects invalid maps", () => {
  expect(() => parseModelMap('{"opus":"x"}')).toThrow(/default/);
  expect(() => parseModelMap('["x"]')).toThrow(/object/);
  expect(() => parseModelMap('{"default":1}')).toThrow(/non-empty strings/);
  expect(() => parseModelMap("{not json")).toThrow();
});
