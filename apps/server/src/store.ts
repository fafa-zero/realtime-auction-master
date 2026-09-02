import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import "./env.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { completeWithModel } from "./ai.js";
import {
  isMysqlPersistenceConfigured,
  loadMysqlState,
  saveMysqlState,
  type PersistedAuctionState
} from "./mysqlPersistence.js";
import type {
  AuditLog,
  Auction,
  AuctionHistoryItem,
  AuctionSnapshot,
  Bid,
  LiveRoom,
  Order,
  Product,
  ProductQueueStatus,
  Session,
  User,
  BidRisk,
  DanmakuBlockedUser,
  DanmakuMessage
} from "./types.js";

const DATA_FILE = resolve(process.env.AUCTION_DATA_FILE ?? "data/auction-state.json");
const DEFAULT_LIVE_ROOM_ID = "live-1";
const DEMO_HOST_USER_ID = "user-demo-host";
const DEFAULT_JEWELRY_IMAGE_URL = "/static/jewelry.jpg";
const DEFAULT_WATCH_IMAGE_URL = "/static/watch.jpg";
const PASSWORD_HASH_PREFIX = "scrypt";
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_KEY_BYTES = 64;
let mysqlPersistenceReady = false;
let mysqlPersistenceDisabled = false;
let pendingPersistenceSave: Promise<void> = Promise.resolve();

const products: Product[] = createDefaultProducts();
const liveRooms: LiveRoom[] = createDefaultLiveRooms();
const auctions: Auction[] = createDefaultAuctions();

const bids: Bid[] = [];
const processedBidRequestIds = new Map<string, Bid>();
const history: AuctionHistoryItem[] = [];
const orders: Order[] = [];
const users: User[] = [];
const sessions: Session[] = [];
const danmakuMessages: DanmakuMessage[] = [];
const danmakuBlockedUsers: DanmakuBlockedUser[] = [];
const auditLogs: AuditLog[] = [];
const danmakuRateLimits = new Map<string, number[]>();

loadState();
ensureDemoWebAccounts();
ensureDemoLiveRoomOwnership();
ensureLocalDemoProductImages();
rebuildProcessedBidRequestIds();

export interface StartAuctionOptions {
  durationSeconds?: number;
  ceilingPrice?: number;
  incrementStep?: number;
  productId?: string;
}

export interface MiniprogramAuthInput {
  code?: string;
  mockCode?: string;
  openId?: string;
  nickname?: string;
  avatarUrl?: string;
}

export interface LoginWebInput {
  account: string;
  password: string;
}

export interface RegisterWebInput extends LoginWebInput {
  nickname?: string;
  role?: "BUYER" | "HOST";
}

export interface ProductImportRow {
  name: string;
  description: string;
  imageUrl?: string;
  startPrice: number;
  incrementStep: number;
  ceilingPrice: number;
  durationSeconds: number;
  stock?: number;
  sellingPoints?: string;
  scriptKeywords?: string;
}

export type ProductManageInput = ProductImportRow;

export interface AuditLogInput {
  userId: string;
  userNickname: string;
  role: AuditLog["role"];
  liveRoomId?: string;
  action: string;
  targetId?: string;
  detail?: Record<string, unknown>;
}

