export type ChatAttachmentKind = "image" | "voice-note";

export type ChatAttachment = {
  id: string;
  kind?: ChatAttachmentKind;
  dataUrl: string;
  previewUrl?: string;
  mimeType: string;
  fileName?: string;
  source?: "upload" | "record";
  durationMs?: number;
  transcript?: string;
  transcriptParts?: string[];
  persistedNoteId?: string;
};

export type ChatQueueItem = {
  id: string;
  text: string;
  createdAt: number;
  attachments?: ChatAttachment[];
  refreshSessions?: boolean;
};

export const CRON_CHANNEL_LAST = "last";

export type CronFormState = {
  name: string;
  description: string;
  agentId: string;
  enabled: boolean;
  scheduleKind: "at" | "every" | "cron";
  scheduleAt: string;
  everyAmount: string;
  everyUnit: "minutes" | "hours" | "days";
  cronExpr: string;
  cronTz: string;
  sessionTarget: "main" | "isolated";
  wakeMode: "next-heartbeat" | "now";
  payloadKind: "systemEvent" | "agentTurn";
  payloadText: string;
  deliveryMode: "none" | "announce" | "webhook";
  deliveryChannel: string;
  deliveryTo: string;
  timeoutSeconds: string;
};
