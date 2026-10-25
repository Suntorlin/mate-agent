#!/usr/bin/env node
/**
 * End-to-end check of the local stack through the reference product, Demo Studio: what a browser
 * does, minus the browser. It signs up fresh accounts and drives the real engine, gateway, data
 * plane and (for the scenarios marked "model") a real model. Each scenario is a named step; the
 * run prints a table and exits non-zero if any step failed.
 *
 *   scripts/local/stack.sh up
 *   node scripts/local/e2e-demo.mjs                       # every scenario
 *   node scripts/local/e2e-demo.mjs --no-model            # only the ones that cost nothing
 *   node scripts/local/e2e-demo.mjs --only inline,mcp     # some of them
 *   node scripts/local/e2e-demo.mjs --json report.json    # also write the results as JSON
 *
 * The model scenarios cost a few cents of OpenRouter spend per run, and the sandbox one takes a
 * minute or two. The product is at DEMO_URL (default http://localhost:$DEMO_PORT, 9320).
 * The browser side is e2e-ui.mjs. Shared helpers: lib/demo-client.mjs.
 */

import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
  callTool,
  check,
  DEMO_URL,
  DemoClient,
  ENGINE_TOKEN,
  IMAGE_CREDITS,
  mcp,
  newEmail,
  newPassword,
} from "./lib/demo-client.mjs";

/** State the scenarios share: user A runs the model scenarios in one conversation. */
const ctx = { a: new DemoClient(), conversationId: "", signupCredits: 0, pageId: "" };
const a = ctx.a;

/** Always run: the others need an account and a conversation. */
const SETUP = ["signup", "conversation"];

const expectStatus = async (promise, status, what) => {
  const response = await promise;
  check(response.status === status, `${what}: expected ${status}, got ${response.status}`);
  return response;
};

