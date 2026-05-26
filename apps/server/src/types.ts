export type AuctionStatus = "PENDING" | "ACTIVE" | "SOLD" | "UNSOLD" | "CANCELLED";

export interface Product {
  id: string;
  name: string;
  imageUrl: string;
  description: string;
}

export interface LiveRoom {
  id: string;
  title: string;
  hostName: string;
  streamUrl: string;
  viewerCount: number;
  currentAuctionId: string;
}

export interface User {
  id: string;
  openId: string;
  nickname: string;
  avatarUrl: string;
  role: "BUYER" | "HOST" | "ADMIN";
  createdAt: number;
}

export interface Session {
  token: string;
  userId: string;
  expiresAt: number;
}

export interface Bid {
  id: string;
  auctionId: string;
  userId: string;
  nickname: string;
  price: number;
  createdAt: number;
  clientRequestId: string;
}

export interface Order {
  id: string;
  auctionId: string;
  productId: string;
  buyerUserId: string;
  buyerNickname: string;
  finalPrice: number;
  status: "PENDING_PAYMENT" | "PAID";
  createdAt: number;
}

export interface Auction {
  id: string;
  productId: string;
  liveRoomId: string;
  startPrice: number;
  currentPrice: number;
  incrementStep: number;
  ceilingPrice: number;
  durationSeconds: number;
  startTime: number | null;
  endTime: number | null;
  extendThresholdSeconds: number;
  extendSeconds: number;
  maxExtendCount: number;
  extendCount: number;
  status: AuctionStatus;
  winnerUserId: string | null;
  winnerNickname: string | null;
  version: number;
}

export interface AuctionSnapshot {
  product: Product;
  auction: Auction;
  bids: Bid[];
  order: Order | null;
  participantCount: number;
  serverTime: number;
}

export interface AuctionHistoryItem {
  auction: Auction;
  product: Product;
  bids: Bid[];
  order: Order | null;
  participantCount: number;
  archivedAt: number;
}
