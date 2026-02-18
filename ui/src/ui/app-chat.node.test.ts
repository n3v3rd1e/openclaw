/**
 * Tests for voice-note recording helpers.
 *
 * Because app-chat.ts transitively imports browser-only modules (localStorage,
 * Lit, etc.) we duplicate the pure logic here so we can run in Node without
 * mocking the entire browser environment.
 */
import { describe, expect, it, afterEach } from "vitest";

// ---- inlined from app-chat.ts (keep in sync) ----
const RECORDER_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
  "audio/mp4;codecs=opus",
  "audio/mp4;codecs=aac",
  "audio/mp4",
  "audio/aac",
] as const;

function pickRecorderMimeType(): string {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }
  for (const candidate of RECORDER_MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return "";
}

function resolveVoiceNoteExtension(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("ogg")) {
    return "ogg";
  }
  if (normalized.includes("mp4") || normalized.includes("m4a") || normalized.includes("aac")) {
    return "m4a";
  }
  if (normalized.includes("mpeg") || normalized.includes("mp3")) {
    return "mp3";
  }
  return "webm";
}
// ---- end inlined ----

describe("resolveVoiceNoteExtension", () => {
  const cases: [string, string][] = [
    ["audio/webm;codecs=opus", "webm"],
    ["audio/webm", "webm"],
    ["audio/ogg;codecs=opus", "ogg"],
    ["audio/ogg", "ogg"],
    ["audio/mp4", "m4a"],
    ["audio/mp4;codecs=opus", "m4a"],
    ["audio/mp4;codecs=aac", "m4a"],
    ["audio/aac", "m4a"],
    ["audio/mpeg", "mp3"],
    ["audio/unknown", "webm"],
  ];
  for (const [input, expected] of cases) {
    it(`${input} → .${expected}`, () => {
      expect(resolveVoiceNoteExtension(input)).toBe(expected);
    });
  }
});

describe("pickRecorderMimeType", () => {
  const orig = (globalThis as Record<string, unknown>).MediaRecorder;
  afterEach(() => {
    if (orig) {
      (globalThis as Record<string, unknown>).MediaRecorder = orig;
    } else {
      delete (globalThis as Record<string, unknown>).MediaRecorder;
    }
  });

  it("returns '' when MediaRecorder is undefined", () => {
    delete (globalThis as Record<string, unknown>).MediaRecorder;
    expect(pickRecorderMimeType()).toBe("");
  });

  it("returns '' when isTypeSupported is missing", () => {
    (globalThis as Record<string, unknown>).MediaRecorder = {};
    expect(pickRecorderMimeType()).toBe("");
  });

  it("picks first supported candidate (webm)", () => {
    (globalThis as Record<string, unknown>).MediaRecorder = {
      isTypeSupported: (t: string) => t === "audio/webm;codecs=opus",
    };
    expect(pickRecorderMimeType()).toBe("audio/webm;codecs=opus");
  });

  it("picks audio/mp4;codecs=aac for iOS Safari (no webm/ogg)", () => {
    const supported = new Set(["audio/mp4;codecs=aac", "audio/mp4"]);
    (globalThis as Record<string, unknown>).MediaRecorder = {
      isTypeSupported: (t: string) => supported.has(t),
    };
    expect(pickRecorderMimeType()).toBe("audio/mp4;codecs=aac");
  });

  it("picks audio/mp4;codecs=opus on newer iOS Safari", () => {
    const supported = new Set(["audio/mp4;codecs=opus", "audio/mp4"]);
    (globalThis as Record<string, unknown>).MediaRecorder = {
      isTypeSupported: (t: string) => supported.has(t),
    };
    expect(pickRecorderMimeType()).toBe("audio/mp4;codecs=opus");
  });

  it("returns '' when nothing is supported (browser will pick default)", () => {
    (globalThis as Record<string, unknown>).MediaRecorder = { isTypeSupported: () => false };
    expect(pickRecorderMimeType()).toBe("");
  });
});

describe("RECORDER_MIME_CANDIDATES order", () => {
  it("has mp4 variants before plain audio/mp4", () => {
    const mp4OpusIdx = RECORDER_MIME_CANDIDATES.indexOf("audio/mp4;codecs=opus");
    const mp4AacIdx = RECORDER_MIME_CANDIDATES.indexOf("audio/mp4;codecs=aac");
    const mp4Idx = RECORDER_MIME_CANDIDATES.indexOf("audio/mp4");
    expect(mp4OpusIdx).toBeLessThan(mp4Idx);
    expect(mp4AacIdx).toBeLessThan(mp4Idx);
  });

  it("prefers webm/ogg over mp4 (more widely supported server-side)", () => {
    const webmIdx = RECORDER_MIME_CANDIDATES.indexOf("audio/webm;codecs=opus");
    const mp4Idx = RECORDER_MIME_CANDIDATES.indexOf("audio/mp4;codecs=opus");
    expect(webmIdx).toBeLessThan(mp4Idx);
  });
});
