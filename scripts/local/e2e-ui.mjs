#!/usr/bin/env node
/**
 * The browser half of the local end-to-end check: a real Chromium drives Demo Studio the way a
 * person does, on a desktop and on a phone, in light and dark. Each scenario is a named step; the
 * run prints a table and exits non-zero if any step failed. The API half is e2e-demo.mjs.
 *
 *   scripts/local/stack.sh up
 *   node scripts/local/e2e-ui.mjs                          # every scenario
 *   node scripts/local/e2e-ui.mjs --no-model               # only the ones that cost nothing
 *   node scripts/local/e2e-ui.mjs --only routing,theme     # some of them
 *   node scripts/local/e2e-ui.mjs --shots out/             # also save a screenshot per scenario
 *
 * Needs Chromium for Playwright once: `npx playwright-core install chromium` (`playwright-core` is a
 * dev dependency; E2E_CHROMIUM_PATH points at a browser you already have). The model scenarios
 * cost a few cents.
 */

/* global document, window, location, getComputedStyle -- used inside page.evaluate, which runs in the browser */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import {
  callTool,
  check,
  DEMO_URL,
  DemoClient,
  IMAGE_CREDITS,
  newEmail,
  newPassword,
  sleep,
} from "./lib/demo-client.mjs";

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const MODEL_TIMEOUT_MS = 120_000;
const SANDBOX_TIMEOUT_MS = 240_000;
/** The design system's rule: every tappable target is at least this tall on a phone (design-system DESIGN.md). */
const TOUCH_MIN_PX = 44;

const browser = await chromium.launch({
  executablePath: process.env.E2E_CHROMIUM_PATH || undefined,
});
const consoleErrors = [];

/** A page in its own context (its own cookies and storage), with console errors collected. */
async function open({ viewport = DESKTOP, colorScheme = "light", client } = {}) {
  const context = await browser.newContext({
    viewport,
    colorScheme,
    deviceScaleFactor: 2,
    hasTouch: viewport.width < 768,
  });
  const page = await context.newPage();
  const label = `${viewport.width}px ${colorScheme}`;
  page.on("pageerror", (error) => consoleErrors.push(`${label}: ${error.message}`));
  page.on("console", (message) => {
    // A refused request (a signed-out /api/me, a duplicate sign-up) is the app working; the
    // browser logs it as an error. A 5xx or a script error is not.
    if (message.type() === "error" && !/status of 4\d\d/.test(message.text())) {
      consoleErrors.push(`${label}: ${message.text()}`);
    }
  });
  await page.goto(DEMO_URL);
  if (client) await signInThroughUi(page, client.user);
  return page;
}

async function signInThroughUi(page, user) {
  await page.getByRole("button", { name: /Already have an account/ }).click();
  await page.locator("input[type=email]").fill(user.email);
  await page.locator("input[type=password]").fill(user.password);
  await page.locator("button[type=submit]").click();
  await page.getByRole("navigation", { name: "Main" }).waitFor();
}

async function signUpThroughUi(page, email = newEmail("ui"), password = newPassword()) {
  await page.locator("input[type=email]").fill(email);
  await page.locator("input[type=password]").fill(password);
  await page.locator("button[type=submit]").click();
  await page.getByRole("navigation", { name: "Main" }).waitFor();
  return { email, password };
}

const isPhone = (page) => page.viewportSize().width < 768;
const composer = (page) => page.getByLabel("Message");
const send = (page) => page.getByRole("button", { name: "Send" });
const hash = (page) => page.evaluate(() => location.hash);
const theme = (page) => page.evaluate(() => document.documentElement.dataset.theme);

/** Start a conversation from wherever the app is (the empty state, or the + in the list). */
async function newConversation(page) {
  await page
    .getByRole("button", { name: /new conversation/i })
    .first()
    .click();
  await composer(page).waitFor();
}

async function ask(page, text, { timeout = MODEL_TIMEOUT_MS } = {}) {
  await composer(page).fill(text);
  await send(page).click();
  // The turn is over when the stop button is gone and a reply is shown.
  await page.locator(".turn__meta").last().waitFor({ timeout });
}

