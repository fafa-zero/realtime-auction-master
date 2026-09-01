import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import type { AuctionSnapshot } from "./types.js";

const EVENT_CHANNEL = "auction:realtime-events";
const SNAPSHOT_PREFIX = "auction:snapshot";
const INSTANCE_ID = process.env.AUCTION_INSTANCE_ID?.trim() || randomUUID();
const DEFAULT_CACHE_TTL_SECONDS = 15;

export interface RealtimeEventEnvelope {
  id: string;
  origin: string;
  liveRoomId: string;
  type: string;
  payload: unknown;
  createdAt: number;
}

type RemoteEventHandler = (event: RealtimeEventEnvelope) => void;
type RedisConnection = ReturnType<typeof createRedisClient>;

let commandClient: RedisConnection | null = null;
let subscriberClient: RedisConnection | null = null;
let redisReady = false;

export async function initializeRedisInfrastructure(onRemoteEvent: RemoteEventHandler) {
  const redisUrl = process.env.REDIS_URL?.trim();

  if (!redisUrl) {
    return false;
  }

  const publisher = createRedisClient(redisUrl);
  const subscriber = publisher.duplicate();

  try {
    await Promise.all([publisher.connect(), subscriber.connect()]);
    await subscriber.subscribe(EVENT_CHANNEL, (raw) => {
      const event = parseRealtimeEvent(raw);

      if (event && event.origin !== INSTANCE_ID) {
        onRemoteEvent(event);
      }
    });
    commandClient = publisher;
    subscriberClient = subscriber;
    redisReady = true;
    console.log("Redis event bridge and snapshot cache are enabled");
    return true;
  } catch (error) {
    redisReady = false;
    await closeClient(publisher);
    await closeClient(subscriber);
    console.warn(`Redis 实时能力不可用，已回退单实例模式：${getErrorMessage(error)}`);
    return false;
  }
}

export async function publishRealtimeEvent(liveRoomId: string, type: string, payload: unknown) {
  if (!redisReady || !commandClient) {
    return false;
  }

  const event: RealtimeEventEnvelope = {
    id: randomUUID(),
    origin: INSTANCE_ID,
    liveRoomId,
    type,
    payload,
    createdAt: Date.now()
  };

  try {
    const snapshot = extractSnapshot(payload);
    const operations: Promise<unknown>[] = [commandClient.publish(EVENT_CHANNEL, JSON.stringify(event))];

    if (snapshot) {
      operations.push(cacheAuctionSnapshot(liveRoomId, snapshot));
    }

    await Promise.all(operations);
    return true;
  } catch (error) {
    console.warn(`Redis 事件发布失败，已保留本地广播：${getErrorMessage(error)}`);
    return false;
  }
}

export async function cacheAuctionSnapshot(liveRoomId: string, snapshot: unknown) {
  if (!redisReady || !commandClient) {
    return false;
  }

  try {
    await commandClient.set(snapshotKey(liveRoomId), JSON.stringify(snapshot), {
      EX: getSnapshotTtlSeconds()
    });
    return true;
  } catch (error) {
    console.warn(`Redis 快照写入失败，已继续使用本地状态：${getErrorMessage(error)}`);
    return false;
  }
}

export async function getCachedAuctionSnapshot<T>(liveRoomId: string): Promise<T | null> {
  if (!redisReady || !commandClient) {
    return null;
  }

  try {
    const raw = await commandClient.get(snapshotKey(liveRoomId));
    return raw ? (JSON.parse(raw) as T) : null;
  } catch (error) {
    console.warn(`Redis 快照读取失败，已继续使用本地状态：${getErrorMessage(error)}`);
    return null;
  }
}

export async function getAuctionSnapshotForRead(
  liveRoomId: string,
  getLocalSnapshot: () => AuctionSnapshot
): Promise<AuctionSnapshot> {
  if (!isSnapshotCacheReadsEnabled()) {
    return getLocalSnapshot();
  }

  const cached = await getCachedAuctionSnapshot<unknown>(liveRoomId);
  return isAuctionSnapshotForRoom(cached, liveRoomId) ? cached : getLocalSnapshot();
}

export async function closeRedisInfrastructure() {
  redisReady = false;
  const publisher = commandClient;
  const subscriber = subscriberClient;
  commandClient = null;
  subscriberClient = null;
  await Promise.all([closeClient(publisher), closeClient(subscriber)]);
}

export function parseRealtimeEvent(raw: string): RealtimeEventEnvelope | null {
  try {
    const value = JSON.parse(raw) as Partial<RealtimeEventEnvelope>;
    if (
      typeof value.id !== "string" ||
      typeof value.origin !== "string" ||
      typeof value.liveRoomId !== "string" ||
      typeof value.type !== "string" ||
      typeof value.createdAt !== "number"
    ) {
      return null;
    }
    return value as RealtimeEventEnvelope;
  } catch {
    return null;
  }
}

export function snapshotKey(liveRoomId: string) {
  return `${SNAPSHOT_PREFIX}:${liveRoomId}`;
}

export function extractSnapshot(payload: unknown): unknown | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (isRecord(payload.auction) && isRecord(payload.product) && Array.isArray(payload.bids)) {
    return payload;
  }
  const nested = payload.snapshot;
  if (isRecord(nested) && isRecord(nested.auction) && isRecord(nested.product) && Array.isArray(nested.bids)) {
    return nested;
  }
  return null;
}

export function isAuctionSnapshotForRoom(value: unknown, liveRoomId: string): value is AuctionSnapshot {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isRecord(value.auction) &&
    value.auction.liveRoomId === liveRoomId &&
    isRecord(value.product) &&
    Array.isArray(value.bids) &&
    (value.order === null || isRecord(value.order)) &&
    typeof value.participantCount === "number" &&
    typeof value.serverTime === "number"
  );
}

export function isSnapshotCacheReadsEnabled() {
  return process.env.REDIS_SNAPSHOT_CACHE_READS?.trim().toLowerCase() === "true";
}

function createRedisClient(redisUrl: string) {
  const client = createClient({
    url: redisUrl,
    socket: {
      connectTimeout: 800,
      reconnectStrategy: false
    }
  });
  client.on("error", (error) => {
    console.warn(`Redis 客户端错误：${getErrorMessage(error)}`);
  });
  return client;
}

function getSnapshotTtlSeconds() {
  const configured = Number(process.env.REDIS_SNAPSHOT_TTL_SECONDS ?? DEFAULT_CACHE_TTL_SECONDS);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_CACHE_TTL_SECONDS;
}

async function closeClient(client: RedisConnection | null) {
  if (!client?.isOpen) {
    return;
  }
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "未知错误";
}
