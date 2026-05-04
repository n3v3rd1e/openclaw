import { describe, expect, it, vi } from "vitest";
import { __testing } from "./claude-live-session.js";

describe("Claude live session raw window", () => {
  it("windows raw JSONL instead of aborting when the turn exceeds retained line limits", () => {
    const turn = {
      rawLines: Array.from({ length: __testing.limits.maxTurnLines + 50 }, (_, i) =>
        JSON.stringify({ type: "stream_event", i }),
      ),
      rawChars: 0,
    } as unknown as Parameters<typeof __testing.trimTurnRawWindow>[0];
    turn.rawChars = turn.rawLines.reduce((sum, line) => sum + line.length + 1, 0);

    __testing.trimTurnRawWindow(turn);

    expect(turn.rawLines.length).toBeLessThanOrEqual(__testing.limits.maxTurnLines);
    expect(turn.rawLines[0]).toContain('"i":50');
  });

  it("retains the newest raw JSONL when the char budget is exceeded", () => {
    const longLine = "x".repeat(Math.ceil(__testing.limits.maxTurnRawChars / 2));
    const turn = {
      rawLines: [
        JSON.stringify({ type: "stream_event", marker: "old", text: longLine }),
        JSON.stringify({ type: "stream_event", marker: "middle", text: longLine }),
        JSON.stringify({ type: "result", marker: "new", result: "ok" }),
      ],
      rawChars: 0,
    } as unknown as Parameters<typeof __testing.trimTurnRawWindow>[0];
    turn.rawChars = turn.rawLines.reduce((sum, line) => sum + line.length + 1, 0);

    __testing.trimTurnRawWindow(turn);

    expect(turn.rawLines.join("\n")).not.toContain('"marker":"old"');
    expect(turn.rawLines.at(-1)).toContain('"marker":"new"');
    expect(turn.rawChars).toBeLessThanOrEqual(__testing.limits.maxTurnRawChars);
  });
});

describe("Claude live session activity extraction", () => {
  it("extracts tool_use blocks from nested Claude stream events", () => {
    expect(
      __testing.collectClaudeToolUses({
        type: "stream_event",
        event: {
          type: "content_block_start",
          content_block: {
            type: "tool_use",
            id: "toolu_123",
            name: "read",
            input: { path: "README.md" },
          },
        },
      }),
    ).toEqual([{ id: "toolu_123", name: "read" }]);
  });
});
