import { extractText } from "../chat/message-extract.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { ChatAttachment } from "../ui-types.ts";
import { generateUUID } from "../uuid.ts";

const LOCAL_CHAT_STATE_KEY = "openclaw.control.chat.local.v1";
const LOCAL_CHAT_STATE_VERSION = 1;
const LOCAL_CHAT_ATTACHMENTS_LIMIT = 8;
const LOCAL_CHAT_VOICE_NOTES_LIMIT = 40;

type StoredChatAttachment = {
  id: string;
  kind?: "image" | "voice-note";
  dataUrl: string;
  mimeType: string;
  fileName?: string;
  source?: "upload" | "record";
  durationMs?: number;
  transcript?: string;
  transcriptParts?: string[];
  persistedNoteId?: string;
};

type StoredLocalVoiceNote = {
  id: string;
  timestamp: number;
  attachment: StoredChatAttachment;
};

type StoredSessionChatState = {
  draft?: string;
  attachments?: StoredChatAttachment[];
  voiceNotes?: StoredLocalVoiceNote[];
};

type StoredChatStateStore = {
  version: number;
  sessions: Record<string, StoredSessionChatState>;
};

type VoiceNotesSaveResult = {
  note?: {
    id?: string;
  };
};

export type ChatState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatThinkingLevel: string | null;
  chatSending: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatRunId: string | null;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  lastError: string | null;
};

export type ChatEventPayload = {
  runId: string;
  sessionKey: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  errorMessage?: string;
};

function getLocalStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readLocalChatStateStore(): StoredChatStateStore | null {
  const storage = getLocalStorage();
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(LOCAL_CHAT_STATE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<StoredChatStateStore>;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.version !== "number" ||
      parsed.version !== LOCAL_CHAT_STATE_VERSION ||
      typeof parsed.sessions !== "object" ||
      parsed.sessions === null
    ) {
      return null;
    }
    return {
      version: LOCAL_CHAT_STATE_VERSION,
      sessions: parsed.sessions as Record<string, StoredSessionChatState>,
    };
  } catch {
    return null;
  }
}

function writeLocalChatStateStore(store: StoredChatStateStore): void {
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }
  try {
    storage.setItem(LOCAL_CHAT_STATE_KEY, JSON.stringify(store));
  } catch {
    // Ignore quota/private mode write failures.
  }
}

function updateLocalSessionState(
  sessionKey: string,
  updater: (current: StoredSessionChatState) => StoredSessionChatState | null,
): void {
  if (!sessionKey.trim()) {
    return;
  }
  const store = readLocalChatStateStore() ?? {
    version: LOCAL_CHAT_STATE_VERSION,
    sessions: {},
  };
  const current = store.sessions[sessionKey] ?? {};
  const next = updater(current);
  if (!next) {
    delete store.sessions[sessionKey];
  } else {
    store.sessions[sessionKey] = next;
  }
  writeLocalChatStateStore(store);
}

function readLocalSessionState(sessionKey: string): StoredSessionChatState | null {
  if (!sessionKey.trim()) {
    return null;
  }
  const store = readLocalChatStateStore();
  if (!store) {
    return null;
  }
  const session = store.sessions[sessionKey];
  if (!session || typeof session !== "object") {
    return null;
  }
  return session;
}

function dataUrlToBase64(dataUrl: string): { content: string; mimeType: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    return null;
  }
  return { mimeType: match[1], content: match[2] };
}

function isVoiceNoteAttachment(attachment: ChatAttachment): boolean {
  if (attachment.kind === "voice-note") {
    return true;
  }
  return attachment.mimeType.toLowerCase().startsWith("audio/");
}

function normalizeTranscript(attachment: ChatAttachment): string {
  if (typeof attachment.transcript === "string") {
    return attachment.transcript.trim();
  }
  if (!Array.isArray(attachment.transcriptParts)) {
    return "";
  }
  return attachment.transcriptParts
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join("\n");
}

