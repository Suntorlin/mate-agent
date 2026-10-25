import { describe, expect, it } from "vitest";
import { foldSteps, stepLabel } from "./steps.ts";

describe("step lines", () => {
  it("names tools in plain words, whatever server they come from", () => {
    expect(stepLabel("mcp__app__save_note")).toBe("Saving a note");
    expect(stepLabel("mcp__open-inspect__upload-media")).toBe("Publishing to the preview");
    expect(stepLabel("Write")).toBe("Writing a file");
    expect(stepLabel("Bash")).toBe("Running a command");
    expect(stepLabel("use_sandbox")).toBe("Starting a computer");
    expect(stepLabel("something_new")).toBe("Working");
  });

  it("keeps the latest status per call and collapses repeats", () => {
    const steps = foldSteps([
      { tool: "Write", callId: "1", status: "running" },
      { tool: "Write", callId: "1", status: "completed" },
      { tool: "Edit", callId: "2", status: "completed" },
      { tool: "Bash", callId: "3", status: "running" },
    ]);
    expect(steps).toEqual([
      { label: "Writing a file", count: 2, running: false },
      { label: "Running a command", count: 1, running: true },
    ]);
  });
});
