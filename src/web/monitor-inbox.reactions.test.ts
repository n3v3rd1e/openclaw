import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ACCOUNT_ID,
  getAuthDir,
  getSock,
  installWebMonitorInboxUnitTestHooks,
} from "./monitor-inbox.test-harness.js";

installWebMonitorInboxUnitTestHooks();

describe("web monitor inbox reactions", () => {
  it("invokes onReaction for inbound reaction messages", async () => {
    const sock = getSock();
    const onMessage = vi.fn();
    const onReaction = vi.fn();

    const { monitorWebInbox } = await import("./inbound.js");
    await monitorWebInbox({
      verbose: false,
      accountId: DEFAULT_ACCOUNT_ID,
      authDir: getAuthDir(),
      onMessage,
      onReaction,
    });

    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: {
            remoteJid: "5511999990000@s.whatsapp.net",
            id: "reaction-msg-1",
            fromMe: false,
          },
          messageTimestamp: 1700000000,
          pushName: "Alice",
          message: {
            reactionMessage: {
              key: {
                remoteJid: "5511999990000@s.whatsapp.net",
                id: "original-msg-1",
                fromMe: true,
              },
              text: "❤️",
            },
          },
        },
      ],
    });

    // Give the async handler time to process
    await new Promise((r) => setTimeout(r, 50));

    expect(onReaction).toHaveBeenCalledTimes(1);
    const reaction = onReaction.mock.calls[0][0];
    expect(reaction.emoji).toBe("❤️");
    expect(reaction.isRemoval).toBe(false);
    expect(reaction.targetMessageId).toBe("original-msg-1");
    expect(reaction.targetFromMe).toBe(true);
    expect(reaction.senderName).toBe("Alice");
    expect(reaction.accountId).toBe(DEFAULT_ACCOUNT_ID);

    // Should NOT have been forwarded as a normal message
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("detects reaction removals (empty text)", async () => {
    const sock = getSock();
    const onReaction = vi.fn();

    const { monitorWebInbox } = await import("./inbound.js");
    await monitorWebInbox({
      verbose: false,
      accountId: DEFAULT_ACCOUNT_ID,
      authDir: getAuthDir(),
      onMessage: vi.fn(),
      onReaction,
    });

    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: {
            remoteJid: "5511999990000@s.whatsapp.net",
            id: "reaction-msg-2",
            fromMe: false,
          },
          messageTimestamp: 1700000001,
          message: {
            reactionMessage: {
              key: {
                remoteJid: "5511999990000@s.whatsapp.net",
                id: "original-msg-1",
                fromMe: true,
              },
              text: "",
            },
          },
        },
      ],
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(onReaction).toHaveBeenCalledTimes(1);
    expect(onReaction.mock.calls[0][0].isRemoval).toBe(true);
    expect(onReaction.mock.calls[0][0].emoji).toBe("");
  });

  it("handles ephemeral reaction messages", async () => {
    const sock = getSock();
    const onReaction = vi.fn();

    const { monitorWebInbox } = await import("./inbound.js");
    await monitorWebInbox({
      verbose: false,
      accountId: DEFAULT_ACCOUNT_ID,
      authDir: getAuthDir(),
      onMessage: vi.fn(),
      onReaction,
    });

    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: {
            remoteJid: "5511999990000@s.whatsapp.net",
            id: "reaction-msg-3",
            fromMe: false,
          },
          messageTimestamp: 1700000002,
          pushName: "Bob",
          message: {
            ephemeralMessage: {
              message: {
                reactionMessage: {
                  key: {
                    remoteJid: "5511999990000@s.whatsapp.net",
                    id: "original-msg-2",
                    fromMe: false,
                  },
                  text: "👍",
                },
              },
            },
          },
        },
      ],
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(onReaction).toHaveBeenCalledTimes(1);
    expect(onReaction.mock.calls[0][0].emoji).toBe("👍");
    expect(onReaction.mock.calls[0][0].targetFromMe).toBe(false);
  });

  it("skips reactions when onReaction is not provided", async () => {
    const sock = getSock();
    const onMessage = vi.fn();

    const { monitorWebInbox } = await import("./inbound.js");
    await monitorWebInbox({
      verbose: false,
      accountId: DEFAULT_ACCOUNT_ID,
      authDir: getAuthDir(),
      onMessage,
      // no onReaction
    });

    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: {
            remoteJid: "5511999990000@s.whatsapp.net",
            id: "reaction-msg-4",
            fromMe: false,
          },
          messageTimestamp: 1700000003,
          message: {
            reactionMessage: {
              key: {
                remoteJid: "5511999990000@s.whatsapp.net",
                id: "original-msg-3",
                fromMe: true,
              },
              text: "😂",
            },
          },
        },
      ],
    });

    await new Promise((r) => setTimeout(r, 50));

    // Reaction messages should not appear as normal messages
    expect(onMessage).not.toHaveBeenCalled();
  });
});