const SCENARIOS = [
  {
    name: "signup",
    describe: "a new account is created, signed in, and starts with credits",
    async run() {
      const user = await a.signUp(newEmail());
      check(user.credits > 0, `expected signup credits, got ${user.credits}`);
      ctx.signupCredits = user.credits;
      await expectStatus(fetch(`${DEMO_URL}/api/me`), 401, "/api/me without a cookie");
      return `${user.credits} credits`;
    },
  },
  {
    name: "conversation",
    describe: "a conversation opens an engine session",
    async run() {
      const conversation = await a.createConversation();
      check(conversation.engineSessionId, "conversation has no engine session");
      ctx.conversationId = conversation.id;
      return `session ${conversation.engineSessionId}`;
    },
  },
  {
    name: "validation",
    describe: "bad sign-ups, sign-ins and prompts are refused with the right status",
    async run() {
      const anon = new DemoClient();
      const post = (path, body, client = anon) => client.fetch(path, { method: "POST", body });
      const taken = newEmail("taken");
      const password = newPassword();
      await expectStatus(
        post("/api/auth/signup", { email: taken, password: "short" }),
        400,
        "short password"
      );
      await expectStatus(
        post("/api/auth/signup", { email: "not-an-email", password }),
        400,
        "bad email"
      );
      await expectStatus(
        post("/api/auth/signup", { email: taken, password }),
        200,
        "first sign-up"
      );
      await expectStatus(
        post("/api/auth/signup", { email: taken, password }),
        409,
        "duplicate sign-up"
      );
      await expectStatus(
        post("/api/auth/signup", { email: taken.toUpperCase(), password }),
        409,
        "email case"
      );
      const wrong = await expectStatus(
        post("/api/auth/signin", { email: taken, password: "wrong-password" }),
        401,
        "wrong password"
      );
      const unknown = await expectStatus(
        post("/api/auth/signin", { email: newEmail("nobody"), password }),
        401,
        "unknown email"
      );
      check(
        (await wrong.text()) === (await unknown.text()),
        "a wrong password and an unknown email must look the same (no account enumeration)"
      );
      await expectStatus(
        new DemoClient().fetch("/api/conversations"),
        401,
        "list without a cookie"
      );
      const prompt = (content) =>
        post(`/api/conversations/${ctx.conversationId}/prompt`, { content }, a);
      await expectStatus(prompt(""), 400, "empty prompt");
      await expectStatus(prompt("   "), 400, "blank prompt");
      await expectStatus(prompt("x".repeat(20_001)), 400, "oversized prompt");
      await expectStatus(
        a.fetch(`/api/conversations/${ctx.conversationId}/prompt`, {
          method: "POST",
          body: undefined,
        }),
        400,
        "no body"
      );
      await expectStatus(a.fetch("/api/conversations/does-not-exist"), 404, "unknown conversation");
      await expectStatus(post("/api/auth/signout", {}, a), 200, "sign out");
      await expectStatus(a.fetch("/api/me"), 401, "after sign-out");
      await a.api("/api/auth/signin", {
        method: "POST",
        body: { email: a.user.email, password: a.user.password },
      });
      return "13 refusals, then sign-in works again";
    },
  },
  {
    name: "isolation",
    describe: "one user cannot read, prompt, stop or list another user's conversation",
    async run() {
      const b = new DemoClient();
      await b.signUp();
      const base = `/api/conversations/${ctx.conversationId}`;
      for (const [method, path] of [
        ["GET", base],
        ["GET", `${base}/artifacts`],
        ["GET", `${base}/events`],
        ["POST", `${base}/prompt`],
        ["POST", `${base}/stop`],
        ["GET", `${base}/artifacts/anything/content`],
      ]) {
        await expectStatus(
          b.fetch(path, { method, body: method === "POST" ? { content: "hi" } : undefined }),
          404,
          `${method} ${path} as another user`
        );
      }
      const listed = (await b.api("/api/conversations")).conversations;
      check(listed.length === 0, `another user sees ${listed.length} conversation(s)`);
      return "6 routes answer 404 to another user; the list is empty";
    },
  },
  {
    name: "engine-auth",
    describe: "the engine's two endpoints (token mint, MCP) refuse anyone without the right bearer",
    async run() {
      const mint = (headers, body) =>
        fetch(`${DEMO_URL}/api/engine/mcp-token`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify(body),
        });
      await expectStatus(mint({}, { user_id: a.user.id }), 401, "mint without a bearer");
      await expectStatus(
        mint({ Authorization: "Bearer wrong" }, { user_id: a.user.id }),
        401,
        "mint with a wrong bearer"
      );
      await expectStatus(
        fetch(`${DEMO_URL}/api/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
        401,
        "MCP without a token"
      );
      check(
        (await mcp("not-a-token", { id: 1, method: "tools/list" })).status === 401,
        "MCP accepted a made-up token"
      );
      const dummyWeb = await mcp(a.cookie.split("=")[1] ?? "x", { id: 1, method: "tools/list" });
      check(dummyWeb.status === 401, "a web session cookie must not work as an MCP token");
      if (!ENGINE_TOKEN)
        return "refusals ok; the valid-bearer half was skipped (no APP_ENGINE_TOKEN)";
      const withEngine = { Authorization: `Bearer ${ENGINE_TOKEN}` };
      await expectStatus(mint(withEngine, { user_id: "not-hex" }), 400, "mint with a bad user id");
      await expectStatus(
        mint(withEngine, { user_id: "0123456789abcdef" }),
        404,
        "mint for an unknown user"
      );
      const token = await a.mintMcpToken();
      check(
        (await mcp(token, { id: 1, method: "tools/list" })).status === 200,
        "a minted token did not work"
      );
      return "mint and MCP refuse no, wrong and borrowed credentials; a minted token works";
    },
  },
  {
    name: "tools",
    describe: "the MCP tools: protocol, per-user notes, balance, and bad input",
    async run() {
      check(ENGINE_TOKEN, "needs APP_ENGINE_TOKEN (the local .env.local)");
      const tokenA = await a.mintMcpToken();
      const b = new DemoClient();
      await b.signUp();
      const tokenB = await b.mintMcpToken();

      const init = await mcp(tokenA, {
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26" },
      });
      check(
        init.body.result.serverInfo && init.body.result.instructions,
        "initialize has no server info or persona"
      );
      check(
        (await mcp(tokenA, { method: "notifications/initialized" })).status === 202,
        "a notification must answer 202"
      );
      const tools = (await mcp(tokenA, { id: 2, method: "tools/list" })).body.result.tools
        .map((t) => t.name)
        .sort();
      check(
        JSON.stringify(tools) ===
          JSON.stringify(["generate_image", "get_credit_balance", "list_notes", "save_note"]),
        `tools were ${tools}`
      );
      check(
        (await mcp(tokenA, { id: 3, method: "no/such/method" })).body.error,
        "an unknown method must be a JSON-RPC error"
      );
      const malformed = await fetch(`${DEMO_URL}/api/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenA}`, "Content-Type": "application/json" },
        body: "{not json",
      });
      check(malformed.status === 400, `malformed JSON answered ${malformed.status}`);

      const note = `e2e-note-${randomBytes(3).toString("hex")}`;
      check(!(await callTool(tokenA, "save_note", { text: note })).isError, "save_note failed");
      const notesA = (await callTool(tokenA, "list_notes")).value.notes.map((n) => n.text);
      const notesB = (await callTool(tokenB, "list_notes")).value.notes.map((n) => n.text);
      check(notesA.includes(note), "user A does not see their own note");
      check(!notesB.includes(note), "user B can see user A's note");

      check(
        (await callTool(tokenA, "save_note", { text: "" })).isError,
        "an empty note must be refused"
      );
      check(
        (await callTool(tokenA, "save_note", { text: "x".repeat(100_000) })).isError,
        "an oversized note must be refused"
      );
      check(
        (await callTool(tokenA, "save_note", {})).isError,
        "a note with no text must be refused"
      );
      check(
        (await callTool(tokenA, "no_such_tool")).isError,
        "an unknown tool must be an error result"
      );

      const balance = (await callTool(tokenA, "get_credit_balance")).value.credits;
      check(balance === (await a.credits()), "the tool and the API disagree on the balance");
      const image = await callTool(tokenA, "generate_image", { prompt: 'a "quoted" <tag> & more' });
      check(
        image.value.creditsCharged === IMAGE_CREDITS,
        "generate_image did not charge its price"
      );
      check(
        image.value.svg.startsWith("<svg") && !image.value.svg.includes("<tag>"),
        "the picture must escape the prompt"
      );
      check(
        (await a.credits()) === balance - IMAGE_CREDITS,
        "the balance did not drop by the price"
      );
      return "protocol, 4 tools, notes isolated between users, input refused, image escaped and charged";
    },
  },
  {
    name: "out-of-credits",
    describe: "at zero credits a prompt is refused (402) and a priced tool takes nothing",
    async run() {
      check(ENGINE_TOKEN, "needs APP_ENGINE_TOKEN (the local .env.local)");
      const c = new DemoClient();
      const user = await c.signUp();
      const conversation = await c.createConversation();
      const token = await c.mintMcpToken();
      const images = Math.floor(user.credits / IMAGE_CREDITS);
      for (let i = 0; i < images; i++) {
        check(
          !(await callTool(token, "generate_image", { prompt: `drain ${i}` })).isError,
          `image ${i} refused early`
        );
      }
      const left = await c.credits();
      check(left < IMAGE_CREDITS, `expected under ${IMAGE_CREDITS} credits left, got ${left}`);
      const refused = await callTool(token, "generate_image", { prompt: "one too many" });
      check(refused.isError && (await c.credits()) === left, "a refused image must take nothing");
      if (left > 0)
        return `${left} credits left (below the price of an image): image refused, nothing taken`;
      const response = await c.fetch(`/api/conversations/${conversation.id}/prompt`, {
        method: "POST",
        body: { content: "hello" },
      });
      check(response.status === 402, `a prompt at zero credits answered ${response.status}`);
      check(
        (await response.json()).error === "out_of_credits",
        "the refusal must say out_of_credits"
      );
      return `drained ${images} images to 0: prompt refused with 402`;
    },
  },
  {
    name: "inline",
    model: true,
    describe: "a conversational prompt is answered inline, and the turn is charged",
    async run() {
      const before = await a.credits();
      const turn = await a.runTurn(
        ctx.conversationId,
        "Reply with exactly the word PONG in capitals, and nothing else. Do not use any tool."
      );
      check(/PONG/.test(turn.reply), `reply was ${JSON.stringify(turn.reply.slice(0, 120))}`);
      check(turn.runtime === "inline", `expected the inline runtime, got ${turn.runtime}`);
      const after = await a.credits();
      check(turn.credits > 0 && after < before, `no charge: ${before} -> ${after}`);
      return `runtime ${turn.runtime}, ${turn.credits} credits`;
    },
  },
  {
    name: "mcp",
    model: true,
    describe: "the product's MCP tools work: balance and notes, through minted tokens",
    async run() {
      const nonce = randomBytes(3).toString("hex");
      const turn = await a.runTurn(
        ctx.conversationId,
        `Do these with your tools, then answer in one line. 1) Save a note with the exact text "e2e-${nonce}". 2) List my notes. 3) Tell me my credit balance as a number. Include the note text in your answer.`
      );
      check(
        turn.reply.includes(`e2e-${nonce}`),
        `note not in the reply: ${turn.reply.slice(0, 200)}`
      );
      check(/\d{3,}/.test(turn.reply), `no balance in the reply: ${turn.reply.slice(0, 200)}`);
      return `runtime ${turn.runtime}`;
    },
  },
  {
    name: "concurrent",
    model: true,
    describe: "a second prompt while a turn runs is refused (409), not queued or charged twice",
    async run() {
      const c = new DemoClient();
      await c.signUp();
      const conversation = await c.createConversation();
      const prompt = (content) =>
        c.fetch(`/api/conversations/${conversation.id}/prompt`, {
          method: "POST",
          body: { content },
        });
      const first = await prompt("Reply with exactly the word ONE, nothing else.");
      check(first.status === 200, `the first prompt answered ${first.status}`);
      const second = await prompt("Reply with exactly the word TWO, nothing else.");
      check(second.status === 409, `the second prompt answered ${second.status}, expected 409`);
      check((await second.json()).error === "turn_running", "the refusal must say turn_running");
      const { turn } = await first.json();
      const deadline = Date.now() + 120_000;
      let settled = null;
      while (Date.now() < deadline && !settled) {
        await c.credits();
        const { turns } = await c.api(`/api/conversations/${conversation.id}`);
        settled = turns.find((t) => t.messageId === turn.messageId && t.status === "settled");
        if (!settled) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      check(settled, "the first turn never settled");
      const { turns } = await c.api(`/api/conversations/${conversation.id}`);
      check(turns.length === 1, `${turns.length} turns recorded, expected 1`);
      const after = await prompt("Reply with exactly the word THREE, nothing else.");
      check(after.status === 200, `a prompt after the turn answered ${after.status}`);
      return "second refused with turn_running; one turn recorded; the next prompt after it works";
    },
  },
  {
    name: "paid-tool",
    model: true,
    describe: `generate_image takes ${IMAGE_CREDITS} credits, on top of the model cost`,
    async run() {
      const before = await a.credits();
      const turn = await a.runTurn(
        ctx.conversationId,
        "Use your generate_image tool to make a picture of a red circle, then say done."
      );
      const after = await a.credits();
      check(
        before - after >= IMAGE_CREDITS,
        `balance went ${before} -> ${after}, expected at least ${IMAGE_CREDITS} less`
      );
      return `${before - after} credits (turn ${turn.credits})`;
    },
  },
  {
    name: "sandbox",
    model: true,
    describe: "a prompt that needs a computer runs in a sandbox and publishes a page",
    async run() {
      const turn = await a.runTurn(
        ctx.conversationId,
        "On your computer, write a file hello.html: an HTML page with an h1 saying 'Hello from the sandbox' and a button that shows an alert. Publish it with upload-media so it shows in the preview."
      );
      check(
        turn.runtime && turn.runtime !== "inline",
        `expected a sandbox runtime, got ${turn.runtime}`
      );
      const published = await a.artifacts(ctx.conversationId);
      const page = published.find((artifact) => artifact.type === "page");
      check(page, `no page artifact; got ${JSON.stringify(published.map((a) => a.type))}`);
      ctx.pageId = page.id;
      return `runtime ${turn.runtime}, artifact ${page.name}`;
    },
  },
  {
    name: "preview",
    model: true,
    describe: "the published page is served sandboxed from the product",
    async run() {
      check(ctx.pageId, "no page from the sandbox scenario");
      const response = await a.fetch(
        `/api/conversations/${ctx.conversationId}/artifacts/${ctx.pageId}/content`
      );
      check(response.status === 200, `content answered ${response.status}`);
      const csp = response.headers.get("content-security-policy") ?? "";
      check(csp.includes("sandbox"), `page is not CSP-sandboxed: ${JSON.stringify(csp)}`);
      const html = await response.text();
      check(/Hello from the sandbox/i.test(html), `unexpected page: ${html.slice(0, 120)}`);
      return `${html.length} bytes, CSP sandbox`;
    },
  },
  {
    name: "credits",
    model: true,
    describe: "every turn was settled and the balance only went down",
    async run() {
      const { turns } = await a.api(`/api/conversations/${ctx.conversationId}`);
      check(
        turns.every((turn) => turn.status === "settled"),
        "a turn is still running"
      );
      const balance = await a.credits();
      check(
        balance < ctx.signupCredits,
        `balance ${balance} did not drop from ${ctx.signupCredits}`
      );
      return `${ctx.signupCredits} -> ${balance} over ${turns.length} turns`;
    },
  },
];

// --- runner ------------------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { only: null, json: null, noModel: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--only") args.only = argv[++i].split(",");
    else if (argv[i] === "--json") args.json = argv[++i];
    else if (argv[i] === "--no-model") args.noModel = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const unknown = (args.only ?? []).filter((name) => !SCENARIOS.some((s) => s.name === name));
  if (unknown.length > 0) throw new Error(`unknown scenario(s): ${unknown.join(", ")}`);

  const results = [];
  console.log(`Demo Studio at ${DEMO_URL}\n`);
  for (const scenario of SCENARIOS) {
    if (args.only && !args.only.includes(scenario.name) && !SETUP.includes(scenario.name)) continue;
    if (args.noModel && scenario.model) continue;
    const started = Date.now();
    let outcome;
    try {
      outcome = { ok: true, detail: await scenario.run() };
    } catch (error) {
      outcome = { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    results.push({ name: scenario.name, ...outcome, seconds });
    console.log(
      `${outcome.ok ? "ok  " : "FAIL"}  ${scenario.name.padEnd(13)} ${String(seconds).padStart(6)}s  ${outcome.detail}`
    );
  }

  const failed = results.filter((result) => !result.ok);
  console.log(
    `\n${failed.length === 0 ? "E2E OK" : "E2E FAILED"}  ${results.length - failed.length}/${results.length} scenarios`
  );
  if (args.json)
    await writeFile(args.json, JSON.stringify({ demoUrl: DEMO_URL, results }, null, 2));
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
});
