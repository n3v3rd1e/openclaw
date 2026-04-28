import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Client } from "@buape/carbon";
import { ChannelType, Routes, type APIChannel, type APIMessage } from "discord-api-types/v10";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import type { DiscordGuildEntryResolved } from "./allow-list.js";
import type { DiscordMessageEvent, DiscordMessageHandler } from "./listeners.js";

const DISCORD_EPOCH_MS = 1_420_070_400_000n;
const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_LIMIT = 25;

export type DiscordRestBackfillHandle = {
  stop: () => void;
};

type DiscordRestBackfillState = {
  channels: Record<string, string>;
};

type RestClient = {
  get?: (route: string, params?: Record<string, string | number>) => Promise<unknown>;
};

type BackfillConfig = {
  enabled?: boolean;
  intervalMs?: number;
  limit?: number;
  startupLookbackMs?: number;
  channels?: string[];
};

function readBackfillConfig(discordConfig: unknown): BackfillConfig {
  const value = (discordConfig as { backfill?: unknown } | undefined)?.backfill;
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as BackfillConfig;
}

function normalizePositiveInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(value), 1), max);
}

function snowflakeFromTimestampMs(timestampMs: number): string {
  const clamped = Math.max(0, Math.floor(timestampMs));
  return String((BigInt(clamped) - DISCORD_EPOCH_MS) << 22n);
}

function compareSnowflake(a: string | undefined, b: string | undefined): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  try {
    const ai = BigInt(a);
    const bi = BigInt(b);
    return ai === bi ? 0 : ai > bi ? 1 : -1;
  } catch {
    return a.localeCompare(b);
  }
}

function isTextReadableChannel(channel: APIChannel): boolean {
  return (
    channel.type === ChannelType.GuildText ||
    channel.type === ChannelType.GuildAnnouncement ||
    channel.type === ChannelType.PublicThread ||
    channel.type === ChannelType.PrivateThread ||
    channel.type === ChannelType.AnnouncementThread
  );
}

function normalizeChannelIds(values: Iterable<unknown>): string[] {
  const ids = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      ids.add(trimmed);
    }
  }
  return [...ids];
}

function resolveConfiguredChannelIds(params: {
  guildEntries?: Record<string, DiscordGuildEntryResolved>;
  groupDmChannels?: string[];
  extraChannels?: string[];
  channelGuildIds?: Map<string, string>;
}): string[] {
  const values: unknown[] = [...(params.groupDmChannels ?? []), ...(params.extraChannels ?? [])];
  for (const [guildId, guild] of Object.entries(params.guildEntries ?? {})) {
    const channelKeys = Object.keys(guild.channels ?? {});
    values.push(...channelKeys);
    if (/^\d+$/.test(guildId)) {
      for (const channelId of normalizeChannelIds(channelKeys)) {
        params.channelGuildIds?.set(channelId, guildId);
      }
    }
  }
  return normalizeChannelIds(values);
}

async function resolveGuildBackfillChannelIds(params: {
  rest: RestClient;
  guildEntries?: Record<string, DiscordGuildEntryResolved>;
  channelGuildIds?: Map<string, string>;
}): Promise<string[]> {
  const ids = new Set<string>();
  if (typeof params.rest.get !== "function") {
    return [];
  }
  for (const [guildId, guild] of Object.entries(params.guildEntries ?? {})) {
    if (!/^\d+$/.test(guildId)) {
      continue;
    }
    const channelKeys = Object.keys(guild.channels ?? {});
    const needsGuildListing = channelKeys.length === 0 || channelKeys.includes("*");
    if (!needsGuildListing) {
      continue;
    }
    try {
      const channels = (await params.rest.get(Routes.guildChannels(guildId))) as APIChannel[];
      for (const channel of channels) {
        if (channel?.id && isTextReadableChannel(channel)) {
          ids.add(channel.id);
          params.channelGuildIds?.set(channel.id, guildId);
        }
      }
    } catch (err) {
      logVerbose(`discord backfill: failed to list guild ${guildId} channels: ${String(err)}`);
    }
  }
  return [...ids];
}

function statePath(accountId: string): string {
  return path.join(resolveStateDir(process.env), "discord", "rest-backfill", `${accountId}.json`);
}

async function readState(accountId: string): Promise<DiscordRestBackfillState> {
  try {
    const raw = await readFile(statePath(accountId), "utf8");
    const parsed = JSON.parse(raw) as Partial<DiscordRestBackfillState>;
    return {
      channels: parsed.channels && typeof parsed.channels === "object" ? parsed.channels : {},
    };
  } catch {
    return { channels: {} };
  }
}

async function writeState(accountId: string, state: DiscordRestBackfillState): Promise<void> {
  const file = statePath(accountId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state, null, 2));
}

