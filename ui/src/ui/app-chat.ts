import { parseAgentSessionKey } from "../../../src/sessions/session-key-utils.js";
import { scheduleChatScroll } from "./app-scroll.ts";
import { setLastActiveSessionKey } from "./app-settings.ts";
import { resetToolStream } from "./app-tool-stream.ts";
import type { OpenClawApp } from "./app.ts";
import {
  abortChatRun,
  appendLocalVoiceNoteMessage,
  loadChatHistory,
  persistVoiceNoteAttachment,
  sendChatMessage,
  syncChatComposerLocalState,
} from "./controllers/chat.ts";
import { loadSessions } from "./controllers/sessions.ts";
import type { GatewayHelloOk } from "./gateway.ts";
import { normalizeBasePath } from "./navigation.ts";
import type { ChatAttachment, ChatQueueItem } from "./ui-types.ts";
import { generateUUID } from "./uuid.ts";

export type ChatHost = {
  client: OpenClawApp["client"];
  connected: boolean;
  lastError: string | null;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatMessages: unknown[];
  chatQueue: ChatQueueItem[];
  chatRunId: string | null;
  chatSending: boolean;
  chatRecording: boolean;
  chatRecordError: string | null;
  sessionKey: string;
  basePath: string;
  hello: GatewayHelloOk | null;
  chatAvatarUrl: string | null;
  refreshSessionsAfterChat: Set<string>;
};

export const CHAT_SESSIONS_ACTIVE_MINUTES = 120;
const RECORDER_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
  "audio/mp4",
] as const;

type ActiveVoiceRecorder = {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: BlobPart[];
  startedAt: number;
  mimeType: string;
  stopping: boolean;
};

const activeVoiceRecorders = new WeakMap<ChatHost, ActiveVoiceRecorder>();

export function isChatBusy(host: ChatHost) {
  return host.chatSending || Boolean(host.chatRunId);
}

export function isChatStopCommand(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "/stop") {
    return true;
  }
  return (
    normalized === "stop" ||
    normalized === "esc" ||
    normalized === "abort" ||
    normalized === "wait" ||
    normalized === "exit"
  );
}

function isChatResetCommand(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "/new" || normalized === "/reset") {
    return true;
  }
  return normalized.startsWith("/new ") || normalized.startsWith("/reset ");
}

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
  if (normalized.includes("mp4") || normalized.includes("m4a")) {
    return "m4a";
  }
  if (normalized.includes("mpeg") || normalized.includes("mp3")) {
    return "mp3";
  }
  return "webm";
}

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      resolve(reader.result as string);
    });
    reader.addEventListener("error", () => {
      reject(new Error("failed to read voice note recording"));
    });
    reader.readAsDataURL(blob);
  });
}

function stopMediaStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

function resolveMicPermissionError(err: unknown): string | null {
  if (!(err instanceof DOMException)) {
    return null;
  }
  if (
    err.name === "NotAllowedError" ||
    err.name === "PermissionDeniedError" ||
    err.name === "SecurityError"
  ) {
    return "Microphone access denied. Allow mic permissions and try recording again.";
  }
  return null;
}

function buildVoiceNoteFileName(now: number, mimeType: string): string {
  const iso = new Date(now).toISOString().replace(/[^\d]/g, "").slice(0, 14);
  return `voice-note-${iso}.${resolveVoiceNoteExtension(mimeType)}`;
}

function buildVoiceNoteBlob(params: {
  recorder: MediaRecorder;
  chunks: BlobPart[];
  mimeType: string;
}) {
  const type = params.recorder.mimeType || params.mimeType || "audio/webm";
  return new Blob(params.chunks, { type });
}

export function setChatDraft(host: ChatHost, next: string) {
  host.chatMessage = next;
  syncChatComposerLocalState(host as unknown as OpenClawApp);
}

export function setChatAttachments(host: ChatHost, next: ChatAttachment[]) {
  host.chatAttachments = next;
  syncChatComposerLocalState(host as unknown as OpenClawApp);
}

export function clearChatRecordError(host: ChatHost) {
  host.chatRecordError = null;
}

async function startVoiceNoteRecording(host: ChatHost) {
  if (!host.connected) {
    return;
  }
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    host.chatRecordError = "Microphone recording is not supported in this browser.";
    return;
  }
  if (typeof MediaRecorder === "undefined") {
    host.chatRecordError = "Microphone recording is not supported in this browser.";
    return;
  }

  host.chatRecordError = null;
  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = pickRecorderMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    const chunks: BlobPart[] = [];

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
      }
    });
    recorder.start(250);

    activeVoiceRecorders.set(host, {
      recorder,
      stream,
      chunks,
      startedAt: Date.now(),
      mimeType: recorder.mimeType || mimeType || "audio/webm",
      stopping: false,
    });
    host.chatRecording = true;
  } catch (err) {
    if (stream) {
      stopMediaStream(stream);
    }
    host.chatRecording = false;
    host.chatRecordError =
      resolveMicPermissionError(err) ?? `Unable to start recording: ${String(err)}`;
  }
}