export async function initializePersistence() {
  if (!isMysqlPersistenceConfigured()) {
    return;
  }

  try {
    const data = await loadMysqlState();
    mysqlPersistenceReady = true;

    if (data) {
      applyPersistedState(data);
      ensureDemoWebAccounts();
      ensureDemoLiveRoomOwnership();
      ensureLocalDemoProductImages();
      rebuildProcessedBidRequestIds();
    }

    saveState();
    await flushPersistence();
    console.log("MySQL persistence is enabled");
  } catch (error) {
    mysqlPersistenceDisabled = true;
    console.warn(`MySQL 持久化不可用，已回落本地 JSON：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

export async function flushPersistence() {
  await pendingPersistenceSave;
}

export interface CreateLiveRoomInput {
  ownerUserId: string;
  title: string;
  hostName?: string;
  productName: string;
  productDescription: string;
  startPrice: number;
  incrementStep: number;
  ceilingPrice: number;
  durationSeconds: number;
  stock?: number;
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RISK_RECENT_WINDOW_MS = 20_000;
const RISK_PENDING_ORDER_LIMIT = 2;
const RISK_HIGH_FREQUENCY_BID_LIMIT = 5;
const RISK_REPEAT_BID_LIMIT = 3;
const RISK_LARGE_JUMP_MULTIPLIER = 5;
const RISK_EXTREME_JUMP_MULTIPLIER = 10;
const DANMAKU_HISTORY_LIMIT = 80;
const AUDIT_LOG_LIMIT = 1_000;
const DANMAKU_RATE_LIMIT_WINDOW_MS = 10_000;
const DANMAKU_RATE_LIMIT_COUNT = 5;
const DANMAKU_SENSITIVE_WORDS = ["假货", "骗子", "诈骗", "刷单", "加微信", "私聊"];

function createDefaultProducts(): Product[] {
  return [
    {
      id: "product-1",
      name: "天然翡翠吊坠",
      imageUrl: DEFAULT_JEWELRY_IMAGE_URL,
      description: "好物专场演示商品，适合用于演示实时互动、价格更新和订单确认流程。",
      stock: 1
    },
    {
      id: "product-2",
      name: "复古机械腕表",
      imageUrl: DEFAULT_WATCH_IMAGE_URL,
      description: "第二个好物专场演示商品，用于验证多专场状态隔离和用户入口切换。",
      stock: 1
    }
  ];
}

function createDefaultLiveRooms(): LiveRoom[] {
  return [
    {
      id: "live-1",
      title: "珠宝严选好物专场",
      hostName: "小雅",
      streamUrl: "https://example.com/mock/jewelry-live.m3u8",
      viewerCount: 1286,
      currentAuctionId: "auction-1",
      ownerUserId: DEMO_HOST_USER_ID
    },
    {
      id: "live-2",
      title: "腕表收藏好物专场",
      hostName: "阿辰",
      streamUrl: "https://example.com/mock/watch-live.m3u8",
      viewerCount: 842,
      currentAuctionId: "auction-2",
      ownerUserId: DEMO_HOST_USER_ID
    }
  ];
}

function createDefaultAuctions(): Auction[] {
  return [
    createSeedAuction({
      id: "auction-1",
      liveRoomId: "live-1",
      productId: "product-1",
      incrementStep: 100,
      ceilingPrice: 3000,
      durationSeconds: 90
    }),
    createSeedAuction({
      id: "auction-2",
      liveRoomId: "live-2",
      productId: "product-2",
      incrementStep: 200,
      ceilingPrice: 8800,
      durationSeconds: 120
    })
  ];
}

export function getLiveRooms() {
  return liveRooms.map((room) => enrichLiveRoom(room));
}

export function getLiveRoom(liveRoomId = DEFAULT_LIVE_ROOM_ID) {
  return enrichLiveRoom(requireLiveRoom(liveRoomId));
}

export function recordLiveRoomView(liveRoomId = DEFAULT_LIVE_ROOM_ID) {
  const liveRoom = requireLiveRoom(liveRoomId);
  liveRoom.viewerCount += 1;
  return enrichLiveRoom(liveRoom);
}

export function getLiveRoomsForHost(userId: string) {
  return getLiveRooms().filter((room) => room.ownerUserId === userId);
}

export function getUserByAccount(account: string) {
  const normalized = normalizeAccount(account);
  const user = users.find((item) => item.account === normalized);

  return user ? sanitizeUser(user) : null;
}

export function getAuction(liveRoomId = DEFAULT_LIVE_ROOM_ID) {
  return requireAuctionForLiveRoom(liveRoomId);
}

export function getSnapshot(liveRoomId = DEFAULT_LIVE_ROOM_ID): AuctionSnapshot {
  const liveRoom = requireLiveRoom(liveRoomId);
  const auction = requireAuction(liveRoom.currentAuctionId);
  const auctionBids = getAuctionBids(auction.id);
  const order = getCurrentOrder(auction.id);

  return {
    product: cloneProductWithQueueStatus(requireProduct(auction.productId), auction),
    auction: { ...auction },
    bids: auctionBids.slice(0, 30),
    order: order ? { ...order } : null,
    participantCount: getParticipantCount(auction.id),
    serverTime: Date.now()
  };
}

export function getAuctionHistory(liveRoomId?: string) {
  return history
    .filter((item) => !liveRoomId || item.auction.liveRoomId === liveRoomId)
    .slice(0, 20)
    .map(cloneHistoryItem);
}

export function getOrders(liveRoomId?: string) {
  const orderMap = new Map<string, Order>();

  for (const item of orders) {
    orderMap.set(item.id, item);
  }

  for (const item of history) {
    if (item.order) {
      orderMap.set(item.order.id, item.order);
    }
  }

  return [...orderMap.values()]
    .filter((item) => !liveRoomId || item.liveRoomId === liveRoomId)
    .map((item) => ({ ...item }));
}

export function getBidCount(liveRoomId?: string) {
  if (!liveRoomId) {
    return bids.length;
  }

  const roomAuctionIds = new Set(
    auctions.filter((auction) => auction.liveRoomId === liveRoomId).map((auction) => auction.id)
  );

  return bids.filter((bid) => roomAuctionIds.has(bid.auctionId)).length;
}

export function getOrdersForUser(userId: string, liveRoomId?: string) {
  return getOrders(liveRoomId).filter((order) => order.buyerUserId === userId);
}

export function createLiveRoom(input: CreateLiveRoomInput) {
  const normalized = normalizeProductImportRow({
    name: input.productName,
    description: input.productDescription,
    imageUrl: getDefaultProductImageUrl(input.productName, input.title),
    startPrice: input.startPrice,
    incrementStep: input.incrementStep,
    ceilingPrice: input.ceilingPrice,
    durationSeconds: input.durationSeconds,
    stock: input.stock ?? 1
  });
  const roomId = `live-${randomUUID()}`;
  const productId = `product-${randomUUID()}`;
  const auctionId = `auction-${randomUUID()}`;
  const owner = users.find((user) => user.id === input.ownerUserId);
  const liveRoom: LiveRoom = {
    id: roomId,
    title: input.title.trim() || `${normalized.name}直播间`,
    hostName: input.hostName?.trim() || owner?.nickname || "新主播",
    streamUrl: `https://example.com/mock/${roomId}.m3u8`,
    viewerCount: 0,
    currentAuctionId: auctionId,
    ownerUserId: input.ownerUserId,
    createdAt: Date.now()
  };
  const product: Product = {
    id: productId,
    liveRoomId: roomId,
    name: normalized.name,
    imageUrl: normalized.imageUrl ?? getDefaultProductImageUrl(normalized.name, liveRoom.title),
    description: normalized.description,
    startPrice: normalized.startPrice,
    incrementStep: normalized.incrementStep,
    ceilingPrice: normalized.ceilingPrice,
    durationSeconds: normalized.durationSeconds,
    stock: normalized.stock,
    queueStatus: "QUEUED",
    importedAt: Date.now()
  };
  const auction = createSeedAuction({
    id: auctionId,
    liveRoomId: roomId,
    productId,
    startPrice: normalized.startPrice,
    incrementStep: normalized.incrementStep,
    ceilingPrice: normalized.ceilingPrice,
    durationSeconds: normalized.durationSeconds
  });

  liveRooms.push(liveRoom);
  products.push(product);
  auctions.push(auction);
  saveState();

  return {
    room: enrichLiveRoom(liveRoom),
    snapshot: getSnapshot(roomId)
  };
}

export function getDanmakuMessages(liveRoomId = DEFAULT_LIVE_ROOM_ID) {
  requireLiveRoom(liveRoomId);

  return danmakuMessages
    .filter((message) => isVisibleDanmakuMessage(message, liveRoomId))
    .slice(0, DANMAKU_HISTORY_LIMIT)
    .map((message) => ({ ...message }));
}

export function getDanmakuBlockedUsers(liveRoomId = DEFAULT_LIVE_ROOM_ID) {
  requireLiveRoom(liveRoomId);

  return danmakuBlockedUsers
    .filter((item) => item.liveRoomId === liveRoomId)
    .sort((a, b) => b.blockedAt - a.blockedAt)
    .map((item) => ({ ...item }));
}

export function getAuditLogs(liveRoomId?: string, limit = 20) {
  if (liveRoomId) {
    requireLiveRoom(liveRoomId);
  }

  return auditLogs
    .filter((item) => !liveRoomId || item.liveRoomId === liveRoomId)
    .slice(0, limit)
    .map(cloneAuditLog);
}

export function recordAuditLog(input: AuditLogInput) {
  if (input.liveRoomId) {
    requireLiveRoom(input.liveRoomId);
  }

  const log: AuditLog = {
    id: `audit-${randomUUID()}`,
    userId: input.userId,
    userNickname: input.userNickname,
    role: input.role,
    liveRoomId: input.liveRoomId,
    action: input.action,
    targetId: input.targetId,
    detail: input.detail ? { ...input.detail } : undefined,
    createdAt: Date.now()
  };

  auditLogs.unshift(log);
  auditLogs.splice(AUDIT_LOG_LIMIT);
  saveState();

  return cloneAuditLog(log);
}

export function sendDanmakuMessage(input: {
  liveRoomId: string;
  userId: string;
  nickname: string;
  content: string;
}) {
  requireLiveRoom(input.liveRoomId);
  const content = normalizeDanmakuContent(input.content);
  assertDanmakuUserAllowed(input.liveRoomId, input.userId);
  assertDanmakuRateLimit(input.liveRoomId, input.userId);
  const nickname = input.nickname.trim() || "匿名用户";
  const message: DanmakuMessage = {
    id: randomUUID(),
    liveRoomId: input.liveRoomId,
    userId: input.userId,
    nickname: nickname.slice(0, 40),
    content,
    createdAt: Date.now(),
    status: "VISIBLE"
  };

  danmakuMessages.unshift(message);
  trimDanmakuMessages(input.liveRoomId);
  saveState();

  return { ...message };
}

export function retractDanmakuMessage(input: {
  liveRoomId: string;
  messageId: string;
  moderatorUserId: string;
  reason?: string;
}) {
  requireLiveRoom(input.liveRoomId);
  const message = danmakuMessages.find(
    (item) => item.id === input.messageId && item.liveRoomId === input.liveRoomId
  );

  if (!message) {
    throw new Error("弹幕不存在");
  }

  if ((message.status ?? "VISIBLE") === "RETRACTED") {
    return { ...message };
  }

  message.status = "RETRACTED";
  message.retractedAt = Date.now();
  message.retractedBy = input.moderatorUserId;
  message.retractionReason = input.reason?.trim() || "主播撤回";
  saveState();

  return { ...message };
}

export function blockDanmakuUser(input: {
  liveRoomId: string;
  userId: string;
  nickname: string;
  moderatorUserId: string;
  reason?: string;
}) {
  requireLiveRoom(input.liveRoomId);

  if (input.userId === input.moderatorUserId) {
    throw new Error("不能屏蔽自己");
  }

  const existing = danmakuBlockedUsers.find(
    (item) => item.liveRoomId === input.liveRoomId && item.userId === input.userId
  );
  const blockedUser: DanmakuBlockedUser = {
    liveRoomId: input.liveRoomId,
    userId: input.userId,
    nickname: input.nickname.trim() || input.userId,
    reason: input.reason?.trim() || "主播屏蔽",
    blockedAt: Date.now(),
    blockedBy: input.moderatorUserId
  };

  if (existing) {
    Object.assign(existing, blockedUser);
  } else {
    danmakuBlockedUsers.unshift(blockedUser);
  }

  saveState();

  return { ...blockedUser };
}

export function getOrder(orderId: string) {
  const order = getOrders().find((item) => item.id === orderId);

  if (!order) {
    throw new Error("订单不存在");
  }

  return order;
}

export function registerMiniprogram(input: MiniprogramAuthInput) {
  const openId = getMiniprogramOpenId(input);
  let user = users.find((item) => item.openId === openId);

  if (user?.miniprogramRegisteredAt) {
    throw new Error("买家已注册，请直接登录");
  }

  if (user) {
    updateUserProfile(user, input);
    user.miniprogramRegisteredAt = Date.now();
  } else {
    user = {
      id: `user-${randomUUID()}`,
      openId,
      miniprogramRegisteredAt: Date.now(),
      nickname: input.nickname?.trim() || "小程序用户",
      avatarUrl: input.avatarUrl ?? "",
      role: "BUYER",
      createdAt: Date.now()
    };
    users.push(user);
  }

  saveState();

  return sanitizeUser(user);
}

export function loginMiniprogram(input: MiniprogramAuthInput) {
  const openId = getMiniprogramOpenId(input);
  const user = users.find((item) => item.openId === openId);

  if (!user) {
    throw new Error("买家账号不存在，请先注册");
  }

  if (!user.miniprogramRegisteredAt) {
    throw new Error("买家账号未注册，请先注册");
  }

  updateUserProfile(user, input);
  const session = createSession(user.id);
  removeExpiredSessions();
  saveState();

  return {
    token: session.token,
    expiresAt: session.expiresAt,
    user: sanitizeUser(user)
  };
}

export function registerWebUser(input: RegisterWebInput) {
  const account = normalizeAccount(input.account);
  const password = input.password.trim();

  if (!password) {
    throw new Error("密码不能为空");
  }

  if (users.some((item) => item.account === account)) {
    throw new Error("账号已存在，请直接登录");
  }

  const user: User = {
    id: `user-${randomUUID()}`,
    account,
    password: hashPassword(password),
    nickname: input.nickname?.trim() || account,
    avatarUrl: "",
    role: input.role ?? "HOST",
    createdAt: Date.now()
  };

  users.push(user);
  saveState();

  return sanitizeUser(user);
}

export function loginWebUser(input: LoginWebInput) {
  const account = normalizeAccount(input.account);
  const password = input.password.trim();
  const user = users.find((item) => item.account === account);

  if (!user) {
    throw new Error("账号不存在，请先注册");
  }

  if (!verifyPassword(password, user.password ?? "")) {
    throw new Error("账号或密码错误");
  }

  if (!isPasswordHash(user.password ?? "")) {
    user.password = hashPassword(password);
  }

  const session = createSession(user.id);
  removeExpiredSessions();
  saveState();

  return {
    token: session.token,
    expiresAt: session.expiresAt,
    user: sanitizeUser(user)
  };
}

export function logoutSession(token: string) {
  const index = sessions.findIndex((item) => item.token === token);

  if (index >= 0) {
    sessions.splice(index, 1);
    saveState();
  }

  return { ok: true };
}

export function getUserByToken(token: string) {
  removeExpiredSessions();
  const session = sessions.find((item) => item.token === token);

  if (!session) {
    throw new Error("登录已失效，请重新登录");
  }

  const user = users.find((item) => item.id === session.userId);

  if (!user) {
    throw new Error("用户不存在");
  }

  return sanitizeUser(user);
}

export function updateUserProfileByToken(token: string, input: { nickname?: string; avatarUrl?: string }) {
  const currentUser = getUserByToken(token);
  const user = users.find((item) => item.id === currentUser.id);

  if (!user) {
    throw new Error("用户不存在");
  }

  updateUserProfile(user, input);
  saveState();

  return sanitizeUser(user);
}

export function getProductQueue(liveRoomId = DEFAULT_LIVE_ROOM_ID) {
  requireLiveRoom(liveRoomId);

  return products
    .filter((product) => getProductAuction(product.id, liveRoomId))
    .map((product) => {
      const auction = getProductAuction(product.id, liveRoomId);

      if (!auction) {
        throw new Error("商品竞拍配置不存在");
      }

      return {
        product: cloneProductWithQueueStatus(product, auction),
        auction: { ...auction }
      };
    })
    .sort((a, b) => (a.product.importedAt ?? 0) - (b.product.importedAt ?? 0));
}

export function importAuctionProducts(liveRoomId: string, rows: ProductImportRow[]) {
  const liveRoom = requireLiveRoom(liveRoomId);
  const failedRows: Array<{ rowNumber: number; reason: string }> = [];
  const imported: Product[] = [];

  rows.forEach((row, index) => {
    const rowNumber = index + 2;

    try {
      const normalized = normalizeProductImportRow(row);
      const product: Product = {
        id: `product-${randomUUID()}`,
        liveRoomId,
        imageUrl: normalized.imageUrl ?? getDefaultProductImageUrl(normalized.name, liveRoom.title),
        name: normalized.name,
        description: normalized.description,
        startPrice: normalized.startPrice,
        incrementStep: normalized.incrementStep,
        ceilingPrice: normalized.ceilingPrice,
        durationSeconds: normalized.durationSeconds,
        stock: normalized.stock,
        sellingPoints: normalized.sellingPoints,
        scriptKeywords: normalized.scriptKeywords,
        aiScript: buildLocalProductScript(liveRoom, normalized),
        buyerAiScript: buildLocalBuyerProductScript(normalized),
        aiScriptUpdatedAt: Date.now(),
        queueStatus: "QUEUED",
        importedAt: Date.now() + index
      };
      const auction = createSeedAuction({
        id: `auction-${randomUUID()}`,
        liveRoomId,
        productId: product.id,
        startPrice: normalized.startPrice,
        incrementStep: normalized.incrementStep,
        ceilingPrice: normalized.ceilingPrice,
        durationSeconds: normalized.durationSeconds
      });

      products.push(product);
      auctions.push(auction);
      imported.push(product);
    } catch (error) {
      failedRows.push({ rowNumber, reason: getErrorMessage(error) });
    }
  });

  if (imported.length > 0 || failedRows.length > 0) {
    saveState();
  }

  return {
    ok: true,
    importedCount: imported.length,
    failedRows,
    items: getProductQueue(liveRoomId)
  };
}

export function createAuctionProduct(liveRoomId: string, input: ProductManageInput) {
  const liveRoom = requireLiveRoom(liveRoomId);
  const normalized = normalizeProductImportRow(input);
  const product: Product = {
    id: `product-${randomUUID()}`,
    liveRoomId,
    imageUrl: normalized.imageUrl ?? getDefaultProductImageUrl(normalized.name, liveRoom.title),
    name: normalized.name,
    description: normalized.description,
    startPrice: normalized.startPrice,
    incrementStep: normalized.incrementStep,
    ceilingPrice: normalized.ceilingPrice,
    durationSeconds: normalized.durationSeconds,
    stock: normalized.stock,
    sellingPoints: normalized.sellingPoints,
    scriptKeywords: normalized.scriptKeywords,
    aiScript: buildLocalProductScript(liveRoom, normalized),
    buyerAiScript: buildLocalBuyerProductScript(normalized),
    aiScriptUpdatedAt: Date.now(),
    queueStatus: "QUEUED",
    importedAt: Date.now()
  };
  const auction = createSeedAuction({
    id: `auction-${randomUUID()}`,
    liveRoomId,
    productId: product.id,
    startPrice: normalized.startPrice,
    incrementStep: normalized.incrementStep,
    ceilingPrice: normalized.ceilingPrice,
    durationSeconds: normalized.durationSeconds
  });

  products.push(product);
  auctions.push(auction);
  saveState();

  return {
    ok: true,
    item: getProductQueue(liveRoomId).find((item) => item.product.id === product.id),
    items: getProductQueue(liveRoomId)
  };
}

export function updateAuctionProduct(
  liveRoomId: string,
  productId: string,
  input: Partial<ProductManageInput>
) {
  const liveRoom = requireLiveRoom(liveRoomId);
  const product = requireProduct(productId);
  const auction = requireAuctionForProduct(liveRoomId, productId);

  if (auction.status !== "PENDING") {
    throw new Error("已开始或已结束的商品不能编辑，请新增商品重新配置");
  }

  const merged = normalizeProductImportRow({
    name: input.name ?? product.name,
    description: input.description ?? product.description,
    imageUrl: input.imageUrl !== undefined ? input.imageUrl : product.imageUrl,
    startPrice: input.startPrice ?? product.startPrice ?? auction.startPrice,
    incrementStep: input.incrementStep ?? product.incrementStep ?? auction.incrementStep,
    ceilingPrice: input.ceilingPrice ?? product.ceilingPrice ?? auction.ceilingPrice,
    durationSeconds: input.durationSeconds ?? product.durationSeconds ?? auction.durationSeconds,
    stock: input.stock ?? product.stock ?? 1,
    sellingPoints: input.sellingPoints ?? product.sellingPoints,
    scriptKeywords: input.scriptKeywords ?? product.scriptKeywords
  });

  product.name = merged.name;
  product.description = merged.description;
  product.imageUrl = merged.imageUrl ?? getDefaultProductImageUrl(merged.name, liveRoom.title);
  product.startPrice = merged.startPrice;
  product.incrementStep = merged.incrementStep;
  product.ceilingPrice = merged.ceilingPrice;
  product.durationSeconds = merged.durationSeconds;
  product.stock = merged.stock;
  product.sellingPoints = merged.sellingPoints;
  product.scriptKeywords = merged.scriptKeywords;
  product.aiScript = buildLocalProductScript(liveRoom, merged);
  product.buyerAiScript = buildLocalBuyerProductScript(merged);
  product.aiScriptUpdatedAt = Date.now();

  auction.startPrice = merged.startPrice;
  auction.currentPrice = merged.startPrice;
  auction.incrementStep = merged.incrementStep;
  auction.ceilingPrice = merged.ceilingPrice;
  auction.durationSeconds = merged.durationSeconds;
  saveState();

  return {
    ok: true,
    item: getProductQueue(liveRoomId).find((item) => item.product.id === productId),
    items: getProductQueue(liveRoomId)
  };
}

export function archiveAuctionProduct(liveRoomId: string, productId: string) {
  const auction = requireAuctionForProduct(liveRoomId, productId);

  if (auction.status !== "PENDING") {
    throw new Error("已开始或已结束的商品不能下架");
  }

  setProductQueueStatus(productId, "CANCELLED");
  saveState();

  return {
    ok: true,
    item: getProductQueue(liveRoomId).find((item) => item.product.id === productId),
    items: getProductQueue(liveRoomId)
  };
}

export function reorderAuctionProducts(liveRoomId: string, productIds: string[]) {
  const queue = getProductQueue(liveRoomId);
  const knownIds = new Set(queue.map((item) => item.product.id));

  for (const productId of productIds) {
    if (!knownIds.has(productId)) {
      throw new Error("商品不属于当前直播间");
    }
  }

  const orderedIds = [
    ...productIds,
    ...queue.map((item) => item.product.id).filter((productId) => !productIds.includes(productId))
  ];
  const base = Date.now();

  orderedIds.forEach((productId, index) => {
    requireProduct(productId).importedAt = base + index;
  });
  saveState();

  return {
    ok: true,
    items: getProductQueue(liveRoomId)
  };
}

export function startProductAuction(liveRoomId: string, productId: string) {
  const product = requireProduct(productId);

  if (product.queueStatus === "CANCELLED") {
    throw new Error("已下架商品不能开始竞拍");
  }

  return startAuction(liveRoomId, { productId });
}

export function startAuction(liveRoomIdOrOptions: string | StartAuctionOptions = DEFAULT_LIVE_ROOM_ID, maybeOptions: StartAuctionOptions = {}) {
  const liveRoomId = typeof liveRoomIdOrOptions === "string" ? liveRoomIdOrOptions : DEFAULT_LIVE_ROOM_ID;
  const options = typeof liveRoomIdOrOptions === "string" ? maybeOptions : liveRoomIdOrOptions;
  const liveRoom = requireLiveRoom(liveRoomId);
  const currentAuction = requireAuction(liveRoom.currentAuctionId);
  const auction = options.productId ? requireAuctionForProduct(liveRoomId, options.productId) : currentAuction;

  if (currentAuction.id !== auction.id) {
    if (currentAuction.status === "ACTIVE") {
      throw new Error("当前竞拍进行中，结束后才能开始下一件");
    }

    archiveCurrentAuction(liveRoomId);
    liveRoom.currentAuctionId = auction.id;
  }

  if (auction.status !== "PENDING" && auction.status !== "UNSOLD" && auction.status !== "SOLD" && auction.status !== "CANCELLED") {
    throw new Error("当前专场状态不允许开始");
  }

  archiveCurrentAuction(liveRoomId);

  const latestOrderCreatedAt = orders
    .filter((order) => order.auctionId === auction.id)
    .reduce((latest, order) => Math.max(latest, order.createdAt), 0);
  const now = Math.max(Date.now(), latestOrderCreatedAt + 1);
  removeAuctionBids(auction.id);
  removeProcessedRequestsForAuction(auction.id);

  if (options.durationSeconds !== undefined) {
    auction.durationSeconds = options.durationSeconds;
  }

  if (options.incrementStep !== undefined) {
    auction.incrementStep = options.incrementStep;
  }

  if (options.ceilingPrice !== undefined) {
    auction.ceilingPrice = options.ceilingPrice;
  }

  syncAuctionConfigToProduct(auction);

  if (auction.ceilingPrice < auction.startPrice + auction.incrementStep) {
    throw new Error("封顶价必须高于最低参与金额");
  }

  auction.currentPrice = auction.startPrice;
  auction.startTime = now;
  auction.endTime = now + auction.durationSeconds * 1000;
  auction.extendCount = 0;
  auction.status = "ACTIVE";
  auction.winnerUserId = null;
  auction.winnerNickname = null;
  auction.version += 1;
  setProductQueueStatus(auction.productId, "ACTIVE");
  saveState();

  return getSnapshot(liveRoomId);
}

export function cancelAuction(liveRoomIdOrReason = DEFAULT_LIVE_ROOM_ID, maybeReason = "专场已取消") {
  const liveRoomId = isKnownLiveRoom(liveRoomIdOrReason) ? liveRoomIdOrReason : DEFAULT_LIVE_ROOM_ID;
  const reason = isKnownLiveRoom(liveRoomIdOrReason) ? maybeReason : liveRoomIdOrReason;
  const auction = requireAuctionForLiveRoom(liveRoomId);

  if (auction.status !== "PENDING" && auction.status !== "ACTIVE") {
    throw new Error("当前专场状态不允许取消");
  }

  auction.status = "CANCELLED";
  auction.version += 1;
  setProductQueueStatus(auction.productId, "CANCELLED");
  archiveCurrentAuction(liveRoomId);
  saveState();

  return {
    reason,
    snapshot: getSnapshot(liveRoomId)
  };
}

export function placeBid(input: {
  liveRoomId?: string;
  userId: string;
  nickname: string;
  price: number;
  clientRequestId: string;
}) {
  const liveRoomId = input.liveRoomId ?? DEFAULT_LIVE_ROOM_ID;
  const auction = requireAuctionForLiveRoom(liveRoomId);
  const now = Date.now();

  const bidRequestKey = getBidRequestKey(auction.id, input.userId, input.clientRequestId);
  const previousBid = processedBidRequestIds.get(bidRequestKey);
  if (previousBid) {
    return {
      bid: previousBid,
      extended: false,
      settled: false,
      duplicate: true,
      snapshot: getSnapshot(liveRoomId)
    };
  }

  if (auction.status !== "ACTIVE") {
    throw new Error("专场未开始，无法参与");
  }

  if (!auction.endTime) {
    throw new Error("专场已结束，无法参与");
  }

  if (now >= auction.endTime) {
    throw new Error("专场已结束，无法参与");
  }

  const minPrice = auction.currentPrice + auction.incrementStep;
  if (input.price < minPrice) {
    throw new Error(`金额过低，最低参与金额为 ${minPrice} 元`);
  }

  if (input.price > auction.ceilingPrice) {
    throw new Error(`金额不能超过封顶价 ${auction.ceilingPrice} 元`);
  }

  const risk = assessBidRisk({
    liveRoomId,
    auction,
    userId: input.userId,
    price: input.price,
    now
  });

  if (risk.action === "BLOCK") {
    throw new Error(`出价已被风控拦截：${risk.reasons.join("；")}`);
  }

  const bid: Bid = {
    id: randomUUID(),
    auctionId: auction.id,
    userId: input.userId,
    nickname: input.nickname,
    price: input.price,
    createdAt: now,
    clientRequestId: input.clientRequestId,
    risk: risk.level === "LOW" ? undefined : risk
  };

  bids.push(bid);
  processedBidRequestIds.set(bidRequestKey, bid);

  auction.currentPrice = input.price;
  auction.winnerUserId = input.userId;
  auction.winnerNickname = input.nickname;

  const remainingSeconds = Math.ceil((auction.endTime - now) / 1000);
  const canExtend = auction.extendCount < auction.maxExtendCount;
  const shouldExtend = remainingSeconds <= auction.extendThresholdSeconds && canExtend;

  if (shouldExtend) {
    auction.endTime += auction.extendSeconds * 1000;
    auction.extendCount += 1;
  }

  auction.version += 1;

  let settled = false;
  if (auction.currentPrice >= auction.ceilingPrice) {
    settled = settleAuction(liveRoomId).settled;
  }

  if (!settled) {
    saveState();
  }

  return {
    bid,
    extended: shouldExtend,
    settled,
    duplicate: false,
    snapshot: getSnapshot(liveRoomId)
  };
}

export function settleAuction(liveRoomId = DEFAULT_LIVE_ROOM_ID) {
  const auction = requireAuctionForLiveRoom(liveRoomId);

  if (auction.status !== "ACTIVE") {
    return {
      settled: false,
      snapshot: getSnapshot(liveRoomId)
    };
  }

  auction.version += 1;

  if (auction.winnerUserId && auction.winnerNickname) {
    auction.status = "SOLD";
    setProductQueueStatus(auction.productId, "SOLD");
    const existingOrder = getCurrentOrder(auction.id);

    if (!existingOrder) {
      decreaseProductStock(auction.productId);
      orders.push({
        id: randomUUID(),
        auctionId: auction.id,
        liveRoomId,
        productId: auction.productId,
        buyerUserId: auction.winnerUserId,
        buyerNickname: auction.winnerNickname,
        finalPrice: auction.currentPrice,
        status: "PENDING_PAYMENT",
        createdAt: Math.max(Date.now(), (auction.startTime ?? 0) + 1)
      });
    }
  } else {
    auction.status = "UNSOLD";
    setProductQueueStatus(auction.productId, "UNSOLD");
  }

  archiveCurrentAuction(liveRoomId);
  saveState();

  return {
    settled: true,
    snapshot: getSnapshot(liveRoomId)
  };
}

export function payOrder(orderId: string) {
  const order = orders.find((item) => item.id === orderId);

  if (!order) {
    throw new Error("订单不存在");
  }

  if (order.status !== "PAID") {
    order.status = "PAID";
    syncHistoryOrder(order);
    saveState();
  }

  return { ...order };
}

export async function generateProductScript(liveRoomId = DEFAULT_LIVE_ROOM_ID, productId?: string) {
  const liveRoom = requireLiveRoom(liveRoomId);
  const auction = productId ? requireAuctionForProduct(liveRoomId, productId) : requireAuctionForLiveRoom(liveRoomId);
  const product = requireProduct(auction.productId);
  const productScriptInput = {
    name: product.name,
    description: product.description,
    startPrice: auction.startPrice,
    incrementStep: auction.incrementStep,
    ceilingPrice: auction.ceilingPrice,
    durationSeconds: auction.durationSeconds,
    stock: product.stock ?? 1,
    sellingPoints: product.sellingPoints,
    scriptKeywords: product.scriptKeywords
  };
  const fallbackContent = buildLocalProductScript(liveRoom, productScriptInput);

  const result = await completeWithModel({
    title: "AI 商品讲解词",
    systemPrompt: "你是直播电商主播助理，输出必须简洁、合规、自然，不得承诺保值、收益或绝对效果。",
    userPrompt: `请生成 80 字以内直播讲解词。\n直播间：${liveRoom.title}\n主播：${liveRoom.hostName}\n商品名称：${product.name}\n商品描述：${product.description}\n商品卖点：${product.sellingPoints ?? "未填写"}\n讲解关键词：${product.scriptKeywords ?? "未填写"}\n起拍价：${auction.startPrice}\n最低加价：${auction.incrementStep}\n封顶价：${auction.ceilingPrice}\n竞拍时长：${auction.durationSeconds} 秒\n库存：${product.stock ?? 1} 件`,
    fallbackContent
  });

  product.aiScript = result.content;
  product.buyerAiScript = buildLocalBuyerProductScript(productScriptInput);
  product.aiScriptUpdatedAt = result.generatedAt;
  saveState();

  return {
    ...result,
    product: cloneProductWithQueueStatus(product, auction)
  };
}

export async function generateAuctionSummary(liveRoomId = DEFAULT_LIVE_ROOM_ID) {
  const liveRoom = requireLiveRoom(liveRoomId);
  const auction = requireAuctionForLiveRoom(liveRoomId);
  const product = requireProduct(auction.productId);
  const auctionBids = getAuctionBids(auction.id);
  const order = getCurrentOrder(auction.id);
  const bidCount = auctionBids.length;
  const statusText = {
    PENDING: "待开始",
    ACTIVE: "竞拍中",
    SOLD: "已成交",
    UNSOLD: "已流拍",
    CANCELLED: "已取消"
  } satisfies Record<typeof auction.status, string>;

  const result =
    auction.status === "SOLD" && order
      ? `本场竞拍由 ${order.buyerNickname} 以 ${order.finalPrice} 元成交。`
      : `本场竞拍当前状态为${statusText[auction.status]}。`;

  const fallbackContent = `${liveRoom.title}：${result}共有 ${getParticipantCount(auction.id)} 位用户参与，累计 ${bidCount} 次有效出价，触发 ${auction.extendCount} 次自动延时。建议主播复盘出价高峰时间和用户互动节奏，用于优化下一场竞拍讲解。`;

  return completeWithModel({
    title: "AI 竞拍复盘",
    systemPrompt: "你是直播电商运营分析助手，输出要简短、客观，给出可执行建议。",
    userPrompt: `请生成一段竞拍复盘。\n直播间：${liveRoom.title}\n主播：${liveRoom.hostName}\n商品：${product.name}\n成交状态：${auction.status}\n当前价：${auction.currentPrice}\n参与人数：${getParticipantCount(auction.id)}\n出价次数：${bidCount}\n延时次数：${auction.extendCount}`,
    fallbackContent
  });
}

export async function generateHostCue(liveRoomId = DEFAULT_LIVE_ROOM_ID) {
  const liveRoom = requireLiveRoom(liveRoomId);
  const auction = requireAuctionForLiveRoom(liveRoomId);
  const product = requireProduct(auction.productId);
  const auctionBids = getAuctionBids(auction.id);
  const recentDanmaku = getDanmakuMessages(liveRoomId)
    .slice(0, 5)
    .map((item) => `${item.nickname}：${item.content}`);
  const lastBid = auctionBids[0];
  const nextBid = auction.currentPrice + auction.incrementStep;
  const statusText = {
    PENDING: "待开始",
    ACTIVE: "竞拍中",
    SOLD: "已成交",
    UNSOLD: "已流拍",
    CANCELLED: "已取消"
  } satisfies Record<typeof auction.status, string>;
  const fallbackContent =
    auction.status === "ACTIVE"
      ? `${liveRoom.hostName}可以这样说：正在关注${product.name}的朋友别错过，目前最高价 ${auction.currentPrice} 元，下一口 ${nextBid} 元起。${lastBid ? `刚刚 ${lastBid.nickname} 出到了 ${lastBid.price} 元，` : ""}还有疑问可以直接发弹幕，我会结合细节继续讲。`
      : `${liveRoom.hostName}可以这样说：这件${product.name}已经准备好，起拍价 ${auction.startPrice} 元，每次最低加价 ${auction.incrementStep} 元。想看细节或使用场景的朋友可以先发弹幕，马上开始竞拍。`;

  return completeWithModel({
    title: "AI 主播实时话术",
    systemPrompt: "你是直播电商主播场控助手，只输出一段主播可以直接念的自然话术，合规、简短，不制造虚假紧迫感。",
    userPrompt: `请生成 90 字以内主播实时话术。\n直播间：${liveRoom.title}\n主播：${liveRoom.hostName}\n商品：${product.name}\n商品描述：${product.description}\n竞拍状态：${statusText[auction.status]}\n当前价：${auction.currentPrice}\n下一口价：${nextBid}\n封顶价：${auction.ceilingPrice}\n参与人数：${getParticipantCount(auction.id)}\n最近出价：${lastBid ? `${lastBid.nickname} ${lastBid.price} 元` : "暂无"}\n最近弹幕：${recentDanmaku.length ? recentDanmaku.join("；") : "暂无"}`,
    fallbackContent
  });
}

export async function detectBidRisk(input: { liveRoomId?: string; userId: string; price: number }) {
  const liveRoomId = input.liveRoomId ?? DEFAULT_LIVE_ROOM_ID;
  const auction = requireAuctionForLiveRoom(liveRoomId);
  const auctionBids = getAuctionBids(auction.id);
  const userBids = auctionBids.filter((bid) => bid.userId === input.userId);
  const recentBids = userBids.filter((bid) => Date.now() - bid.createdAt <= 30_000);
  const jumpAmount = input.price - auction.currentPrice;
  const reachesCeiling = input.price >= auction.ceilingPrice;
  const highFrequency = recentBids.length >= 3;
  const largeJump = jumpAmount >= auction.incrementStep * 5;

  const level = reachesCeiling || highFrequency || largeJump ? "中" : "低";
  const reasons = [
    reachesCeiling ? "本次出价达到封顶价，会立即触发成交" : null,
    highFrequency ? "该用户 30 秒内出价次数较多" : null,
    largeJump ? "本次加价幅度明显高于最低加价要求" : null
  ].filter(Boolean);

  const fallbackContent =
    reasons.length > 0
      ? `风险等级：${level}。${reasons.join("；")}。建议主播关注用户身份和直播间反馈。`
      : "风险等级：低。当前出价行为未发现明显异常，可按正常竞拍流程处理。";

  const result = await completeWithModel({
    title: "AI 异常出价提示",
    systemPrompt: "你是竞拍风控助手，只输出风险等级和原因，风险等级只能是低、中、高。",
    userPrompt: `请判断本次出价风险。\n直播间：${liveRoomId}\n当前最高价：${auction.currentPrice}\n最新出价：${input.price}\n用户 30 秒内出价次数：${recentBids.length}\n本次加价幅度：${jumpAmount}\n是否达到封顶价：${reachesCeiling}`,
    fallbackContent
  });

  return {
    ...result,
    level
  };
}

export function resetDemoState() {
  liveRooms.splice(0, liveRooms.length, ...createDefaultLiveRooms());
  products.splice(0, products.length, ...createDefaultProducts());
  auctions.splice(0, auctions.length, ...createDefaultAuctions());
  bids.splice(0, bids.length);
  orders.splice(0, orders.length);
  history.splice(0, history.length);
  users.splice(0, users.length);
  sessions.splice(0, sessions.length);
  danmakuMessages.splice(0, danmakuMessages.length);
  danmakuBlockedUsers.splice(0, danmakuBlockedUsers.length);
  auditLogs.splice(0, auditLogs.length);
  danmakuRateLimits.clear();
  processedBidRequestIds.clear();
  ensureDemoWebAccounts();
  ensureDemoLiveRoomOwnership();
  ensureLocalDemoProductImages();
  rebuildProcessedBidRequestIds();
  saveState();

  return {
    ok: true,
    rooms: getLiveRooms(),
    snapshots: getLiveRooms().map((room) => getSnapshot(room.id))
  };
}

function createSeedAuction(input: {
  id: string;
  liveRoomId: string;
  productId: string;
  startPrice?: number;
  incrementStep: number;
  ceilingPrice: number;
  durationSeconds: number;
}): Auction {
  return {
    id: input.id,
    productId: input.productId,
    liveRoomId: input.liveRoomId,
    startPrice: input.startPrice ?? 0,
    currentPrice: input.startPrice ?? 0,
    incrementStep: input.incrementStep,
    ceilingPrice: input.ceilingPrice,
    durationSeconds: input.durationSeconds,
    startTime: null,
    endTime: null,
    extendThresholdSeconds: 10,
    extendSeconds: 20,
    maxExtendCount: 3,
    extendCount: 0,
    status: "PENDING",
    winnerUserId: null,
    winnerNickname: null,
    version: 1
  };
}

function enrichLiveRoom(liveRoom: LiveRoom) {
  const auction = requireAuction(liveRoom.currentAuctionId);

  return {
    ...liveRoom,
    viewerCount: liveRoom.viewerCount + getParticipantCount(auction.id)
  };
}

function getAuctionBids(auctionId: string) {
  return bids
    .filter((bid) => bid.auctionId === auctionId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((bid) => ({ ...bid }));
}

function getParticipantCount(auctionId: string) {
  return new Set(bids.filter((bid) => bid.auctionId === auctionId).map((bid) => bid.userId)).size;
}

function getCurrentOrder(auctionId: string) {
  const auction = requireAuction(auctionId);
  const startTime = auction.startTime;

  if (!startTime) {
    return null;
  }

  return orders.find((item) => item.auctionId === auctionId && item.createdAt > startTime) ?? null;
}

function getCurrentSnapshotForOrder(order: Order) {
  const liveRoom = liveRooms.find((room) => room.currentAuctionId === order.auctionId);

  if (!liveRoom) {
    return null;
  }

  const snapshot = getSnapshot(liveRoom.id);
  return snapshot.order?.id === order.id ? snapshot : null;
}

export function getOrderSnapshot(orderId: string) {
  return getCurrentSnapshotForOrder(getOrder(orderId));
}

function archiveCurrentAuction(liveRoomId: string) {
  const auction = requireAuctionForLiveRoom(liveRoomId);

  if (auction.status === "PENDING") {
    return;
  }

  const historyItem: AuctionHistoryItem = {
    product: cloneProductWithQueueStatus(requireProduct(auction.productId), auction),
    auction: { ...auction },
    bids: getAuctionBids(auction.id),
    order: getCurrentOrder(auction.id),
    participantCount: getParticipantCount(auction.id),
    archivedAt: Date.now()
  };
  const existingIndex = history.findIndex((item) => item.auction.id === auction.id && item.auction.startTime === auction.startTime);

  if (existingIndex >= 0) {
    history[existingIndex] = historyItem;
  } else {
    history.unshift(historyItem);
  }

  history.splice(20);
}

function removeAuctionBids(auctionId: string) {
  for (let index = bids.length - 1; index >= 0; index -= 1) {
    if (bids[index].auctionId === auctionId) {
      bids.splice(index, 1);
    }
  }
}

function removeProcessedRequestsForAuction(auctionId: string) {
  for (const [requestId, bid] of processedBidRequestIds.entries()) {
    if (bid.auctionId === auctionId) {
      processedBidRequestIds.delete(requestId);
    }
  }
}

function getBidRequestKey(auctionId: string, userId: string, clientRequestId: string) {
  return `${auctionId}:${userId}:${clientRequestId}`;
}

function syncHistoryOrder(order: Order) {
  for (const item of history) {
    if (item.order?.id === order.id) {
      item.order = { ...order };
    }
  }
}

function assessBidRisk(input: {
  liveRoomId: string;
  auction: Auction;
  userId: string;
  price: number;
  now: number;
}): BidRisk {
  const auctionBids = bids.filter((bid) => bid.auctionId === input.auction.id);
  const userBids = auctionBids.filter((bid) => bid.userId === input.userId);
  const recentUserBids = userBids.filter((bid) => input.now - bid.createdAt <= RISK_RECENT_WINDOW_MS);
  const pendingOrders = getOrdersForUser(input.userId, input.liveRoomId).filter((order) => order.status !== "PAID");
  const jumpAmount = input.price - input.auction.currentPrice;
  const remainingSeconds = input.auction.endTime
    ? Math.ceil((input.auction.endTime - input.now) / 1000)
    : Number.POSITIVE_INFINITY;
  const reachesCeiling = input.price >= input.auction.ceilingPrice;
  const inFinalWindow = remainingSeconds <= input.auction.extendThresholdSeconds;
  const reasons: string[] = [];

  if (recentUserBids.length >= RISK_HIGH_FREQUENCY_BID_LIMIT) {
    reasons.push(`${Math.round(RISK_RECENT_WINDOW_MS / 1000)} 秒内出价超过 ${RISK_HIGH_FREQUENCY_BID_LIMIT} 次`);
  }

  if (pendingOrders.length >= RISK_PENDING_ORDER_LIMIT) {
    reasons.push(`该用户有 ${pendingOrders.length} 笔待支付订单`);
  }

  if (
    recentUserBids.length >= RISK_REPEAT_BID_LIMIT &&
    jumpAmount >= input.auction.incrementStep * RISK_EXTREME_JUMP_MULTIPLIER
  ) {
    reasons.push("连续出价后出现异常大幅加价");
  }

  if (reasons.length > 0) {
    return {
      level: "HIGH",
      action: "BLOCK",
      reasons
    };
  }

  if (jumpAmount >= input.auction.incrementStep * RISK_LARGE_JUMP_MULTIPLIER) {
    reasons.push("本次加价幅度明显高于最低加价要求");
  }

  if (reachesCeiling && inFinalWindow) {
    reasons.push("临近结束直接达到封顶价，建议主播关注身份和支付意愿");
  } else if (reachesCeiling) {
    reasons.push("本次出价达到封顶价，会立即触发成交");
  }

  if (recentUserBids.length >= RISK_REPEAT_BID_LIMIT) {
    reasons.push("该用户短时间内连续出价，建议关注是否恶意抬价");
  }

  if (reasons.length > 0) {
    return {
      level: "MEDIUM",
      action: "REVIEW",
      reasons
    };
  }

  return {
    level: "LOW",
    action: "ALLOW",
    reasons: []
  };
}

function ensureDemoWebAccounts() {
  const demoUsers: User[] = [
    {
      id: DEMO_HOST_USER_ID,
      account: "demo-host",
      password: hashPassword("demo123"),
      nickname: "演示主播",
      avatarUrl: "",
      role: "HOST",
      createdAt: Date.now()
    },
    {
      id: "user-demo-buyer",
      account: "demo-buyer",
      password: hashPassword("demo123"),
      nickname: "Web 预览买家",
      avatarUrl: "",
      role: "BUYER",
      createdAt: Date.now()
    }
  ];

  for (const demoUser of demoUsers) {
    if (!users.some((user) => user.account === demoUser.account || user.id === demoUser.id)) {
      users.push(demoUser);
    }
  }
}

function ensureDemoLiveRoomOwnership() {
  for (const liveRoom of liveRooms) {
    if ((liveRoom.id === "live-1" || liveRoom.id === "live-2") && !liveRoom.ownerUserId) {
      liveRoom.ownerUserId = DEMO_HOST_USER_ID;
    }
  }
}

function ensureLocalDemoProductImages() {
  for (const product of products) {
    if (!product.imageUrl || isLegacyRemoteDemoImage(product.imageUrl)) {
      const liveRoom = product.liveRoomId ? liveRooms.find((room) => room.id === product.liveRoomId) : undefined;
      product.imageUrl = getDefaultProductImageUrl(product.name, liveRoom?.title);
    }
  }
}

function getDefaultProductImageUrl(productName = "", liveRoomTitle = "") {
  const text = `${productName} ${liveRoomTitle}`;

  if (/表|腕表|watch|灯|台灯/i.test(text)) {
    return DEFAULT_WATCH_IMAGE_URL;
  }

  return DEFAULT_JEWELRY_IMAGE_URL;
}

function isLegacyRemoteDemoImage(imageUrl: string) {
  return imageUrl.includes("images.unsplash.com/photo-1605100804763-247f67b3557e") ||
    imageUrl.includes("images.unsplash.com/photo-1522312346375-d1a52e2b99b3");
}

function createSession(userId: string): Session {
  const session: Session = {
    token: `sess-${randomUUID()}`,
    userId,
    expiresAt: Date.now() + SESSION_TTL_MS
  };

  sessions.push(session);
  return session;
}

function getMiniprogramOpenId(input: MiniprogramAuthInput) {
  if (input.openId?.trim()) {
    return `wechat-openid-${input.openId.trim()}`;
  }

  const loginCode = input.mockCode?.trim() || input.code?.trim();

  if (!loginCode) {
    throw new Error("小程序登录 code 不能为空");
  }

  return input.mockCode ? `mock-openid-${loginCode}` : `wx-code-${loginCode}`;
}

function normalizeAccount(account: string) {
  const normalized = account.trim().toLowerCase();

  if (!normalized) {
    throw new Error("账号不能为空");
  }

  return normalized;
}

function normalizeProductImportRow(row: ProductImportRow): ProductImportRow {
  const name = row.name.trim();
  const description = row.description.trim();

  if (!name) {
    throw new Error("商品名称不能为空");
  }

  if (!description) {
    throw new Error("商品描述不能为空");
  }

  const numbers = {
    startPrice: row.startPrice,
    incrementStep: row.incrementStep,
    ceilingPrice: row.ceilingPrice,
    durationSeconds: row.durationSeconds,
    stock: row.stock ?? 1
  };

  for (const [field, value] of Object.entries(numbers)) {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new Error(`${getProductImportFieldLabel(field)}必须是整数`);
    }
  }

  if (row.startPrice < 0) {
    throw new Error("起拍价不能小于 0");
  }

  if (row.incrementStep < 1) {
    throw new Error("最低加价不能小于 1");
  }

  if (row.ceilingPrice < row.startPrice + row.incrementStep) {
    throw new Error("封顶价必须高于最低参与金额");
  }

  if (row.durationSeconds < 15 || row.durationSeconds > 600) {
    throw new Error("竞拍时长秒必须在 15 到 600 之间");
  }

  const stock = row.stock ?? 1;
  if (stock < 1 || stock > 100_000) {
    throw new Error("库存必须在 1 到 100000 之间");
  }

  return {
    name,
    description,
    imageUrl: row.imageUrl?.trim() || undefined,
    startPrice: row.startPrice,
    incrementStep: row.incrementStep,
    ceilingPrice: row.ceilingPrice,
    durationSeconds: row.durationSeconds,
    stock,
    sellingPoints: row.sellingPoints?.trim(),
    scriptKeywords: row.scriptKeywords?.trim()
  };
}

function getProductImportFieldLabel(field: string) {
  return (
    {
      startPrice: "起拍价",
      incrementStep: "最低加价",
      ceilingPrice: "封顶价",
      durationSeconds: "竞拍时长秒",
      stock: "库存"
    }[field] ?? field
  );
}

function buildLocalProductScript(liveRoom: LiveRoom, row: ProductImportRow) {
  const sellingPoints = row.sellingPoints ? `核心卖点是${row.sellingPoints}，` : "";
  const keywords = row.scriptKeywords ? `讲解时可以突出${row.scriptKeywords}。` : "适合在直播间重点展示细节和使用场景。";

  return `${liveRoom.hostName}为大家带来${row.name}，${sellingPoints}${row.startPrice} 元起拍，每次最低加价 ${row.incrementStep} 元，封顶价 ${row.ceilingPrice} 元，竞拍时长 ${row.durationSeconds} 秒，库存 ${row.stock ?? 1} 件。${keywords}`;
}

function buildLocalBuyerProductScript(row: ProductImportRow) {
  const sellingPoints = row.sellingPoints ? `${row.sellingPoints}。` : row.description;
  const keywords = row.scriptKeywords ? `看点：${row.scriptKeywords}。` : "";

  return `${row.name}：${sellingPoints}${keywords}起拍 ${row.startPrice} 元，每次最低加价 ${row.incrementStep} 元，封顶 ${row.ceilingPrice} 元。`;
}

function cloneProductWithQueueStatus(product: Product, auction: Auction): Product {
  return {
    ...product,
    startPrice: product.startPrice ?? auction.startPrice,
    incrementStep: product.incrementStep ?? auction.incrementStep,
    ceilingPrice: product.ceilingPrice ?? auction.ceilingPrice,
    durationSeconds: product.durationSeconds ?? auction.durationSeconds,
    stock: product.stock ?? 1,
    queueStatus: deriveProductQueueStatus(product, auction)
  };
}

function deriveProductQueueStatus(product: Product, auction: Auction): ProductQueueStatus {
  if (auction.status === "ACTIVE") {
    return "ACTIVE";
  }

  if (auction.status === "SOLD") {
    return "SOLD";
  }

  if (auction.status === "UNSOLD") {
    return "UNSOLD";
  }

  if (auction.status === "CANCELLED") {
    return "CANCELLED";
  }

  return product.queueStatus ?? "QUEUED";
}

function getProductAuction(productId: string, liveRoomId: string) {
  return auctions.find((auction) => auction.productId === productId && auction.liveRoomId === liveRoomId);
}

function requireAuctionForProduct(liveRoomId: string, productId: string) {
  requireLiveRoom(liveRoomId);
  requireProduct(productId);
  const auction = getProductAuction(productId, liveRoomId);

  if (!auction) {
    throw new Error("商品竞拍配置不存在");
  }

  return auction;
}

function syncAuctionConfigToProduct(auction: Auction) {
  const product = requireProduct(auction.productId);

  product.liveRoomId = product.liveRoomId ?? auction.liveRoomId;
  product.startPrice = auction.startPrice;
  product.incrementStep = auction.incrementStep;
  product.ceilingPrice = auction.ceilingPrice;
  product.durationSeconds = auction.durationSeconds;
}

function setProductQueueStatus(productId: string, status: ProductQueueStatus) {
  const product = requireProduct(productId);
  product.queueStatus = status;
}

function decreaseProductStock(productId: string) {
  const product = requireProduct(productId);
  product.stock = Math.max(0, (product.stock ?? 1) - 1);
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "导入失败";
}

function saveState() {
  const state = getPersistedState();

  mkdirSync(dirname(DATA_FILE), { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));

  if (mysqlPersistenceReady && !mysqlPersistenceDisabled) {
    pendingPersistenceSave = saveMysqlState(state);
  } else {
    pendingPersistenceSave = Promise.resolve();
  }
}

function loadState() {
  try {
    applyPersistedState(JSON.parse(readFileSync(DATA_FILE, "utf8")) as Partial<PersistedAuctionState> & {
      auction?: Partial<Auction>;
      order?: Order | null;
    });
  } catch {
    // Missing or invalid state file falls back to the seeded demo data.
  }
}

function getPersistedState(): PersistedAuctionState {
  return {
    liveRooms,
    users,
    sessions,
    products,
    auctions,
    bids,
    orders,
    history,
    danmakuMessages,
    danmakuBlockedUsers,
    auditLogs
  };
}

function applyPersistedState(data: Partial<PersistedAuctionState> & { auction?: Partial<Auction>; order?: Order | null }) {
  if (Array.isArray(data.products)) {
    mergeById(products, data.products);
  }

  if (Array.isArray(data.liveRooms)) {
    mergeById(liveRooms, data.liveRooms);
  }

  if (Array.isArray(data.users)) {
    mergeById(users, data.users);
  }

  if (Array.isArray(data.sessions)) {
    sessions.splice(0, sessions.length, ...data.sessions.filter((session) => session.expiresAt > Date.now()));
  }

  if (Array.isArray(data.auctions)) {
    mergeById(auctions, data.auctions);
  } else if (data.auction) {
    const currentAuction = requireAuction("auction-1");
    Object.assign(currentAuction, data.auction);
  }

  if (Array.isArray(data.bids)) {
    bids.splice(0, bids.length, ...data.bids);
  }

  if (Array.isArray(data.orders)) {
    orders.splice(0, orders.length, ...data.orders);
  } else if (data.order) {
    orders.splice(0, orders.length, data.order);
  }

  if (Array.isArray(data.history)) {
    history.splice(0, history.length, ...data.history.slice(0, 20));
  }

  if (Array.isArray(data.danmakuMessages)) {
    danmakuMessages.splice(0, danmakuMessages.length, ...data.danmakuMessages);
    for (const liveRoom of liveRooms) {
      trimDanmakuMessages(liveRoom.id);
    }
  }

  if (Array.isArray(data.danmakuBlockedUsers)) {
    danmakuBlockedUsers.splice(0, danmakuBlockedUsers.length, ...data.danmakuBlockedUsers);
  }

  if (Array.isArray(data.auditLogs)) {
    auditLogs.splice(0, auditLogs.length, ...data.auditLogs.slice(0, AUDIT_LOG_LIMIT));
  }

  ensureOrderLiveRoomIds();
}

function rebuildProcessedBidRequestIds() {
  processedBidRequestIds.clear();

  for (const bid of bids) {
    processedBidRequestIds.set(getBidRequestKey(bid.auctionId, bid.userId, bid.clientRequestId), bid);
  }
}

function mergeById<T extends { id: string }>(target: T[], source: T[]) {
  for (const item of source) {
    const existing = target.find((candidate) => candidate.id === item.id);

    if (existing) {
      Object.assign(existing, item);
    } else {
      target.push(item);
    }
  }
}

function cloneHistoryItem(item: AuctionHistoryItem) {
  return {
    product: { ...item.product },
    auction: { ...item.auction },
    bids: item.bids.map((bid) => ({ ...bid })),
    order: item.order ? { ...item.order } : null,
    participantCount: item.participantCount,
    archivedAt: item.archivedAt
  };
}

function cloneAuditLog(item: AuditLog) {
  return {
    ...item,
    detail: item.detail ? { ...item.detail } : undefined
  };
}

function sanitizeUser(user: User) {
  return {
    id: user.id,
    account: user.account,
    miniprogramRegisteredAt: user.miniprogramRegisteredAt,
    nickname: user.nickname,
    avatarUrl: user.avatarUrl,
    role: user.role,
    createdAt: user.createdAt
  };
}

function updateUserProfile(user: User, input: { nickname?: string; avatarUrl?: string }) {
  const nickname = input.nickname?.trim();

  if (nickname) {
    user.nickname = nickname;
  }

  if (input.avatarUrl !== undefined) {
    user.avatarUrl = input.avatarUrl;
  }
}

function hashPassword(password: string) {
  const salt = randomBytes(PASSWORD_SALT_BYTES).toString("hex");
  const hash = scryptSync(password, salt, PASSWORD_KEY_BYTES).toString("hex");
  return `${PASSWORD_HASH_PREFIX}:${salt}:${hash}`;
}

function verifyPassword(password: string, storedPassword: string) {
  if (!isPasswordHash(storedPassword)) {
    return storedPassword === password;
  }

  const [, salt, hash] = storedPassword.split(":");

  if (!salt || !hash) {
    return false;
  }

  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(password, salt, expected.length);

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function isPasswordHash(password: string) {
  return password.startsWith(`${PASSWORD_HASH_PREFIX}:`);
}

function normalizeDanmakuContent(content: string) {
  const normalized = content.replace(/\s+/g, " ").trim();

  if (!normalized) {
    throw new Error("弹幕内容不能为空");
  }

  if (normalized.length > 80) {
    throw new Error("弹幕内容不能超过 80 个字符");
  }

  const lowerContent = normalized.toLowerCase();
  const sensitiveWord = DANMAKU_SENSITIVE_WORDS.find((word) => lowerContent.includes(word.toLowerCase()));

  if (sensitiveWord) {
    throw new Error(`弹幕包含敏感词：${sensitiveWord}`);
  }

  return normalized;
}

function isVisibleDanmakuMessage(message: DanmakuMessage, liveRoomId: string) {
  return (
    message.liveRoomId === liveRoomId &&
    (message.status ?? "VISIBLE") === "VISIBLE" &&
    !danmakuBlockedUsers.some((item) => item.liveRoomId === liveRoomId && item.userId === message.userId)
  );
}

function assertDanmakuUserAllowed(liveRoomId: string, userId: string) {
  const blockedUser = danmakuBlockedUsers.find((item) => item.liveRoomId === liveRoomId && item.userId === userId);

  if (blockedUser) {
    throw new Error(`你已被屏蔽，无法发送弹幕：${blockedUser.reason}`);
  }
}

function assertDanmakuRateLimit(liveRoomId: string, userId: string) {
  const key = `${liveRoomId}:${userId}`;
  const now = Date.now();
  const recent = (danmakuRateLimits.get(key) ?? []).filter(
    (createdAt) => now - createdAt <= DANMAKU_RATE_LIMIT_WINDOW_MS
  );

  if (recent.length >= DANMAKU_RATE_LIMIT_COUNT) {
    throw new Error(`弹幕发送过快，请 ${Math.ceil(DANMAKU_RATE_LIMIT_WINDOW_MS / 1000)} 秒后再试`);
  }

  recent.push(now);
  danmakuRateLimits.set(key, recent);
}

function trimDanmakuMessages(liveRoomId: string) {
  const roomMessages = danmakuMessages.filter((message) => message.liveRoomId === liveRoomId);

  for (const message of roomMessages.slice(DANMAKU_HISTORY_LIMIT)) {
    const index = danmakuMessages.findIndex((item) => item.id === message.id);

    if (index >= 0) {
      danmakuMessages.splice(index, 1);
    }
  }
}

function removeExpiredSessions() {
  const now = Date.now();

  for (let index = sessions.length - 1; index >= 0; index -= 1) {
    if (sessions[index].expiresAt <= now) {
      sessions.splice(index, 1);
    }
  }
}

function requireLiveRoom(liveRoomId: string) {
  const liveRoom = liveRooms.find((room) => room.id === liveRoomId);

  if (!liveRoom) {
    throw new Error("专场不存在");
  }

  return liveRoom;
}

function requireAuctionForLiveRoom(liveRoomId: string) {
  const liveRoom = requireLiveRoom(liveRoomId);
  return requireAuction(liveRoom.currentAuctionId);
}

function requireAuction(auctionId: string) {
  const auction = auctions.find((item) => item.id === auctionId);

  if (!auction) {
    throw new Error("专场不存在");
  }

  return auction;
}

function requireProduct(productId: string) {
  const product = products.find((item) => item.id === productId);

  if (!product) {
    throw new Error("商品不存在");
  }

  return product;
}

function getOrderLiveRoomId(order: Order) {
  if (order.liveRoomId) {
    return order.liveRoomId;
  }

  const activeAuction = auctions.find((auction) => auction.id === order.auctionId);

  if (activeAuction) {
    return activeAuction.liveRoomId;
  }

  const historyItem = history.find((item) => item.auction.id === order.auctionId);
  return historyItem?.auction.liveRoomId ?? null;
}

function ensureOrderLiveRoomIds() {
  for (const order of orders) {
    order.liveRoomId = getOrderLiveRoomId(order) ?? DEFAULT_LIVE_ROOM_ID;
  }

  for (const item of history) {
    if (item.order) {
      item.order.liveRoomId = item.order.liveRoomId || item.auction.liveRoomId;
    }
  }
}

function isKnownLiveRoom(value: string) {
  return liveRooms.some((room) => room.id === value);
}
