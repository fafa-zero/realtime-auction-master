import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { completeWithModel } from "./ai.js";
import type { Auction, AuctionHistoryItem, AuctionSnapshot, Bid, LiveRoom, Order, Product, Session, User } from "./types.js";

const DATA_FILE = resolve(process.env.AUCTION_DATA_FILE ?? "data/auction-state.json");
const DEFAULT_LIVE_ROOM_ID = "live-1";

const products: Product[] = [
  {
    id: "product-1",
    name: "天然翡翠吊坠",
    imageUrl:
      "https://images.unsplash.com/photo-1605100804763-247f67b3557e?auto=format&fit=crop&w=900&q=80",
    description: "模拟直播间竞拍商品，适合用于演示实时出价、自动延时和封顶成交流程。"
  },
  {
    id: "product-2",
    name: "复古机械腕表",
    imageUrl:
      "https://images.unsplash.com/photo-1522312346375-d1a52e2b99b3?auto=format&fit=crop&w=900&q=80",
    description: "第二直播间演示商品，用于验证多直播间状态隔离和观众入口切换。"
  }
];

const liveRooms: LiveRoom[] = [
  {
    id: "live-1",
    title: "珠宝严选竞拍直播间",
    hostName: "主播小雅",
    streamUrl: "https://example.com/mock/jewelry-live.m3u8",
    viewerCount: 1286,
    currentAuctionId: "auction-1"
  },
  {
    id: "live-2",
    title: "腕表收藏竞拍直播间",
    hostName: "主播阿辰",
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
rebuildProcessedBidRequestIds();

export interface StartAuctionOptions {
  durationSeconds?: number;
  ceilingPrice?: number;
  incrementStep?: number;
}

export interface LoginMiniprogramInput {
  code?: string;
  mockCode?: string;
  nickname?: string;
  avatarUrl?: string;
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
    product: { ...requireProduct(auction.productId) },
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

export function startAuction(liveRoomIdOrOptions: string | StartAuctionOptions = DEFAULT_LIVE_ROOM_ID, maybeOptions: StartAuctionOptions = {}) {
  const liveRoomId = typeof liveRoomIdOrOptions === "string" ? liveRoomIdOrOptions : DEFAULT_LIVE_ROOM_ID;
  const options = typeof liveRoomIdOrOptions === "string" ? maybeOptions : liveRoomIdOrOptions;
  const auction = requireAuctionForLiveRoom(liveRoomId);

  if (auction.status !== "PENDING" && auction.status !== "UNSOLD" && auction.status !== "SOLD" && auction.status !== "CANCELLED") {
    throw new Error("当前竞拍状态不允许开始");
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

  if (auction.ceilingPrice < auction.startPrice + auction.incrementStep) {
    throw new Error("封顶价必须高于最低首次出价");
  }

  auction.currentPrice = auction.startPrice;
  auction.startTime = now;
  auction.endTime = now + auction.durationSeconds * 1000;
  auction.extendCount = 0;
  auction.status = "ACTIVE";
  auction.winnerUserId = null;
  auction.winnerNickname = null;
  auction.version += 1;
  saveState();

  return getSnapshot(liveRoomId);
}

export function cancelAuction(liveRoomIdOrReason = DEFAULT_LIVE_ROOM_ID, maybeReason = "主播取消竞拍") {
  const liveRoomId = isKnownLiveRoom(liveRoomIdOrReason) ? liveRoomIdOrReason : DEFAULT_LIVE_ROOM_ID;
  const reason = isKnownLiveRoom(liveRoomIdOrReason) ? maybeReason : liveRoomIdOrReason;
  const auction = requireAuctionForLiveRoom(liveRoomId);

  if (auction.status !== "PENDING" && auction.status !== "ACTIVE") {
    throw new Error("当前竞拍状态不允许取消");
  }

  auction.status = "CANCELLED";
  auction.version += 1;
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
    throw new Error("竞拍未进行，无法出价");
  }

  if (!auction.endTime) {
    throw new Error("竞拍已结束，无法出价");
  }

  if (now >= auction.endTime) {
    throw new Error("竞拍已结束，无法出价");
  }

  const minPrice = auction.currentPrice + auction.incrementStep;
  if (input.price < minPrice) {
    throw new Error(`出价过低，最低出价为 ${minPrice} 元`);
  }

  if (input.price > auction.ceilingPrice) {
    throw new Error(`出价不能超过封顶价 ${auction.ceilingPrice} 元`);
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
    const existingOrder = getCurrentOrder(auction.id);

    if (!existingOrder) {
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

export async function generateProductScript(liveRoomId = DEFAULT_LIVE_ROOM_ID) {
  const liveRoom = requireLiveRoom(liveRoomId);
  const auction = requireAuctionForLiveRoom(liveRoomId);
  const product = requireProduct(auction.productId);
  const fallbackContent = `今晚${liveRoom.title}由${liveRoom.hostName}带来${product.name}竞拍，${auction.startPrice} 元起拍，每次最低加价 ${auction.incrementStep} 元，封顶价 ${auction.ceilingPrice} 元。喜欢的朋友可以关注当前最高价，把握出价时机。`;

  return completeWithModel({
    title: "AI 商品讲解词",
    systemPrompt: "你是直播电商主播助理，输出必须简洁、合规、自然，不得承诺保值、收益或绝对效果。",
    userPrompt: `请生成 80 字以内直播讲解词。\n直播间：${liveRoom.title}\n主播：${liveRoom.hostName}\n商品名称：${product.name}\n商品描述：${product.description}\n起拍价：${auction.startPrice}\n最低加价：${auction.incrementStep}\n封顶价：${auction.ceilingPrice}\n竞拍时长：${auction.durationSeconds} 秒`,
    fallbackContent
  });
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
  incrementStep: number;
  ceilingPrice: number;
  durationSeconds: number;
}): Auction {
  return {
    id: input.id,
    productId: input.productId,
    liveRoomId: input.liveRoomId,
    startPrice: 0,
    currentPrice: 0,
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
    product: { ...requireProduct(auction.productId) },
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
    throw new Error("直播间不存在");
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
    throw new Error("竞拍不存在");
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