function splitTranscriptParts(transcript: string): string[] {
  return transcript
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function toStoredChatAttachment(attachment: ChatAttachment): StoredChatAttachment | null {
  const id = typeof attachment.id === "string" ? attachment.id.trim() : "";
  if (!id) {
    return null;
  }
  const dataUrl = typeof attachment.dataUrl === "string" ? attachment.dataUrl.trim() : "";
  const mimeType = typeof attachment.mimeType === "string" ? attachment.mimeType.trim() : "";
  if (!dataUrl || !mimeType) {
    return null;
  }

  const transcript = normalizeTranscript(attachment);
  const stored: StoredChatAttachment = {
    id,
    kind: isVoiceNoteAttachment(attachment) ? "voice-note" : "image",
    dataUrl,
    mimeType,
    fileName:
      typeof attachment.fileName === "string" && attachment.fileName.trim()
        ? attachment.fileName.trim()
        : undefined,
    source:
      attachment.source === "record" || attachment.source === "upload"
        ? attachment.source
        : undefined,
    durationMs:
      typeof attachment.durationMs === "number" && Number.isFinite(attachment.durationMs)
        ? Math.max(0, Math.round(attachment.durationMs))
        : undefined,
    transcript: transcript || undefined,
    transcriptParts: transcript ? splitTranscriptParts(transcript) : undefined,
    persistedNoteId:
      typeof attachment.persistedNoteId === "string" && attachment.persistedNoteId.trim()
        ? attachment.persistedNoteId.trim()
        : undefined,
  };
  return stored;
}

function fromStoredChatAttachment(value: unknown): ChatAttachment | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const dataUrl = typeof raw.dataUrl === "string" ? raw.dataUrl.trim() : "";
  const mimeType = typeof raw.mimeType === "string" ? raw.mimeType.trim() : "";
  if (!id || !dataUrl || !mimeType) {
    return null;
  }
  const transcript =
    typeof raw.transcript === "string" && raw.transcript.trim() ? raw.transcript.trim() : "";
  const transcriptParts = transcript ? splitTranscriptParts(transcript) : undefined;
  return {
    id,
    kind: raw.kind === "voice-note" || raw.kind === "image" ? raw.kind : undefined,
    dataUrl,
    mimeType,
    fileName:
      typeof raw.fileName === "string" && raw.fileName.trim() ? raw.fileName.trim() : undefined,
    source: raw.source === "record" || raw.source === "upload" ? raw.source : undefined,
    durationMs:
      typeof raw.durationMs === "number" && Number.isFinite(raw.durationMs)
        ? Math.max(0, Math.round(raw.durationMs))
        : undefined,
    transcript: transcript || undefined,
    transcriptParts,
    persistedNoteId:
      typeof raw.persistedNoteId === "string" && raw.persistedNoteId.trim()
        ? raw.persistedNoteId.trim()
        : undefined,
  };
}

function getLocalVoiceNoteMarkerId(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const raw = message as Record<string, unknown>;
  const marker = raw.__openclaw as Record<string, unknown> | undefined;
  if (!marker || marker.kind !== "local-voice-note") {
    return null;
  }
  return typeof marker.id === "string" && marker.id.trim() ? marker.id.trim() : null;
}

function buildVoiceNoteContentBlock(
  attachment: ChatAttachment,
  opts?: { persistedNoteId?: string; includePreviewUrl?: boolean },
): Record<string, unknown> {
  const transcript = normalizeTranscript(attachment);
  const persistedNoteId =
    opts?.persistedNoteId?.trim() ||
    (typeof attachment.persistedNoteId === "string" ? attachment.persistedNoteId.trim() : "");
  const block: Record<string, unknown> = {
    type: "voice_note",
    source: {
      type: "base64",
      media_type: attachment.mimeType,
      data: attachment.dataUrl,
    },
    mimeType: attachment.mimeType,
    fileName: attachment.fileName,
  };
  if (
    opts?.includePreviewUrl &&
    typeof attachment.previewUrl === "string" &&
    attachment.previewUrl
  ) {
    block.url = attachment.previewUrl;
  }
  if (transcript) {
    block.transcript = transcript;
    block.transcriptParts = splitTranscriptParts(transcript);
  }
  if (persistedNoteId) {
    block.persistedNoteId = persistedNoteId;
  }
  return block;
}

