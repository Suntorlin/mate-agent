/**
 * What the agent is doing, in plain words. Tool names and commands are never shown; a run of
 * the same kind of step collapses into one line with a count.
 */

export interface Step {
  label: string;
  count: number;
  running: boolean;
}

const LABELS: Array<[RegExp, string]> = [
  [/^use_sandbox$/, "Starting a computer"],
  [/upload-media|upload_media/i, "Publishing to the preview"],
  [/save_note/, "Saving a note"],
  [/list_notes/, "Reading your notes"],
  [/get_credit_balance/, "Checking your credits"],
  [/^(write|edit|multiedit|notebookedit)$/i, "Writing a file"],
  [/^(read|glob|grep|ls)$/i, "Looking at files"],
  [/^bash$/i, "Running a command"],
  [/web(fetch|search)/i, "Searching the web"],
  [/todo/i, "Planning"],
];

export function stepLabel(tool: string): string {
  const name = tool.replace(/^mcp__.+?__/, "");
  for (const [pattern, label] of LABELS) if (pattern.test(name)) return label;
  return "Working";
}

export interface ToolCallEvent {
  tool: string;
  callId: string;
  status?: string;
}

/** Fold tool calls (latest status per call) into step lines. */
export function foldSteps(calls: readonly ToolCallEvent[]): Step[] {
  const latest = new Map<string, ToolCallEvent>();
  for (const call of calls) latest.set(call.callId, call);
  const steps: Step[] = [];
  for (const call of latest.values()) {
    const label = stepLabel(call.tool);
    const running = call.status !== "completed" && call.status !== "error";
    const last = steps.at(-1);
    if (last && last.label === label) {
      steps[steps.length - 1] = { label, count: last.count + 1, running: last.running || running };
    } else {
      steps.push({ label, count: 1, running });
    }
  }
  return steps;
}
