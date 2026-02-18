import type { AnyMessageContent } from "@whiskeysockets/baileys";
import type { NormalizedLocation } from "../../channels/location.js";

export type WebListenerCloseReason = {
  status?: number;
  isLoggedOut: boolean;
  error?: unknown;
};

export type WebInboundReaction = {
  /** Emoji text (empty string = removal). */
  emoji: string;
  /** Whether this is a removal (emoji cleared). */
  isRemoval: boolean;
  /** Account that received this reaction. */
  accountId: string;
  /** Chat JID where the reaction occurred. */
  chatId: string;
  chatType: "direct" | "group";
  /** Message key of the target message that was reacted to. */
  targetMessageId?: string;
  /** Whether the target message was sent by us. */
  targetFromMe?: boolean;
  /** JID of the person who reacted. */
  senderJid?: string;
  /** E.164 of the person who reacted. */
  senderE164?: string;
  /** Push name of the person who reacted. */
  senderName?: string;
  /** Group subject, if in a group. */
  groupSubject?: string;
  /** Timestamp (ms). */
  timestamp?: number;
};

export type WebInboundMessage = {
  id?: string;
  from: string; // conversation id: E.164 for direct chats, group JID for groups
  conversationId: string; // alias for clarity (same as from)
  to: string;
  accountId: string;
  body: string;
  /** Optional reaction metadata when this inbound event represents a WhatsApp reaction. */
  reaction?: WebInboundReaction;
  pushName?: string;
  timestamp?: number;
  chatType: "direct" | "group";
  chatId: string;
  senderJid?: string;
  senderE164?: string;
  senderName?: string;
  replyToId?: string;
  replyToBody?: string;
  replyToSender?: string;
  replyToSenderJid?: string;
  replyToSenderE164?: string;
  groupSubject?: string;
  groupParticipants?: string[];
  mentionedJids?: string[];
  selfJid?: string | null;
  selfE164?: string | null;
  location?: NormalizedLocation;
  sendComposing: () => Promise<void>;
  reply: (text: string) => Promise<void>;
  sendMedia: (payload: AnyMessageContent) => Promise<void>;
  mediaPath?: string;
  mediaType?: string;
  mediaFileName?: string;
  mediaUrl?: string;
  wasMentioned?: boolean;
};
