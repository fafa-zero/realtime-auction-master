import "./env.js";
import http from "node:http";
import path from "node:path";
import cors from "cors";
import express from "express";
import { Server, type Socket } from "socket.io";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { z } from "zod";
import {
  cancelAuction,
  archiveAuctionProduct,
  blockDanmakuUser,
  createAuctionProduct,
  createLiveRoom,
  detectBidRisk,
  flushPersistence,
  getAuctionHistory,
  generateAuctionSummary,
  generateHostCue,
  generateProductScript,
  getAuditLogs,
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
  getOrderSnapshot,
  getProductQueue,
  getUserByAccount,
  getUserByToken,
  initializePersistence,
  importAuctionProducts,
  loginMiniprogram,
  loginWebUser,
  logoutSession,
  payOrder,
  placeBid,
  recordLiveRoomView,
  recordAuditLog,
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
import { completeWithAgentChat } from "./ai.js";
import {
  closeRedisInfrastructure,
  getAuctionSnapshotForRead,
  initializeRedisInfrastructure,
  publishRealtimeEvent
} from "./redis-infrastructure.js";

const PORT = Number(process.env.PORT ?? 4200);
const CLIENT_URL = process.env.CLIENT_URL ?? "http://localhost:5174";
const CLIENT_ORIGINS = getLocalClientOrigins(CLIENT_URL);
const DEFAULT_LIVE_ROOM_ID = "live-1";
const WEB_DIST_DIR = path.resolve(process.cwd(), "../web/dist");
const MIN_PASSWORD_LENGTH = 6;
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 2 * 1024 * 1024);
const LOGIN_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_RATE_LIMIT_MAX_FAILURES = 5;
const HOST_INVITE_CODE = process.env.HOST_INVITE_CODE?.trim() ?? "";
const loginFailures = new Map<string, { count: number; firstFailedAt: number }>();

type AuthenticatedUser = {
  id: string;
  account?: string;
  nickname: string;
  role: "BUYER" | "HOST" | "ADMIN";
};

const app = express();
app.use(cors({ origin: CLIENT_ORIGINS }));
app.use(express.json());
app.use(waitForPersistenceBeforeMutationResponse);
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

function waitForPersistenceBeforeMutationResponse(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  if (!["POST", "PATCH", "DELETE"].includes(req.method)) {
    next();
    return;
  }

  const originalJson = res.json.bind(res) as (body?: unknown) => express.Response;

  res.json = ((body?: unknown) => {
    void flushPersistence().finally(() => {
      originalJson(body);
    });

    return res;
  }) as typeof res.json;

  next();
}

function assertHostInviteCode(hostInviteCode?: string) {
  if (!HOST_INVITE_CODE || hostInviteCode?.trim() !== HOST_INVITE_CODE) {
    throw new Error("主播注册需要有效邀请码");
  }
}

function getLoginRateLimitKey(req: express.Request, account: string) {
  return `${req.ip ?? "unknown"}:${account.trim().toLowerCase()}`;
}

function assertLoginAllowed(req: express.Request, account: string) {
  const key = getLoginRateLimitKey(req, account);
  const entry = loginFailures.get(key);

  if (!entry) {
    return;
  }

  if (Date.now() - entry.firstFailedAt > LOGIN_RATE_LIMIT_WINDOW_MS) {
    loginFailures.delete(key);
    return;
  }

  if (entry.count >= LOGIN_RATE_LIMIT_MAX_FAILURES) {
    throw new Error("登录尝试过多，请稍后再试");
  }
}

function recordLoginFailure(req: express.Request, account: string) {
  const key = getLoginRateLimitKey(req, account);
  const now = Date.now();
  const entry = loginFailures.get(key);

  if (!entry || now - entry.firstFailedAt > LOGIN_RATE_LIMIT_WINDOW_MS) {
    loginFailures.set(key, { count: 1, firstFailedAt: now });
    return;
  }

  entry.count += 1;
}

