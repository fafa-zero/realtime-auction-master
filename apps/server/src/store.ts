import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { completeWithModel } from "./ai.js";
import type { Auction, AuctionHistoryItem, AuctionSnapshot, Bid, Order, Product } from "./types.js";

const DATA_FILE = resolve(process.env.AUCTION_DATA_FILE ?? "data/auction-state.json");

const product: Product = {
  id: "product-1",
  name: "天然翡翠吊坠",
  imageUrl:
    "https://images.unsplash.com/photo-1605100804763-247f67b3557e?auto=format&fit=crop&w=900&q=80",
  description: "模拟直播间竞拍商品，适合用于演示实时出价、自动延时和封顶成交流程。"
};

const auction: Auction = {
  id: "auction-1",
  productId: product.id,
  liveRoomId: "live-1",
  startPrice: 0,
  currentPrice: 0,
  incrementStep: 100,
  ceilingPrice: 3000,
  durationSeconds: 90,
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

const bids: Bid[] = [];
const participantIds = new Set<string>();
const processedBidRequestIds = new Map<string, Bid>();
const history: AuctionHistoryItem[] = [];
let order: Order | null = null;

loadState();

export interface StartAuctionOptions {
  durationSeconds?: number;
  ceilingPrice?: number;
  incrementStep?: number;
}

export function getAuction() {
  return auction;
}

export function getSnapshot(): AuctionSnapshot {
  return {
    product,
    auction: { ...auction },
    bids: [...bids].sort((a, b) => b.createdAt - a.createdAt).slice(0, 30),
    order,
    participantCount: participantIds.size,
    serverTime: Date.now()
  };
}

export function getAuctionHistory() {
  return history.slice(0, 20);
}

export function getOrders() {
  const orderMap = new Map<string, Order>();

  for (const item of [order, ...history.map((historyItem) => historyItem.order)]) {
    if (item) {
      orderMap.set(item.id, item);
    }
  }

  return [...orderMap.values()];
}

export function startAuction(options: StartAuctionOptions = {}) {
  if (auction.status !== "PENDING" && auction.status !== "UNSOLD" && auction.status !== "SOLD") {
    throw new Error("当前竞拍状态不允许开始");
  }

  archiveCurrentAuction();

  const now = Date.now();
  bids.length = 0;
  participantIds.clear();
  processedBidRequestIds.clear();
  order = null;

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

  return getSnapshot();
}

export function cancelAuction(reason = "主播取消竞拍") {
  if (auction.status !== "PENDING" && auction.status !== "ACTIVE") {
    throw new Error("当前竞拍状态不允许取消");
  }

  auction.status = "CANCELLED";
  auction.version += 1;
  archiveCurrentAuction();
  saveState();

  return {
    reason,
    snapshot: getSnapshot()
  };
}

export function placeBid(input: {
  userId: string;
  nickname: string;
  price: number;
  clientRequestId: string;
}) {
  const now = Date.now();

  const previousBid = processedBidRequestIds.get(input.clientRequestId);
  if (previousBid) {
    return {
      bid: previousBid,
      extended: false,
      settled: false,
      duplicate: true,
      snapshot: getSnapshot()
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
  participantIds.add(input.userId);

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
    settled = settleAuction().settled;
  }

  if (!settled) {
    saveState();
  }

  return {
    bid,
    extended: shouldExtend,
    settled,
    duplicate: false,
    snapshot: getSnapshot()
  };
}

export function settleAuction() {
  if (auction.status !== "ACTIVE") {
    return {
      settled: false,
      snapshot: getSnapshot()
    };
  }

  auction.version += 1;

  if (auction.winnerUserId && auction.winnerNickname) {
    auction.status = "SOLD";
    order = {
      id: randomUUID(),
      auctionId: auction.id,
      productId: auction.productId,
      buyerUserId: auction.winnerUserId,
      buyerNickname: auction.winnerNickname,
      finalPrice: auction.currentPrice,
      status: "PENDING_PAYMENT",
      createdAt: Date.now()
    };
  } else {
    auction.status = "UNSOLD";
  }

  archiveCurrentAuction();
  saveState();

  return {
    settled: true,
    snapshot: getSnapshot()
  };
}

export function payOrder(orderId: string) {
  if (!order || order.id !== orderId) {
    throw new Error("订单不存在");
  }

  if (order.status === "PAID") {
    return order;
  }

  order = {
    ...order,
    status: "PAID"
  };
  auction.version += 1;
  archiveCurrentAuction();
  saveState();

  return order;
}

function archiveCurrentAuction() {
  if (auction.status === "PENDING") {
    return;
  }

  const historyItem = {
    product: { ...product },
    auction: { ...auction },
    bids: [...bids].sort((a, b) => b.createdAt - a.createdAt),
    order: order ? { ...order } : null,
    participantCount: participantIds.size,
    archivedAt: Date.now()
  };
  const existingIndex = history.findIndex((item) => item.auction.startTime === auction.startTime);

  if (existingIndex >= 0) {
    history[existingIndex] = historyItem;
  } else {
    history.unshift(historyItem);
  }

  history.splice(20);
}

function saveState() {
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  writeFileSync(
    DATA_FILE,
    JSON.stringify(
      {
        auction,
        bids,
        history,
        order
      },
      null,
      2
    )
  );
}

function loadState() {
  try {
    const data = JSON.parse(readFileSync(DATA_FILE, "utf8")) as {
      auction?: Partial<Auction>;
      bids?: Bid[];
      history?: AuctionHistoryItem[];
      order?: Order | null;
    };

    Object.assign(auction, data.auction);

    if (Array.isArray(data.bids)) {
      bids.splice(0, bids.length, ...data.bids);
      participantIds.clear();
      processedBidRequestIds.clear();

      for (const bid of bids) {
        participantIds.add(bid.userId);
        processedBidRequestIds.set(bid.clientRequestId, bid);
      }
    }

    if (Array.isArray(data.history)) {
      history.splice(0, history.length, ...data.history.slice(0, 20));
    }

    order = data.order ?? null;
  } catch {
    // Missing or invalid state file falls back to the seeded demo auction.
  }
}

export async function generateProductScript() {
  const fallbackContent = `今晚直播间这款${product.name}正在竞拍，${auction.startPrice} 元起拍，每次最低加价 ${auction.incrementStep} 元，封顶价 ${auction.ceilingPrice} 元。喜欢的朋友可以关注当前最高价，把握出价时机。`;

  return completeWithModel({
    title: "AI 商品讲解词",
    systemPrompt: "你是直播电商主播助理，输出必须简洁、合规、自然，不得承诺保值、收益或绝对效果。",
    userPrompt: `请生成 80 字以内直播讲解词。\n商品名称：${product.name}\n商品描述：${product.description}\n起拍价：${auction.startPrice}\n最低加价：${auction.incrementStep}\n封顶价：${auction.ceilingPrice}\n竞拍时长：${auction.durationSeconds} 秒`,
    fallbackContent
  });
}

export async function generateAuctionSummary() {
  const bidCount = bids.length;
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

  const fallbackContent = `${result}共有 ${participantIds.size} 位用户参与，累计 ${bidCount} 次有效出价，触发 ${auction.extendCount} 次自动延时。建议主播复盘出价高峰时间和用户互动节奏，用于优化下一场竞拍讲解。`;

  return completeWithModel({
    title: "AI 竞拍复盘",
    systemPrompt: "你是直播电商运营分析助手，输出要简短、客观，给出可执行建议。",
    userPrompt: `请生成一段竞拍复盘。\n商品：${product.name}\n成交状态：${auction.status}\n当前价：${auction.currentPrice}\n参与人数：${participantIds.size}\n出价次数：${bidCount}\n延时次数：${auction.extendCount}`,
    fallbackContent
  });
}

export async function detectBidRisk(input: { userId: string; price: number }) {
  const userBids = bids.filter((bid) => bid.userId === input.userId);
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
    userPrompt: `请判断本次出价风险。\n当前最高价：${auction.currentPrice}\n最新出价：${input.price}\n用户 30 秒内出价次数：${recentBids.length}\n本次加价幅度：${jumpAmount}\n是否达到封顶价：${reachesCeiling}`,
    fallbackContent
  });

  return {
    ...result,
    level
  };
}
