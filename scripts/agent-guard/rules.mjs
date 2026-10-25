/**
 * The red lines in AGENTS.md that a hook can enforce, as rules over a Bash command line.
 *
 *   deny  - never allowed from an agent session: rewriting or deleting main, `--all` and
 *           `--mirror`, the shared stash.
 *   push  - allowed only in a turn where the user said to push ("推送" or "push"): `git push`,
 *           opening or merging a pull request, writing to a branch through the GitHub API.
 *   ask   - the user must confirm each time: deleting or creating Cloudflare resources, deploying
 *           around the deploy script, skipping the clean-checkout guard.
 *
 * A hook can only stop what is spelled out in the command. It guards against forgetting, not against
 * an agent that works around it; that is why the git hooks in .husky refuse the same pushes.
 */
import { gitCommand, programOf, simpleCommands } from "./commands.mjs";

const MAIN = /^(?:refs\/heads\/)?main$/;

/** `dev`, `HEAD:dev`, `+HEAD:refs/heads/main` -> the branch the refspec writes. */
const destination = (refspec) => refspec.replace(/^\+/, "").split(":").pop();

function gitFindings(subcommand, args) {
  if (subcommand === "stash" && !["list", "show"].includes(args[0])) {
    return [
      {
        action: "deny",
        message:
          "git stash is off limits: the stash is shared by every worktree of this repository. " +
          "Save work in progress as a WIP commit on your own branch instead.",
      },
    ];
  }
  if (subcommand !== "push") return [];
  if (args.includes("--dry-run") || args.includes("-n")) return [];

  const refspecs = args.filter((arg) => !arg.startsWith("-")).slice(1); // the first is the remote
  if (args.some((arg) => arg === "--all" || arg === "--mirror")) {
    return [
      {
        action: "deny",
        message:
          "Name the branches to push: --all and --mirror also move main and every other ref.",
      },
    ];
  }
  const toMain = refspecs.some((spec) => MAIN.test(destination(spec)));
  const rewriting =
    args.some((arg) => ["-f", "--force", "--delete", "-d"].includes(arg)) ||
    args.some((arg) => arg.startsWith("--force-with-lease")) ||
    refspecs.some((spec) => spec.startsWith("+") || spec.startsWith(":"));
  if (toMain && rewriting) {
    return [
      {
        action: "deny",
        message:
          "main only moves forward, to a tagged release (docs/RELEASING.md): no force, no delete.",
      },
    ];
  }
  return [
    {
      action: "push",
      message: toMain
        ? "A push to main needs the user's go-ahead in this turn; main takes only a tagged release."
        : "git push needs the user's go-ahead in this turn.",
    },
  ];
}

const GH_WRITES = /(^|\/)(merges|pulls|git\/refs|contents|releases)(\/|$)/;

function ghFindings(args) {
  const [area, verb] = args;
  if (area === "pr" && (verb === "create" || verb === "merge")) {
    return [{ action: "push", message: `gh pr ${verb} needs the user's go-ahead in this turn.` }];
  }
  if (area === "api") {
    const method = args.findIndex((arg) => arg === "-X" || arg === "--method");
    const verbUsed = method === -1 ? null : args[method + 1]?.toUpperCase();
    const hasFields = args.some((arg) =>
      ["-f", "-F", "--field", "--raw-field", "--input"].includes(arg)
    );
    const writes = verbUsed ? verbUsed !== "GET" : hasFields;
    const target = args.find((arg) => /^\/?repos\//.test(arg));
    if (writes && target && GH_WRITES.test(target)) {
      return [
        {
          action: "push",
          message:
            "Writing to the repository through the GitHub API needs the user's go-ahead in this turn.",
        },
      ];
    }
  }
  return [];
}

function wranglerFindings(args) {
  const positional = args.filter((arg) => !arg.startsWith("-"));
  if (args.includes("--dry-run")) return [];
  if (positional.slice(0, 4).includes("delete")) {
    return [
      {
        action: "ask",
        message: "wrangler delete removes a Cloudflare resource; confirm with the user first.",
      },
    ];
  }
  if (
    ["deploy", "publish"].includes(positional[0]) ||
    (positional[0] === "versions" && positional[1] === "deploy")
  ) {
    return [
      {
        action: "ask",
        message:
          "Deploy through the deploy script from a clean dev checkout, not with wrangler directly " +
          "(AGENTS.md, Environments and branches); confirm with the user to go around it.",
      },
    ];
  }
  return [];
}

/** @returns {{ action: "deny" | "push" | "ask", message: string }[]} */
export function classify(commandLine) {
  const findings = [];
  for (const words of simpleCommands(commandLine)) {
    const program = programOf(words);
    if (!program) continue;
    if (program.assignments.includes("ALLOW_DIRTY=1")) {
      findings.push({
        action: "ask",
        message:
          "ALLOW_DIRTY=1 skips the clean-checkout guard of the deploy scripts; confirm with the user.",
      });
    }
    const rest = words.slice(program.index + 1);
    if (program.name === "git") {
      const { subcommand, args } = gitCommand(words, program.index);
      findings.push(...gitFindings(subcommand, args));
    } else if (program.name === "gh") {
      findings.push(...ghFindings(rest));
    } else if (program.name === "wrangler") {
      findings.push(...wranglerFindings(rest));
    } else if (["npx", "bunx", "pnpx"].includes(program.name)) {
      const tool = rest.findIndex((arg) => !arg.startsWith("-"));
      if (rest[tool] === "wrangler") findings.push(...wranglerFindings(rest.slice(tool + 1)));
    } else if (program.name === "create-env.sh") {
      findings.push({
        action: "ask",
        message: "create-env.sh creates Cloudflare resources; confirm with the user first.",
      });
    }
  }
  return findings;
}

const NEGATION =
  /(?:不要|别|不能|不得|不准|禁止|勿|不用|无需|先不|暂时不|don'?t|do not|never|no need to|without)[^。.!！\n]{0,12}$/i;
const QUESTION = /(?:吗|是否|要不要|能不能|可不可以|should i|can i|shall i)|[?？]\s*$/i;

/**
 * Did the user's message tell the agent to push (not discuss pushing, not forbid it)? "git push" in
 * a message is a command being quoted, not the word, so the English word has to stand alone.
 */
export function approvesPush(prompt) {
  const text = prompt.trim();
  const matches = [...text.matchAll(/推送|(?<!git )\bpush\b/gi)];
  if (matches.length === 0) return false;
  return matches.some((match) => {
    const before = text.slice(0, match.index);
    const sentenceStart = Math.max(
      before.lastIndexOf("。"),
      before.lastIndexOf("\n"),
      before.lastIndexOf("."),
      0
    );
    const sentenceEnd = text.slice(match.index).search(/[。.!！\n]|$/) + match.index;
    const sentence = text.slice(sentenceStart, sentenceEnd + 1);
    return !NEGATION.test(before) && !QUESTION.test(sentence);
  });
}
