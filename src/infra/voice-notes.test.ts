import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveVoiceNotesDir, saveVoiceNote } from "./voice-notes.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tmpDirs.map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
  tmpDirs.length = 0;
});

describe("voice note persistence", () => {
  it("writes audio + transcript + metadata under voice-notes state dir", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-voice-notes-"));
    tmpDirs.push(root);

    const audio = Buffer.from("voice-note-audio");
    const persisted = await saveVoiceNote(
      {
        audioBase64: audio.toString("base64"),
        mimeType: "audio/ogg",
        fileName: "memo.ogg",
        source: "record",
        sessionKey: "main",
        durationMs: 1840,
        transcript: "hello world",
      },
      root,
    );

    expect(persisted.dirPath.startsWith(resolveVoiceNotesDir(root))).toBe(true);
    expect(persisted.metadata.audioFile).toBe("audio.ogg");
    expect(persisted.metadata.transcript).toBe("hello world");
    expect(persisted.metadata.source).toBe("record");
    expect(persisted.metadata.sessionKey).toBe("main");
    expect(persisted.metadata.durationMs).toBe(1840);

    const writtenAudio = await fs.readFile(persisted.audioPath);
    expect(writtenAudio.equals(audio)).toBe(true);

    const writtenTranscript = await fs.readFile(persisted.transcriptPath, "utf8");
    expect(writtenTranscript).toBe("hello world");

    const rawMetadata = await fs.readFile(persisted.metadataPath, "utf8");
    const parsed = JSON.parse(rawMetadata) as { id: string; transcriptLength: number };
    expect(parsed.id).toBe(persisted.id);
    expect(parsed.transcriptLength).toBe("hello world".length);
  });

  it("concatenates transcript parts when transcript is omitted", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-voice-notes-"));
    tmpDirs.push(root);

    const persisted = await saveVoiceNote(
      {
        audioBase64: Buffer.from("audio").toString("base64"),
        mimeType: "audio/mpeg",
        transcriptParts: [" first line ", "", "second line"],
      },
      root,
    );

    expect(persisted.metadata.transcript).toBe("first line\nsecond line");
  });
});
