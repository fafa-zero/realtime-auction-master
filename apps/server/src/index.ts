import http from "node:http";
import path from "node:path";
import cors from "cors";
import express from "express";
import { Server } from "socket.io";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { z } from "zod";
import {
  cancelAuction,
  archiveAuctionProduct,
  blockDanmakuUser,
  createAuctionProduct,
  createLiveRoom,
  detectBidRisk,
  getAuctionHistory,
  generateAuctionSummary,
  generateProductScript,
  getAuction,
  getBidCount,
  getSnapshot,
  getDanmakuBlockedUsers,
  getDanmakuMessages,
  getLiveRoom,
  getLiveRooms,
  getLiveRoomsForHost,
  getOrder,
  getOrders,
  getOrdersForUser,
  getProductQueue,
  getUserByAccount,
  getUserByToken,
  importAuctionProducts,
  loginMiniprogram,
  loginWebUser,
  payOrder,
  placeBid,
  registerMiniprogram,
  registerWebUser,
  reorderAuctionProducts,
  resetDemoState,
  retractDanmakuMessage,
  sendDanmakuMessage,
  settleAuction,
  startAuction,
  startProductAuction,
  updateAuctionProduct,
  updateUserProfileByToken
} from "./store.js";
import type { ProductImportRow } from "./store.js";
import { parseSpreadsheet, type SpreadsheetRecord } from "./spreadsheet.js";
import { resolveMiniprogramLogin } from "./wechat.js";

const PORT = Number(process.env.PORT ?? 4200);
const CLIENT_URL = process.env.CLIENT_URL ?? "http://localhost:5174";
const CLIENT_ORIGINS = getLocalClientOrigins(CLIENT_URL);
const DEFAULT_LIVE_ROOM_ID = "live-1";
const WEB_DIST_DIR = path.resolve(process.cwd(), "../web/dist");

const app = express();
app.use(cors({ origin: CLIENT_ORIGINS }));
app.use(express.json());
app.use("/static", express.static(path.resolve(process.cwd(), "public")));
app.use(express.static(WEB_DIST_DIR));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGINS,
    methods: ["GET", "POST"]
  }
});
const miniprogramWss = new WebSocketServer({ noServer: true });
const miniprogramClients = new Map<WebSocket, { liveRoomId: string | null }>();

function getLocalClientOrigins(clientUrl: string) {
  const origins = new Set<string>();

  try {
    const url = new URL(clientUrl);
    origins.add(url.origin);

    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      const alternate = new URL(url.toString());
      alternate.hostname = url.hostname === "localhost" ? "127.0.0.1" : "localhost";
      origins.add(alternate.origin);
    }
  } catch {
    origins.add(clientUrl);
  }

  return Array.from(origins);
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, serverTime: Date.now() });
});

app.get("/api/demo/check", (_req, res) => {
  const rooms = getLiveRooms();
  const demoHost = getUserByAccount("demo-host");
  const demoBuyer = getUserByAccount("demo-buyer");
  const hostRooms = demoHost ? getLiveRoomsForHost(demoHost.id) : [];
  const standardRoomIds = new Set(["live-1", "live-2"]);
  const standardRooms = rooms.filter((room) => standardRoomIds.has(room.id));
  const roomChecks = standardRooms.map((room) => {
    const snapshot = getSnapshot(room.id);

    return {
      id: room.id,
      title: room.title,
      ownerUserId: room.ownerUserId,
      status: snapshot.auction.status,
      productName: snapshot.product.name,
      imageUrl: snapshot.product.imageUrl,
      imageLocal: snapshot.product.imageUrl.startsWith("/static/"),
      bidCount: getBidCount(room.id),
      orderCount: getOrders(room.id).length
    };
  });
  const checks = {
    api: true,
    staticImages: ["/static/jewelry.jpg", "/static/watch.jpg"],
    demoHostExists: Boolean(demoHost),
    demoBuyerExists: Boolean(demoBuyer),
    standardRoomsReady:
      standardRooms.length === 2 &&
      roomChecks.every((room) => room.ownerUserId === "user-demo-host" && room.imageLocal),
    demoHostRoomCount: hostRooms.length,
    miniprogramApiCandidates: ["http://localhost:4300", "http://127.0.0.1:4300"],
    miniprogramWsPath: "/miniprogram-ws"
  };

  res.json({
    ok: Object.values({
      api: checks.api,
      demoHostExists: checks.demoHostExists,
      demoBuyerExists: checks.demoBuyerExists,
      standardRoomsReady: checks.standardRoomsReady,
      demoHostHasRooms: checks.demoHostRoomCount >= 2
    }).every(Boolean),
    serverTime: Date.now(),
    checks,
    rooms: roomChecks,
    recommendedAction: "如 ok 为 false，请用 demo-host 登录主播端后点击“重置演示数据”。"
  });
});