async function stopVoiceNoteRecording(host: ChatHost) {
  const active = activeVoiceRecorders.get(host);
  if (!active) {
    host.chatRecording = false;
    return;
  }
  if (active.stopping) {
    return;
  }

  active.stopping = true;
  try {
    const blob = await new Promise<Blob>((resolve, reject) => {
      const handleStop = () => {
        resolve(buildVoiceNoteBlob(active));
      };
      const handleError = (event: Event) => {
        const recordingError = (event as ErrorEvent).error;
        reject(
          recordingError instanceof Error
            ? recordingError
            : new Error("voice note recording failed"),
        );
      };
      active.recorder.addEventListener("stop", handleStop, { once: true });
      active.recorder.addEventListener("error", handleError as EventListener, { once: true });

      try {
        if (active.recorder.state === "inactive") {
          handleStop();
          return;
        }
        active.recorder.stop();
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    if (blob.size === 0) {
      throw new Error("voice note recording was empty");
    }

    const now = Date.now();
    const mimeType = blob.type || active.mimeType || "audio/webm";
    const dataUrl = await readBlobAsDataUrl(blob);
    const previewUrl = URL.createObjectURL(blob);
    const attachment: ChatAttachment = {
      id: generateUUID(),
      kind: "voice-note",
      dataUrl,
      previewUrl,
      mimeType,
      fileName: buildVoiceNoteFileName(now, mimeType),
      source: "record",
      durationMs: Math.max(0, now - active.startedAt),
    };

    host.chatAttachments = [...host.chatAttachments, attachment];
    appendLocalVoiceNoteMessage(host as unknown as OpenClawApp, attachment, { timestamp: now });
    syncChatComposerLocalState(host as unknown as OpenClawApp);

    try {
      const persistedId = await persistVoiceNoteAttachment(
        host as unknown as OpenClawApp,
        attachment,
      );
      if (!persistedId) {
        host.chatRecordError =
          "Voice note saved locally, but gateway persistence did not complete.";
      }
    } catch (err) {
      console.warn("[control-ui] voice note persist failed:", err);
      host.chatRecordError = `Unable to persist voice note: ${String(err)}`;
    }
  } catch (err) {
    host.chatRecordError = `Unable to save voice note: ${String(err)}`;
  } finally {
    stopMediaStream(active.stream);
    activeVoiceRecorders.delete(host);
    host.chatRecording = false;
  }
}

export async function handleToggleVoiceNoteRecording(host: ChatHost) {
  if (!host.connected) {
    return;
  }
  const active = activeVoiceRecorders.get(host);
  if (active || host.chatRecording) {
    await stopVoiceNoteRecording(host);
    return;
  }
  await startVoiceNoteRecording(host);
}

export async function handleAbortChat(host: ChatHost) {
  if (!host.connected) {
    return;
  }
  host.chatMessage = "";
  syncChatComposerLocalState(host as unknown as OpenClawApp);
  await abortChatRun(host as unknown as OpenClawApp);
}

function enqueueChatMessage(
  host: ChatHost,
  text: string,
  attachments?: ChatAttachment[],
  refreshSessions?: boolean,
) {
  const trimmed = text.trim();
  const hasAttachments = Boolean(attachments && attachments.length > 0);
  if (!trimmed && !hasAttachments) {
    return;
  }
  host.chatQueue = [
    ...host.chatQueue,
    {
      id: generateUUID(),
      text: trimmed,
      createdAt: Date.now(),
      attachments: hasAttachments ? attachments?.map((att) => ({ ...att })) : undefined,
      refreshSessions,
    },
  ];
}

async function sendChatMessageNow(
  host: ChatHost,
  message: string,
  opts?: {
    previousDraft?: string;
    restoreDraft?: boolean;
    attachments?: ChatAttachment[];
    previousAttachments?: ChatAttachment[];
    restoreAttachments?: boolean;
    refreshSessions?: boolean;
  },
) {
  resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
  const runId = await sendChatMessage(host as unknown as OpenClawApp, message, opts?.attachments);
  const ok = Boolean(runId);
  if (!ok && opts?.previousDraft != null) {
    host.chatMessage = opts.previousDraft;
  }
  if (!ok && opts?.previousAttachments) {
    host.chatAttachments = opts.previousAttachments;
  }
  if (ok) {
    setLastActiveSessionKey(
      host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
      host.sessionKey,
    );
  }
  if (ok && opts?.restoreDraft && opts.previousDraft?.trim()) {
    host.chatMessage = opts.previousDraft;
  }
  if (ok && opts?.restoreAttachments && opts.previousAttachments?.length) {
    host.chatAttachments = opts.previousAttachments;
  }
  syncChatComposerLocalState(host as unknown as OpenClawApp);
  scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
  if (ok && !host.chatRunId) {
    void flushChatQueue(host);
  }
  if (ok && opts?.refreshSessions && runId) {
    host.refreshSessionsAfterChat.add(runId);
  }
  return ok;
}

async function flushChatQueue(host: ChatHost) {
  if (!host.connected || isChatBusy(host)) {
    return;
  }
  const [next, ...rest] = host.chatQueue;
  if (!next) {
    return;
  }
  host.chatQueue = rest;
  const ok = await sendChatMessageNow(host, next.text, {
    attachments: next.attachments,
    refreshSessions: next.refreshSessions,
  });
  if (!ok) {
    host.chatQueue = [next, ...host.chatQueue];
  }
}

export function removeQueuedMessage(host: ChatHost, id: string) {
  host.chatQueue = host.chatQueue.filter((item) => item.id !== id);
}

export async function handleSendChat(
  host: ChatHost,
  messageOverride?: string,
  opts?: { restoreDraft?: boolean },
) {
  if (!host.connected) {
    return;
  }
  const previousDraft = host.chatMessage;
  const message = (messageOverride ?? host.chatMessage).trim();
  const attachments = host.chatAttachments ?? [];
  const attachmentsToSend = messageOverride == null ? attachments : [];
  const hasAttachments = attachmentsToSend.length > 0;

  // Allow sending with just attachments (no message text required)
  if (!message && !hasAttachments) {
    return;
  }

  if (isChatStopCommand(message)) {
    await handleAbortChat(host);
    return;
  }

  const refreshSessions = isChatResetCommand(message);
  if (messageOverride == null) {
    host.chatMessage = "";
    // Clear attachments when sending
    host.chatAttachments = [];
    syncChatComposerLocalState(host as unknown as OpenClawApp);
  }

  if (isChatBusy(host)) {
    enqueueChatMessage(host, message, attachmentsToSend, refreshSessions);
    return;
  }

  await sendChatMessageNow(host, message, {
    previousDraft: messageOverride == null ? previousDraft : undefined,
    restoreDraft: Boolean(messageOverride && opts?.restoreDraft),
    attachments: hasAttachments ? attachmentsToSend : undefined,
    previousAttachments: messageOverride == null ? attachments : undefined,
    restoreAttachments: Boolean(messageOverride && opts?.restoreDraft),
    refreshSessions,
  });
}

export async function refreshChat(host: ChatHost, opts?: { scheduleScroll?: boolean }) {
  await Promise.all([
    loadChatHistory(host as unknown as OpenClawApp),
    loadSessions(host as unknown as OpenClawApp, {
      activeMinutes: CHAT_SESSIONS_ACTIVE_MINUTES,
    }),
    refreshChatAvatar(host),
  ]);
  if (opts?.scheduleScroll !== false) {
    scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
  }
}

export const flushChatQueueForEvent = flushChatQueue;

type SessionDefaultsSnapshot = {
  defaultAgentId?: string;
};

function resolveAgentIdForSession(host: ChatHost): string | null {
  const parsed = parseAgentSessionKey(host.sessionKey);
  if (parsed?.agentId) {
    return parsed.agentId;
  }
  const snapshot = host.hello?.snapshot as
    | { sessionDefaults?: SessionDefaultsSnapshot }
    | undefined;
  const fallback = snapshot?.sessionDefaults?.defaultAgentId?.trim();
  return fallback || "main";
}

function buildAvatarMetaUrl(basePath: string, agentId: string): string {
  const base = normalizeBasePath(basePath);
  const encoded = encodeURIComponent(agentId);
  return base ? `${base}/avatar/${encoded}?meta=1` : `/avatar/${encoded}?meta=1`;
}

export async function refreshChatAvatar(host: ChatHost) {
  if (!host.connected) {
    host.chatAvatarUrl = null;
    return;
  }
  const agentId = resolveAgentIdForSession(host);
  if (!agentId) {
    host.chatAvatarUrl = null;
    return;
  }
  host.chatAvatarUrl = null;
  const url = buildAvatarMetaUrl(host.basePath, agentId);
  try {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) {
      host.chatAvatarUrl = null;
      return;
    }
    const data = (await res.json()) as { avatarUrl?: unknown };
    const avatarUrl = typeof data.avatarUrl === "string" ? data.avatarUrl.trim() : "";
    host.chatAvatarUrl = avatarUrl || null;
  } catch {
    host.chatAvatarUrl = null;
  }
}
