import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { completeWithModel } from "./ai.js";
import type {
  Auction,
  AuctionHistoryItem,
  AuctionSnapshot,
  Bid,
  LiveRoom,
  Order,
  Product,
  ProductQueueStatus,
  Session,
  User
} from "./types.js";

const DATA_FILE = resolve(process.env.AUCTION_DATA_FILE ?? "data/auction-state.json");
const DEFAULT_LIVE_ROOM_ID = "live-1";

const products: Product[] = [
  {
    id: "product-1",
    name: "天然翡翠吊坠",
    imageUrl: "/static/jewelry.jpg",
    description: "好物专场演示商品，适合用于演示实时互动、价格更新和订单确认流程。",
    stock: 1
  },
  {
    id: "product-2",
    name: "复古机械腕表",
    imageUrl: "/static/watch.jpg",
    description: "第二个好物专场演示商品，用于验证多专场状态隔离和用户入口切换。",
    stock: 1
  }
];

const liveRooms: LiveRoom[] = [
  {
    id: "live-1",
    title: "珠宝严选好物专场",
    hostName: "小雅",
    streamUrl: "https://example.com/mock/jewelry-live.m3u8",
    viewerCount: 1286,
    currentAuctionId: "auction-1"
  },
  {
    id: "live-2",
    title: "腕表收藏好物专场",
    hostName: "阿辰",
    streamUrl: "https://example.com/mock/watch-live.m3u8",
    viewerCount: 842,
    currentAuctionId: "auction-2"
  }
];

const auctions: Auction[] = [
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

const bids: Bid[] = [];
const processedBidRequestIds = new Map<string, Bid>();
const history: AuctionHistoryItem[] = [];
const orders: Order[] = [];
const users: User[] = [];
const sessions: Session[] = [];

loadState();
ensureDemoWebAccounts();
rebuildProcessedBidRequestIds();

export interface StartAuctionOptions {
  durationSeconds?: number;
  ceilingPrice?: number;
  incrementStep?: number;
  productId?: string;
}

export interface LoginMiniprogramInput {
  code?: string;
  mockCode?: string;
  nickname?: string;
  avatarUrl?: string;
}

export interface LoginWebInput {
  account: string;
  password: string;
}

export interface RegisterWebInput extends LoginWebInput {
  nickname?: string;
  role?: "BUYER" | "HOST" | "ADMIN";
}

export interface ProductImportRow {
  name: string;
  description: string;
  startPrice: number;
  incrementStep: number;
  ceilingPrice: number;
  durationSeconds: number;
  stock?: number;
  sellingPoints?: string;
  scriptKeywords?: string;
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function getLiveRooms() {
  return liveRooms.map((room) => enrichLiveRoom(room));
}

export function getLiveRoom(liveRoomId = DEFAULT_LIVE_ROOM_ID) {
  return enrichLiveRoom(requireLiveRoom(liveRoomId));
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
    .filter((item) => !liveRoomId || getOrderLiveRoomId(item) === liveRoomId)
    .map((item) => ({ ...item }));
}

export function getOrdersForUser(userId: string, liveRoomId?: string) {
  return getOrders(liveRoomId).filter((order) => order.buyerUserId === userId);
}

export function getOrder(orderId: string) {
  const order = getOrders().find((item) => item.id === orderId);

  if (!order) {
    throw new Error("订单不存在");
  }

  return order;
}

export function loginMiniprogram(input: LoginMiniprogramInput) {
  const loginCode = input.mockCode?.trim() || input.code?.trim();

  if (!loginCode) {
    throw new Error("小程序登录 code 不能为空");
  }

  const openId = input.mockCode ? `mock-openid-${loginCode}` : `wx-code-${loginCode}`;
  let user = users.find((item) => item.openId === openId);

  if (!user) {
    user = {
      id: `user-${randomUUID()}`,
      openId,
      nickname: input.nickname?.trim() || "小程序用户",
      avatarUrl: input.avatarUrl ?? "",
      role: "BUYER",
      createdAt: Date.now()
    };
    users.push(user);
  } else {
    updateUserProfile(user, input);
  }

  const session: Session = {
    token: `sess-${randomUUID()}`,
    userId: user.id,
    expiresAt: Date.now() + SESSION_TTL_MS
  };

  sessions.push(session);
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
    password,
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

  if (user.password !== password) {
    throw new Error("账号或密码错误");
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
        imageUrl: "",
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

export function startProductAuction(liveRoomId: string, productId: string) {
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

  const now = Date.now();
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

  const previousBid = processedBidRequestIds.get(input.clientRequestId);
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

  const bid: Bid = {
    id: randomUUID(),
    auctionId: auction.id,
    userId: input.userId,
    nickname: input.nickname,
    price: input.price,
    createdAt: now,
    clientRequestId: input.clientRequestId
  };

  bids.push(bid);
  processedBidRequestIds.set(input.clientRequestId, bid);

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
        productId: auction.productId,
        buyerUserId: auction.winnerUserId,
        buyerNickname: auction.winnerNickname,
        finalPrice: auction.currentPrice,
        status: "PENDING_PAYMENT",
        createdAt: Date.now()
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
    const auction = requireAuction(order.auctionId);
    auction.version += 1;
    archiveCurrentAuction(auction.liveRoomId);
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

  return orders.find((item) => item.auctionId === auctionId && item.createdAt >= startTime) ?? null;
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

function ensureDemoWebAccounts() {
  const demoUsers: User[] = [
    {
      id: "user-demo-host",
      account: "demo-host",
      password: "demo123",
      nickname: "演示主播",
      avatarUrl: "",
      role: "HOST",
      createdAt: Date.now()
    },
    {
      id: "user-demo-buyer",
      account: "demo-buyer",
      password: "demo123",
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

function createSession(userId: string): Session {
  const session: Session = {
    token: `sess-${randomUUID()}`,
    userId,
    expiresAt: Date.now() + SESSION_TTL_MS
  };

  sessions.push(session);
  return session;
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
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  writeFileSync(
    DATA_FILE,
    JSON.stringify(
      {
        liveRooms,
        users,
        sessions,
        products,
        auctions,
        bids,
        orders,
        history
      },
      null,
      2
    )
  );
}

function loadState() {
  try {
    const data = JSON.parse(readFileSync(DATA_FILE, "utf8")) as {
      liveRooms?: LiveRoom[];
      users?: User[];
      sessions?: Session[];
      products?: Product[];
      auctions?: Auction[];
      bids?: Bid[];
      orders?: Order[];
      history?: AuctionHistoryItem[];
      auction?: Partial<Auction>;
      order?: Order | null;
    };

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
  } catch {
    // Missing or invalid state file falls back to the seeded demo data.
  }
}

function rebuildProcessedBidRequestIds() {
  processedBidRequestIds.clear();

  for (const bid of bids) {
    processedBidRequestIds.set(bid.clientRequestId, bid);
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

function sanitizeUser(user: User) {
  return {
    id: user.id,
    account: user.account,
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
  const activeAuction = auctions.find((auction) => auction.id === order.auctionId);

  if (activeAuction) {
    return activeAuction.liveRoomId;
  }

  const historyItem = history.find((item) => item.auction.id === order.auctionId);
  return historyItem?.auction.liveRoomId ?? null;
}

function isKnownLiveRoom(value: string) {
  return liveRooms.some((room) => room.id === value);
}