const productManageSchema = z.object({
  name: z.string().min(1, "商品名称不能为空").max(80),
  description: z.string().min(1, "商品描述不能为空").max(300),
  imageUrl: z.string().max(500).optional(),
  startPrice: z.number().int().min(0),
  incrementStep: z.number().int().min(1),
  ceilingPrice: z.number().int().min(1),
  durationSeconds: z.number().int().min(15).max(600),
  stock: z.number().int().min(1).max(100_000).optional(),
  sellingPoints: z.string().max(300).optional(),
  scriptKeywords: z.string().max(200).optional()
});

app.get(["/", "/host", "/host/setup", "/live/:liveRoomId"], (_req, res) => {
  res.sendFile(path.join(WEB_DIST_DIR, "index.html"));
});

app.post("/api/auth/miniprogram/login", async (req, res) => {
  try {
    const schema = z.object({
      code: z.string().min(1).optional(),
      mockCode: z.string().min(1).optional(),
      nickname: z.string().min(1).max(40).optional(),
      avatarUrl: z.string().max(500).optional()
    });
    const input = schema.parse(req.body ?? {});
    const login = await resolveMiniprogramLogin(input);
    const result = loginMiniprogram({ ...input, openId: login.openId });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(401).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.post("/api/auth/miniprogram/register", async (req, res) => {
  try {
    const schema = z.object({
      code: z.string().min(1).optional(),
      mockCode: z.string().min(1).optional(),
      nickname: z.string().min(1).max(40).optional(),
      avatarUrl: z.string().max(500).optional()
    });
    const input = schema.parse(req.body ?? {});
    const login = await resolveMiniprogramLogin(input);
    const user = registerMiniprogram({ ...input, openId: login.openId });
    res.json({ ok: true, user });
  } catch (error) {
    res.status(400).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.post("/api/auth/web/register", (req, res) => {
  try {
    const schema = z.object({
      account: z.string().min(1, "账号不能为空").max(80, "账号不能超过 80 个字符"),
      password: z.string().min(1, "密码不能为空").max(80, "密码不能超过 80 个字符"),
      nickname: z.string().min(1).max(40).optional(),
      role: z.enum(["BUYER", "HOST", "ADMIN"]).optional()
    });
    const input = schema.parse(req.body ?? {});
    const user = registerWebUser(input);
    res.json({ ok: true, user });
  } catch (error) {
    res.status(400).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.post("/api/auth/web/login", (req, res) => {
  try {
    const schema = z.object({
      account: z.string().min(1, "账号不能为空").max(80, "账号不能超过 80 个字符"),
      password: z.string().min(1, "密码不能为空").max(80, "密码不能超过 80 个字符")
    });
    const input = schema.parse(req.body ?? {});
    const result = loginWebUser(input);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(401).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.get("/api/me", (req, res) => {
  try {
    const user = getUserByToken(getAuthToken(req));
    res.json({ ok: true, user });
  } catch (error) {
    res.status(401).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.patch("/api/me/profile", (req, res) => {
  try {
    const schema = z.object({
      nickname: z.string().min(1).max(40).optional(),
      avatarUrl: z.string().max(500).optional()
    });
    const input = schema.parse(req.body ?? {});
    const user = updateUserProfileByToken(getAuthToken(req), input);
    res.json({ ok: true, user });
  } catch (error) {
    res.status(400).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.post("/api/admin/reset-demo", (req, res) => {
  try {
    requireHostUser(req);
    const result = resetDemoState();

    for (const snapshot of result.snapshots) {
      broadcastAuctionEvent(snapshot.auction.liveRoomId, "auction:snapshot", snapshot);
      broadcastAuctionEvent(snapshot.auction.liveRoomId, "danmaku:history", []);
    }

    res.json(result);
  } catch (error) {
    res.status(getErrorStatus(error)).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.get("/api/me/orders", (req, res) => {
  try {
    const user = getUserByToken(getAuthToken(req));
    const liveRoomId = typeof req.query.liveRoomId === "string" ? req.query.liveRoomId : undefined;

    if (liveRoomId) {
      assertLiveRoom(liveRoomId);
    }

    res.json({
      ok: true,
      items: getOrdersForUser(user.id, liveRoomId)
    });
  } catch (error) {
    res.status(getErrorStatus(error)).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.get("/api/auction", (_req, res) => {
  res.json(getSnapshot());
});

app.get("/api/live-rooms", (_req, res) => {
  res.json({
    ok: true,
    items: getLiveRooms()
  });
});

app.get("/api/me/live-rooms", (req, res) => {
  try {
    const user = requireHostUser(req);
    res.json({
      ok: true,
      items: getLiveRoomsForHost(user.id)
    });
  } catch (error) {
    res.status(getErrorStatus(error)).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.post("/api/live-rooms", (req, res) => {
  try {
    const user = requireHostUser(req);
    const schema = z.object({
      title: z.string().min(1, "直播间名称不能为空").max(80),
      hostName: z.string().max(40).optional(),
      productName: z.string().min(1, "商品名称不能为空").max(80),
      productDescription: z.string().min(1, "商品描述不能为空").max(300),
      startPrice: z.number().int().min(0),
      incrementStep: z.number().int().min(1),
      ceilingPrice: z.number().int().min(1),
      durationSeconds: z.number().int().min(15).max(600),
      stock: z.number().int().min(1).max(100_000).optional()
    });
    const input = schema.parse(req.body ?? {});
    const result = createLiveRoom({
      ownerUserId: user.id,
      ...input
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(getErrorStatus(error)).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.get("/api/live-rooms/default", (_req, res) => {
  res.json({
    ok: true,
    room: getLiveRoom()
  });
});

app.get("/api/live-rooms/:liveRoomId", (req, res) => {
  try {
    assertLiveRoom(req.params.liveRoomId);
    res.json({
      ok: true,
      room: getLiveRoom(req.params.liveRoomId)
    });
  } catch (error) {
    res.status(404).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.get("/api/live-rooms/:liveRoomId/auction", (req, res) => {
  try {
    assertLiveRoom(req.params.liveRoomId);
    res.json(getSnapshot(req.params.liveRoomId));
  } catch (error) {
    res.status(404).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.get("/api/live-rooms/:liveRoomId/products", (req, res) => {
  try {
    assertLiveRoom(req.params.liveRoomId);
    res.json({
      ok: true,
      items: getProductQueue(req.params.liveRoomId)
    });
  } catch (error) {
    res.status(404).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.post("/api/live-rooms/:liveRoomId/products", (req, res) => {
  try {
    assertLiveRoom(req.params.liveRoomId);
    requireHostUser(req);
    const input = productManageSchema.parse(req.body ?? {});
    res.json(createAuctionProduct(req.params.liveRoomId, input));
  } catch (error) {
    res.status(getErrorStatus(error)).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.patch("/api/live-rooms/:liveRoomId/products/:productId", (req, res) => {
  try {
    assertLiveRoom(req.params.liveRoomId);
    requireHostUser(req);
    const input = productManageSchema.partial().parse(req.body ?? {});
    res.json(updateAuctionProduct(req.params.liveRoomId, req.params.productId, input));
  } catch (error) {
    res.status(getErrorStatus(error)).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.delete("/api/live-rooms/:liveRoomId/products/:productId", (req, res) => {
  try {
    assertLiveRoom(req.params.liveRoomId);
    requireHostUser(req);
    res.json(archiveAuctionProduct(req.params.liveRoomId, req.params.productId));
  } catch (error) {
    res.status(getErrorStatus(error)).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.post("/api/live-rooms/:liveRoomId/products/reorder", (req, res) => {
  try {
    assertLiveRoom(req.params.liveRoomId);
    requireHostUser(req);
    const schema = z.object({
      productIds: z.array(z.string().min(1)).min(1)
    });
    const input = schema.parse(req.body ?? {});
    res.json(reorderAuctionProducts(req.params.liveRoomId, input.productIds));
  } catch (error) {
    res.status(getErrorStatus(error)).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.get("/api/live-rooms/:liveRoomId/danmaku", (req, res) => {
  try {
    assertLiveRoom(req.params.liveRoomId);
    res.json({
      ok: true,
      items: getDanmakuMessages(req.params.liveRoomId)
    });
  } catch (error) {
    res.status(404).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.post("/api/live-rooms/:liveRoomId/danmaku", (req, res) => {
  try {
    assertLiveRoom(req.params.liveRoomId);
    const authUser = getOptionalAuthUser(req);
    const input = parseDanmakuInput(req.body, authUser);
    const message = sendDanmakuMessage({
      liveRoomId: req.params.liveRoomId,
      ...input
    });

    broadcastAuctionEvent(req.params.liveRoomId, "danmaku:new", message);
    res.json({ ok: true, message });
  } catch (error) {
    res.status(400).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.get("/api/live-rooms/:liveRoomId/danmaku/blocked-users", (req, res) => {
  try {
    assertLiveRoom(req.params.liveRoomId);
    requireHostUser(req);
    res.json({
      ok: true,
      items: getDanmakuBlockedUsers(req.params.liveRoomId)
    });
  } catch (error) {
    res.status(getErrorStatus(error)).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.post("/api/live-rooms/:liveRoomId/danmaku/:messageId/retract", (req, res) => {
  try {
    assertLiveRoom(req.params.liveRoomId);
    const moderator = requireHostUser(req);
    const schema = z.object({
      reason: z.string().max(80).optional()
    });
    const input = schema.parse(req.body ?? {});
    const message = retractDanmakuMessage({
      liveRoomId: req.params.liveRoomId,
      messageId: req.params.messageId,
      moderatorUserId: moderator.id,
      reason: input.reason
    });

    broadcastAuctionEvent(req.params.liveRoomId, "danmaku:retracted", message);
    res.json({ ok: true, message });
  } catch (error) {
    res.status(getErrorStatus(error)).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.post("/api/live-rooms/:liveRoomId/danmaku/block-user", (req, res) => {
  try {
    assertLiveRoom(req.params.liveRoomId);
    const moderator = requireHostUser(req);
    const schema = z.object({
      userId: z.string().min(1),
      nickname: z.string().min(1).max(40),
      reason: z.string().max(80).optional()
    });
    const input = schema.parse(req.body ?? {});
    const blockedUser = blockDanmakuUser({
      liveRoomId: req.params.liveRoomId,
      userId: input.userId,
      nickname: input.nickname,
      moderatorUserId: moderator.id,
      reason: input.reason
    });

    broadcastAuctionEvent(req.params.liveRoomId, "danmaku:user-blocked", blockedUser);
    res.json({ ok: true, blockedUser });
  } catch (error) {
    res.status(getErrorStatus(error)).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.post("/api/live-rooms/:liveRoomId/products/import", async (req, res) => {
  try {
    assertLiveRoom(req.params.liveRoomId);
    requireHostUser(req);
    const records = Array.isArray(req.body?.rows)
      ? (req.body.rows as SpreadsheetRecord[])
      : parseSpreadsheetFromUpload(await readUpload(req), req.headers["content-type"]);
    const result = importAuctionProducts(req.params.liveRoomId, records.map(recordToProductImportRow));
    res.json(result);
  } catch (error) {
    res.status(400).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.post("/api/live-rooms/:liveRoomId/products/:productId/start", (req, res) => {
  try {
    assertLiveRoom(req.params.liveRoomId);
    requireHostUser(req);
    const snapshot = startProductAuction(req.params.liveRoomId, req.params.productId);
    broadcastAuctionEvent(req.params.liveRoomId, "auction:started", snapshot);
    res.json(snapshot);
  } catch (error) {
    res.status(400).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.post("/api/live-rooms/:liveRoomId/products/:productId/ai-script", async (req, res) => {
  try {
    assertLiveRoom(req.params.liveRoomId);
    requireHostUser(req);
    res.json(await generateProductScript(req.params.liveRoomId, req.params.productId));
  } catch (error) {
    res.status(400).json(createAiErrorResponse(getErrorMessage(error)));
  }
});

app.get("/api/auction/history", (_req, res) => {
  res.json({
    ok: true,
    items: getAuctionHistory()
  });
});

app.get("/api/live-rooms/:liveRoomId/auction/history", (req, res) => {
  try {
    assertLiveRoom(req.params.liveRoomId);
    res.json({
      ok: true,
      items: getAuctionHistory(req.params.liveRoomId)
    });
  } catch (error) {
    res.status(404).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.get("/api/orders", (_req, res) => {
  try {
    requireHostUser(_req);
    res.json({
      ok: true,
      items: getOrders()
    });
  } catch (error) {
    res.status(getErrorStatus(error)).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.get("/api/live-rooms/:liveRoomId/orders", (req, res) => {
  try {
    assertLiveRoom(req.params.liveRoomId);
    requireHostUser(req);
    res.json({
      ok: true,
      items: getOrders(req.params.liveRoomId)
    });
  } catch (error) {
    res.status(404).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.post("/api/auction/start", (req, res) => {
  handleStartAuction(req, DEFAULT_LIVE_ROOM_ID, res);
});

app.post("/api/live-rooms/:liveRoomId/auction/start", (req, res) => {
  handleStartAuction(req, req.params.liveRoomId, res);
});

function handleStartAuction(req: express.Request, liveRoomId: string, res: express.Response) {
  try {
    assertLiveRoom(liveRoomId);
    requireHostUser(req);
    const schema = z.object({
      durationSeconds: z
        .number({ invalid_type_error: "专场时长必须是数字" })
        .int("专场时长必须是整数")
        .min(15, "专场时长不能少于 15 秒")
        .max(600, "专场时长不能超过 600 秒")
        .optional(),
      incrementStep: z
        .number({ invalid_type_error: "最低加价必须是数字" })
        .int("最低加价必须是整数")
        .min(1, "最低加价不能少于 1 元")
        .max(100_000, "最低加价不能超过 100000 元")
        .optional(),
      ceilingPrice: z
        .number({ invalid_type_error: "封顶价必须是数字" })
        .int("封顶价必须是整数")
        .min(1, "封顶价不能少于 1 元")
        .max(10_000_000, "封顶价不能超过 10000000 元")
        .optional()
    });
    const input = schema.parse(req.body ?? {});
    const snapshot = startAuction(liveRoomId, input);
    broadcastAuctionEvent(liveRoomId, "auction:started", snapshot);
    res.json(snapshot);
  } catch (error) {
    res.status(getErrorStatus(error)).json({ ok: false, message: getErrorMessage(error) });
  }
}

app.post("/api/auction/cancel", (req, res) => {
  handleCancelAuction(req, DEFAULT_LIVE_ROOM_ID, res);
});

app.post("/api/live-rooms/:liveRoomId/auction/cancel", (req, res) => {
  handleCancelAuction(req, req.params.liveRoomId, res);
});

function handleCancelAuction(req: express.Request, liveRoomId: string, res: express.Response) {
  try {
    assertLiveRoom(liveRoomId);
    requireHostUser(req);
    const schema = z.object({
      reason: z.string().min(1).optional()
    });
    const input = schema.parse(req.body ?? {});
    const result = cancelAuction(liveRoomId, input.reason);
    broadcastAuctionEvent(liveRoomId, "auction:cancelled", result);
    res.json(result.snapshot);
  } catch (error) {
    res.status(getErrorStatus(error)).json({ ok: false, message: getErrorMessage(error) });
  }
}

app.post("/api/auction/bids", (req, res) => {
  handlePlaceBid(req.body, DEFAULT_LIVE_ROOM_ID, res);
});

app.post("/api/live-rooms/:liveRoomId/auction/bids", (req, res) => {
  handlePlaceBid(req.body, req.params.liveRoomId, res);
});

function handlePlaceBid(body: unknown, liveRoomId: string, res: express.Response) {
  try {
    assertLiveRoom(liveRoomId);
    const authUser = getOptionalAuthUser(res.req);
    const schema = z.object({
      userId: z.string().min(1, "用户 ID 不能为空").optional(),
      nickname: z.string().min(1, "昵称不能为空").optional(),
      price: z.number({ invalid_type_error: "参与金额必须是数字" }).positive("参与金额必须大于 0"),
      clientRequestId: z.string().min(1, "请求 ID 不能为空")
    });
    const input = schema.parse(body);
    const bidder = resolveBidder(input, authUser);
    const result = placeBid({ ...input, ...bidder, liveRoomId });

    broadcastAuctionEvent(liveRoomId, "auction:bid-success", result.snapshot);

    if (result.extended) {
      broadcastAuctionEvent(liveRoomId, "auction:extended", result.snapshot);
    }

    if (result.settled) {
      broadcastAuctionEvent(liveRoomId, "auction:ended", result.snapshot);
    }

    res.json({
      ok: true,
      bid: result.bid,
      extended: result.extended,
      settled: result.settled,
      duplicate: result.duplicate,
      risk: result.bid.risk,
      snapshot: result.snapshot
    });
  } catch (error) {
    res.status(400).json({ ok: false, message: getErrorMessage(error) });
  }
}

app.post("/api/orders/:orderId/pay", (req, res) => {
  try {
    const authUser = getUserByToken(getAuthToken(req));
    const order = getOrder(req.params.orderId);

    if (order.buyerUserId !== authUser.id) {
      res.status(403).json({ ok: false, message: "只能支付自己的订单" });
      return;
    }

    const paidOrder = payOrder(req.params.orderId);
    const liveRoom = getLiveRooms().find((room) => room.currentAuctionId === paidOrder.auctionId);
    const snapshot = getSnapshot(liveRoom?.id ?? DEFAULT_LIVE_ROOM_ID);
    broadcastAuctionEvent(snapshot.auction.liveRoomId, "order:paid", snapshot);
    res.json({
      ...paidOrder,
      ok: true,
      order: paidOrder,
      snapshot
    });
  } catch (error) {
    res.status(getErrorStatus(error)).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.post("/api/ai/product-script", async (req, res) => {
  try {
    requireHostUser(req);
    const liveRoomId = getLiveRoomIdFromRequest(req.body);
    const productId = getProductIdFromRequest(req.body);
    res.json(await generateProductScript(liveRoomId, productId));
  } catch (error) {
    res.status(getErrorStatus(error)).json(createAiErrorResponse(getErrorMessage(error)));
  }
});

app.post("/api/ai/auction-summary", async (req, res) => {
  try {
    requireHostUser(req);
    const liveRoomId = getLiveRoomIdFromRequest(req.body);
    res.json(await generateAuctionSummary(liveRoomId));
  } catch (error) {
    res.status(getErrorStatus(error)).json(createAiErrorResponse(getErrorMessage(error)));
  }
});

app.post("/api/ai/bid-risk", async (req, res) => {
  try {
    requireHostUser(req);
    const schema = z.object({
      liveRoomId: z.string().min(1).optional(),
      userId: z.string().min(1),
      price: z.number().positive()
    });
    const input = schema.parse(req.body);
    res.json(await detectBidRisk(input));
  } catch (error) {
    res.status(getErrorStatus(error)).json(createAiErrorResponse(getErrorMessage(error)));
  }
});

io.on("connection", (socket) => {
  socket.emit("auction:snapshot", getSnapshot());
  socket.emit("danmaku:history", getDanmakuMessages(DEFAULT_LIVE_ROOM_ID));

  socket.on("auction:join", (payload?: { liveRoomId?: string }) => {
    const liveRoomId = payload?.liveRoomId ?? DEFAULT_LIVE_ROOM_ID;
    try {
      assertLiveRoom(liveRoomId);
    } catch (error) {
      socket.emit("auction:error", { message: getErrorMessage(error) });
      return;
    }

    for (const room of socket.rooms) {
      if (room.startsWith("room:live:")) {
        socket.leave(room);
      }
    }

    socket.join(getLiveRoomSocketRoom(liveRoomId));
    socket.emit("auction:snapshot", getSnapshot(liveRoomId));
    socket.emit("danmaku:history", getDanmakuMessages(liveRoomId));
  });

  socket.on("auction:bid", (payload, callback) => {
    try {
      const schema = z.object({
        liveRoomId: z.string().min(1).optional(),
        userId: z.string().min(1).optional(),
        nickname: z.string().min(1).optional(),
        price: z.number().positive(),
        token: z.string().min(1).optional(),
        clientRequestId: z.string().min(1)
      });
      const input = schema.parse(payload);
      const authUser = input.token ? getUserByToken(input.token) : null;
      const bidder = resolveBidder(input, authUser);
      const result = placeBid({ ...input, ...bidder });

      broadcastAuctionEvent(result.snapshot.auction.liveRoomId, "auction:bid-success", result.snapshot);

      if (result.extended) {
        broadcastAuctionEvent(result.snapshot.auction.liveRoomId, "auction:extended", result.snapshot);
      }

      if (result.settled) {
        broadcastAuctionEvent(result.snapshot.auction.liveRoomId, "auction:ended", result.snapshot);
      }

      callback?.({ ok: true, bid: result.bid, risk: result.bid.risk });
    } catch (error) {
      callback?.({ ok: false, message: getErrorMessage(error) });
    }
  });

  socket.on("danmaku:send", (payload, callback) => {
    try {
      const schema = z.object({
        liveRoomId: z.string().min(1),
        userId: z.string().min(1).optional(),
        nickname: z.string().min(1).optional(),
        token: z.string().min(1).optional(),
        content: z.string().min(1).max(80)
      });
      const input = schema.parse(payload);
      const authUser = input.token ? getUserByToken(input.token) : null;
      const message = sendDanmakuMessage({
        liveRoomId: input.liveRoomId,
        ...parseDanmakuInput(input, authUser)
      });

      broadcastAuctionEvent(input.liveRoomId, "danmaku:new", message);
      callback?.({ ok: true, message });
    } catch (error) {
      callback?.({ ok: false, message: getErrorMessage(error) });
    }
  });
});

setInterval(() => {
  for (const liveRoom of getLiveRooms()) {
    const auction = getAuction(liveRoom.id);

    if (auction.status !== "ACTIVE" || !auction.endTime) {
      continue;
    }

    if (Date.now() >= auction.endTime) {
      const result = settleAuction(liveRoom.id);

      if (result.settled) {
        broadcastAuctionEvent(liveRoom.id, "auction:ended", result.snapshot);
      }
    }
  }
}, 500);

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname !== "/miniprogram-ws") {
    return;
  }

  miniprogramWss.handleUpgrade(req, socket, head, (ws) => {
    miniprogramWss.emit("connection", ws, req);
  });
});

miniprogramWss.on("connection", (ws) => {
  miniprogramClients.set(ws, { liveRoomId: null });
  sendMiniprogramEvent(ws, "auction:snapshot", getSnapshot(DEFAULT_LIVE_ROOM_ID));

  ws.on("message", (raw) => {
    try {
      const message = parseMiniprogramMessage(raw);

      if (message.type === "ping") {
        sendMiniprogramEvent(ws, "pong", { serverTime: Date.now() });
        return;
      }

      if (message.type === "auction:join") {
        const schema = z.object({
          liveRoomId: z.string().min(1)
        });
        const payload = schema.parse(message.payload ?? {});
        assertLiveRoom(payload.liveRoomId);
        miniprogramClients.set(ws, { liveRoomId: payload.liveRoomId });
        sendMiniprogramEvent(ws, "auction:snapshot", getSnapshot(payload.liveRoomId));
        return;
      }

      if (message.type === "auction:bid") {
        const schema = z.object({
          liveRoomId: z.string().min(1),
          token: z.string().min(1),
          price: z.number().positive(),
          clientRequestId: z.string().min(1)
        });
        const payload = schema.parse(message.payload ?? {});
        const authUser = getUserByToken(payload.token);
        const result = placeBid({
          liveRoomId: payload.liveRoomId,
          userId: authUser.id,
          nickname: authUser.nickname,
          price: payload.price,
          clientRequestId: payload.clientRequestId
        });

        broadcastAuctionEvent(payload.liveRoomId, "auction:bid-success", result.snapshot);

        if (result.extended) {
          broadcastAuctionEvent(payload.liveRoomId, "auction:extended", result.snapshot);
        }

        if (result.settled) {
          broadcastAuctionEvent(payload.liveRoomId, "auction:ended", result.snapshot);
        }

        sendMiniprogramEvent(ws, "auction:bid-ack", {
          ok: true,
          bid: result.bid,
          duplicate: result.duplicate,
          risk: result.bid.risk
        });
        return;
      }

      if (message.type === "danmaku:send") {
        const schema = z.object({
          liveRoomId: z.string().min(1),
          token: z.string().min(1),
          content: z.string().min(1).max(80)
        });
        const payload = schema.parse(message.payload ?? {});
        const authUser = getUserByToken(payload.token);
        const danmaku = sendDanmakuMessage({
          liveRoomId: payload.liveRoomId,
          userId: authUser.id,
          nickname: authUser.nickname,
          content: payload.content
        });

        broadcastAuctionEvent(payload.liveRoomId, "danmaku:new", danmaku);
        sendMiniprogramEvent(ws, "danmaku:ack", {
          ok: true,
          message: danmaku
        });
        return;
      }

      sendMiniprogramEvent(ws, "auction:error", { message: "未知小程序消息类型" });
    } catch (error) {
      const message = getErrorMessage(error);
      sendMiniprogramEvent(ws, "auction:bid-ack", { ok: false, message });
      sendMiniprogramEvent(ws, "auction:error", { message });
    }
  });

  ws.on("close", () => {
    miniprogramClients.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`Auction server is running on http://localhost:${PORT}`);
});

function getErrorMessage(error: unknown) {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => issue.message).join("；");
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "操作失败";
}

function getErrorStatus(error: unknown) {
  const message = getErrorMessage(error);
  if (message.includes("专场不存在") || message.includes("不存在")) {
    return 404;
  }

  if (
    message.includes("需要主播") ||
    message.includes("只有买家") ||
    message.includes("只能支付") ||
    message.includes("权限")
  ) {
    return 403;
  }

  return 401;
}

function createAiErrorResponse(message: string) {
  return {
    ok: false,
    message,
    fallback: true
  };
}

function getLiveRoomSocketRoom(liveRoomId: string) {
  return `room:live:${liveRoomId}`;
}

function broadcastAuctionEvent(liveRoomId: string, type: string, payload: unknown) {
  io.to(getLiveRoomSocketRoom(liveRoomId)).emit(type, payload);

  for (const [ws, client] of miniprogramClients.entries()) {
    if (client.liveRoomId === liveRoomId) {
      sendMiniprogramEvent(ws, type, payload);
    }
  }
}

function sendMiniprogramEvent(ws: WebSocket, type: string, payload: unknown) {
  if (ws.readyState !== ws.OPEN) {
    return;
  }

  ws.send(JSON.stringify({ type, payload }));
}

function parseMiniprogramMessage(raw: RawData) {
  const text = rawDataToString(raw);
  const data = JSON.parse(text) as {
    type?: unknown;
    payload?: unknown;
  };

  if (typeof data.type !== "string") {
    throw new Error("小程序消息 type 不能为空");
  }

  return {
    type: data.type,
    payload: data.payload
  };
}

function rawDataToString(raw: RawData) {
  if (typeof raw === "string") {
    return raw;
  }

  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString("utf8");
  }

  if (raw instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(raw)).toString("utf8");
  }

  return raw.toString("utf8");
}

function assertLiveRoom(liveRoomId: string) {
  getLiveRoom(liveRoomId);
}

function getLiveRoomIdFromRequest(body: unknown) {
  const result = z.object({ liveRoomId: z.string().min(1).optional() }).safeParse(body);
  return result.success ? result.data.liveRoomId : undefined;
}

function getProductIdFromRequest(body: unknown) {
  const result = z.object({ productId: z.string().min(1).optional() }).safeParse(body);
  return result.success ? result.data.productId : undefined;
}

async function readUpload(req: express.Request) {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function parseSpreadsheetFromUpload(buffer: Buffer, contentTypeHeader: string | string[] | undefined) {
  if (buffer.length === 0) {
    throw new Error("请上传固定模板 Excel 文件");
  }

  const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader ?? "";

  if (!contentType.startsWith("multipart/form-data")) {
    return parseSpreadsheet(buffer);
  }

  const boundary = contentType.match(/boundary="?([^";]+)"?/i)?.[1];

  if (!boundary) {
    throw new Error("上传表单缺少 boundary");
  }

  const file = extractMultipartFile(buffer, boundary);
  return parseSpreadsheet(file.buffer, file.filename);
}

function extractMultipartFile(buffer: Buffer, boundary: string) {
  const body = buffer.toString("latin1");
  const parts = body.split(`--${boundary}`);

  for (const part of parts) {
    if (!part.includes("filename=")) {
      continue;
    }

    const headerEnd = part.indexOf("\r\n\r\n");

    if (headerEnd < 0) {
      continue;
    }

    const headers = part.slice(0, headerEnd);
    const filename = headers.match(/filename="([^"]*)"/)?.[1] ?? "products.xlsx";
    let content = part.slice(headerEnd + 4);

    if (content.endsWith("\r\n")) {
      content = content.slice(0, -2);
    }

    return {
      filename,
      buffer: Buffer.from(content, "latin1")
    };
  }

  throw new Error("上传表单中没有找到文件");
}

function recordToProductImportRow(record: SpreadsheetRecord): ProductImportRow {
  return {
    name: getRecordValue(record, "商品名称"),
    description: getRecordValue(record, "商品描述"),
    startPrice: parseImportNumber(getRecordValue(record, "起拍价")),
    incrementStep: parseImportNumber(getRecordValue(record, "最低加价")),
    ceilingPrice: parseImportNumber(getRecordValue(record, "封顶价")),
    durationSeconds: parseImportNumber(getRecordValue(record, "竞拍时长秒", "竞拍时长")),
    stock: parseOptionalImportNumber(getRecordValue(record, "库存")),
    imageUrl: getRecordValue(record, "商品图片", "图片", "图片地址", "imageUrl"),
    sellingPoints: getRecordValue(record, "商品卖点"),
    scriptKeywords: getRecordValue(record, "讲解关键词")
  };
}

function getRecordValue(record: SpreadsheetRecord, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];

    if (value !== undefined) {
      return String(value).trim();
    }
  }

  return "";
}

function parseImportNumber(value: string) {
  const normalized = value.replace(/[,\s￥¥]/g, "");
  return Number(normalized);
}

function parseOptionalImportNumber(value: string) {
  return value.trim() ? parseImportNumber(value) : undefined;
}

function getAuthToken(req: express.Request) {
  const auth = req.headers.authorization;

  if (!auth?.startsWith("Bearer ")) {
    throw new Error("缺少登录 token");
  }

  return auth.slice("Bearer ".length).trim();
}

function getOptionalAuthUser(req: express.Request) {
  try {
    return getUserByToken(getAuthToken(req));
  } catch {
    return null;
  }
}

function requireHostUser(req: express.Request) {
  const user = getUserByToken(getAuthToken(req));

  if (user.role !== "HOST" && user.role !== "ADMIN") {
    throw new Error("需要主播或管理员权限");
  }

  return user;
}

function resolveBidder(
  input: { userId?: string; nickname?: string },
  authUser: { id: string; nickname: string; role?: string } | null
) {
  if (authUser) {
    if (authUser.role !== "BUYER") {
      throw new Error("只有买家账号可以出价");
    }

    return {
      userId: authUser.id,
      nickname: authUser.nickname
    };
  }

  if (!input.userId || !input.nickname) {
    throw new Error("用户 ID 和昵称不能为空");
  }

  return {
    userId: input.userId,
    nickname: input.nickname
  };
}

function parseDanmakuInput(
  input: { userId?: string; nickname?: string; content?: string },
  authUser: { id: string; nickname: string } | null
) {
  const schema = z.object({
    userId: z.string().min(1).optional(),
    nickname: z.string().min(1).optional(),
    content: z.string().min(1, "弹幕内容不能为空").max(80, "弹幕内容不能超过 80 个字符")
  });
  const parsed = schema.parse(input);

  if (authUser) {
    return {
      userId: authUser.id,
      nickname: authUser.nickname,
      content: parsed.content
    };
  }

  if (!parsed.userId || !parsed.nickname) {
    throw new Error("用户 ID 和昵称不能为空");
  }

  return {
    userId: parsed.userId,
    nickname: parsed.nickname,
    content: parsed.content
  };
}
