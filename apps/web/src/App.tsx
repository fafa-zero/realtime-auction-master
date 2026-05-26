import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  BarChart3,
  Bot,
  CircleDollarSign,
  Clock3,
  CreditCard,
  FileText,
  Radio,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Timer,
  TrendingUp,
  UserCheck,
  Wifi,
  WifiOff
} from "lucide-react";
import { io, type Socket } from "socket.io-client";
import type { AuctionSnapshot, AuctionStatus, Order } from "./types";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

const statusText = {
  PENDING: "待开始",
  ACTIVE: "竞拍中",
  SOLD: "已成交",
  UNSOLD: "已流拍",
  CANCELLED: "已取消"
};

type AiResult = {
  ok?: boolean;
  title: string;
  content: string;
  generatedAt: number;
  source: "model" | "fallback";
  fallback?: boolean;
  message?: string;
  level?: string;
};

type PayOrderResponse =
  | Order
  | {
      ok: true;
      order: Order;
      snapshot: AuctionSnapshot;
    };

type AiTask = "script" | "summary" | "risk";

const aiTaskText: Record<AiTask, string> = {
  script: "讲解词",
  summary: "竞拍复盘",
  risk: "风险提示"
};

export function App() {
  const [snapshot, setSnapshot] = useState<AuctionSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [userId] = useState(() => `user-${Math.floor(Math.random() * 9000 + 1000)}`);
  const [nickname, setNickname] = useState(() => `用户${Math.floor(Math.random() * 90 + 10)}`);
  const [bidPrice, setBidPrice] = useState("");
  const [message, setMessage] = useState("正在连接竞拍服务...");
  const [now, setNow] = useState(Date.now());
  const [serverOffset, setServerOffset] = useState(0);
  const [submittingBid, setSubmittingBid] = useState(false);
  const [aiResult, setAiResult] = useState<AiResult | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiTask, setAiTask] = useState<AiTask | null>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    fetch(`${API_URL}/api/auction`)
      .then((res) => res.json())
      .then((data: AuctionSnapshot) => {
        syncSnapshotClock(data);
        setSnapshot(data);
        setBidPrice(String(data.auction.currentPrice + data.auction.incrementStep));
      })
      .catch(() => setMessage("无法获取竞拍数据，请确认后端已启动"));

    const socket = io(API_URL, {
      transports: ["websocket", "polling"],
      reconnectionAttempts: 10
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      setMessage("已连接实时竞拍服务");
      socket.emit("auction:join");
    });

    socket.on("disconnect", () => {
      setConnected(false);
      setMessage("连接已断开，正在自动重连");
    });

    const updateSnapshot = (data: AuctionSnapshot) => {
      syncSnapshotClock(data);
      setSnapshot((current) => {
        if (current && data.auction.version < current.auction.version) {
          return current;
        }

        setBidPrice(String(data.auction.currentPrice + data.auction.incrementStep));
        return data;
      });
    };

    socket.on("auction:snapshot", updateSnapshot);
    socket.on("auction:started", (data: AuctionSnapshot) => {
      updateSnapshot(data);
      setMessage("竞拍已开始");
    });
    socket.on("auction:bid-success", (data: AuctionSnapshot) => {
      updateSnapshot(data);
      setMessage(`当前最高价已更新为 ${formatMoney(data.auction.currentPrice)}`);
    });
    socket.on("auction:extended", (data: AuctionSnapshot) => {
      updateSnapshot(data);
      setMessage(`触发自动延时，结束时间延长 ${data.auction.extendSeconds} 秒`);
    });
    socket.on("auction:ended", (data: AuctionSnapshot) => {
      updateSnapshot(data);
      setMessage(data.auction.status === "SOLD" ? "竞拍已成交" : "竞拍已结束");
    });
    socket.on("auction:cancelled", (result: { reason: string; snapshot: AuctionSnapshot }) => {
      updateSnapshot(result.snapshot);
      setMessage(`竞拍已取消：${result.reason}`);
    });
    socket.on("order:paid", updateSnapshot);

    function syncSnapshotClock(data: AuctionSnapshot) {
      setServerOffset(data.serverTime - Date.now());
    }

    return () => {
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, []);

  const remaining = useMemo(() => {
    if (!snapshot?.auction.endTime) {
      return 0;
    }

    return Math.max(0, snapshot.auction.endTime - (now + serverOffset));
  }, [now, serverOffset, snapshot?.auction.endTime]);

  const nextBid = snapshot ? snapshot.auction.currentPrice + snapshot.auction.incrementStep : 0;
  const bidAmount = Number(bidPrice);
  const progress = snapshot
    ? Math.min(100, (snapshot.auction.currentPrice / snapshot.auction.ceilingPrice) * 100)
    : 0;
  const lastBid = snapshot?.bids[0] ?? null;
  const canBid = Boolean(
    snapshot &&
      connected &&
      snapshot.auction.status === "ACTIVE" &&
      !submittingBid &&
      nickname.trim().length > 0 &&
      Number.isFinite(bidAmount) &&
      bidAmount >= nextBid
  );
  const bidFeedback = snapshot
    ? getBidFeedback({
        status: snapshot.auction.status,
        connected,
        nickname,
        bidAmount,
        nextBid
      })
    : "";
  const inExtendWindow = Boolean(
    snapshot &&
      snapshot.auction.status === "ACTIVE" &&
      remaining > 0 &&
      Math.ceil(remaining / 1000) <= snapshot.auction.extendThresholdSeconds &&
      snapshot.auction.extendCount < snapshot.auction.maxExtendCount
  );
  const stageLabel = snapshot ? getStageLabel(snapshot.auction.status) : "";
  const stageDetail = snapshot ? getStageDetail(snapshot, remaining) : "";
  const syncLabel = connected && snapshot ? `同步版本 v${snapshot.auction.version}` : "等待实时同步";

  async function startAuction() {
    const res = await fetch(`${API_URL}/api/auction/start`, { method: "POST" });
    const data = await res.json();

    if (!res.ok) {
      setMessage(data.message ?? "启动竞拍失败");
      return;
    }

    setSnapshot(data);
    setMessage("竞拍已启动");
  }

  async function cancelAuction() {
    const res = await fetch(`${API_URL}/api/auction/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "主播手动取消异常竞拍" })
    });
    const data = await res.json();

    if (!res.ok) {
      setMessage(data.message ?? "取消竞拍失败");
      return;
    }

    setSnapshot(data);
  }

  function placeUserBid() {
    if (!socketRef.current || !snapshot) {
      return;
    }

    const price = Number(bidPrice);
    if (!Number.isFinite(price) || price <= 0) {
      setMessage("请输入有效出价金额");
      return;
    }

    if (price < nextBid) {
      setMessage(`当前最低出价为 ${formatMoney(nextBid)}`);
      return;
    }

    const cleanNickname = nickname.trim();
    if (!cleanNickname) {
      setMessage("请先填写出价昵称");
      return;
    }

    setSubmittingBid(true);
    socketRef.current.emit(
      "auction:bid",
      {
        userId,
        nickname: cleanNickname,
        price,
        clientRequestId: `${userId}-${Date.now()}-${Math.random().toString(16).slice(2)}`
      },
      (response: { ok: boolean; message?: string }) => {
        setSubmittingBid(false);
        if (!response.ok) {
          setMessage(response.message ?? "出价失败");
          return;
        }

        setMessage("出价成功，等待广播同步");
      }
    );
  }

  async function runAiTask(type: AiTask) {
    setAiLoading(true);
    setAiTask(type);
    setAiResult(null);

    try {
      const price = Number(bidPrice || nextBid);
      const endpoint =
        type === "script"
          ? "/api/ai/product-script"
          : type === "summary"
            ? "/api/ai/auction-summary"
            : "/api/ai/bid-risk";
      const init =
        type === "risk"
          ? {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ userId, price })
            }
          : { method: "POST" };
      const res = await fetch(`${API_URL}${endpoint}`, init);
      const data = await res.json();

      if (!res.ok) {
        setMessage(data.message ?? "AI 助手生成失败");
        return;
      }

      setAiResult(data);
      setMessage(
        data.message ??
          (data.source === "model" ? "AI 助手已生成结果" : "已使用本地 AI 兜底策略生成结果")
      );
    } catch {
      setMessage("AI 助手暂时不可用，请稍后重试");
    } finally {
      setAiLoading(false);
      setAiTask(null);
    }
  }

  async function payOrder() {
    if (!snapshot?.order) {
      return;
    }

    const res = await fetch(`${API_URL}/api/orders/${snapshot.order.id}/pay`, { method: "POST" });
    const data = (await res.json()) as PayOrderResponse & { message?: string };

    if (!res.ok) {
      setMessage(data.message ?? "支付失败");
      return;
    }

    if ("snapshot" in data) {
      setSnapshot(data.snapshot);
    } else {
      setSnapshot({
        ...snapshot,
        order: data
      });
    }

    setMessage("模拟支付成功");
  }

  if (!snapshot) {
    return (
      <main className="loading-page">
        <Radio className="spin" size={28} />
        <p>{message}</p>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <section className="live-panel">
        <div className="topbar">
          <div>
            <p className="eyebrow">实时竞拍大师</p>
            <h1>直播间竞拍控制台</h1>
            <p className="topbar-meta">{syncLabel} / Socket.IO 多端广播</p>
          </div>
          <div className={connected ? "connection online" : "connection offline"}>
            {connected ? <Wifi size={18} /> : <WifiOff size={18} />}
            {connected ? "实时连接" : "重连中"}
          </div>
        </div>

        <div className="live-stage">
          <div className="live-badge">
            <Radio size={16} />
            LIVE
          </div>
          <img src={snapshot.product.imageUrl} alt={snapshot.product.name} />
          <div className="live-overlay">
            <p>抖音电商直播模拟</p>
            <strong>{snapshot.product.name}</strong>
            <div className="live-meta">
              <span>
                <TrendingUp size={15} />
                当前价 {formatMoney(snapshot.auction.currentPrice)}
              </span>
              <span>{snapshot.participantCount} 人围观出价</span>
            </div>
          </div>
        </div>

        <div className="product-strip">
          <div>
            <p className="eyebrow">当前商品</p>
            <h2>{snapshot.product.name}</h2>
            <p>{snapshot.product.description}</p>
            <p className="product-note">{stageDetail}</p>
          </div>
          <div className={`status-pill status-${snapshot.auction.status.toLowerCase()}`}>
            {statusText[snapshot.auction.status]}
          </div>
        </div>

        <div className="stats-grid">
          <Metric label="当前最高价" value={formatMoney(snapshot.auction.currentPrice)} />
          <Metric label="最低加价" value={formatMoney(snapshot.auction.incrementStep)} />
          <Metric label="封顶价" value={formatMoney(snapshot.auction.ceilingPrice)} />
          <Metric label="参与人数" value={`${snapshot.participantCount} 人`} />
        </div>
      </section>

      <aside className="control-panel">
        <div className="notice">
          <AlertTriangle size={18} />
          <span>{message}</span>
        </div>
        <div className="sync-strip">
          <span>{syncLabel}</span>
          <span>{connected ? "实时广播已开启" : "正在恢复连接"}</span>
        </div>

        <section className="panel-section">
          <div className="section-title">
            <Timer size={18} />
            <h2>竞拍状态</h2>
          </div>
          <div className="status-summary">
            <span>{stageLabel}</span>
            <strong>{statusText[snapshot.auction.status]}</strong>
          </div>
          <div className="countdown">{formatRemaining(remaining)}</div>
          <div className="progress">
            <span style={{ width: `${progress}%` }} />
          </div>
          {inExtendWindow ? (
            <div className="extend-alert">已进入自动延时窗口，新的有效出价会延长结束时间</div>
          ) : null}
          <div className="rule-list">
            <span>封顶进度：{progress.toFixed(0)}%</span>
            <span>延时阈值：结束前 {snapshot.auction.extendThresholdSeconds} 秒</span>
            <span>每次延时：{snapshot.auction.extendSeconds} 秒</span>
            <span>
              延时次数：{snapshot.auction.extendCount}/{snapshot.auction.maxExtendCount}
            </span>
          </div>
          {lastBid ? (
            <div className="latest-bid">
              <span>最新出价</span>
              <strong>
                {lastBid.nickname} / {formatMoney(lastBid.price)}
              </strong>
            </div>
          ) : null}
        </section>

        <section className="panel-section">
          <div className="section-title">
            <CircleDollarSign size={18} />
            <h2>用户出价</h2>
          </div>
          <label className="field">
            <span>昵称</span>
            <input value={nickname} onChange={(event) => setNickname(event.target.value)} />
          </label>
          <label className="field">
            <span>出价金额</span>
            <input
              type="number"
              min={nextBid}
              step={snapshot.auction.incrementStep}
              value={bidPrice}
              onChange={(event) => setBidPrice(event.target.value)}
            />
          </label>
          <p className={canBid ? "bid-helper ok" : "bid-helper"}>{bidFeedback}</p>
          <button
            className="primary-button"
            disabled={!canBid}
            onClick={placeUserBid}
          >
            {submittingBid ? "出价提交中" : `出价 ${formatMoney(Number(bidPrice || nextBid))}`}
          </button>
        </section>

        <section className="panel-section">
          <div className="section-title">
            <Bot size={18} />
            <h2>AI 竞拍助手</h2>
          </div>
          <div className="button-row ai-actions">
            <button disabled={aiLoading} onClick={() => runAiTask("script")}>
              <FileText size={16} />
              <span>{aiTask === "script" ? "生成中" : "讲解词"}</span>
            </button>
            <button disabled={aiLoading} onClick={() => runAiTask("summary")}>
              <BarChart3 size={16} />
              <span>{aiTask === "summary" ? "生成中" : "竞拍复盘"}</span>
            </button>
            <button disabled={aiLoading} onClick={() => runAiTask("risk")}>
              <ShieldAlert size={16} />
              <span>{aiTask === "risk" ? "生成中" : "风险提示"}</span>
            </button>
          </div>
          {aiLoading ? (
            <div className="ai-box ai-loading">
              <div className="ai-title">
                <Sparkles className="spin" size={16} />
                <strong>{aiTask ? `${aiTaskText[aiTask]}生成中` : "AI 助手生成中"}</strong>
              </div>
              <p>正在结合当前竞拍状态生成可演示结果。</p>
            </div>
          ) : aiResult ? (
            <div className="ai-box">
              <div className="ai-title">
                {aiResult.level ? <ShieldAlert size={16} /> : <Bot size={16} />}
                <strong>{aiResult.title}</strong>
              </div>
              <div className="ai-meta">
                <span className={`source-badge source-${aiResult.source}`}>
                  {aiResult.source === "model" ? "模型生成" : "本地兜底"}
                </span>
                {aiResult.level ? (
                  <span className={`risk-badge risk-${getRiskClass(aiResult.level)}`}>
                    风险{aiResult.level}
                  </span>
                ) : null}
                <span>{formatTime(aiResult.generatedAt)}</span>
              </div>
              <p className="ai-content">{aiResult.content}</p>
            </div>
          ) : (
            <div className="ai-empty">
              <Sparkles size={18} />
              <p>可生成商品讲解词、竞拍复盘或异常出价提示。</p>
            </div>
          )}
        </section>

        <section className="panel-section">
          <div className="section-title">
            <RotateCcw size={18} />
            <h2>主播操作</h2>
          </div>
          <div className="button-row">
            <button onClick={startAuction}>开始/重开竞拍</button>
            <button className="danger" disabled={snapshot.auction.status !== "ACTIVE"} onClick={cancelAuction}>
              取消竞拍
            </button>
          </div>
        </section>

        <section className="panel-section">
          <div className="section-title">
            <BadgeCheck size={18} />
            <h2>成交结果</h2>
          </div>
          {snapshot.order ? (
            <div className="order-box">
              <div className="order-head">
                <UserCheck size={18} />
                <strong>{snapshot.order.buyerNickname}</strong>
                <span className={snapshot.order.status === "PAID" ? "pay-status paid" : "pay-status"}>
                  {snapshot.order.status === "PAID" ? "已支付" : "待支付"}
                </span>
              </div>
              <div className="order-grid">
                <span>成交价</span>
                <strong>{formatMoney(snapshot.order.finalPrice)}</strong>
                <span>订单号</span>
                <strong>{snapshot.order.id.slice(0, 8)}</strong>
              </div>
              <button disabled={snapshot.order.status === "PAID"} onClick={payOrder}>
                <CreditCard size={16} />
                <span>{snapshot.order.status === "PAID" ? "支付已完成" : "模拟支付"}</span>
              </button>
            </div>
          ) : (
            <p className="muted">暂无成交订单</p>
          )}
        </section>

        <section className="panel-section">
          <h2>实时出价记录</h2>
          <div className="bid-list">
            {snapshot.bids.length === 0 ? (
              <p className="muted">暂无出价</p>
            ) : (
              snapshot.bids.map((bid, index) => (
                <div className={index === 0 ? "bid-row is-latest" : "bid-row"} key={bid.id}>
                  <div>
                    <span>{bid.nickname}</span>
                    <small>
                      <Clock3 size={13} />
                      {formatTime(bid.createdAt)}
                    </small>
                  </div>
                  <strong>{formatMoney(bid.price)}</strong>
                </div>
              ))
            )}
          </div>
        </section>
      </aside>
    </main>
  );
}

function Metric(props: { label: string; value: string }) {
  return (
    <div className="metric-card">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function getStageLabel(status: AuctionStatus) {
  if (status === "ACTIVE") {
    return "距结束";
  }

  if (status === "PENDING") {
    return "等待主播开始";
  }

  if (status === "SOLD") {
    return "竞拍成交";
  }

  if (status === "UNSOLD") {
    return "未产生有效出价";
  }

  return "流程已取消";
}

function getStageDetail(snapshot: AuctionSnapshot, remaining: number) {
  const { auction } = snapshot;

  if (auction.status === "ACTIVE") {
    return `当前最低可出价 ${formatMoney(auction.currentPrice + auction.incrementStep)}，剩余 ${formatRemaining(remaining)}。`;
  }

  if (auction.status === "SOLD" && snapshot.order) {
    return `已生成待支付订单，买家 ${snapshot.order.buyerNickname}，成交价 ${formatMoney(snapshot.order.finalPrice)}。`;
  }

  if (auction.status === "UNSOLD") {
    return "倒计时结束且没有有效出价，本场竞拍流拍。";
  }

  if (auction.status === "CANCELLED") {
    return "主播已取消本场模拟竞拍，可重新开始演示。";
  }

  return "点击开始竞拍后，用户出价会通过 Socket.IO 实时同步到所有窗口。";
}

function getBidFeedback(input: {
  status: AuctionStatus;
  connected: boolean;
  nickname: string;
  bidAmount: number;
  nextBid: number;
}) {
  if (input.status !== "ACTIVE") {
    return "竞拍开始后可出价";
  }

  if (!input.connected) {
    return "等待实时连接恢复";
  }

  if (!input.nickname.trim()) {
    return "请填写昵称后再出价";
  }

  if (!Number.isFinite(input.bidAmount) || input.bidAmount <= 0) {
    return `最低出价 ${formatMoney(input.nextBid)}`;
  }

  if (input.bidAmount < input.nextBid) {
    return `当前最低出价 ${formatMoney(input.nextBid)}`;
  }

  return "本次出价满足规则，提交后会实时广播";
}

function getRiskClass(level: string) {
  if (level === "高") {
    return "high";
  }

  if (level === "中") {
    return "medium";
  }

  return "low";
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    maximumFractionDigits: 0
  }).format(value);
}

function formatTime(value: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(value));
}

function formatRemaining(ms: number) {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const centiseconds = Math.floor((ms % 1000) / 10);

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}
