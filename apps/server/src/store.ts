import { randomUUID } from "node:crypto";
import type { Auction, AuctionSnapshot, Bid, Order, Product } from "./types.js";

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
let order: Order | null = null;

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

export function startAuction() {
  if (auction.status !== "PENDING" && auction.status !== "UNSOLD" && auction.status !== "SOLD") {
    throw new Error("当前竞拍状态不允许开始");
  }

  const now = Date.now();
  bids.length = 0;
  participantIds.clear();
  order = null;

  auction.currentPrice = auction.startPrice;
  auction.startTime = now;
  auction.endTime = now + auction.durationSeconds * 1000;
  auction.extendCount = 0;
  auction.status = "ACTIVE";
  auction.winnerUserId = null;
  auction.winnerNickname = null;
  auction.version += 1;

  return getSnapshot();
}

export function cancelAuction(reason = "主播取消竞拍") {
  if (auction.status !== "PENDING" && auction.status !== "ACTIVE") {
    throw new Error("当前竞拍状态不允许取消");
  }

  auction.status = "CANCELLED";
  auction.version += 1;

  return {
    reason,
    snapshot: getSnapshot()
  };
}

export function placeBid(input: {
  userId: string;
  nickname: string;
  price: number;
}) {
  const now = Date.now();

  if (auction.status !== "ACTIVE") {
    throw new Error("竞拍未进行，无法出价");
  }

  if (!auction.endTime || now >= auction.endTime) {
    settleAuction();
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
    createdAt: now
  };

  bids.push(bid);
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

  if (auction.currentPrice >= auction.ceilingPrice) {
    settleAuction();
  }

  return {
    bid,
    extended: shouldExtend,
    snapshot: getSnapshot()
  };
}

export function settleAuction() {
  if (auction.status !== "ACTIVE") {
    return getSnapshot();
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

  return getSnapshot();
}

export function payOrder(orderId: string) {
  if (!order || order.id !== orderId) {
    throw new Error("订单不存在");
  }

  order = {
    ...order,
    status: "PAID"
  };

  return order;
}
