import http from "node:http";
import cors from "cors";
import express from "express";
import { Server } from "socket.io";
import { z } from "zod";
import {
  cancelAuction,
  detectBidRisk,
  getAuctionHistory,
  generateAuctionSummary,
  generateProductScript,
  getAuction,
  getSnapshot,
  getLiveRoom,
  getOrders,
  payOrder,
  placeBid,
  settleAuction,
  startAuction
} from "./store.js";

const PORT = Number(process.env.PORT ?? 4000);
const CLIENT_URL = process.env.CLIENT_URL ?? "http://localhost:5173";
const ROOM_ID = "auction-1";

const app = express();
app.use(cors({ origin: CLIENT_URL }));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CLIENT_URL,
    methods: ["GET", "POST"]
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, serverTime: Date.now() });
});

app.get("/api/auction", (_req, res) => {
  res.json(getSnapshot());
});

app.get("/api/live-rooms/default", (_req, res) => {
  res.json({
    ok: true,
    room: getLiveRoom()
  });
});

app.get("/api/auction/history", (_req, res) => {
  res.json({
    ok: true,
    items: getAuctionHistory()
  });
});

app.get("/api/orders", (_req, res) => {
  res.json({
    ok: true,
    items: getOrders()
  });
});

app.post("/api/auction/start", (req, res) => {
  try {
    const schema = z.object({
      durationSeconds: z
        .number({ invalid_type_error: "竞拍时长必须是数字" })
        .int("竞拍时长必须是整数")
        .min(15, "竞拍时长不能少于 15 秒")
        .max(600, "竞拍时长不能超过 600 秒")
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
    const snapshot = startAuction(input);
    io.to(ROOM_ID).emit("auction:started", snapshot);
    res.json(snapshot);
  } catch (error) {
    res.status(400).json({ message: getErrorMessage(error) });
  }
});

app.post("/api/auction/cancel", (req, res) => {
  try {
    const schema = z.object({
      reason: z.string().min(1).optional()
    });
    const input = schema.parse(req.body);
    const result = cancelAuction(input.reason);
    io.to(ROOM_ID).emit("auction:cancelled", result);
    res.json(result.snapshot);
  } catch (error) {
    res.status(400).json({ message: getErrorMessage(error) });
  }
});

app.post("/api/auction/bids", (req, res) => {
  try {
    const schema = z.object({
      userId: z.string().min(1, "用户 ID 不能为空"),
      nickname: z.string().min(1, "昵称不能为空"),
      price: z.number({ invalid_type_error: "出价金额必须是数字" }).positive("出价金额必须大于 0"),
      clientRequestId: z.string().min(1, "请求 ID 不能为空")
    });
    const input = schema.parse(req.body);
    const result = placeBid(input);

    io.to(ROOM_ID).emit("auction:bid-success", result.snapshot);

    if (result.extended) {
      io.to(ROOM_ID).emit("auction:extended", result.snapshot);
    }

    if (result.settled) {
      io.to(ROOM_ID).emit("auction:ended", result.snapshot);
    }

    res.json({
      ok: true,
      bid: result.bid,
      extended: result.extended,
      settled: result.settled,
      duplicate: result.duplicate,
      snapshot: result.snapshot
    });
  } catch (error) {
    res.status(400).json({ ok: false, message: getErrorMessage(error) });
  }
});

app.post("/api/orders/:orderId/pay", (req, res) => {
  try {
    const paidOrder = payOrder(req.params.orderId);
    const snapshot = getSnapshot();
    io.to(ROOM_ID).emit("order:paid", snapshot);
    res.json({
      ...paidOrder,
      ok: true,
      order: paidOrder,
      snapshot
    });
  } catch (error) {
    res.status(400).json({ message: getErrorMessage(error) });
  }
});

app.post("/api/ai/product-script", async (_req, res) => {
  res.json(await generateProductScript());
});

app.post("/api/ai/auction-summary", async (_req, res) => {
  res.json(await generateAuctionSummary());
});

app.post("/api/ai/bid-risk", async (req, res) => {
  try {
    const schema = z.object({
      userId: z.string().min(1),
      price: z.number().positive()
    });
    const input = schema.parse(req.body);
    res.json(await detectBidRisk(input));
  } catch (error) {
    res.status(400).json(createAiErrorResponse(getErrorMessage(error)));
  }
});

io.on("connection", (socket) => {
  socket.join(ROOM_ID);
  socket.emit("auction:snapshot", getSnapshot());

  socket.on("auction:join", () => {
    socket.join(ROOM_ID);
    socket.emit("auction:snapshot", getSnapshot());
  });

  socket.on("auction:bid", (payload, callback) => {
    try {
      const schema = z.object({
        userId: z.string().min(1),
        nickname: z.string().min(1),
        price: z.number().positive(),
        clientRequestId: z.string().min(1)
      });
      const input = schema.parse(payload);
      const result = placeBid(input);

      io.to(ROOM_ID).emit("auction:bid-success", result.snapshot);

      if (result.extended) {
        io.to(ROOM_ID).emit("auction:extended", result.snapshot);
      }

      if (result.settled) {
        io.to(ROOM_ID).emit("auction:ended", result.snapshot);
      }

      callback?.({ ok: true, bid: result.bid });
    } catch (error) {
      callback?.({ ok: false, message: getErrorMessage(error) });
    }
  });
});

setInterval(() => {
  const auction = getAuction();

  if (auction.status !== "ACTIVE" || !auction.endTime) {
    return;
  }

  if (Date.now() >= auction.endTime) {
    const result = settleAuction();

    if (result.settled) {
      io.to(ROOM_ID).emit("auction:ended", result.snapshot);
    }
  }
}, 500);

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

function createAiErrorResponse(message: string) {
  return {
    ok: false,
    message,
    fallback: true
  };
}