function buildLocalVoiceNoteMessage(
  attachment: ChatAttachment,
  timestamp: number,
): Record<string, unknown> {
  return {
    role: "user",
    content: [buildVoiceNoteContentBlock(attachment, { includePreviewUrl: true })],
    timestamp,
    __openclaw: {
      kind: "local-voice-note",
      id: attachment.id,
    },
  };
}

function updateLocalVoiceMessageInMemory(
  messages: unknown[],
  attachment: ChatAttachment,
  timestamp: number,
): unknown[] {
  const markerId = attachment.id;
  const nextMessage = buildLocalVoiceNoteMessage(attachment, timestamp);
  let replaced = false;
  const next = messages.map((message) => {
    if (getLocalVoiceNoteMarkerId(message) !== markerId) {
      return message;
    }
    replaced = true;
    return nextMessage;
  });
  if (!replaced) {
    next.push(nextMessage);
  }
  return next;
}

function patchLocalVoiceMessagePersistedId(
  message: unknown,
  attachmentId: string,
  persistedNoteId: string,
): unknown {
  if (getLocalVoiceNoteMarkerId(message) !== attachmentId) {
    return message;
  }
  if (!message || typeof message !== "object") {
    return message;
  }
  const raw = message as Record<string, unknown>;
  if (!Array.isArray(raw.content)) {
    return message;
  }
  const nextContent = raw.content.map((entry) => {
    if (!entry || typeof entry !== "object") {
      return entry;
    }
    const block = entry as Record<string, unknown>;
    const type = typeof block.type === "string" ? block.type.toLowerCase() : "";
    if (type !== "voice_note" && type !== "audio") {
      return entry;
    }
    return { ...block, persistedNoteId };
  });
  return {
    ...raw,
    content: nextContent,
  };
}

function loadLocalVoiceNoteMessages(sessionKey: string): unknown[] {
  const session = readLocalSessionState(sessionKey);
  if (!session || !Array.isArray(session.voiceNotes)) {
    return [];
  }
  const entries = session.voiceNotes
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const raw = entry as Record<string, unknown>;
      const id = typeof raw.id === "string" ? raw.id.trim() : "";
      if (!id) {
        return null;
      }
      const timestamp = typeof raw.timestamp === "number" ? raw.timestamp : Date.now();
      const attachment = fromStoredChatAttachment(raw.attachment);
      if (!attachment) {
        return null;
      }
      attachment.id = id;
      return buildLocalVoiceNoteMessage(attachment, timestamp);
    })
    .filter((entry): entry is Record<string, unknown> => entry !== null);

  entries.sort((a, b) => {
    const left = typeof a.timestamp === "number" ? a.timestamp : 0;
    const right = typeof b.timestamp === "number" ? b.timestamp : 0;
    return left - right;
  });
  return entries;
}

function mergeLocalVoiceNoteMessages(history: unknown[], localVoiceNotes: unknown[]): unknown[] {
  if (localVoiceNotes.length === 0) {
    return history;
  }
  const seen = new Set<string>();
  for (const message of history) {
    const markerId = getLocalVoiceNoteMarkerId(message);
    if (markerId) {
      seen.add(markerId);
    }
  }
  const merged = [...history];
  for (const message of localVoiceNotes) {
    const markerId = getLocalVoiceNoteMarkerId(message);
    if (!markerId || seen.has(markerId)) {
      continue;
    }
    merged.push(message);
    seen.add(markerId);
  }
  return merged;
}

function restoreComposerStateFromLocalStorage(state: ChatState): void {
  const session = readLocalSessionState(state.sessionKey);
  if (!session) {
    return;
  }
  if (!state.chatMessage && typeof session.draft === "string") {
    state.chatMessage = session.draft;
  }
  if ((state.chatAttachments?.length ?? 0) > 0 || !Array.isArray(session.attachments)) {
    return;
  }
  const restored = session.attachments
    .map((attachment) => fromStoredChatAttachment(attachment))
    .filter((attachment): attachment is ChatAttachment => attachment !== null);
  if (restored.length > 0) {
    state.chatAttachments = restored;
  }
}