/** An account made through the API (fast, and its password is known), signed in later by a browser. */
async function account() {
  const client = new DemoClient();
  await client.signUp();
  return client;
}

const SCENARIOS = [
  {
    name: "auth-errors",
    describe: "sign-in and sign-up errors are shown in words, the mode toggles, sign-out returns",
    async run() {
      const known = await account();
      const page = await open();
      await page.locator("input[type=email]").fill(known.user.email);
      await page.locator("input[type=password]").fill(known.user.password);
      await page.locator("button[type=submit]").click();
      await page
        .getByRole("alert")
        .getByText(/already an account/)
        .waitFor();
      await page.getByRole("button", { name: /Already have an account/ }).click();
      check(
        await page.getByRole("heading", { name: "Welcome back" }).isVisible(),
        "no sign-in heading"
      );
      await page.locator("input[type=password]").fill("not-the-password");
      await page.locator("button[type=submit]").click();
      await page
        .getByRole("alert")
        .getByText(/don't match/)
        .waitFor();
      check(
        (await page.locator("input[type=password]").getAttribute("aria-invalid")) === "true",
        "the password field is not marked invalid"
      );
      await page.locator("input[type=password]").fill(known.user.password);
      await page.locator("button[type=submit]").click();
      await page.getByRole("navigation", { name: "Main" }).waitFor();
      await page.getByRole("button", { name: "Me", exact: true }).click();
      await page.getByRole("button", { name: "Sign out" }).click();
      await page.locator("input[type=email]").waitFor();
      check((await hash(page)) !== undefined, "the page broke on sign-out");
      return "duplicate, wrong password, then in and out";
    },
  },
  {
    name: "first-run",
    describe:
      "a new user sees the empty state, starts a chat, and the suggestions fill the composer",
    async run() {
      const page = await open();
      await signUpThroughUi(page);
      if (!isPhone(page)) {
        await page.getByRole("heading", { name: "Start a conversation" }).waitFor();
      }
      await newConversation(page);
      check(/^#\/chats\/[0-9a-f]+$/.test(await hash(page)), `the URL is ${await hash(page)}`);
      await page.getByRole("heading", { name: "What shall we make?" }).waitFor();
      await page.getByRole("button", { name: "What can you do?" }).click();
      check(
        (await composer(page).inputValue()) === "What can you do?",
        "the suggestion did not fill the composer"
      );
      check(await send(page).isEnabled(), "Send stays disabled with text in the composer");
      return "empty state, new chat, suggestion chip";
    },
  },
  {
    name: "routing",
    describe: "reload, back and an unknown or foreign address all land somewhere sensible",
    async run() {
      const page = await open();
      await signUpThroughUi(page);
      await newConversation(page);
      const chatHash = await hash(page);
      await page.reload();
      await composer(page).waitFor();
      check((await hash(page)) === chatHash, "a reload lost the conversation");
      await page.getByRole("button", { name: "Me", exact: true }).click();
      await page.getByRole("heading", { name: "Me" }).waitFor();
      await page.reload();
      await page.getByRole("heading", { name: "Me" }).waitFor();
      await page.goBack();
      await page.getByLabel("Message").waitFor();
      check((await hash(page)) === chatHash, "back from Me did not return to the chat");
      await page.evaluate(() => (location.hash = "#/nowhere/at/all"));
      await page
        .getByRole("heading", { name: /Chats|Start a conversation/ })
        .first()
        .waitFor();
      const other = await account();
      const foreign = await other.createConversation();
      await page.evaluate((id) => (location.hash = `#/chats/${id}`), foreign.id);
      await sleep(800);
      check(
        (await page.getByLabel("Message").count()) === 0,
        "another user's conversation opened a composer"
      );
      return "reload, back, unknown hash, foreign conversation id";
    },
  },
  {
    name: "keyboard",
    describe: "Enter sends, Shift+Enter adds a line, Send is off while the composer is empty",
    async run() {
      const page = await open();
      await signUpThroughUi(page);
      await newConversation(page);
      check(!(await send(page).isEnabled()), "Send is enabled with an empty composer");
      await composer(page).fill("first line");
      await composer(page).press("Shift+Enter");
      await composer(page).type("second line");
      check(
        (await composer(page).inputValue()) === "first line\nsecond line",
        "Shift+Enter did not add a line"
      );
      check((await page.locator(".turn").count()) === 0, "Shift+Enter sent the message");
      await page.keyboard.press("Tab");
      const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
      check(Boolean(focused), "focus did not move to a labelled control after Tab");
      return "Shift+Enter newline, Send disabled when empty, Tab moves focus";
    },
  },
  {
    name: "theme",
    describe: "Dark, Light and System switch at once, persist across reloads, and follow the OS",
    async run() {
      const page = await open({ colorScheme: "light" });
      await signUpThroughUi(page);
      const toMe = async () => {
        if ((await page.getByRole("heading", { name: "Me" }).count()) === 0) {
          await page.getByRole("button", { name: "Me", exact: true }).click();
        }
      };
      await toMe();
      await page.getByRole("radio", { name: "Dark" }).click();
      check((await theme(page)) === "dark", "Dark did not apply");
      await page.reload();
      check((await theme(page)) === "dark", "Dark was lost on reload");
      await page.getByRole("radio", { name: "System" }).click();
      check((await theme(page)) === "light", "System did not follow the light OS");
      await page.emulateMedia({ colorScheme: "dark" });
      await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
      await page.getByRole("radio", { name: "Light" }).click();
      await page.emulateMedia({ colorScheme: "dark" });
      await sleep(300);
      check((await theme(page)) === "light", "a chosen theme must beat the OS");
      await page.reload();
      check((await theme(page)) === "light", "Light was lost on reload");
      return "choices persist, System follows the OS, a choice beats the OS";
    },
  },
  {
    name: "responsive",
    describe: "resizing between desktop and phone switches the layout without losing the chat",
    async run() {
      const page = await open();
      await signUpThroughUi(page);
      await newConversation(page);
      const chatHash = await hash(page);
      const rail = page.locator("nav.ui-nav-rail");
      const tabs = page.locator("nav.ui-tab-bar");
      check(
        (await rail.count()) === 1 && (await tabs.count()) === 0,
        "desktop must show the rail only"
      );
      await page.setViewportSize(PHONE);
      await page.waitForFunction(() => !document.querySelector("nav.ui-nav-rail"));
      await composer(page).waitFor();
      check((await hash(page)) === chatHash, "the chat was lost when shrinking");
      check((await tabs.count()) === 0, "a chat screen on a phone must have no tab bar");
      await page.getByRole("button", { name: "Chats" }).click();
      await tabs.waitFor();
      await page.setViewportSize(DESKTOP);
      await rail.waitFor();
      return "rail and tab bar swap, the open chat survives";
    },
  },
  {
    name: "phone-nav",
    describe: "on a phone: list, chat with a back button, Me; every tappable target is 44px",
    async run() {
      const page = await open({ viewport: PHONE });
      await signUpThroughUi(page);
      await newConversation(page);
      check((await page.locator("nav.ui-tab-bar").count()) === 0, "tab bar shown inside a chat");
      await page.getByRole("button", { name: "Chats" }).click();
      await page.locator("nav.ui-tab-bar").waitFor();
      await page
        .getByRole("navigation", { name: "Conversations" })
        .getByRole("button")
        .first()
        .click();
      await composer(page).waitFor();
      await page.getByRole("button", { name: "Chats" }).click();
      await page.getByRole("button", { name: "Me", exact: true }).click();
      await page.getByRole("heading", { name: "Me" }).waitFor();
      const small = await page.evaluate((min) => {
        return [...document.querySelectorAll("button, a[href], [role=tab], [role=radio]")]
          .map((element) => ({ element, rect: element.getBoundingClientRect() }))
          .filter(({ rect }) => rect.width > 0 && rect.height > 0 && rect.height < min)
          .map(
            ({ element, rect }) =>
              `${element.getAttribute("aria-label") || element.textContent.trim().slice(0, 20)} ${Math.round(rect.height)}px`
          );
      }, TOUCH_MIN_PX);
      check(
        small.length === 0,
        `targets under ${TOUCH_MIN_PX}px on the Me page: ${small.join(", ")}`
      );
      return "list, chat, Me; no small targets on Me";
    },
  },
  {
    name: "accessibility",
    describe: "every control has a name; headings, language and focus ring are in place",
    async run() {
      const page = await open();
      await signUpThroughUi(page);
      await newConversation(page);
      const nameless = await page.evaluate(() =>
        [...document.querySelectorAll("button, a[href], input, textarea, [role=tab], [role=radio]")]
          .filter((element) => element.getBoundingClientRect().width > 0)
          .filter((element) => {
            const label =
              element.getAttribute("aria-label") ||
              element.textContent.trim() ||
              element.getAttribute("title") ||
              element.getAttribute("placeholder") ||
              (element.labels && element.labels[0]?.textContent.trim());
            return !label;
          })
          .map((element) => element.outerHTML.slice(0, 80))
      );
      check(nameless.length === 0, `controls with no name: ${nameless.join(" | ")}`);
      check(
        (await page.evaluate(() => document.documentElement.lang)) === "en",
        "<html lang> is not set"
      );
      await page.keyboard.press("Tab");
      const ring = await page.evaluate(() => {
        const style = getComputedStyle(document.activeElement);
        return `${style.outlineStyle} ${style.outlineWidth}`;
      });
      check(!/^none/.test(ring), `the focused element has no visible outline (${ring})`);
      return "all controls named, lang set, focus visible";
    },
  },
  {
    name: "out-of-credits-ui",
    describe: "at zero credits the composer is off, says why, and Me shows the empty balance",
    async run() {
      const client = await account();
      const token = await client.mintMcpToken();
      for (let i = 0; i < Math.floor(client.user.credits / IMAGE_CREDITS); i++) {
        await callTool(token, "generate_image", { prompt: `drain ${i}` });
      }
      const left = await client.credits();
      check(
        left === 0,
        `${left} credits left: the default signup credits must be a multiple of ${IMAGE_CREDITS}`
      );
      await client.createConversation();
      const page = await open({ client });
      await page
        .getByRole("navigation", { name: "Conversations" })
        .getByRole("button")
        .first()
        .click();
      const box = composer(page);
      await box.waitFor();
      check(await box.isDisabled(), "the composer is enabled at zero credits");
      check((await box.getAttribute("placeholder")) === "Out of credits", "no out-of-credits hint");
      await page
        .getByRole("alert")
        .getByText(/out of credits/i)
        .waitFor();
      check(!(await send(page).isEnabled()), "Send is enabled at zero credits");
      return "composer disabled, notice shown";
    },
  },
  {
    name: "inline-chat",
    model: true,
    describe:
      "an inline answer streams in, names the chat, charges credits, and locks Send meanwhile",
    async run() {
      const page = await open();
      await signUpThroughUi(page);
      await newConversation(page);
      const before = await page.locator(".ui-badge").first().innerText();
      await composer(page).fill("Reply with exactly the word PONG, nothing else.");
      await send(page).click();
      await page.getByText("Reply with exactly the word PONG, nothing else.").first().waitFor();
      check(!(await send(page).isEnabled()), "Send is enabled while a turn runs");
      await page.locator(".turn__meta").last().waitFor({ timeout: MODEL_TIMEOUT_MS });
      check(/PONG/.test(await page.locator(".reply").last().innerText()), "no PONG in the reply");
      check(
        /Answered directly/.test(await page.locator(".turn__meta").last().innerText()),
        "not answered inline"
      );
      const row = page
        .getByRole("navigation", { name: "Conversations" })
        .getByRole("button")
        .first();
      if (!isPhone(page)) {
        check(
          /Reply with exactly/.test(await row.innerText()),
          "the chat was not named after the prompt"
        );
      }
      await page.waitForFunction(
        (was) => document.querySelector(".ui-badge")?.textContent !== was,
        before
      );
      return "streamed, named, charged";
    },
  },
  {
    name: "stop",
    model: true,
    describe: "Stop ends a long turn and gives the composer back",
    async run() {
      const page = await open();
      await signUpThroughUi(page);
      await newConversation(page);
      await composer(page).fill(
        "Write a 1500-word story about a lighthouse, slowly, with many paragraphs."
      );
      await send(page).click();
      const stop = page.getByRole("button", { name: "Stop" });
      await stop.waitFor({ timeout: 30_000 });
      await sleep(1500);
      await stop.click();
      await stop.waitFor({ state: "detached", timeout: 60_000 });
      await composer(page).fill("next");
      check(await send(page).isEnabled(), "Send stays off after Stop");
      return "stopped, composer usable again";
    },
  },
  {
    name: "unsafe-text",
    model: true,
    describe: "HTML and javascript: links in a prompt or a reply never become markup",
    async run() {
      const page = await open();
      await signUpThroughUi(page);
      await newConversation(page);
      const hostile = `<img src=x onerror="window.__xss=1"> [click](javascript:window.__xss=2)`;
      await ask(page, `Repeat this back as plain text, exactly: ${hostile}`);
      check((await page.evaluate(() => window.__xss)) === undefined, "script ran from chat text");
      check(
        (await page.locator(".turn img, .reply a[href^='javascript']").count()) === 0,
        "markup was injected"
      );
      check(
        (await page.locator(".turn__prompt").first().innerText()).includes("<img"),
        "the prompt is not shown as text"
      );
      return "the prompt is text; no img, no javascript: link, no script";
    },
  },
  {
    name: "long-text",
    model: true,
    describe: "an unbroken 1500-character word and CJK text wrap instead of overflowing",
    async run() {
      const page = await open({ viewport: PHONE });
      await signUpThroughUi(page);
      await newConversation(page);
      await composer(page).fill(`${"a".repeat(1500)} 你好，世界。这是一段中文。🙂`);
      await send(page).click();
      await page.locator(".turn__prompt").waitFor();
      const overflow = await page.evaluate(() => {
        const width = document.documentElement.clientWidth;
        return [...document.querySelectorAll(".turn__prompt, .timeline, .composer")]
          .filter(
            (element) =>
              element.scrollWidth > element.clientWidth + 1 ||
              element.getBoundingClientRect().right > width + 1
          )
          .map((element) => element.className);
      });
      check(overflow.length === 0, `overflow in: ${overflow.join(", ")}`);
      await page
        .getByRole("button", { name: "Stop" })
        .click()
        .catch(() => {});
      return "no horizontal overflow on a phone";
    },
  },
  {
    name: "multi-chat",
    model: true,
    describe: "two chats keep their own history; the list is newest first and switching is instant",
    async run() {
      const page = await open();
      await signUpThroughUi(page);
      await newConversation(page);
      await ask(page, "Reply with exactly the word ALPHA, nothing else.");
      await page.getByRole("button", { name: "New conversation" }).first().click();
      await page.getByRole("heading", { name: "What shall we make?" }).waitFor();
      await ask(page, "Reply with exactly the word BRAVO, nothing else.");
      const rows = page.getByRole("navigation", { name: "Conversations" }).getByRole("button");
      check((await rows.count()) === 2, `${await rows.count()} chats in the list`);
      check(/BRAVO/.test(await rows.first().innerText()), "the newest chat is not first");
      await rows.nth(1).click();
      // Look only inside the chat: the list also carries both titles.
      const chat = page.locator(".timeline");
      await chat.getByText("ALPHA").first().waitFor();
      check(
        (await chat.locator(".turn").count()) === 1,
        "the other chat shows more than its own turn"
      );
      check(!(await chat.innerText()).includes("BRAVO"), "chats mixed their history");
      await rows.nth(0).click();
      await chat.getByText("BRAVO").first().waitFor();
      check(
        !(await chat.innerText()).includes("ALPHA"),
        "chats mixed their history on the way back"
      );
      return "ordering, switching, separate histories";
    },
  },
  {
    name: "sandbox-preview",
    model: true,
    describe: "a published page opens in the preview, runs sandboxed, and cannot reach the app",
    async run() {
      const page = await open();
      await signUpThroughUi(page);
      await newConversation(page);
      await composer(page).fill(
        "On your computer, write probe.html: an h1 'Probe page', and a script that runs `try { parent.document.cookie; document.body.dataset.probe = 'LEAK'; } catch (e) { document.body.dataset.probe = 'BLOCKED'; }` and shows that value in a div with id 'result'. Publish it with upload-media."
      );
      await send(page).click();
      await page.locator(".stage-frame").waitFor({ timeout: SANDBOX_TIMEOUT_MS });
      await page.locator(".turn__meta").last().waitFor({ timeout: SANDBOX_TIMEOUT_MS });
      const frame = page.frameLocator(".stage-frame");
      await frame.getByRole("heading", { name: "Probe page" }).waitFor();
      const result = await frame.locator("#result").innerText();
      check(/BLOCKED/.test(result), `the page reached the app: ${result}`);
      const download = page.getByRole("link", { name: "Download" });
      check(
        /download=/.test(await download.getAttribute("href")),
        "the download link is not a download"
      );
      if (!isPhone(page)) {
        await page.getByRole("button", { name: "Close preview" }).click();
        await page.locator(".stage-frame").waitFor({ state: "detached" });
        await page.getByRole("button", { name: "Open preview" }).click();
        await page.locator(".stage-frame").waitFor();
      }
      return "preview opens, page isolated (BLOCKED), download link, close and reopen";
    },
  },
  {
    name: "phone-preview",
    model: true,
    describe:
      "on a phone the preview is a sheet: it opens by itself, Escape closes it, a button reopens it",
    async run() {
      const page = await open({ viewport: PHONE });
      await signUpThroughUi(page);
      await newConversation(page);
      await composer(page).fill(
        "On your computer, write note.html with an h1 'Phone page' and publish it with upload-media."
      );
      await send(page).click();
      const sheet = page.getByRole("dialog", { name: "Preview" });
      await sheet.waitFor({ timeout: SANDBOX_TIMEOUT_MS });
      await sheet
        .frameLocator(".stage-frame")
        .getByRole("heading", { name: "Phone page" })
        .waitFor();
      await page.keyboard.press("Escape");
      await sheet.waitFor({ state: "detached" });
      await page.getByRole("button", { name: "Open preview" }).click();
      await sheet.waitFor();
      await sheet.getByRole("button", { name: "Close preview" }).click();
      await sheet.waitFor({ state: "detached" });
      return "opened by itself, Escape and the close button both close it, the header button reopens it";
    },
  },
];

function parseArgs(argv) {
  const args = { only: null, shots: null, noModel: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--only") args.only = argv[++i].split(",");
    else if (argv[i] === "--shots") args.shots = argv[++i];
    else if (argv[i] === "--no-model") args.noModel = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const unknown = (args.only ?? []).filter((name) => !SCENARIOS.some((s) => s.name === name));
if (unknown.length > 0) {
  console.error(`unknown scenario(s): ${unknown.join(", ")}`);
  process.exit(2);
}
if (args.shots) await mkdir(args.shots, { recursive: true });

console.log(`Demo Studio at ${DEMO_URL}\n`);
const results = [];
for (const scenario of SCENARIOS) {
  if (args.only && !args.only.includes(scenario.name)) continue;
  if (args.noModel && scenario.model) continue;
  const started = Date.now();
  const errorsBefore = consoleErrors.length;
  let outcome;
  try {
    outcome = { ok: true, detail: await scenario.run() };
  } catch (error) {
    outcome = {
      ok: false,
      detail: error instanceof Error ? error.message.split("\n")[0] : String(error),
    };
  }
  const fresh = consoleErrors.slice(errorsBefore);
  if (outcome.ok && fresh.length > 0) {
    outcome = { ok: false, detail: `console errors: ${fresh.slice(0, 2).join(" | ")}` };
  }
  if (args.shots) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    const last = pages.at(-1);
    if (last)
      await last.screenshot({ path: join(args.shots, `${scenario.name}.png`) }).catch(() => {});
  }
  for (const context of browser.contexts()) await context.close();
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  results.push({ name: scenario.name, ...outcome, seconds });
  console.log(
    `${outcome.ok ? "ok  " : "FAIL"}  ${scenario.name.padEnd(18)} ${String(seconds).padStart(6)}s  ${outcome.detail}`
  );
}
await browser.close();

const failed = results.filter((result) => !result.ok);
console.log(
  `\n${failed.length === 0 ? "E2E UI OK" : "E2E UI FAILED"}  ${results.length - failed.length}/${results.length} scenarios`
);
process.exit(failed.length === 0 ? 0 : 1);
