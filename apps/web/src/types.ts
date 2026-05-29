export type AuctionStatus = "PENDING" | "ACTIVE" | "SOLD" | "UNSOLD" | "CANCELLED";

export interface Product {
  id: string;
  name: string;
  imageUrl: string;
  description: string;
  liveRoomId?: string;
  startPrice?: number;
  incrementStep?: number;
  ceilingPrice?: number;
  durationSeconds?: number;
  stock?: number;
  sellingPoints?: string;
  scriptKeywords?: string;
  aiScript?: string;
  aiScriptUpdatedAt?: number;
  queueStatus?: "QUEUED" | "ACTIVE" | "SOLD" | "UNSOLD" | "CANCELLED";
  importedAt?: number;
}

export interface LiveRoom {
  id: string;
  title: string;
  hostName: string;
  streamUrl: string;
  viewerCount: number;
  currentAuctionId: string;
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
  product: Product;
  auction: Auction;
  bids: Bid[];
  order: Order | null;
  participantCount: number;
  archivedAt: number;
}

export interface ProductQueueItem {
  product: Product;
  auction: Auction;
}

export interface AuthUser {
  id: string;
  account?: string;
  nickname: string;
  avatarUrl: string;
  role: "BUYER" | "HOST" | "ADMIN";
  createdAt: number;
}