export function syncChatComposerLocalState(state: ChatState): void {
  const draft = typeof state.chatMessage === "string" ? state.chatMessage : "";
  const attachments = Array.isArray(state.chatAttachments) ? state.chatAttachments : [];
  const storedAttachments = attachments
    .map((attachment) => toStoredChatAttachment(attachment))
    .filter((attachment): attachment is StoredChatAttachment => attachment !== null)
    .slice(-LOCAL_CHAT_ATTACHMENTS_LIMIT);

  updateLocalSessionState(state.sessionKey, (current) => {
    const next: StoredSessionChatState = {
      ...current,
      draft: draft ? draft : undefined,
      attachments: storedAttachments.length > 0 ? storedAttachments : undefined,
    };
    const hasVoiceNotes = Array.isArray(next.voiceNotes) && next.voiceNotes.length > 0;
    const hasDraft = typeof next.draft === "string" && next.draft.length > 0;
    const hasAttachments = Array.isArray(next.attachments) && next.attachments.length > 0;
    if (!hasVoiceNotes && !hasDraft && !hasAttachments) {
      return null;
    }
    return next;
  });
}

function updateLocalVoiceNotePersistence(
  state: ChatState,
  attachmentId: string,
  persistedNoteId: string,
): void {
  state.chatAttachments = state.chatAttachments.map((attachment) =>
    attachment.id === attachmentId ? { ...attachment, persistedNoteId } : attachment,
  );
  state.chatMessages = state.chatMessages.map((message) =>
    patchLocalVoiceMessagePersistedId(message, attachmentId, persistedNoteId),
  );

  updateLocalSessionState(state.sessionKey, (current) => {
    const nextVoiceNotes = Array.isArray(current.voiceNotes)
      ? current.voiceNotes.map((entry) => {
          if (entry.id !== attachmentId) {
            return entry;
          }
          return {
            ...entry,
            attachment: {
              ...entry.attachment,
              persistedNoteId,
            },
          };
        })
      : current.voiceNotes;

    const nextAttachments = Array.isArray(current.attachments)
      ? current.attachments.map((entry) =>
          entry.id === attachmentId ? { ...entry, persistedNoteId } : entry,
        )
      : current.attachments;

    return {
      ...current,
      voiceNotes: nextVoiceNotes,
      attachments: nextAttachments,
    };
  });
}

function buildVoiceNotePromptText(voiceNotes: ChatAttachment[]): string {
  if (voiceNotes.length === 0) {
    return "";
  }
  return voiceNotes
    .map((attachment, index) => {
      const label = attachment.fileName?.trim() || `Voice note ${index + 1}`;
      const transcript = normalizeTranscript(attachment);
      if (!transcript) {
        return `[${label}]`;
      }
      return `[${label} transcript]\n${transcript}`;
    })
    .join("\n\n")
    .trim();
}

function normalizeAbortedAssistantMessage(message: unknown): Record<string, unknown> | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const candidate = message as Record<string, unknown>;
  if (candidate.role !== "assistant") {
    return null;
  }
  if (!("content" in candidate) || !Array.isArray(candidate.content)) {
    return null;
  }
  return candidate;
}

function hasLocalVoiceNoteMessage(messages: unknown[], attachmentId: string): boolean {
  return messages.some((message) => getLocalVoiceNoteMarkerId(message) === attachmentId);
}

export function appendLocalVoiceNoteMessage(
  state: ChatState,
  attachment: ChatAttachment,
  opts?: { timestamp?: number },
): void {
  const timestamp = typeof opts?.timestamp === "number" ? opts.timestamp : Date.now();
  state.chatMessages = updateLocalVoiceMessageInMemory(state.chatMessages, attachment, timestamp);

  const storedAttachment = toStoredChatAttachment(attachment);
  if (!storedAttachment) {
    return;
  }

  updateLocalSessionState(state.sessionKey, (current) => {
    const voiceNotes = Array.isArray(current.voiceNotes) ? current.voiceNotes : [];
    const nextVoiceNotes = [
      ...voiceNotes.filter((entry) => entry.id !== attachment.id),
      {
        id: attachment.id,
        timestamp,
        attachment: storedAttachment,
      },
    ]
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-LOCAL_CHAT_VOICE_NOTES_LIMIT);

    const next: StoredSessionChatState = {
      ...current,
      voiceNotes: nextVoiceNotes,
    };
    return next;
  });
}

