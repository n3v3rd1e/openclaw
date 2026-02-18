import { describe, expect, it, vi } from "vitest";
import type { ChatAttachment } from "../ui-types.ts";
import {
  appendLocalVoiceNoteMessage,
  handleChatEvent,
  loadChatHistory,
  sendChatMessage,
  syncChatComposerLocalState,
  type ChatEventPayload,
  type ChatState,
} from "./chat.ts";

function createState(overrides: Partial<ChatState> = {}): ChatState {
  return {
    chatAttachments: [],
    chatLoading: false,
    chatMessage: "",
    chatMessages: [],
    chatRunId: null,
    chatSending: false,
    chatStream: null,
    chatStreamStartedAt: null,
    chatThinkingLevel: null,
    client: null,
    connected: true,
    lastError: null,
    sessionKey: "main",
    ...overrides,
  };
}

describe("handleChatEvent", () => {
  it("returns null when payload is missing", () => {
    const state = createState();
    expect(handleChatEvent(state, undefined)).toBe(null);
  });

  it("returns null when sessionKey does not match", () => {
    const state = createState({ sessionKey: "main" });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "other",
      state: "final",
    };
    expect(handleChatEvent(state, payload)).toBe(null);
  });

  it("returns null for delta from another run", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-user",
      chatStream: "Hello",
    });
    const payload: ChatEventPayload = {
      runId: "run-announce",
      sessionKey: "main",
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
    };
    expect(handleChatEvent(state, payload)).toBe(null);
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatStream).toBe("Hello");
  });

  it("returns 'final' for final from another run (e.g. sub-agent announce) without clearing state", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-user",
      chatStream: "Working...",
      chatStreamStartedAt: 123,
    });
    const payload: ChatEventPayload = {
      runId: "run-announce",
      sessionKey: "main",
      state: "final",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Sub-agent findings" }],
      },
    };
    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatStream).toBe("Working...");
    expect(state.chatStreamStartedAt).toBe(123);
  });

  it("processes final from own run and clears state", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Reply",
      chatStreamStartedAt: 100,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
    };
    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
  });

  it("processes aborted from own run and keeps partial assistant message", () => {
    const existingMessage = {
      role: "user",
      content: [{ type: "text", text: "Hi" }],
      timestamp: 1,
    };
    const partialMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Partial reply" }],
      timestamp: 2,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Partial reply",
      chatStreamStartedAt: 100,
      chatMessages: [existingMessage],
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "aborted",
      message: partialMessage,
    };

    expect(handleChatEvent(state, payload)).toBe("aborted");
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
    expect(state.chatMessages).toEqual([existingMessage, partialMessage]);
  });

  it("falls back to streamed partial when aborted payload message is invalid", () => {
    const existingMessage = {
      role: "user",
      content: [{ type: "text", text: "Hi" }],
      timestamp: 1,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Partial reply",
      chatStreamStartedAt: 100,
      chatMessages: [existingMessage],
    });
    const payload = {
      runId: "run-1",
      sessionKey: "main",
      state: "aborted",
      message: "not-an-assistant-message",
    } as unknown as ChatEventPayload;

    expect(handleChatEvent(state, payload)).toBe("aborted");
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
    expect(state.chatMessages).toHaveLength(2);
    expect(state.chatMessages[0]).toEqual(existingMessage);
    expect(state.chatMessages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Partial reply" }],
    });
  });

  it("falls back to streamed partial when aborted payload has non-assistant role", () => {
    const existingMessage = {
      role: "user",
      content: [{ type: "text", text: "Hi" }],
      timestamp: 1,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Partial reply",
      chatStreamStartedAt: 100,
      chatMessages: [existingMessage],
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "aborted",
      message: {
        role: "user",
        content: [{ type: "text", text: "unexpected" }],
      },
    };

    expect(handleChatEvent(state, payload)).toBe("aborted");
    expect(state.chatMessages).toHaveLength(2);
    expect(state.chatMessages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Partial reply" }],
    });
  });

  it("processes aborted from own run without message and empty stream", () => {
    const existingMessage = {
      role: "user",
      content: [{ type: "text", text: "Hi" }],
      timestamp: 1,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "",
      chatStreamStartedAt: 100,
      chatMessages: [existingMessage],
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "aborted",
    };

    expect(handleChatEvent(state, payload)).toBe("aborted");
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
    expect(state.chatMessages).toEqual([existingMessage]);
  });
});

