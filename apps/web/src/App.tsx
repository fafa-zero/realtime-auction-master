import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, BadgeCheck, CircleDollarSign, Radio, RotateCcw, Timer, Wifi, WifiOff } from "lucide-react";
import { io, type Socket } from "socket.io-client";
import type { AuctionSnapshot } from "./types";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

const statusText = {
  PENDING: "待开始",
  ACTIVE: "竞拍中",
  SOLD: "已成交",
  UNSOLD: "已流拍",
  CANCELLED: "已取消"
};

export function App() {
  const [snapshot, setSnapshot] = useState<AuctionSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [userId] = useState(() => `user-${Math.floor(Math.random() * 9000 + 1000)}`);
  const [nickname, setNickname] = useState(() => `用户${Math.floor(Math.random() * 90 + 10)}`);
  const [bidPrice, setBidPrice] = useState("");
  const [message, setMessage] = useState("正在连接竞拍服务...");
  const [now, setNow] = useState(Date.now());
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    fetch(`${API_URL}/api/auction`)
      .then((res) => res.json())
      .then((data: AuctionSnapshot) => {
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

    return Math.max(0, snapshot.auction.endTime - now);
  }, [now, snapshot?.auction.endTime]);

  const nextBid = snapshot ? snapshot.auction.currentPrice + snapshot.auction.incrementStep : 0;
  const progress = snapshot
    ? Math.min(100, (snapshot.auction.currentPrice / snapshot.auction.ceilingPrice) * 100)
    : 0;

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

    socketRef.current.emit(
      "auction:bid",
      {
        userId,
        nickname,
        price
      },
      (response: { ok: boolean; message?: string }) => {
        if (!response.ok) {
          setMessage(response.message ?? "出价失败");
          return;
        }

        setMessage("出价成功，等待广播同步");
      }
    );
  }

  async function payOrder() {
    if (!snapshot?.order) {
      return;
    }

    const res = await fetch(`${API_URL}/api/orders/${snapshot.order.id}/pay`, { method: "POST" });
    const data = await res.json();

    if (!res.ok) {
      setMessage(data.message ?? "支付失败");
      return;
    }

    setSnapshot({
      ...snapshot,
      order: data
    });
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
          </div>
        </div>

        <div className="product-strip">
          <div>
            <p className="eyebrow">当前商品</p>
            <h2>{snapshot.product.name}</h2>
            <p>{snapshot.product.description}</p>
          </div>
          <div className="status-pill">{statusText[snapshot.auction.status]}</div>
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

        <section className="panel-section">
          <div className="section-title">
            <Timer size={18} />
            <h2>竞拍状态</h2>
          </div>
          <div className="countdown">{formatRemaining(remaining)}</div>
          <div className="progress">
            <span style={{ width: `${progress}%` }} />
          </div>
          <div className="rule-list">
            <span>延时阈值：结束前 {snapshot.auction.extendThresholdSeconds} 秒</span>
            <span>每次延时：{snapshot.auction.extendSeconds} 秒</span>
            <span>
              延时次数：{snapshot.auction.extendCount}/{snapshot.auction.maxExtendCount}
            </span>
          </div>
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
          <button className="primary-button" disabled={snapshot.auction.status !== "ACTIVE"} onClick={placeUserBid}>
            出价 {formatMoney(Number(bidPrice || nextBid))}
          </button>
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
              <strong>{snapshot.order.buyerNickname}</strong>
              <span>成交价：{formatMoney(snapshot.order.finalPrice)}</span>
              <span>状态：{snapshot.order.status === "PAID" ? "已支付" : "待支付"}</span>
              <button disabled={snapshot.order.status === "PAID"} onClick={payOrder}>
                模拟支付
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
              snapshot.bids.map((bid) => (
                <div className="bid-row" key={bid.id}>
                  <span>{bid.nickname}</span>
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

function formatMoney(value: number) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    maximumFractionDigits: 0
  }).format(value);
}

function formatRemaining(ms: number) {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const centiseconds = Math.floor((ms % 1000) / 10);

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}