export async function persistVoiceNoteAttachment(
  state: ChatState,
  attachment: ChatAttachment,
): Promise<string | null> {
  if (!state.client || !state.connected) {
    return null;
  }

  const existing =
    typeof attachment.persistedNoteId === "string" ? attachment.persistedNoteId.trim() : "";
  if (existing) {
    return existing;
  }

  const parsed = dataUrlToBase64(attachment.dataUrl);
  if (!parsed) {
    return null;
  }

  const transcript = normalizeTranscript(attachment);
  const result = await state.client.request<VoiceNotesSaveResult>("voice-notes.save", {
    sessionKey: state.sessionKey,
    source: attachment.source ?? "upload",
    durationMs: attachment.durationMs,
    transcript: transcript || undefined,
    transcriptParts: transcript ? splitTranscriptParts(transcript) : undefined,
    audio: {
      mimeType: parsed.mimeType || attachment.mimeType,
      fileName: attachment.fileName,
      content: parsed.content,
    },
  });
  const persistedId = result.note?.id?.trim() || "";
  if (!persistedId) {
    return null;
  }
  attachment.persistedNoteId = persistedId;
  updateLocalVoiceNotePersistence(state, attachment.id, persistedId);
  return persistedId;
}

export async function loadChatHistory(state: ChatState) {
  if (!state.client || !state.connected) {
    return;
  }
  state.chatLoading = true;
  state.lastError = null;
  try {
    const res = await state.client.request<{ messages?: Array<unknown>; thinkingLevel?: string }>(
      "chat.history",
      {
        sessionKey: state.sessionKey,
        limit: 200,
      },
    );
    const remoteMessages = Array.isArray(res.messages) ? res.messages : [];
    const localVoiceNotes = loadLocalVoiceNoteMessages(state.sessionKey);
    state.chatMessages = mergeLocalVoiceNoteMessages(remoteMessages, localVoiceNotes);
    state.chatThinkingLevel = res.thinkingLevel ?? null;
    restoreComposerStateFromLocalStorage(state);
  } catch (err) {
    state.lastError = String(err);
  } finally {
    state.chatLoading = false;
  }
}

