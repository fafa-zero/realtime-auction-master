import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  BarChart3,
  Bot,
  CircleDollarSign,
  Clock3,
  CreditCard,
  Flame,
  FileText,
  History,
  Radio,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Timer,
  TrendingUp,
  UserCheck,
  Users,
  Wifi,
  WifiOff
} from "lucide-react";
import { io, type Socket } from "socket.io-client";
import type { AuctionHistoryItem, AuctionSnapshot, AuctionStatus, LiveRoom, Order } from "./types";

const API_URL = import.meta.env.VITE_API_URL ?? "";
const DEFAULT_LIVE_ROOM_ID = "live-1";

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
type ViewMode = "host" | "buyer";
type AppRoute = {
  viewMode: ViewMode;
  liveRoomId: string;
  notFound?: boolean;
  redirectTo?: string;
};

const aiTaskText: Record<AiTask, string> = {
  script: "讲解词",
  summary: "竞拍复盘",
  risk: "风险提示"
};

const demoBidders = [
  { userId: "demo-user-a", nickname: "演示用户A", stepMultiplier: 1 },
  { userId: "demo-user-b", nickname: "演示用户B", stepMultiplier: 2 },
  { userId: "demo-user-c", nickname: "演示用户C", stepMultiplier: 3 }
];

export function App() {
  const [route, setRoute] = useState<AppRoute>(() => parseRoute(getCurrentPath()));
  const [snapshot, setSnapshot] = useState<AuctionSnapshot | null>(null);
  const [liveRoom, setLiveRoom] = useState<LiveRoom | null>(null);
  const [liveRooms, setLiveRooms] = useState<LiveRoom[]>([]);
  const [connected, setConnected] = useState(false);
  const [userId] = useState(() => `user-${Math.floor(Math.random() * 9000 + 1000)}`);
  const [nickname, setNickname] = useState(() => `用户${Math.floor(Math.random() * 90 + 10)}`);
  const [bidPrice, setBidPrice] = useState("");
  const [durationSeconds, setDurationSeconds] = useState("90");
  const [incrementStep, setIncrementStep] = useState("100");
  const [ceilingPrice, setCeilingPrice] = useState("3000");
  const [message, setMessage] = useState("正在连接竞拍服务...");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [serverOffset, setServerOffset] = useState(0);
  const [submittingBid, setSubmittingBid] = useState(false);
  const [aiResult, setAiResult] = useState<AiResult | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiTask, setAiTask] = useState<AiTask | null>(null);
  const [historyItems, setHistoryItems] = useState<AuctionHistoryItem[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const socketRef = useRef<Socket | null>(null);
  const viewMode = route.viewMode;
  const liveRoomId = route.liveRoomId;

  useEffect(() => {
    const onPopState = () => setRoute(parseRoute(getCurrentPath()));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (!route.redirectTo) {
      return;
    }

    window.history.replaceState(null, "", route.redirectTo);
    setRoute(parseRoute(route.redirectTo));
  }, [route.redirectTo]);

  useEffect(() => {
    if (route.notFound) {
      return;
    }

    let cancelled = false;
    setSnapshot(null);
    setLiveRoom(null);
    setLoadError(null);
    setConnected(false);
    setMessage(`正在进入直播间 ${liveRoomId}...`);

    async function loadInitialData() {
      try {
        const [roomRes, auctionRes] = await Promise.all([
          fetch(`${API_URL}/api/live-rooms/${encodeURIComponent(liveRoomId)}`),
          fetch(`${API_URL}/api/live-rooms/${encodeURIComponent(liveRoomId)}/auction`)
        ]);
        const roomData = (await roomRes.json()) as { room?: LiveRoom; message?: string };
        const auctionData = (await auctionRes.json()) as AuctionSnapshot & { message?: string };

        if (!roomRes.ok) {
          throw new Error(roomData.message ?? "直播间不存在");
        }

        if (!auctionRes.ok) {
          throw new Error(auctionData.message ?? "无法获取竞拍数据");
        }

        if (cancelled) {
          return;
        }

        setLiveRoom(roomData.room ?? null);
        syncSnapshotClock(auctionData);
        setSnapshot(auctionData);
        setBidPrice(String(auctionData.auction.currentPrice + auctionData.auction.incrementStep));
        setDurationSeconds(String(auctionData.auction.durationSeconds));
        setIncrementStep(String(auctionData.auction.incrementStep));
        setCeilingPrice(String(auctionData.auction.ceilingPrice));
        void refreshArchiveData();
      } catch (error) {
        if (cancelled) {
          return;
        }

        setLoadError(error instanceof Error ? error.message : "无法进入直播间，请确认后端已启动");
        setMessage("无法进入直播间");
      }
    }

    void loadInitialData();

    const socket = io(API_URL, {
      transports: ["websocket", "polling"],
      reconnectionAttempts: 10
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      setMessage("已连接实时竞拍服务");
      socket.emit("auction:join", { liveRoomId });
    });

    socket.on("disconnect", () => {
      setConnected(false);
      setMessage("连接已断开，正在自动重连");
    });

    const updateSnapshot = (data: AuctionSnapshot) => {
      if (data.auction.liveRoomId !== liveRoomId) {
        return false;
      }

      syncSnapshotClock(data);
      setSnapshot((current) => {
        if (current && data.auction.version < current.auction.version) {
          return current;
        }

        setBidPrice(String(data.auction.currentPrice + data.auction.incrementStep));
        setDurationSeconds(String(data.auction.durationSeconds));
        setIncrementStep(String(data.auction.incrementStep));
        setCeilingPrice(String(data.auction.ceilingPrice));
        return data;
      });
      return true;
    };

    socket.on("auction:snapshot", updateSnapshot);
    socket.on("auction:started", (data: AuctionSnapshot) => {
      if (updateSnapshot(data)) {
        setMessage("竞拍已开始");
      }
    });
    socket.on("auction:bid-success", (data: AuctionSnapshot) => {
      if (updateSnapshot(data)) {
        setMessage(`当前最高价已更新为 ${formatMoney(data.auction.currentPrice)}`);
      }
    });
    socket.on("auction:extended", (data: AuctionSnapshot) => {
      if (updateSnapshot(data)) {
        setMessage(`触发自动延时，结束时间延长 ${data.auction.extendSeconds} 秒`);
      }
    });
    socket.on("auction:ended", (data: AuctionSnapshot) => {
      if (updateSnapshot(data)) {
        setMessage(data.auction.status === "SOLD" ? "竞拍已成交" : "竞拍已结束");
        void refreshArchiveData();
      }
    });
    socket.on("auction:cancelled", (result: { reason: string; snapshot: AuctionSnapshot }) => {
      if (updateSnapshot(result.snapshot)) {
        setMessage(`竞拍已取消：${result.reason}`);
        void refreshArchiveData();
      }
    });
    socket.on("order:paid", (data: AuctionSnapshot) => {
      if (updateSnapshot(data)) {
        void refreshArchiveData();
      }
    });
    socket.on("auction:error", (data: { message?: string }) => {
      setMessage(data.message ?? "实时消息订阅失败");
    });

    function syncSnapshotClock(data: AuctionSnapshot) {
      setServerOffset(data.serverTime - Date.now());
    }

    return () => {
      cancelled = true;
      socket.disconnect();
    };
  }, [liveRoomId, route.notFound]);

  useEffect(() => {
    fetch(`${API_URL}/api/live-rooms`)
      .then((res) => res.json())
      .then((data: { items?: LiveRoom[] }) => setLiveRooms(data.items ?? []))
      .catch(() => {
        // The page can still operate with the current room snapshot.
      });
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
  const myHistory = historyItems.filter((item) =>
    item.bids.some((bid) => bid.userId === userId || bid.nickname === nickname)
  );

  async function startAuction() {
    const duration = Number(durationSeconds);
    const step = Number(incrementStep);
    const ceiling = Number(ceilingPrice);

    if (!Number.isInteger(duration) || duration < 15 || duration > 600) {
      setMessage("竞拍时长必须是 15 到 600 秒的整数");
      return;
    }

    if (!Number.isInteger(step) || step < 1) {
      setMessage("最低加价必须是大于 0 的整数");
      return;
    }

    if (!Number.isInteger(ceiling) || ceiling < step) {
      setMessage("封顶价必须是整数，并且不能低于首次最低出价");
      return;
    }

    const res = await fetch(`${API_URL}/api/live-rooms/${encodeURIComponent(liveRoomId)}/auction/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        durationSeconds: duration,
        incrementStep: step,
        ceilingPrice: ceiling
      })
    });
    const data = await res.json();

    if (!res.ok) {
      setMessage(data.message ?? "启动竞拍失败");
      return;
    }

    setSnapshot(data);
    setMessage("竞拍已启动");
    void refreshArchiveData();
  }

  async function cancelAuction() {
    const res = await fetch(`${API_URL}/api/live-rooms/${encodeURIComponent(liveRoomId)}/auction/cancel`, {
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
    void refreshArchiveData();
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
    emitBid({
      userId,
      nickname: cleanNickname,
      price,
      onDone: () => {
        setSubmittingBid(false);
      }
    });
  }

  function placeDemoBid(bidder: (typeof demoBidders)[number]) {
    if (!snapshot) {
      return;
    }

    const price = Math.min(
      snapshot.auction.ceilingPrice,
      snapshot.auction.currentPrice + snapshot.auction.incrementStep * bidder.stepMultiplier
    );

    emitBid({
      userId: bidder.userId,
      nickname: bidder.nickname,
      price
    });
  }

  function placeCeilingBid() {
    if (!snapshot) {
      return;
    }

    emitBid({
      userId: "demo-user-final",
      nickname: "封顶买家",
      price: snapshot.auction.ceilingPrice
    });
  }

  function emitBid(input: {
    userId: string;
    nickname: string;
    price: number;
    onDone?: () => void;
  }) {
    if (!socketRef.current) {
      setMessage("实时连接未就绪，无法出价");
      input.onDone?.();
      return;
    }

    socketRef.current.emit(
      "auction:bid",
      {
        userId: input.userId,
        liveRoomId,
        nickname: input.nickname,
        price: input.price,
        clientRequestId: `${input.userId}-${Date.now()}-${Math.random().toString(16).slice(2)}`
      },
      (response: { ok: boolean; message?: string }) => {
        input.onDone?.();

        if (!response.ok) {
          setMessage(response.message ?? "出价失败");
          return;
        }

        setMessage(`${input.nickname} 出价 ${formatMoney(input.price)}，等待广播同步`);
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
    void refreshArchiveData();
  }

  async function refreshArchiveData() {
    try {
      const [historyRes, ordersRes] = await Promise.all([
        fetch(`${API_URL}/api/live-rooms/${encodeURIComponent(liveRoomId)}/auction/history`),
        fetch(`${API_URL}/api/live-rooms/${encodeURIComponent(liveRoomId)}/orders`)
      ]);
      const historyData = (await historyRes.json()) as { items?: AuctionHistoryItem[] };
      const ordersData = (await ordersRes.json()) as { items?: Order[] };

      setHistoryItems(historyData.items ?? []);
      setOrders(ordersData.items ?? []);
    } catch {
      // Archive panels are secondary; keep the live auction usable if history fetch fails.
    }
  }

  if (route.notFound || loadError) {
    return (
      <RouteError
        title={route.notFound ? "页面不存在" : "无法进入直播间"}
        message={loadError ?? "请检查访问路径，主播端使用 /host，观众预览页使用 /live/live-1。"}
        onGoHost={() => navigateTo("/host", setRoute)}
        onGoLive={() => navigateTo(`/live/${DEFAULT_LIVE_ROOM_ID}`, setRoute)}
      />
    );
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
              <h1>{viewMode === "host" ? "直播间竞拍控制台" : "观众实时竞拍台"}</h1>
              <p className="topbar-meta">{syncLabel} / Socket.IO 多端广播</p>
            </div>
          <div className="topbar-actions">
            {viewMode === "host" ? (
              <label className="room-select">
                <span>直播间</span>
                <select
                  value={liveRoomId}
                  onChange={(event) => navigateTo(`/host?liveRoomId=${encodeURIComponent(event.target.value)}`, setRoute)}
                >
                  {(liveRooms.length > 0 ? liveRooms : liveRoom ? [liveRoom] : []).map((room) => (
                    <option value={room.id} key={room.id}>
                      {room.title}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <div className="mode-switch" aria-label="视图切换">
              <button
                className={viewMode === "host" ? "active" : ""}
                onClick={() => navigateTo(`/host?liveRoomId=${encodeURIComponent(liveRoomId)}`, setRoute)}
              >
                <Radio size={16} />
                主播端
              </button>
              <button
                className={viewMode === "buyer" ? "active" : ""}
                onClick={() => navigateTo(`/live/${liveRoomId}`, setRoute)}
              >
                <Users size={16} />
                Web 预览
              </button>
            </div>
            <div className={connected ? "connection online" : "connection offline"}>
              {connected ? <Wifi size={18} /> : <WifiOff size={18} />}
              {connected ? "实时连接" : "重连中"}
            </div>
          </div>
        </div>

        <div className="live-stage">
          <div className="live-badge">
            <Radio size={16} />
            LIVE
          </div>
          <img src={snapshot.product.imageUrl} alt={snapshot.product.name} />
          <div className="live-overlay">
            <p>{liveRoom ? `${liveRoom.hostName} / ${liveRoom.id}` : "抖音电商直播模拟"}</p>
            <strong>{snapshot.product.name}</strong>
            <div className="live-meta">
              <span>
                <TrendingUp size={15} />
                当前价 {formatMoney(snapshot.auction.currentPrice)}
              </span>
              <span>{liveRoom?.viewerCount ?? snapshot.participantCount} 人正在观看</span>
              <span>{liveRoom?.title ?? "模拟直播间"}</span>
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

        {viewMode === "buyer" ? (
          <section className="panel-section buyer-guide">
            <div className="section-title">
              <Users size={18} />
              <h2>观众提醒</h2>
            </div>
            <div className="buyer-guide-grid">
              <span>领先用户</span>
              <strong>{snapshot.auction.winnerNickname ?? "暂无"}</strong>
              <span>下一口价</span>
              <strong>{formatMoney(nextBid)}</strong>
              <span>我的身份</span>
              <strong>{nickname}</strong>
            </div>
          </section>
        ) : null}

        <section className="panel-section">
          <div className="section-title">
            <CircleDollarSign size={18} />
            <h2>{viewMode === "host" ? "用户出价" : "我要出价"}</h2>
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

        {viewMode === "host" ? (
          <>
            <section className="panel-section demo-panel">
              <div className="section-title">
                <Flame size={18} />
                <h2>演示出价工具</h2>
              </div>
              <div className="demo-bid-grid">
                {demoBidders.map((bidder) => (
                  <button
                    disabled={snapshot.auction.status !== "ACTIVE" || !connected}
                    key={bidder.userId}
                    onClick={() => placeDemoBid(bidder)}
                  >
                    <span>{bidder.nickname}</span>
                    <strong>
                      +{formatMoney(snapshot.auction.incrementStep * bidder.stepMultiplier)}
                    </strong>
                  </button>
                ))}
              </div>
              <button
                className="ceiling-button"
                disabled={snapshot.auction.status !== "ACTIVE" || !connected}
                onClick={placeCeilingBid}
              >
                封顶出价 {formatMoney(snapshot.auction.ceilingPrice)}
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
              <div className="settings-grid">
                <label className="field">
                  <span>竞拍时长（秒）</span>
                  <input
                    type="number"
                    min={15}
                    max={600}
                    value={durationSeconds}
                    onChange={(event) => setDurationSeconds(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>最低加价</span>
                  <input
                    type="number"
                    min={1}
                    value={incrementStep}
                    onChange={(event) => setIncrementStep(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>封顶价</span>
                  <input
                    type="number"
                    min={1}
                    value={ceilingPrice}
                    onChange={(event) => setCeilingPrice(event.target.value)}
                  />
                </label>
              </div>
              <div className="button-row">
                <button onClick={startAuction}>开始/重开竞拍</button>
                <button
                  className="danger"
                  disabled={snapshot.auction.status !== "ACTIVE"}
                  onClick={cancelAuction}
                >
                  取消竞拍
                </button>
              </div>
            </section>

            <section className="panel-section">
              <div className="section-title">
                <History size={18} />
                <h2>订单管理</h2>
              </div>
              <ArchiveList
                emptyText="暂无历史订单"
                items={orders.slice(0, 5).map((item) => ({
                  id: item.id,
                  title: item.buyerNickname,
                  meta: `${formatMoney(item.finalPrice)} / ${
                    item.status === "PAID" ? "已支付" : "待支付"
                  }`,
                  time: item.createdAt
                }))}
              />
            </section>
          </>
        ) : null}

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

        {viewMode === "buyer" ? (
          <section className="panel-section">
            <div className="section-title">
              <History size={18} />
              <h2>我的竞拍</h2>
            </div>
            <ArchiveList
              emptyText="暂无参与记录"
              items={myHistory.slice(0, 5).map((item) => ({
                id: `${item.auction.startTime ?? item.archivedAt}`,
                title: item.product.name,
                meta: `${statusText[item.auction.status]} / 最高价 ${formatMoney(item.auction.currentPrice)}`,
                time: item.archivedAt
              }))}
            />
          </section>
        ) : null}
      </aside>
    </main>
  );
}

function ArchiveList(props: {
  emptyText: string;
  items: Array<{
    id: string;
    title: string;
    meta: string;
    time: number;
  }>;
}) {
  if (props.items.length === 0) {
    return <p className="muted">{props.emptyText}</p>;
  }

  return (
    <div className="archive-list">
      {props.items.map((item) => (
        <div className="archive-row" key={item.id}>
          <div>
            <strong>{item.title}</strong>
            <span>{item.meta}</span>
          </div>
          <small>{formatTime(item.time)}</small>
        </div>
      ))}
    </div>
  );
}

function RouteError(props: {
  title: string;
  message: string;
  onGoHost: () => void;
  onGoLive: () => void;
}) {
  return (
    <main className="route-error">
      <div>
        <Radio size={28} />
        <p className="eyebrow">实时竞拍大师</p>
        <h1>{props.title}</h1>
        <p>{props.message}</p>
        <div className="route-error-actions">
          <button onClick={props.onGoHost}>进入主播端</button>
          <button className="primary-button" onClick={props.onGoLive}>
            打开观众预览
          </button>
        </div>
      </div>
    </main>
  );
}

function parseRoute(pathname: string): AppRoute {
  const url = new URL(pathname, window.location.origin);
  const cleanPath = url.pathname.replace(/\/+$/, "") || "/";
  const queryLiveRoomId = url.searchParams.get("liveRoomId") ?? undefined;

  if (cleanPath === "/") {
    return {
      viewMode: "buyer",
      liveRoomId: DEFAULT_LIVE_ROOM_ID,
      redirectTo: `/live/${DEFAULT_LIVE_ROOM_ID}`
    };
  }

  if (cleanPath === "/host") {
    return {
      viewMode: "host",
      liveRoomId: queryLiveRoomId || DEFAULT_LIVE_ROOM_ID
    };
  }

  if (cleanPath.startsWith("/live/")) {
    const [, , rawLiveRoomId] = cleanPath.split("/");
    const liveRoomId = rawLiveRoomId ? decodeURIComponent(rawLiveRoomId) : DEFAULT_LIVE_ROOM_ID;

    return {
      viewMode: "buyer",
      liveRoomId
    };
  }

  return {
    viewMode: "buyer",
    liveRoomId: DEFAULT_LIVE_ROOM_ID,
    notFound: true
  };
}

function navigateTo(path: string, setRoute: (route: AppRoute) => void) {
  window.history.pushState(null, "", path);
  setRoute(parseRoute(path));
}

function getCurrentPath() {
  return `${window.location.pathname}${window.location.search}`;
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
