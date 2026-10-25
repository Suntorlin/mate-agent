/**
 * The product's tools, served to the engine as an MCP server (Streamable HTTP, plain JSON
 * answers). Both of the engine's runtimes use it: the inline runtime as an MCP client, a
 * sandbox's agent through its MCP configuration. Every call carries a token this backend minted
 * for one user, so a tool only ever sees that user's data.
 *
 * `initialize` returns the product's persona as MCP `instructions`; the engine puts it in front
 * of the agent, which is how a product gives the engine its voice without a prompt of its own.
 */

import { z } from "zod";
import type { Store, User } from "./store.ts";

const SERVER_INFO = { name: "demo-studio", version: "1" };
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const NOTE_MAX_CHARS = 2000;
const IMAGE_PROMPT_MAX_CHARS = 500;
/** As much of the prompt as fits across the placeholder at its font size. */
const IMAGE_CAPTION_MAX_CHARS = 36;
/** What one generated image costs, in credits: a tool the product charges for itself. */
export const IMAGE_CREDITS = 20;

export const INSTRUCTIONS = `You are Pixel, the assistant of Demo Studio, a small reference product built on Mate Agent.
Be brief and friendly. Answer in the language the user writes in.

When you make something for the user (a web page, a document, an image, any file), it must
appear in their preview pane:
- Write the file, then publish it with the upload-media tool: artifactType "page" for a
  self-contained .html file (inline its CSS and JavaScript), artifactType "file" for anything else.
- Then tell the user in one sentence what you made; do not paste the whole file into the chat.

Demo Studio's own tools: get_credit_balance (the user's credits), save_note and list_notes
(short notes the user asks you to remember), and generate_image, which costs ${IMAGE_CREDITS} credits
an image and answers with the image as SVG markup: save it as a .svg file and publish it with
upload-media (artifactType "file"). Say what an image costs before making more than one.`;

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDefinition[] = [
  {
    name: "get_credit_balance",
    description: "The signed-in user's Demo Studio credit balance. Each turn costs credits.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "save_note",
    description: "Save a short note for the user in Demo Studio.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "The note, plain text" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "list_notes",
    description: "The notes the user saved in Demo Studio, oldest first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "generate_image",
    description:
      `Make an image from a prompt (a mock generator: a placeholder SVG). ` +
      `Costs ${IMAGE_CREDITS} credits; refused when the user has fewer.`,
    inputSchema: {
      type: "object",
      properties: { prompt: { type: "string", description: "What the image shows" } },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
];

const rpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const saveNoteSchema = z.object({ text: z.string().trim().min(1).max(NOTE_MAX_CHARS) });
const generateImageSchema = z.object({
  prompt: z.string().trim().min(1).max(IMAGE_PROMPT_MAX_CHARS),
});

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function text(value: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

const XML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => XML_ENTITIES[char]!);
}

/** A placeholder picture for a prompt: the same prompt always gives the same colours. */
function placeholderSvg(prompt: string): string {
  let hash = 0;
  for (const char of prompt) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  const caption =
    prompt.length > IMAGE_CAPTION_MAX_CHARS
      ? `${prompt.slice(0, IMAGE_CAPTION_MAX_CHARS - 1)}…`
      : prompt;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hue} 70% 62%)"/>` +
    `<stop offset="1" stop-color="hsl(${(hue + 60) % 360} 70% 38%)"/></linearGradient></defs>` +
    `<rect width="512" height="512" fill="url(#g)"/>` +
    `<text x="256" y="262" text-anchor="middle" font-family="sans-serif" font-size="22" ` +
    `fill="white">${escapeXml(caption)}</text></svg>`
  );
}

function callTool(store: Store, user: User, name: string, args: unknown): ToolResult {
  switch (name) {
    case "get_credit_balance": {
      const current = store.userById(user.id);
      return text(JSON.stringify({ credits: current?.credits ?? 0 }));
    }
    case "save_note": {
      const parsed = saveNoteSchema.safeParse(args ?? {});
      if (!parsed.success) return text(`text must be 1 to ${NOTE_MAX_CHARS} characters`, true);
      const note = store.addNote(user.id, parsed.data.text);
      return text(JSON.stringify({ saved: note }));
    }
    case "list_notes":
      return text(JSON.stringify({ notes: store.notes(user.id) }));
    case "generate_image": {
      const parsed = generateImageSchema.safeParse(args ?? {});
      if (!parsed.success) {
        return text(`prompt must be 1 to ${IMAGE_PROMPT_MAX_CHARS} characters`, true);
      }
      const credits = store.spendCredits(user.id, IMAGE_CREDITS);
      if (credits === null) {
        const balance = store.userById(user.id)?.credits ?? 0;
        return text(
          `not enough credits: an image costs ${IMAGE_CREDITS}, the user has ${balance}`,
          true
        );
      }
      const svg = placeholderSvg(parsed.data.prompt);
      return text(JSON.stringify({ svg, creditsCharged: IMAGE_CREDITS, credits }));
    }
    default:
      return text(`unknown tool: ${name}`, true);
  }
}

export type McpReply = { status: number; body: unknown | null };

/** Answer one JSON-RPC message for a user. Notifications get 202 with no body. */
export function handleMcpMessage(store: Store, user: User, raw: unknown): McpReply {
  const parsed = rpcRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      status: 400,
      body: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } },
    };
  }
  const { id, method, params } = parsed.data;
  if (id === undefined) return { status: 202, body: null };
  const result = (value: unknown): McpReply => ({
    status: 200,
    body: { jsonrpc: "2.0", id, result: value },
  });
  switch (method) {
    case "initialize":
      return result({
        protocolVersion:
          typeof params?.protocolVersion === "string"
            ? params.protocolVersion
            : DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return result({});
    case "tools/list":
      return result({ tools: TOOLS });
    case "tools/call":
      return result(callTool(store, user, String(params?.name ?? ""), params?.arguments));
    default:
      return {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `method not found: ${method}` },
        },
      };
  }
}