export async function sendChatMessage(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
): Promise<string | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  const msg = message.trim();
  const allAttachments = attachments ?? [];
  const imageAttachments = allAttachments.filter(
    (attachment) => !isVoiceNoteAttachment(attachment),
  );
  const voiceNoteAttachments = allAttachments.filter((attachment) =>
    isVoiceNoteAttachment(attachment),
  );
  const hasImageAttachments = imageAttachments.length > 0;
  const hasVoiceNotes = voiceNoteAttachments.length > 0;
  if (!msg && !hasImageAttachments && !hasVoiceNotes) {
    return null;
  }

  const voicePromptText = buildVoiceNotePromptText(voiceNoteAttachments);
  const outboundMessage = [msg, voicePromptText].filter(Boolean).join("\n\n");

  const now = Date.now();
  const persistedVoiceNoteIds = new Map<string, string>();
  if (hasVoiceNotes) {
    await Promise.all(
      voiceNoteAttachments.map(async (attachment) => {
        const knownId =
          typeof attachment.persistedNoteId === "string" ? attachment.persistedNoteId.trim() : "";
        if (knownId) {
          persistedVoiceNoteIds.set(attachment.id, knownId);
          return;
        }
        try {
          const persistedId = await persistVoiceNoteAttachment(state, attachment);
          if (persistedId) {
            persistedVoiceNoteIds.set(attachment.id, persistedId);
          }
        } catch (err) {
          console.warn("[control-ui] voice note persist failed:", err);
        }
      }),
    );
  }

  // Build user message content blocks
  const contentBlocks: Array<Record<string, unknown>> = [];
  if (msg) {
    contentBlocks.push({ type: "text", text: msg });
  }
  // Add image previews to the message for display
  for (const att of imageAttachments) {
    contentBlocks.push({
      type: "image",
      source: { type: "base64", media_type: att.mimeType, data: att.dataUrl },
    });
  }
  for (const att of voiceNoteAttachments) {
    if (hasLocalVoiceNoteMessage(state.chatMessages, att.id)) {
      continue;
    }
    contentBlocks.push(
      buildVoiceNoteContentBlock(att, {
        persistedNoteId: persistedVoiceNoteIds.get(att.id),
        includePreviewUrl: true,
      }),
    );
  }

  if (contentBlocks.length > 0) {
    state.chatMessages = [
      ...state.chatMessages,
      {
        role: "user",
        content: contentBlocks,
        timestamp: now,
      },
    ];
  }

  state.chatSending = true;
  state.lastError = null;
  const runId = generateUUID();
  state.chatRunId = runId;
  state.chatStream = "";
  state.chatStreamStartedAt = now;

  // Convert attachments to API format
  const apiAttachments = hasImageAttachments
    ? imageAttachments
        .map((att) => {
          const parsed = dataUrlToBase64(att.dataUrl);
          if (!parsed) {
            return null;
          }
          return {
            type: "image",
            mimeType: parsed.mimeType,
            content: parsed.content,
          };
        })
        .filter((a): a is NonNullable<typeof a> => a !== null)
    : undefined;

  try {
    await state.client.request("chat.send", {
      sessionKey: state.sessionKey,
      message: outboundMessage,
      deliver: false,
      idempotencyKey: runId,
      attachments: apiAttachments,
    });
    return runId;
  } catch (err) {
    const error = String(err);
    state.chatRunId = null;
    state.chatStream = null;
    state.chatStreamStartedAt = null;
    state.lastError = error;
    state.chatMessages = [
      ...state.chatMessages,
      {
        role: "assistant",
        content: [{ type: "text", text: "Error: " + error }],
        timestamp: Date.now(),
      },
    ];
    return null;
  } finally {
    state.chatSending = false;
  }
}

export async function abortChatRun(state: ChatState): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  const runId = state.chatRunId;
  try {
    await state.client.request(
      "chat.abort",
      runId ? { sessionKey: state.sessionKey, runId } : { sessionKey: state.sessionKey },
    );
    return true;
  } catch (err) {
    state.lastError = String(err);
    return false;
  }
}

export function handleChatEvent(state: ChatState, payload?: ChatEventPayload) {
  if (!payload) {
    return null;
  }
  if (payload.sessionKey !== state.sessionKey) {
    return null;
  }

  // Final from another run (e.g. sub-agent announce): refresh history to show new message.
  // See https://github.com/openclaw/openclaw/issues/1909
  if (payload.runId && state.chatRunId && payload.runId !== state.chatRunId) {
    if (payload.state === "final") {
      return "final";
    }
    return null;
  }

  if (payload.state === "delta") {
    const next = extractText(payload.message);
    if (typeof next === "string") {
      const current = state.chatStream ?? "";
      if (!current || next.length >= current.length) {
        state.chatStream = next;
      }
    }
  } else if (payload.state === "final") {
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
  } else if (payload.state === "aborted") {
    const normalizedMessage = normalizeAbortedAssistantMessage(payload.message);
    if (normalizedMessage) {
      state.chatMessages = [...state.chatMessages, normalizedMessage];
    } else {
      const streamedText = state.chatStream ?? "";
      if (streamedText.trim()) {
        state.chatMessages = [
          ...state.chatMessages,
          {
            role: "assistant",
            content: [{ type: "text", text: streamedText }],
            timestamp: Date.now(),
          },
        ];
      }
    }
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
  } else if (payload.state === "error") {
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
    state.lastError = payload.errorMessage ?? "chat error";
  }
  return payload.state;
}
