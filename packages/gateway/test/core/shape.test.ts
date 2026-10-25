import { expect, test } from "vitest";
import { requestShape } from "../../src/core/shape";

test("sizes the parts of a messages request without keeping any content", () => {
  const bash = { name: "Bash", description: "Run a command", input_schema: { type: "object" } };
  const image = { name: "mcp__media__generate_image", description: "x", input_schema: {} };
  const status = { name: "mcp__media__get_generation_status", description: "y", input_schema: {} };
  const shape = requestShape({
    system: [
      { type: "text", text: "abcde" },
      { type: "text", text: "fgh" },
    ],
    tools: [bash, image, status],
    messages: [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "ok" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [
              { type: "text", text: "a.mp4" },
              { type: "image", source: {} },
            ],
          },
          { type: "image", source: {} },
        ],
      },
    ],
  });
  expect(shape).toEqual({
    sys: 8,
    tools: [1, JSON.stringify(bash).length],
    mcp: { media: [2, JSON.stringify(image).length + JSON.stringify(status).length] },
    msgs: [3, 5 + 2 + JSON.stringify({ command: "ls" }).length + 5, 5],
    images: 2,
  });
});

test("records the thinking effort the request was sent at", () => {
  expect(requestShape({ output_config: { effort: "low" } }).effort).toBe("low");
  expect("effort" in requestShape({ messages: [] })).toBe(false);
});

test("an empty or odd body sizes to zero", () => {
  expect(requestShape({ system: "sys", tools: "no", messages: null })).toEqual({
    sys: 3,
    tools: [0, 0],
    mcp: {},
    msgs: [0, 0, 0],
    images: 0,
  });
});