describe("sendChatMessage", () => {
  it("persists voice notes and appends transcript to outbound message", async () => {
    const request = vi
      .fn()
      .mockImplementationOnce(async () => ({ note: { id: "voice-note-123" } }))
      .mockImplementationOnce(async () => ({}));
    const state = createState({
      client: { request } as unknown as ChatState["client"],
      connected: true,
      sessionKey: "main",
    });
    const attachments: ChatAttachment[] = [
      {
        id: "voice-1",
        kind: "voice-note",
        dataUrl: "data:audio/ogg;base64,dm9pY2U=",
        mimeType: "audio/ogg",
        fileName: "memo.ogg",
        source: "record",
        durationMs: 1840,
        transcriptParts: [" hello ", "", "second line "],
      },
    ];

    const runId = await sendChatMessage(state, "Summarize this", attachments);

    expect(runId).toEqual(expect.any(String));
    expect(request).toHaveBeenNthCalledWith(
      1,
      "voice-notes.save",
      expect.objectContaining({
        sessionKey: "main",
        source: "record",
        durationMs: 1840,
        transcript: "hello\nsecond line",
        transcriptParts: ["hello", "second line"],
        audio: expect.objectContaining({
          mimeType: "audio/ogg",
          fileName: "memo.ogg",
          content: "dm9pY2U=",
        }),
      }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "chat.send",
      expect.objectContaining({
        sessionKey: "main",
        message: "Summarize this\n\n[memo.ogg transcript]\nhello\nsecond line",
        deliver: false,
        attachments: undefined,
        idempotencyKey: runId,
      }),
    );

    const lastMessage = state.chatMessages.at(-1) as Record<string, unknown>;
    const content = lastMessage.content as Array<Record<string, unknown>>;
    const voiceBlock = content.find((block) => block.type === "voice_note");
    expect(voiceBlock).toMatchObject({
      type: "voice_note",
      mimeType: "audio/ogg",
      fileName: "memo.ogg",
      transcript: "hello\nsecond line",
      persistedNoteId: "voice-note-123",
    });
  });

  it("continues sending when voice-note persistence fails", async () => {
    const request = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error("persist failed");
      })
      .mockImplementationOnce(async () => ({}));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = createState({
      client: { request } as unknown as ChatState["client"],
      connected: true,
      sessionKey: "main",
    });
    const attachments: ChatAttachment[] = [
      {
        id: "voice-2",
        kind: "voice-note",
        dataUrl: "data:audio/ogg;base64,dm9pY2UtMg==",
        mimeType: "audio/ogg",
        fileName: "failed.ogg",
        source: "upload",
        transcript: "test transcript",
      },
    ];

    try {
      const runId = await sendChatMessage(state, "Use this note", attachments);
      expect(runId).toEqual(expect.any(String));
      expect(request).toHaveBeenNthCalledWith(1, "voice-notes.save", expect.any(Object));
      expect(request).toHaveBeenNthCalledWith(
        2,
        "chat.send",
        expect.objectContaining({
          sessionKey: "main",
          message: "Use this note\n\n[failed.ogg transcript]\ntest transcript",
          attachments: undefined,
        }),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        "[control-ui] voice note persist failed:",
        expect.any(Error),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("skips voice-note save when attachment is already persisted", async () => {
    const request = vi.fn().mockResolvedValue({});
    const state = createState({
      client: { request } as unknown as ChatState["client"],
      connected: true,
      sessionKey: "main",
    });
    const attachments: ChatAttachment[] = [
      {
        id: "voice-persisted",
        kind: "voice-note",
        dataUrl: "data:audio/ogg;base64,dm9pY2UtcGVyc2lzdGVk",
        mimeType: "audio/ogg",
        fileName: "persisted.ogg",
        source: "record",
        persistedNoteId: "note-abc",
      },
    ];

    const runId = await sendChatMessage(state, "Use saved note", attachments);

    expect(runId).toEqual(expect.any(String));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        sessionKey: "main",
        message: "Use saved note\n\n[persisted.ogg]",
      }),
    );
  });
});

describe("loadChatHistory", () => {
  it("merges local voice-note bubbles and restores draft/attachments", async () => {
    localStorage.clear();

    const request = vi.fn().mockResolvedValue({
      messages: [{ role: "assistant", content: [{ type: "text", text: "server history" }] }],
      thinkingLevel: "low",
    });
    const state = createState({
      client: { request } as unknown as ChatState["client"],
      connected: true,
      sessionKey: "main",
    });

    const attachment: ChatAttachment = {
      id: "voice-local-1",
      kind: "voice-note",
      dataUrl: "data:audio/webm;base64,dm9pY2UtbG9jYWw=",
      mimeType: "audio/webm",
      fileName: "voice-local.webm",
      source: "record",
      durationMs: 1200,
    };

    state.chatMessage = "draft from local storage";
    state.chatAttachments = [attachment];
    syncChatComposerLocalState(state);
    appendLocalVoiceNoteMessage(state, attachment, { timestamp: 1700000000000 });

    state.chatMessage = "";
    state.chatAttachments = [];
    state.chatMessages = [];

    await loadChatHistory(state);

    expect(state.chatThinkingLevel).toBe("low");
    expect(state.chatMessage).toBe("draft from local storage");
    expect(state.chatAttachments).toHaveLength(1);
    expect(state.chatAttachments[0]).toMatchObject({
      id: "voice-local-1",
      mimeType: "audio/webm",
      dataUrl: "data:audio/webm;base64,dm9pY2UtbG9jYWw=",
    });

    const localMessage = state.chatMessages.find((entry) => {
      const raw = entry as Record<string, unknown>;
      const marker = raw.__openclaw as Record<string, unknown> | undefined;
      return marker?.kind === "local-voice-note" && marker.id === "voice-local-1";
    }) as Record<string, unknown> | undefined;
    expect(localMessage).toBeDefined();
    expect(localMessage?.role).toBe("user");
    const blocks = localMessage?.content as Array<Record<string, unknown>>;
    expect(blocks[0]).toMatchObject({
      type: "voice_note",
      mimeType: "audio/webm",
      fileName: "voice-local.webm",
    });
  });
});
