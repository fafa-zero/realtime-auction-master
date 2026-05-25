import http from "node:http";
import cors from "cors";
import express from "express";
import { Server } from "socket.io";
import { z } from "zod";
import {
  cancelAuction,
  getAuction,
  getSnapshot,
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

function broadcastSnapshot(eventName: string) {
  io.to(ROOM_ID).emit(eventName, getSnapshot());
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, serverTime: Date.now() });
});

app.get("/api/auction", (_req, res) => {
  res.json(getSnapshot());
});

app.post("/api/auction/start", (_req, res) => {
  try {
    const snapshot = startAuction();
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

app.post("/api/orders/:orderId/pay", (req, res) => {
  try {
    const paidOrder = payOrder(req.params.orderId);
    broadcastSnapshot("order:paid");
    res.json(paidOrder);
  } catch (error) {
    res.status(400).json({ message: getErrorMessage(error) });
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
        price: z.number().positive()
      });
      const input = schema.parse(payload);
      const result = placeBid(input);

      io.to(ROOM_ID).emit("auction:bid-success", result.snapshot);

      if (result.extended) {
        io.to(ROOM_ID).emit("auction:extended", result.snapshot);
      }

      if (result.snapshot.auction.status === "SOLD") {
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
    const snapshot = settleAuction();
    io.to(ROOM_ID).emit("auction:ended", snapshot);
  }
}, 500);

server.listen(PORT, () => {
  console.log(`Auction server is running on http://localhost:${PORT}`);
});

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "操作失败";
}