function clearLoginFailures(req: express.Request, account: string) {
  loginFailures.delete(getLoginRateLimitKey(req, account));
}

function writeAuditLog(
  user: AuthenticatedUser,
  action: string,
  options: { liveRoomId?: string; targetId?: string; detail?: Record<string, unknown> } = {}
) {
  recordAuditLog({
    userId: user.id,
    userNickname: user.nickname,
    role: user.role,
    action,
    liveRoomId: options.liveRoomId,
    targetId: options.targetId,
    detail: options.detail
  });
}

function writeAnonymousAuditLog(action: string, detail?: Record<string, unknown>) {
  recordAuditLog({
    userId: "anonymous",
    userNickname: "匿名用户",
    role: "ANONYMOUS",
    action,
    detail
  });
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
    res.json(result);
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
    res.status(getErrorStatus(error)).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.post("/api/auth/web/register", (req, res) => {
  try {
    const schema = z.object({
      account: z.string().min(1, "账号不能为空").max(80, "账号不能超过 80 个字符"),
      password: z
        .string()
        .min(MIN_PASSWORD_LENGTH, `密码不能少于 ${MIN_PASSWORD_LENGTH} 个字符`)
        .max(80, "密码不能超过 80 个字符"),
      nickname: z.string().min(1).max(40).optional(),
      role: z.enum(["BUYER", "HOST"]).optional(),
      hostInviteCode: z.string().max(80).optional()
    });
    const input = schema.parse(req.body ?? {});
    const role = input.role ?? "HOST";

    if (role === "HOST") {
      assertHostInviteCode(input.hostInviteCode);
    }

    const user = registerWebUser({
      account: input.account,
      password: input.password,
      nickname: input.nickname,
      role
    });
    res.json({ ok: true, user });
  } catch (error) {
    res.status(getErrorStatus(error)).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.post("/api/auth/web/login", (req, res) => {
  try {
    const schema = z.object({
      account: z.string().min(1, "账号不能为空").max(80, "账号不能超过 80 个字符"),
      password: z.string().min(1, "密码不能为空").max(80, "密码不能超过 80 个字符")
    });
    const input = schema.parse(req.body ?? {});
    assertLoginAllowed(req, input.account);
    const result = loginWebUser(input);
    clearLoginFailures(req, input.account);
    res.json({ ok: true, ...result });
  } catch (error) {
    const status = getErrorMessage(error).includes("登录尝试过多") ? 429 : 401;
    const input = z.object({ account: z.string().optional() }).safeParse(req.body ?? {});

    if (status !== 429 && input.success && input.data.account) {
      recordLoginFailure(req, input.data.account);
    }

    if (status === 429 && input.success && input.data.account) {
      writeAnonymousAuditLog("LOGIN_RATE_LIMITED", {
        account: input.data.account,
        ip: req.ip ?? "unknown"
      });
    }

    res.status(status).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.post("/api/auth/logout", (req, res) => {
  try {
    const token = getAuthToken(req);
    res.json(logoutSession(token));
  } catch (error) {
    res.status(getErrorStatus(error)).json({ ok: false, message: getErrorMessage(error) });
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
    res.status(getErrorStatus(error)).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.post("/api/admin/reset-demo", (req, res) => {
  try {
    const user = requireDemoResetUser(req);
    const result = resetDemoState();
    writeAuditLog(user, "DEMO_RESET", {
      liveRoomId: DEFAULT_LIVE_ROOM_ID,
      detail: { roomCount: result.rooms.length }
    });

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

app.get("/api/auction", async (_req, res) => {
  res.json(await getAuctionSnapshotForRead(DEFAULT_LIVE_ROOM_ID, () => getSnapshot()));
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
    writeAuditLog(user, "LIVE_ROOM_CREATE", {
      liveRoomId: result.room.id,
      targetId: result.room.id,
      detail: { title: result.room.title }
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
    res.status(getErrorStatus(error)).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.post("/api/live-rooms/:liveRoomId/view", (req, res) => {
  try {
    assertLiveRoom(req.params.liveRoomId);
    res.json({
      ok: true,
      room: recordLiveRoomView(req.params.liveRoomId)
    });
  } catch (error) {
    res.status(getErrorStatus(error)).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.get("/api/live-rooms/:liveRoomId/auction", async (req, res) => {
  try {
    assertLiveRoom(req.params.liveRoomId);
    res.json(
      await getAuctionSnapshotForRead(req.params.liveRoomId, () => getSnapshot(req.params.liveRoomId))
    );
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
    const user = requireRoomHostUser(req, req.params.liveRoomId);
    const input = productManageSchema.parse(req.body ?? {});
    const result = createAuctionProduct(req.params.liveRoomId, input);
    writeAuditLog(user, "PRODUCT_CREATE", {
      liveRoomId: req.params.liveRoomId,
      detail: { name: input.name }
    });
    res.json(result);
  } catch (error) {
    res.status(getErrorStatus(error)).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.patch("/api/live-rooms/:liveRoomId/products/:productId", (req, res) => {
  try {
    assertLiveRoom(req.params.liveRoomId);
    const user = requireRoomHostUser(req, req.params.liveRoomId);
    const input = productManageSchema.partial().parse(req.body ?? {});
    const result = updateAuctionProduct(req.params.liveRoomId, req.params.productId, input);
    writeAuditLog(user, "PRODUCT_UPDATE", {
      liveRoomId: req.params.liveRoomId,
      targetId: req.params.productId,
      detail: { fields: Object.keys(input) }
    });
    res.json(result);
  } catch (error) {
    res.status(getErrorStatus(error)).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.delete("/api/live-rooms/:liveRoomId/products/:productId", (req, res) => {
  try {
    assertLiveRoom(req.params.liveRoomId);
    const user = requireRoomHostUser(req, req.params.liveRoomId);
    const result = archiveAuctionProduct(req.params.liveRoomId, req.params.productId);
    writeAuditLog(user, "PRODUCT_ARCHIVE", {
      liveRoomId: req.params.liveRoomId,
      targetId: req.params.productId
    });
    res.json(result);
  } catch (error) {
    res.status(getErrorStatus(error)).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.post("/api/live-rooms/:liveRoomId/products/reorder", (req, res) => {
  try {
    assertLiveRoom(req.params.liveRoomId);
    const user = requireRoomHostUser(req, req.params.liveRoomId);
    const schema = z.object({
      productIds: z.array(z.string().min(1)).min(1)
    });
    const input = schema.parse(req.body ?? {});
    const result = reorderAuctionProducts(req.params.liveRoomId, input.productIds);
    writeAuditLog(user, "PRODUCT_REORDER", {
      liveRoomId: req.params.liveRoomId,
      detail: { count: input.productIds.length }
    });
    res.json(result);
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
    const authUser = getUserByToken(getAuthToken(req));
    const input = parseDanmakuInput(req.body, authUser);
    const message = sendDanmakuMessage({
      liveRoomId: req.params.liveRoomId,
      ...input
    });

    broadcastAuctionEvent(req.params.liveRoomId, "danmaku:new", message);
    res.json({ ok: true, message });
  } catch (error) {
    res.status(getErrorStatus(error)).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.get("/api/live-rooms/:liveRoomId/danmaku/blocked-users", (req, res) => {
  try {
    assertLiveRoom(req.params.liveRoomId);
    requireRoomHostUser(req, req.params.liveRoomId);
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
    const moderator = requireRoomHostUser(req, req.params.liveRoomId);
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
    writeAuditLog(moderator, "DANMAKU_RETRACT", {
      liveRoomId: req.params.liveRoomId,
      targetId: req.params.messageId,
      detail: { reason: message.retractionReason }
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
    const moderator = requireRoomHostUser(req, req.params.liveRoomId);
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
    writeAuditLog(moderator, "DANMAKU_BLOCK_USER", {
      liveRoomId: req.params.liveRoomId,
      targetId: input.userId,
      detail: { nickname: input.nickname, reason: blockedUser.reason }
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
    const user = requireRoomHostUser(req, req.params.liveRoomId);
    const records = Array.isArray(req.body?.rows)
      ? (req.body.rows as SpreadsheetRecord[])
      : parseSpreadsheetFromUpload(await readUpload(req), req.headers["content-type"]);
    const result = importAuctionProducts(req.params.liveRoomId, records.map(recordToProductImportRow));
    writeAuditLog(user, "PRODUCT_IMPORT", {
      liveRoomId: req.params.liveRoomId,
      detail: {
        importedCount: result.importedCount,
        failedRows: result.failedRows.length
      }
    });
    res.json(result);
  } catch (error) {
    res.status(getErrorStatus(error)).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.post("/api/live-rooms/:liveRoomId/products/:productId/start", (req, res) => {
  try {
    assertLiveRoom(req.params.liveRoomId);
    const user = requireRoomHostUser(req, req.params.liveRoomId);
    const snapshot = startProductAuction(req.params.liveRoomId, req.params.productId);
    writeAuditLog(user, "PRODUCT_START_AUCTION", {
      liveRoomId: req.params.liveRoomId,
      targetId: req.params.productId,
      detail: { productName: snapshot.product.name }
    });
    broadcastAuctionEvent(req.params.liveRoomId, "auction:started", snapshot);
    res.json(snapshot);
  } catch (error) {
    res.status(getErrorStatus(error)).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.post("/api/live-rooms/:liveRoomId/products/:productId/ai-script", async (req, res) => {
  try {
    assertLiveRoom(req.params.liveRoomId);
    requireRoomHostUser(req, req.params.liveRoomId);
    res.json(await generateProductScript(req.params.liveRoomId, req.params.productId));
  } catch (error) {
    res.status(getErrorStatus(error)).json(createAiErrorResponse(getErrorMessage(error)));
  }
});

app.get("/api/auction/history", (req, res) => {
  try {
    const user = requireHostUser(req);
    const items =
      user.role === "ADMIN"
        ? getAuctionHistory()
        : getLiveRoomsForHost(user.id).flatMap((room) => getAuctionHistory(room.id));

    res.json({
      ok: true,
      items
    });
  } catch (error) {
    res.status(getErrorStatus(error)).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.get("/api/live-rooms/:liveRoomId/auction/history", (req, res) => {
  try {
    assertLiveRoom(req.params.liveRoomId);
    const user = getUserByToken(getAuthToken(req));

    if (user.role === "BUYER") {
      res.json({
        ok: true,
        items: getBuyerAuctionHistory(req.params.liveRoomId, user.id)
      });
      return;
    }

    requireRoomHostUser(req, req.params.liveRoomId);
    res.json({
      ok: true,
      items: getAuctionHistory(req.params.liveRoomId)
    });
  } catch (error) {
    res.status(getErrorStatus(error)).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.get("/api/orders", (_req, res) => {
  try {
    const user = requireHostUser(_req);
    const items =
      user.role === "ADMIN"
        ? getOrders()
        : getLiveRoomsForHost(user.id).flatMap((room) => getOrders(room.id));
    res.json({
      ok: true,
      items
    });
  } catch (error) {
    res.status(getErrorStatus(error)).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.get("/api/live-rooms/:liveRoomId/orders", (req, res) => {
  try {
    assertLiveRoom(req.params.liveRoomId);
    requireRoomHostUser(req, req.params.liveRoomId);
    res.json({
      ok: true,
      items: getOrders(req.params.liveRoomId)
    });
  } catch (error) {
    res.status(404).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.get("/api/live-rooms/:liveRoomId/audit-logs", (req, res) => {
  try {
    assertLiveRoom(req.params.liveRoomId);
    requireRoomHostUser(req, req.params.liveRoomId);
    res.json({
      ok: true,
      items: getAuditLogs(req.params.liveRoomId, 20)
    });
  } catch (error) {
    res.status(getErrorStatus(error)).json({ ok: false, message: getErrorMessage(error) });
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
    const user = requireRoomHostUser(req, liveRoomId);
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
    writeAuditLog(user, "AUCTION_START", {
      liveRoomId,
      targetId: snapshot.auction.id,
      detail: {
        durationSeconds: snapshot.auction.durationSeconds,
        incrementStep: snapshot.auction.incrementStep,
        ceilingPrice: snapshot.auction.ceilingPrice
      }
    });
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
    const user = requireRoomHostUser(req, liveRoomId);
    const schema = z.object({
      reason: z.string().min(1).optional()
    });
    const input = schema.parse(req.body ?? {});
    const result = cancelAuction(liveRoomId, input.reason);
    writeAuditLog(user, "AUCTION_CANCEL", {
      liveRoomId,
      targetId: result.snapshot.auction.id,
      detail: { reason: input.reason ?? result.reason }
    });
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
    const authUser = getUserByToken(getAuthToken(res.req));
    const schema = z.object({
      userId: z.string().min(1, "用户 ID 不能为空").optional(),
      nickname: z.string().min(1, "昵称不能为空").optional(),
      price: z.number({ invalid_type_error: "参与金额必须是数字" }).positive("参与金额必须大于 0"),
      clientRequestId: z.string().min(1, "请求 ID 不能为空")
    });
    const input = schema.parse(body);
    const bidder = resolveBidder(authUser);
    const result = placeBid({ ...input, ...bidder, liveRoomId });
    writeAuditLog(authUser, "BID_PLACE", {
      liveRoomId,
      targetId: result.bid.id,
      detail: {
        price: result.bid.price,
        duplicate: result.duplicate,
        settled: result.settled
      }
    });

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
    res.status(getErrorStatus(error)).json({ ok: false, message: getErrorMessage(error) });
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
    const snapshot = getOrderSnapshot(paidOrder.id);
    writeAuditLog(authUser, "ORDER_PAY", {
      liveRoomId: paidOrder.liveRoomId,
      targetId: paidOrder.id,
      detail: { finalPrice: paidOrder.finalPrice }
    });
    broadcastAuctionEvent(paidOrder.liveRoomId, "order:paid", {
      ok: true,
      order: paidOrder,
      snapshot
    });
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
    const liveRoomId = getLiveRoomIdFromRequest(req.body) ?? DEFAULT_LIVE_ROOM_ID;
    requireRoomHostUser(req, liveRoomId);
    const productId = getProductIdFromRequest(req.body);
    res.json(await generateProductScript(liveRoomId, productId));
  } catch (error) {
    res.status(getErrorStatus(error)).json(createAiErrorResponse(getErrorMessage(error)));
  }
});

app.post("/api/ai/auction-summary", async (req, res) => {
  try {
    const liveRoomId = getLiveRoomIdFromRequest(req.body) ?? DEFAULT_LIVE_ROOM_ID;
    requireRoomHostUser(req, liveRoomId);
    res.json(await generateAuctionSummary(liveRoomId));
  } catch (error) {
    res.status(getErrorStatus(error)).json(createAiErrorResponse(getErrorMessage(error)));
  }
});

app.post("/api/ai/host-cue", async (req, res) => {
  try {
    const liveRoomId = getLiveRoomIdFromRequest(req.body) ?? DEFAULT_LIVE_ROOM_ID;
    requireRoomHostUser(req, liveRoomId);
    res.json(await generateHostCue(liveRoomId));
  } catch (error) {
    res.status(getErrorStatus(error)).json(createAiErrorResponse(getErrorMessage(error)));
  }
});

app.post("/api/ai/bid-risk", async (req, res) => {
  try {
    const schema = z.object({
      liveRoomId: z.string().min(1).optional(),
      userId: z.string().min(1),
      price: z.number().positive()
    });
    const input = schema.parse(req.body);
    const liveRoomId = input.liveRoomId ?? DEFAULT_LIVE_ROOM_ID;
    requireRoomHostUser(req, liveRoomId);
    res.json(await detectBidRisk({ ...input, liveRoomId }));
  } catch (error) {
    res.status(getErrorStatus(error)).json(createAiErrorResponse(getErrorMessage(error)));
  }
});

app.post("/api/agent/chat", async (req, res) => {
  try {
    const schema = z.object({
      liveRoomId: z.string().min(1).optional(),
      sessionId: z.string().regex(/^[A-Za-z0-9:_-]{1,80}$/, "会话 ID 格式不正确").optional(),
      message: z.string().min(1, "消息不能为空").max(1_000, "消息不能超过 1000 个字符")
    });
    const input = schema.parse(req.body ?? {});
    const user = getUserByToken(getAuthToken(req));
    const liveRoomId = input.liveRoomId ?? DEFAULT_LIVE_ROOM_ID;
    const liveRoom = getLiveRoom(liveRoomId);
    const snapshot = getSnapshot(liveRoomId);
    const sessionId = input.sessionId ?? "default";
    const canAccessRoomOperations = user.role !== "BUYER";

    if (canAccessRoomOperations) {
      requireRoomHostUser(req, liveRoomId);
    }

    const inventory = canAccessRoomOperations ? getProductQueue(liveRoomId) : [];
    const roomOrders = canAccessRoomOperations
      ? getOrders(liveRoomId)
      : getOrdersForUser(user.id, liveRoomId);
    const historyItems = getAuctionHistory(liveRoomId).slice(0, 10);
    const productNames = new Map([
      ...inventory.map((item) => [item.product.id, item.product.name] as const),
      ...historyItems.map((item) => [item.product.id, item.product.name] as const),
      [snapshot.product.id, snapshot.product.name] as const
    ]);
    const history = historyItems.map((item) => ({
      status: item.auction.status,
      currentPrice: item.auction.currentPrice,
      participantCount: item.participantCount,
      bidCount: item.bids.length,
      productName: item.product.name,
      finalPrice: item.order?.finalPrice,
      orderStatus: item.order?.status,
      archivedAt: item.archivedAt
    }));
    const latestBid = snapshot.bids[0];
    const latestBidRecentCount = latestBid
      ? snapshot.bids.filter(
          (bid) => bid.userId === latestBid.userId && snapshot.serverTime - bid.createdAt <= 30_000
        ).length
      : 0;
    const context = {
      liveRoom: {
        id: liveRoom.id,
        title: liveRoom.title,
        hostName: liveRoom.hostName,
        viewerCount: liveRoom.viewerCount
      },
      product: {
        id: snapshot.product.id,
        name: snapshot.product.name,
        description: snapshot.product.description,
        startPrice: snapshot.auction.startPrice,
        incrementStep: snapshot.auction.incrementStep,
        ceilingPrice: snapshot.auction.ceilingPrice,
        durationSeconds: snapshot.auction.durationSeconds,
        stock: snapshot.product.stock,
        sellingPoints: snapshot.product.sellingPoints,
        scriptKeywords: snapshot.product.scriptKeywords
      },
      auction: {
        status: snapshot.auction.status,
        currentPrice: snapshot.auction.currentPrice,
        startPrice: snapshot.auction.startPrice,
        incrementStep: snapshot.auction.incrementStep,
        ceilingPrice: snapshot.auction.ceilingPrice,
        durationSeconds: snapshot.auction.durationSeconds,
        startTime: snapshot.auction.startTime,
        endTime: snapshot.auction.endTime,
        extendCount: snapshot.auction.extendCount
      },
      order: snapshot.order
        ? { status: snapshot.order.status, finalPrice: snapshot.order.finalPrice }
        : null,
      bids: snapshot.bids.slice(0, 30).map((bid) => ({
        nickname: bid.nickname,
        price: bid.price,
        createdAt: bid.createdAt
      })),
      participantCount: snapshot.participantCount,
      recentDanmaku: getDanmakuMessages(liveRoomId).slice(0, 10).map((item) => `${item.nickname}：${item.content}`),
      history,
      inventory: inventory.map((item) => ({
        id: item.product.id,
        name: item.product.name,
        stock: item.product.stock ?? 0,
        queueStatus: item.product.queueStatus ?? "QUEUED",
        auctionStatus: item.auction.status
      })),
      orders: roomOrders
        .slice()
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, 30)
        .map((order) => ({
          id: order.id,
          productId: order.productId,
          productName: productNames.get(order.productId) ?? "竞拍商品",
          buyerNickname: order.buyerNickname,
          finalPrice: order.finalPrice,
          status: order.status,
          createdAt: order.createdAt
        })),
      bidRisk: latestBid
        ? {
            userId: latestBid.userId,
            price: latestBid.price,
            currentPrice: snapshot.bids[1]?.price ?? snapshot.auction.startPrice,
            incrementStep: snapshot.auction.incrementStep,
            recentBidCount: latestBidRecentCount,
            reachesCeiling: latestBid.price >= snapshot.auction.ceilingPrice
          }
        : undefined,
      serverTime: snapshot.serverTime
    };
    const result = await completeWithAgentChat({
      message: input.message,
      sessionId,
      userId: user.id,
      userRole: user.role,
      liveRoomId,
      context,
      requestId: req.header("x-request-id")
    });
    writeAuditLog(user, "AGENT_CHAT", {
      liveRoomId,
      detail: { sessionId, intent: result.intent, toolsUsed: result.toolsUsed ?? [] }
    });
    res.json(result);
  } catch (error) {
    res.status(getErrorStatus(error)).json({ ok: false, message: getErrorMessage(error) });
  }
});

io.use((socket, next) => {
  try {
    const token = getSocketAuthToken(socket);
    socket.data.user = getUserByToken(token);
    next();
  } catch (error) {
    next(new Error(getErrorMessage(error)));
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

  socket.on("auction:bid", async (payload, callback) => {
    try {
      const schema = z.object({
        liveRoomId: z.string().min(1).optional(),
        userId: z.string().min(1).optional(),
        nickname: z.string().min(1).optional(),
        price: z.number().positive(),
        clientRequestId: z.string().min(1)
      });
      const input = schema.parse(payload);
      const authUser = getSocketUser(socket);
      const bidder = resolveBidder(authUser);
      const liveRoomId = input.liveRoomId ?? DEFAULT_LIVE_ROOM_ID;
      const result = placeBid({
        liveRoomId,
        price: input.price,
        clientRequestId: input.clientRequestId,
        ...bidder
      });
      writeAuditLog(authUser, "BID_PLACE", {
        liveRoomId: result.snapshot.auction.liveRoomId,
        targetId: result.bid.id,
        detail: {
          channel: "socket.io",
          price: result.bid.price,
          duplicate: result.duplicate,
          settled: result.settled
        }
      });
      await flushPersistence();

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

  socket.on("danmaku:send", async (payload, callback) => {
    try {
      const schema = z.object({
        liveRoomId: z.string().min(1),
        userId: z.string().min(1).optional(),
        nickname: z.string().min(1).optional(),
        content: z.string().min(1).max(80)
      });
      const input = schema.parse(payload);
      const authUser = getSocketUser(socket);
      const message = sendDanmakuMessage({
        liveRoomId: input.liveRoomId,
        ...parseDanmakuInput(input, authUser)
      });
      await flushPersistence();

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

  ws.on("message", async (raw) => {
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
        writeAuditLog(authUser, "BID_PLACE", {
          liveRoomId: payload.liveRoomId,
          targetId: result.bid.id,
          detail: {
            channel: "miniprogram-ws",
            price: result.bid.price,
            duplicate: result.duplicate,
            settled: result.settled
          }
        });
        await flushPersistence();

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
        await flushPersistence();

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

await initializePersistence();
await initializeRedisInfrastructure((event) => {
  emitLocalRealtimeEvent(event.liveRoomId, event.type, event.payload);
});

server.listen(PORT, () => {
  console.log(`Auction server is running on http://localhost:${PORT}`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void closeRedisInfrastructure().finally(() => {
      server.close();
    });
  });
}

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

  if (
    message.includes("缺少登录 token") ||
    message.includes("登录已失效") ||
    message === "用户不存在"
  ) {
    return 401;
  }

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

  return 400;
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
  emitLocalRealtimeEvent(liveRoomId, type, payload);
  void publishRealtimeEvent(liveRoomId, type, payload);
}

function emitLocalRealtimeEvent(liveRoomId: string, type: string, payload: unknown) {
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
  const contentLength = Number(req.headers["content-length"] ?? 0);

  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
    throw new Error(`上传文件不能超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB`);
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;

    if (totalBytes > MAX_UPLOAD_BYTES) {
      throw new Error(`上传文件不能超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB`);
    }

    chunks.push(buffer);
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

function getSocketAuthToken(socket: Socket) {
  const authToken = socket.handshake.auth?.token;
  const queryToken = socket.handshake.query?.token;
  const token = Array.isArray(authToken)
    ? authToken[0]
    : authToken ?? (Array.isArray(queryToken) ? queryToken[0] : queryToken);

  if (typeof token !== "string" || !token.trim()) {
    throw new Error("缺少登录 token");
  }

  return token.trim();
}

function getSocketUser(socket: Socket) {
  const user = socket.data.user as AuthenticatedUser | undefined;

  if (!user) {
    throw new Error("缺少登录 token");
  }

  return user;
}

function requireHostUser(req: express.Request) {
  const user = getUserByToken(getAuthToken(req));

  if (user.role !== "HOST" && user.role !== "ADMIN") {
    throw new Error("需要主播或管理员权限");
  }

  return user;
}

function requireRoomHostUser(req: express.Request, liveRoomId: string) {
  const user = requireHostUser(req);

  if (user.role === "ADMIN") {
    return user;
  }

  const liveRoom = getLiveRoom(liveRoomId);
  if (liveRoom.ownerUserId !== user.id) {
    throw new Error("没有该直播间管理权限");
  }

  return user;
}

function requireDemoResetUser(req: express.Request) {
  const user = requireHostUser(req);

  if (user.role === "ADMIN" || user.id === "user-demo-host" || user.account === "demo-host") {
    return user;
  }

  throw new Error("没有演示数据重置权限");
}

function getBuyerAuctionHistory(liveRoomId: string, userId: string) {
  return getAuctionHistory(liveRoomId)
    .filter(
      (item) =>
        item.bids.some((bid) => bid.userId === userId) ||
        item.order?.buyerUserId === userId
    )
    .map((item) => ({
      ...item,
      bids: item.bids.filter((bid) => bid.userId === userId),
      order: item.order?.buyerUserId === userId ? item.order : null
    }));
}

function resolveBidder(authUser: { id: string; nickname: string; role?: string } | null) {
  if (!authUser) {
    throw new Error("缺少登录 token");
  }

  if (authUser.role !== "BUYER") {
    throw new Error("只有买家账号可以出价");
  }

  return {
    userId: authUser.id,
    nickname: authUser.nickname
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

  if (!authUser) {
    throw new Error("缺少登录 token");
  }

  return {
    userId: authUser.id,
    nickname: authUser.nickname,
    content: parsed.content
  };
}
