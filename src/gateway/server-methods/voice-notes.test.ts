import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { voiceNotesHandlers } from "./voice-notes.js";

const tmpDirs: string[] = [];
const originalStateDir = process.env.OPENCLAW_STATE_DIR;

afterEach(async () => {
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  await Promise.all(
    tmpDirs.map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
  tmpDirs.length = 0;
});

describe("voice-notes.save handler", () => {
  it("persists a voice note and returns metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-voice-notes-handler-"));
    tmpDirs.push(root);
    process.env.OPENCLAW_STATE_DIR = root;

    let res:
      | {
          ok: boolean;
          payload?: unknown;
          error?: unknown;
        }
      | undefined;

    await voiceNotesHandlers["voice-notes.save"]({
      req: { type: "req", id: "1", method: "voice-notes.save", params: {} } as never,
      params: {
        sessionKey: "main",
        source: "upload",
        transcriptParts: ["line 1", "line 2"],
        audio: {
          mimeType: "audio/ogg",
          fileName: "memo.ogg",
          content: Buffer.from("voice-note").toString("base64"),
        },
      },
      client: null,
      isWebchatConnect: () => false,
      context: {} as never,
      respond: (ok, payload, error) => {
        res = { ok, payload, error };
      },
    });

    expect(res?.ok).toBe(true);
    const payload = res?.payload as { note?: { id?: string; transcript?: string } } | undefined;
    expect(payload?.note?.id).toMatch(/^voice-note-/);
    expect(payload?.note?.transcript).toBe("line 1\nline 2");

    const notesDir = path.join(root, "voice-notes");
    const entries = await fs.readdir(notesDir);
    expect(entries.length).toBe(1);

    const noteDir = path.join(notesDir, entries[0] ?? "");
    await expect(fs.stat(path.join(noteDir, "metadata.json"))).resolves.toBeDefined();
    await expect(fs.stat(path.join(noteDir, "transcript.txt"))).resolves.toBeDefined();
  });

  it("rejects invalid params", async () => {
    let res:
      | {
          ok: boolean;
          payload?: unknown;
          error?: { code?: string; message?: string };
        }
      | undefined;

    await voiceNotesHandlers["voice-notes.save"]({
      req: { type: "req", id: "2", method: "voice-notes.save", params: {} } as never,
      params: { audio: { content: "" } },
      client: null,
      isWebchatConnect: () => false,
      context: {} as never,
      respond: (ok, payload, error) => {
        res = { ok, payload, error };
      },
    });

    expect(res?.ok).toBe(false);
    expect(res?.error?.code).toBe("INVALID_REQUEST");
  });
});
