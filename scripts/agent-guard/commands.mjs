/**
 * Reads a shell command line the way the agent guard needs to: which programs it runs and with
 * which arguments, so that `echo "git push"` and `git commit -m "no git stash here"` are not
 * mistaken for the real thing. It is not a shell. It splits on the operators, honours quotes, looks
 * inside `$(...)`, backticks and `bash -c '...'`, and gives up quietly on anything stranger, which
 * the pre-push hook and the person watching the session still catch.
 */

const WRAPPERS = new Set(["sudo", "command", "env", "time", "nohup", "exec", "nice", "builtin"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Splits a command line into simple commands, each a list of words with quotes removed. */
export function simpleCommands(line, depth = 0) {
  const commands = [];
  let words = [];
  let word = "";
  let inWord = false;
  let quote = null;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  const nested = (text) => {
    if (depth < 4) commands.push(...simpleCommands(text, depth + 1));
  };

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    if (c === "\\" && i + 1 < line.length) {
      word += line[++i];
      inWord = true;
      continue;
    }
    if ((c === "$" && line[i + 1] === "(") || c === "`") {
      // A command substitution runs, inside double quotes as well.
      const close = c === "`" ? "`" : ")";
      const start = c === "`" ? i + 1 : i + 2;
      let end = start;
      for (let level = 1; end < line.length; end++) {
        if (c !== "`" && line[end] === "(") level++;
        if (line[end] === close && --level === 0) break;
      }
      nested(line.slice(start, end));
      i = end;
      inWord = true;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === ";" || c === "\n" || c === "&" || c === "|" || c === "(" || c === ")") {
      endCommand();
    } else if (c === " " || c === "\t") {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();

  // `bash -c 'git push'` and `eval "git push"` run their argument as a command line.
  for (const command of [...commands]) {
    const program = programOf(command);
    if (!program) continue;
    const rest = command.slice(program.index + 1);
    if (SHELLS.has(program.name)) {
      const at = rest.findIndex((word) => /^-[a-z]*c[a-z]*$/.test(word));
      if (at !== -1 && rest[at + 1] !== undefined) nested(rest[at + 1]);
    } else if (program.name === "eval") {
      nested(rest.join(" "));
    }
  }
  return commands;
}

/** The program a simple command runs, past environment assignments and wrappers like `sudo`. */
export function programOf(words) {
  let index = 0;
  while (index < words.length && (ASSIGNMENT.test(words[index]) || WRAPPERS.has(words[index]))) {
    index++;
  }
  if (index >= words.length) return null;
  const name = words[index].split("/").pop();
  return { name, index, assignments: words.slice(0, index).filter((w) => ASSIGNMENT.test(w)) };
}

const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

/** `git -C dir -c a=b push origin dev` -> { subcommand: "push", args: ["origin", "dev"] } */
export function gitCommand(words, programIndex) {
  let i = programIndex + 1;
  while (i < words.length && words[i].startsWith("-")) {
    i += GIT_OPTIONS_WITH_VALUE.has(words[i]) ? 2 : 1;
  }
  return { subcommand: words[i], args: words.slice(i + 1) };
}
