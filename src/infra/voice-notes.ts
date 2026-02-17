import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { estimateBase64DecodedBytes } from "../media/base64.js";
import { extensionForMime, normalizeMimeType } from "../media/mime.js";
import { createAsyncLock, writeJsonAtomic } from "./json-files.js";

const MAX_VOICE_NOTE_BYTES = 25_000_000;

export type VoiceNoteSource = "upload" | "record";

export type SaveVoiceNoteInput = {
  audioBase64: string;
  mimeType?: string | null;
  fileName?: string | null;
  source?: string | null;
  sessionKey?: string | null;
  durationMs?: number | null;
  transcript?: string | null;
  transcriptParts?: string[] | null;
};

export type VoiceNoteMetadata = {
  id: string;
  createdAtMs: number;
  createdAt: string;
  source: VoiceNoteSource;
  sessionKey: string | null;
  durationMs: number | null;
  mimeType: string;
  fileName: string | null;
  transcript: string;
  transcriptLength: number;
  audioFile: string;
  transcriptFile: string;
};

export type PersistedVoiceNote = {
  id: string;
  dirPath: string;
  audioPath: string;
  transcriptPath: string;
  metadataPath: string;
  metadata: VoiceNoteMetadata;
};

const withLock = createAsyncLock();

export function resolveVoiceNotesDir(baseDir?: string): string {
  return path.join(baseDir ?? resolveStateDir(), "voice-notes");
}

function normalizeSource(raw?: string | null): VoiceNoteSource {
  return raw === "record" ? "record" : "upload";
}

function normalizeDurationMs(raw?: number | null): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return null;
  }
  return Math.round(raw);
}

function normalizeSessionKey(raw?: string | null): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed || null;
}

function sanitizeFileName(raw?: string | null): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = path.basename(raw.trim());
  if (!trimmed) {
    return null;
  }
  const safe = trimmed.replace(/[^a-z0-9._-]+/gi, "_");
  return safe || null;
}

function resolveAudioExtension(params: { mimeType: string; fileName: string | null }): string {
  const fromMime = extensionForMime(params.mimeType);
  if (fromMime && /^[.][a-z0-9]{1,10}$/i.test(fromMime)) {
    return fromMime.toLowerCase();
  }
  if (params.fileName) {
    const ext = path.extname(params.fileName).toLowerCase();
    if (/^[.][a-z0-9]{1,10}$/i.test(ext)) {
      return ext;
    }
  }
  return ".bin";
}

function sanitizeTranscript(params: {
  transcript?: string | null;
  transcriptParts?: string[] | null;
}): string {
  if (typeof params.transcript === "string") {
    return params.transcript.trim();
  }
  if (!Array.isArray(params.transcriptParts)) {
    return "";
  }
  return params.transcriptParts
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join("\n");
}

function decodeAudioBase64(base64: string): Buffer {
  const trimmed = base64.trim();
  if (!trimmed) {
    throw new Error("audio content is required");
  }
  const dataUrlMatch = /^data:[^;]+;base64,(.+)$/i.exec(trimmed);
  const payload = dataUrlMatch ? dataUrlMatch[1] : trimmed;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(payload)) {
    throw new Error("audio content must be base64");
  }
  const estimatedBytes = estimateBase64DecodedBytes(payload);
  if (estimatedBytes <= 0) {
    throw new Error("audio content is empty");
  }
  if (estimatedBytes > MAX_VOICE_NOTE_BYTES) {
    throw new Error(
      `audio content exceeds size limit (${estimatedBytes} > ${MAX_VOICE_NOTE_BYTES} bytes)`,
    );
  }
  const audioBytes = Buffer.from(payload, "base64");
  if (audioBytes.length === 0) {
    throw new Error("audio content is empty");
  }
  if (audioBytes.length > MAX_VOICE_NOTE_BYTES) {
    throw new Error(
      `audio content exceeds size limit (${audioBytes.length} > ${MAX_VOICE_NOTE_BYTES} bytes)`,
    );
  }
  return audioBytes;
}

export async function saveVoiceNote(
  input: SaveVoiceNoteInput,
  baseDir?: string,
): Promise<PersistedVoiceNote> {
  return await withLock(async () => {
    const audioBytes = decodeAudioBase64(input.audioBase64);
    const mimeType = normalizeMimeType(input.mimeType) ?? "application/octet-stream";
    const fileName = sanitizeFileName(input.fileName);
    const transcript = sanitizeTranscript({
      transcript: input.transcript,
      transcriptParts: input.transcriptParts,
    });
    const source = normalizeSource(input.source);
    const sessionKey = normalizeSessionKey(input.sessionKey);
    const durationMs = normalizeDurationMs(input.durationMs);

    const createdAtMs = Date.now();
    const createdAt = new Date(createdAtMs).toISOString();
    const id = `voice-note-${createdAtMs}-${randomUUID().slice(0, 8)}`;
    const dirPath = path.join(resolveVoiceNotesDir(baseDir), id);
    await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
    try {
      await fs.chmod(dirPath, 0o700);
    } catch {
      // best-effort only
    }

    const audioFile = `audio${resolveAudioExtension({ mimeType, fileName })}`;
    const transcriptFile = "transcript.txt";
    const metadataFile = "metadata.json";

    const audioPath = path.join(dirPath, audioFile);
    const transcriptPath = path.join(dirPath, transcriptFile);
    const metadataPath = path.join(dirPath, metadataFile);

    await fs.writeFile(audioPath, audioBytes, { mode: 0o600 });
    await fs.writeFile(transcriptPath, transcript, { encoding: "utf8", mode: 0o600 });

    const metadata: VoiceNoteMetadata = {
      id,
      createdAtMs,
      createdAt,
      source,
      sessionKey,
      durationMs,
      mimeType,
      fileName,
      transcript,
      transcriptLength: transcript.length,
      audioFile,
      transcriptFile,
    };

    await writeJsonAtomic(metadataPath, metadata, { mode: 0o600 });

    return {
      id,
      dirPath,
      audioPath,
      transcriptPath,
      metadataPath,
      metadata,
    };
  });
}
