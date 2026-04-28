import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stateDir = "/tmp/openclaw-discord-rest-backfill-test";

vi.mock("openclaw/plugin-sdk/state-paths", () => ({
  resolveStateDir: () => stateDir,
}));

import { rm } from "node:fs/promises";
import { startDiscordRestBackfill } from "./rest-backfill.js";

const TEST_NOW_MS = 4_102_444_800_000;

function snowflake(offset: number): string {
  return String((BigInt(TEST_NOW_MS + offset) - 1_420_070_400_000n) << 22n);
}

function makeMessage(id: string, channelId = "1475115432770932876") {
  return {
    id,
    channel_id: channelId,
    content: "hello",
    timestamp: new Date().toISOString(),
    type: 0,
    author: { id: "u1", username: "Alex", discriminator: "0" },
    attachments: [],
    embeds: [],
    mentions: [],
    mention_roles: [],
    mention_everyone: false,
  };
}

describe("Discord REST backfill", () => {
  beforeEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it("polls configured channels and dispatches missed user messages once", async () => {
    const get = vi.fn(async () => [makeMessage(snowflake(2_000)), makeMessage(snowflake(1_000))]);
    const handler = vi.fn(async () => undefined);
    const handle = startDiscordRestBackfill({
      accountId: "default",
      client: { rest: { get } } as never,
      runtime: { error: vi.fn(), log: vi.fn() } as never,
      discordConfig: { backfill: { intervalMs: 10, startupLookbackMs: Date.now() + 60_000 } },
      guildEntries: { 1475113795901718703: { channels: { 1475115432770932876: {} } } },
      messageHandler: handler,
    });

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    expect(handler.mock.calls.map((call) => call[0].message.id)).toEqual([
      snowflake(1_000),
      snowflake(2_000),
    ]);

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(handler).toHaveBeenCalledTimes(2);
    handle?.stop();
  });

  it("skips bot-own messages while advancing the watermark", async () => {
    const get = vi.fn(async () => [
      makeMessage(snowflake(1_000)),
      {
        ...makeMessage(snowflake(2_000)),
        author: { id: "bot", username: "Quill", discriminator: "0" },
      },
    ]);
    const handler = vi.fn(async () => undefined);
    const handle = startDiscordRestBackfill({
      accountId: "default",
      client: { rest: { get } } as never,
      runtime: { error: vi.fn(), log: vi.fn() } as never,
      discordConfig: { backfill: { intervalMs: 10, startupLookbackMs: Date.now() + 60_000 } },
      guildEntries: { 1475113795901718703: { channels: { 1475115432770932876: {} } } },
      botUserId: "bot",
      messageHandler: handler,
    });

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(handler.mock.calls[0][0].message.id).toBe(snowflake(1_000));
    handle?.stop();
  });
});