function messageToEvent(message: APIMessage, guildId?: string): DiscordMessageEvent {
  const author = {
    ...message.author,
    globalName: message.author.global_name ?? undefined,
  } as DiscordMessageEvent["author"];
  const referencedMessage = message.referenced_message
    ? ({
        ...message.referenced_message,
        author: message.referenced_message.author
          ? {
              ...message.referenced_message.author,
              globalName: message.referenced_message.author.global_name ?? undefined,
            }
          : undefined,
        mentionedUsers: (message.referenced_message.mentions ?? []).map((mention) => ({
          ...mention,
          globalName: mention.global_name ?? undefined,
        })),
        mentionedRoles: message.referenced_message.mention_roles ?? [],
        mentionedEveryone: message.referenced_message.mention_everyone ?? false,
      } as unknown)
    : undefined;
  const syntheticMessage = {
    ...message,
    author,
    channelId: message.channel_id,
    mentionedUsers: (message.mentions ?? []).map((mention) => ({
      ...mention,
      globalName: mention.global_name ?? undefined,
    })),
    mentionedRoles: message.mention_roles ?? [],
    mentionedEveryone: message.mention_everyone ?? false,
    referencedMessage,
    stickers: message.sticker_items ?? [],
    rawData: message,
  } as DiscordMessageEvent["message"];
  return {
    message: syntheticMessage,
    author,
    channel_id: message.channel_id,
    guild_id: guildId,
    member: (message as { member?: unknown }).member as DiscordMessageEvent["member"],
    rawMember: (message as { member?: unknown }).member as DiscordMessageEvent["rawMember"],
    guild: undefined,
  } as DiscordMessageEvent;
}

export function startDiscordRestBackfill(params: {
  accountId: string;
  client: Client;
  runtime: RuntimeEnv;
  discordConfig: unknown;
  guildEntries?: Record<string, DiscordGuildEntryResolved>;
  groupDmChannels?: string[];
  botUserId?: string;
  messageHandler: DiscordMessageHandler;
  trackInboundEvent?: () => void;
  abortSignal?: AbortSignal;
}): DiscordRestBackfillHandle | null {
  const config = readBackfillConfig(params.discordConfig);
  if (config.enabled === false) {
    return null;
  }
  const rest = params.client.rest as RestClient | undefined;
  if (typeof rest?.get !== "function") {
    return null;
  }

  const intervalMs = normalizePositiveInteger(config.intervalMs, DEFAULT_INTERVAL_MS, 5 * 60_000);
  const limit = normalizePositiveInteger(config.limit, DEFAULT_LIMIT, 100);
  let stopped = false;
  let running = false;
  let timer: NodeJS.Timeout | undefined;
  let state: DiscordRestBackfillState | undefined;
  let channelIds: string[] = [];
  const channelGuildIds = new Map<string, string>();

  const loadChannels = async () => {
    const configured = resolveConfiguredChannelIds({
      guildEntries: params.guildEntries,
      groupDmChannels: params.groupDmChannels,
      extraChannels: config.channels,
      channelGuildIds,
    });
    const guildListed = await resolveGuildBackfillChannelIds({
      rest,
      guildEntries: params.guildEntries,
      channelGuildIds,
    });
    channelIds = [...new Set([...configured, ...guildListed])];
    if (channelIds.length > 0) {
      logVerbose(`discord backfill: watching ${channelIds.length} channel(s)`);
    }
  };

  const tick = async () => {
    if (stopped || running || params.abortSignal?.aborted) {
      return;
    }
    running = true;
    try {
      state ??= await readState(params.accountId);
      if (channelIds.length === 0) {
        await loadChannels();
      }
      const nowSeed = snowflakeFromTimestampMs(Date.now() - (config.startupLookbackMs ?? 0));
      let changed = false;
      for (const channelId of channelIds) {
        const after = state.channels[channelId] ?? nowSeed;
        if (!state.channels[channelId]) {
          state.channels[channelId] = after;
          changed = true;
        }
        const messages = (await rest.get!(Routes.channelMessages(channelId), {
          limit,
          after,
        })) as APIMessage[];
        if (!Array.isArray(messages) || messages.length === 0) {
          continue;
        }
        const ordered = [...messages].sort((a, b) => compareSnowflake(a.id, b.id));
        for (const message of ordered) {
          if (!message?.id || compareSnowflake(message.id, state.channels[channelId]) <= 0) {
            continue;
          }
          state.channels[channelId] = message.id;
          changed = true;
          if (params.botUserId && message.author?.id === params.botUserId) {
            continue;
          }
          params.trackInboundEvent?.();
          await params.messageHandler(
            messageToEvent(message, channelGuildIds.get(channelId)),
            params.client,
            {
              abortSignal: params.abortSignal,
            },
          );
        }
      }
      if (changed) {
        await writeState(params.accountId, state);
      }
    } catch (err) {
      params.runtime.error?.(danger(`discord backfill failed: ${String(err)}`));
    } finally {
      running = false;
    }
  };

  void loadChannels().catch((err) =>
    params.runtime.error?.(danger(`discord backfill channel discovery failed: ${String(err)}`)),
  );
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();

  params.abortSignal?.addEventListener("abort", () => {
    stopped = true;
    if (timer) clearInterval(timer);
  });

  return {
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}
