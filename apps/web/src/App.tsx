import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  BarChart3,
  Bot,
  CircleDollarSign,
  Clock3,
  CreditCard,
  FileText,
  History,
  LogOut,
  Pencil,
  PlusCircle,
  Package,
  PlayCircle,
  Radio,
  Save,
  RotateCcw,
  Trash2,
  ShieldAlert,
  Sparkles,
  Timer,
  TrendingUp,
  Upload,
  UserCheck,
  Users,
  Wifi,
  WifiOff
} from "lucide-react";
import { io, type Socket } from "socket.io-client";
import type {
  AuctionHistoryItem,
  AuctionSnapshot,
  AuctionStatus,
  AuthUser,
  DanmakuBlockedUser,
  DanmakuMessage,
  LiveRoom,
  Order,
  BidRisk,
  ProductQueueItem
} from "./types";

const API_URL = resolveApiUrl(import.meta.env.VITE_API_URL);
const DEFAULT_LIVE_ROOM_ID = "live-1";
const SESSION_STORAGE_KEY = "auction_web_session";
const demoWebAccounts = {
  HOST: { account: "demo-host", password: "demo123" },
  BUYER: { account: "demo-buyer", password: "demo123" }
} as const;

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
  product?: AuctionSnapshot["product"];
};

type WebSession = {
  token: string;
  user: AuthUser;
};

type RegisterInput = {
  account: string;
  password: string;
  nickname: string;
  role: "HOST" | "BUYER";
};

type CreateRoomInput = {
  title: string;
  hostName: string;
  productName: string;
  productDescription: string;
  startPrice: string;
  incrementStep: string;
  ceilingPrice: string;
  durationSeconds: string;
  stock: string;
};

type ProductFormInput = {
  name: string;
  description: string;
  imageUrl: string;
  startPrice: string;
  incrementStep: string;
  ceilingPrice: string;
  durationSeconds: string;
  stock: string;
  sellingPoints: string;
  scriptKeywords: string;
};

type ImportResult = {
  importedCount: number;
  failedRows: Array<{ rowNumber: number; reason: string }>;
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
  home?: boolean;
  setup?: boolean;
  notFound?: boolean;
};

const aiTaskText: Record<AiTask, string> = {
  script: "讲解词",
  summary: "竞拍复盘",
  risk: "风险提示"
};

function resolveApiUrl(configuredApiUrl?: string) {
  const value = configuredApiUrl?.trim();

  if (!value) {
    return "";
  }

  try {
    const apiUrl = new URL(value, window.location.origin);
    const pageHost = window.location.hostname;
    const isPageLocal = pageHost === "localhost" || pageHost === "127.0.0.1";
    const isApiLocal = apiUrl.hostname === "localhost" || apiUrl.hostname === "127.0.0.1";

    if (!isPageLocal && isApiLocal) {
      return "";
    }

    return apiUrl.toString().replace(/\/$/, "");
  } catch {
    return value;
  }
}

export function App() {
  const [route, setRoute] = useState<AppRoute>(() => parseRoute(getCurrentPath()));
  const [session, setSession] = useState<WebSession | null>(() => readStoredSession());
  const [authChecked, setAuthChecked] = useState(false);
  const [snapshot, setSnapshot] = useState<AuctionSnapshot | null>(null);
  const [liveRoom, setLiveRoom] = useState<LiveRoom | null>(null);
  const [liveRooms, setLiveRooms] = useState<LiveRoom[]>([]);
  const [connected, setConnected] = useState(false);
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
  const [productQueue, setProductQueue] = useState<ProductQueueItem[]>([]);
  const [danmakuMessages, setDanmakuMessages] = useState<DanmakuMessage[]>([]);
  const [danmakuBlockedUsers, setDanmakuBlockedUsers] = useState<DanmakuBlockedUser[]>([]);
  const [danmakuText, setDanmakuText] = useState("");
  const [sendingDanmaku, setSendingDanmaku] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importingProducts, setImportingProducts] = useState(false);
  const [productForm, setProductForm] = useState<ProductFormInput>(() => createEmptyProductForm());
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [savingProduct, setSavingProduct] = useState(false);
  const [resettingDemo, setResettingDemo] = useState(false);
  const [authMessage, setAuthMessage] = useState("");
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const socketRef = useRef<Socket | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const currentUser = session?.user ?? null;
  const userId = currentUser?.id ?? "guest-web";
  const viewMode = route.viewMode;
  const liveRoomId = route.liveRoomId;

  useEffect(() => {
    const onPopState = () => setRoute(parseRoute(getCurrentPath()));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function verifySession() {
      if (!session?.token) {
        setAuthChecked(true);
        return;
      }

      try {
        const res = await fetch(`${API_URL}/api/me`, {
          headers: { Authorization: `Bearer ${session.token}` }
        });
        const data = await readJson<{ user?: AuthUser }>(res);

        if (!res.ok || !data.user) {
          throw new Error("登录已失效");
        }

        if (!cancelled) {
          const nextSession = { token: session.token, user: data.user };
          setSession(nextSession);
          writeStoredSession(nextSession);
          setAuthChecked(true);
        }
      } catch {
        if (!cancelled) {
          setSession(null);
          writeStoredSession(null);
          setAuthChecked(true);
        }
      }
    }

    void verifySession();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (currentUser?.nickname) {
      setNickname(currentUser.nickname);
    }
  }, [currentUser?.nickname]);

  useEffect(() => {
    if (
      route.notFound ||
      route.home ||
      route.setup ||
      !session ||
      viewMode !== "host" ||
      liveRoomId !== DEFAULT_LIVE_ROOM_ID ||
      session.user.account === "demo-host"
    ) {
      return;
    }

    let cancelled = false;

    async function routeHostToOwnedRoom() {
      try {
        const roomId = await resolveHostEntryRoom(session as WebSession);

        if (cancelled) {
          return;
        }

        navigateTo(roomId ? `/host?liveRoomId=${encodeURIComponent(roomId)}` : "/host/setup", setRoute);
      } catch {
        if (!cancelled) {
          navigateTo("/host/setup", setRoute);
        }
      }
    }

    void routeHostToOwnedRoom();

    return () => {
      cancelled = true;
    };
  }, [
    liveRoomId,
    route.home,
    route.notFound,
    route.setup,
    session,
    session?.user.account,
    viewMode
  ]);

  useEffect(() => {
    if (route.notFound || route.home || route.setup || !session) {
      return;
    }

    let cancelled = false;
    setSnapshot(null);
    setLiveRoom(null);
    setDanmakuMessages([]);
    setDanmakuBlockedUsers([]);
    setLoadError(null);
    setConnected(false);
    setMessage(`正在进入直播间 ${liveRoomId}...`);

    async function loadInitialData() {
      try {
        const [roomRes, auctionRes] = await Promise.all([
          fetch(`${API_URL}/api/live-rooms/${encodeURIComponent(liveRoomId)}`),
          fetch(`${API_URL}/api/live-rooms/${encodeURIComponent(liveRoomId)}/auction`)
        ]);
        const roomData = await readJson<{ room?: LiveRoom; message?: string }>(roomRes);
        const auctionData = await readJson<AuctionSnapshot & { message?: string }>(auctionRes);

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
        void refreshProductQueue();
        void refreshDanmakuBlockedUsers();
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
    socket.on("danmaku:history", (items: DanmakuMessage[]) => {
      setDanmakuMessages((items ?? []).filter((item) => isVisibleDanmaku(item, liveRoomId)).slice(0, 80));
    });
    socket.on("danmaku:new", (item: DanmakuMessage) => {
      if (!isVisibleDanmaku(item, liveRoomId)) {
        return;
      }

      setDanmakuMessages((current) => {
        if (current.some((message) => message.id === item.id)) {
          return current;
        }

        return [item, ...current].slice(0, 80);
      });
    });
    socket.on("danmaku:retracted", (item: DanmakuMessage) => {
      if (item.liveRoomId !== liveRoomId) {
        return;
      }

      setDanmakuMessages((current) => current.filter((message) => message.id !== item.id));
      setMessage(`弹幕已撤回：${item.retractionReason ?? "主播撤回"}`);
    });
    socket.on("danmaku:user-blocked", (item: DanmakuBlockedUser) => {
      if (item.liveRoomId !== liveRoomId) {
        return;
      }

      setDanmakuMessages((current) => current.filter((message) => message.userId !== item.userId));
      setDanmakuBlockedUsers((current) => {
        const rest = current.filter((user) => user.userId !== item.userId);
        return [item, ...rest];
      });
      setMessage(`${item.nickname} 已被屏蔽：${item.reason}`);
    });
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
  }, [liveRoomId, route.home, route.notFound, session?.token, viewMode]);

  useEffect(() => {
    fetch(`${API_URL}/api/live-rooms`)
      .then((res) => readJson<{ items?: LiveRoom[] }>(res))
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
    if (!snapshot?.auction.endTime || snapshot.auction.status !== "ACTIVE") {
      return 0;
    }

    return Math.max(0, snapshot.auction.endTime - (now + serverOffset));
  }, [now, serverOffset, snapshot?.auction.endTime, snapshot?.auction.status]);

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
  const queueStats = getQueueStats(productQueue, orders);
  const currentQueueItem = snapshot
    ? productQueue.find((item) => item.product.id === snapshot.product.id) ?? null
    : null;
  const nextQueueItem =
    productQueue.find((item) => item.product.queueStatus === "QUEUED") ??
    productQueue.find((item) => item.auction.status === "PENDING") ??
    null;
  const awaitingNextProduct = Boolean(
    viewMode === "host" &&
      snapshot &&
      ["SOLD", "UNSOLD", "CANCELLED"].includes(snapshot.auction.status) &&
      nextQueueItem
  );
  const currentRoomDanmakuMessages = danmakuMessages.filter((item) => isVisibleDanmaku(item, liveRoomId));
  const visibleFlyingDanmaku = currentRoomDanmakuMessages.filter((item) => now - item.createdAt <= 8_000);

  async function handleDemoLogin(role: "HOST" | "BUYER") {
    setAuthMessage("正在登录演示账号...");
    try {
      const session = await loginWeb(demoWebAccounts[role]);
      setSession(session);
      writeStoredSession(session);
      setAuthMessage("");
      setMessage(`已登录：${session.user.nickname}`);

      if (role === "HOST") {
        const roomId = await resolveHostEntryRoom(session);
        navigateTo(roomId ? `/host?liveRoomId=${encodeURIComponent(roomId)}` : "/host/setup", setRoute);
      } else {
        navigateTo(`/live/${liveRoomId}`, setRoute);
      }
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : "登录失败");
    }
  }

  async function handleRegister(input: RegisterInput) {
    setAuthMessage("正在注册账号...");

    try {
      const result = await registerWeb(input);
      setAuthMessage(`账号 ${result.user.account ?? input.account} 注册成功，请登录`);
      setAuthMode("login");
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : "注册失败");
    }
  }

  async function handleManualLogin(input: { account: string; password: string }) {
    setAuthMessage("正在登录账号...");

    try {
      const session = await loginWeb(input);
      setSession(session);
      writeStoredSession(session);
      setAuthMessage("");
      setMessage(`已登录：${session.user.nickname}`);

      if (session.user.role === "BUYER") {
        navigateTo(`/live/${liveRoomId}`, setRoute);
      } else {
        const roomId = await resolveHostEntryRoom(session);
        navigateTo(roomId ? `/host?liveRoomId=${encodeURIComponent(roomId)}` : "/host/setup", setRoute);
      }
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : "登录失败");
    }
  }

  async function handleLogout() {
    setSession(null);
    writeStoredSession(null);
    setAuthMessage("");
    navigateTo("/", setRoute);
  }

  async function createHostRoom(input: CreateRoomInput) {
    if (!session) {
      setMessage("请先登录主播账号");
      return;
    }

    const payload = {
      title: input.title.trim(),
      hostName: input.hostName.trim() || currentUser?.nickname || "新主播",
      productName: input.productName.trim(),
      productDescription: input.productDescription.trim(),
      startPrice: Number(input.startPrice),
      incrementStep: Number(input.incrementStep),
      ceilingPrice: Number(input.ceilingPrice),
      durationSeconds: Number(input.durationSeconds),
      stock: Number(input.stock || 1)
    };
    const res = await fetch(`${API_URL}/api/live-rooms`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getAuthHeaders(session)
      },
      body: JSON.stringify(payload)
    });
    const data = await readJson<{ room?: LiveRoom; snapshot?: AuctionSnapshot; message?: string }>(res);

    if (!res.ok || !data.room) {
      setMessage(data.message ?? "创建直播间失败");
      throw new Error(data.message ?? "创建直播间失败");
    }

    setLiveRooms((current) => [data.room as LiveRoom, ...current.filter((room) => room.id !== data.room?.id)]);
    setMessage(`直播间已创建：${data.room.title}`);
    navigateTo(`/host?liveRoomId=${encodeURIComponent(data.room.id)}`, setRoute);
  }

  function goBack() {
    setSession(null);
    writeStoredSession(null);
    setAuthMode("login");
    setAuthMessage("已返回登录入口，可重新登录或注册账号");
    setMessage("已返回登录入口");
  }

  function renderFloatingBackButton() {
    if (route.home) {
      return null;
    }

    return (
      <button className="floating-back-button" onClick={goBack}>
        <ArrowLeft size={18} />
        返回登录/注册
      </button>
    );
  }

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
      headers: { "Content-Type": "application/json", ...getAuthHeaders(session) },
      body: JSON.stringify({
        durationSeconds: duration,
        incrementStep: step,
        ceilingPrice: ceiling
      })
    });
    const data = await readJson<AuctionSnapshot & { message?: string }>(res);

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
      headers: { "Content-Type": "application/json", ...getAuthHeaders(session) },
      body: JSON.stringify({ reason: "主播手动取消异常竞拍" })
    });
    const data = await readJson<AuctionSnapshot & { message?: string }>(res);

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
      token: viewMode === "buyer" ? session?.token : undefined,
      price,
      onDone: () => {
        setSubmittingBid(false);
      }
    });
  }

  function emitBid(input: {
    userId: string;
    nickname: string;
    token?: string;
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
        token: input.token,
        price: input.price,
        clientRequestId: `${input.userId}-${Date.now()}-${Math.random().toString(16).slice(2)}`
      },
      (response: { ok: boolean; message?: string; risk?: BidRisk }) => {
        input.onDone?.();

        if (!response.ok) {
          setMessage(response.message ?? "出价失败");
          return;
        }

        setMessage(
          response.risk
            ? `${input.nickname} 出价 ${formatMoney(input.price)}，风控提示：${response.risk.reasons.join("；")}`
            : `${input.nickname} 出价 ${formatMoney(input.price)}，等待广播同步`
        );
      }
    );
  }

  function sendDanmaku(event?: React.FormEvent) {
    event?.preventDefault();

    if (!socketRef.current || sendingDanmaku) {
      return;
    }

    const content = danmakuText.trim();

    if (!content) {
      setMessage("请输入弹幕内容");
      return;
    }

    if (content.length > 80) {
      setMessage("弹幕内容不能超过 80 个字符");
      return;
    }

    setSendingDanmaku(true);
    const danmakuSender = getDanmakuSender({
      currentUser,
      fallbackUserId: userId,
      fallbackNickname: nickname,
      viewMode
    });
    socketRef.current.emit(
      "danmaku:send",
      {
        liveRoomId,
        userId: danmakuSender.userId,
        nickname: danmakuSender.nickname,
        token: session?.token,
        content
      },
      (response: { ok: boolean; message?: DanmakuMessage | string }) => {
        setSendingDanmaku(false);

        if (!response.ok) {
          setMessage(typeof response.message === "string" ? response.message : "弹幕发送失败");
          return;
        }

        setDanmakuText("");
        setMessage("弹幕已发送");
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
              headers: { "Content-Type": "application/json", ...getAuthHeaders(session) },
              body: JSON.stringify({ liveRoomId, userId, price })
            }
          : {
              method: "POST",
              headers: { "Content-Type": "application/json", ...getAuthHeaders(session) },
              body: JSON.stringify({ liveRoomId, productId: snapshot?.product.id })
            };
      const res = await fetch(`${API_URL}${endpoint}`, init);
      const data = await readJson<AiResult>(res);

      if (!res.ok) {
        setMessage(data.message ?? "AI 助手生成失败");
        return;
      }

      setAiResult(data);
      if (data.product) {
        const product = data.product;
        setSnapshot((current) => (current ? { ...current, product } : current));
      }
      void refreshProductQueue();
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

    const res = await fetch(`${API_URL}/api/orders/${snapshot.order.id}/pay`, {
      method: "POST",
      headers: viewMode === "buyer" ? getAuthHeaders(session) : undefined
    });
    const data = await readJson<PayOrderResponse & { message?: string }>(res);

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
      const ordersUrl =
        viewMode === "buyer"
          ? `${API_URL}/api/me/orders?liveRoomId=${encodeURIComponent(liveRoomId)}`
          : `${API_URL}/api/live-rooms/${encodeURIComponent(liveRoomId)}/orders`;
      const ordersInit =
        viewMode === "buyer"
          ? {
              headers: getAuthHeaders(session)
            }
          : {
              headers: getAuthHeaders(session)
            };
      const [historyRes, ordersRes] = await Promise.all([
        fetch(`${API_URL}/api/live-rooms/${encodeURIComponent(liveRoomId)}/auction/history`),
        fetch(ordersUrl, ordersInit)
      ]);
      const historyData = await readJson<{ items?: AuctionHistoryItem[] }>(historyRes);
      const ordersData = await readJson<{ items?: Order[] }>(ordersRes);

      setHistoryItems(historyData.items ?? []);
      setOrders(ordersData.items ?? []);
    } catch {
      // Archive panels are secondary; keep the live auction usable if history fetch fails.
    }
  }

  async function refreshProductQueue() {
    try {
      const res = await fetch(`${API_URL}/api/live-rooms/${encodeURIComponent(liveRoomId)}/products`);
      const data = await readJson<{ items?: ProductQueueItem[]; message?: string }>(res);

      if (!res.ok) {
        throw new Error(data.message ?? "商品队列加载失败");
      }

      setProductQueue(data.items ?? []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "商品队列加载失败");
    }
  }

  function updateProductForm(field: keyof ProductFormInput, value: string) {
    setProductForm((current) => ({ ...current, [field]: value }));
  }

  function editProductFromQueue(item: ProductQueueItem) {
    setEditingProductId(item.product.id);
    setProductForm(productToForm(item));
    setMessage(`正在编辑：${item.product.name}`);
  }

  function clearProductForm() {
    setEditingProductId(null);
    setProductForm(createEmptyProductForm());
  }

  function buildProductPayload() {
    return {
      name: productForm.name.trim(),
      description: productForm.description.trim(),
      imageUrl: productForm.imageUrl.trim(),
      startPrice: Number(productForm.startPrice),
      incrementStep: Number(productForm.incrementStep),
      ceilingPrice: Number(productForm.ceilingPrice),
      durationSeconds: Number(productForm.durationSeconds),
      stock: Number(productForm.stock || 1),
      sellingPoints: productForm.sellingPoints.trim(),
      scriptKeywords: productForm.scriptKeywords.trim()
    };
  }

  async function saveProductForm() {
    const payload = buildProductPayload();

    if (!payload.name || !payload.description) {
      setMessage("请填写商品名称和描述");
      return;
    }

    setSavingProduct(true);

    try {
      const url = editingProductId
        ? `${API_URL}/api/live-rooms/${encodeURIComponent(liveRoomId)}/products/${encodeURIComponent(editingProductId)}`
        : `${API_URL}/api/live-rooms/${encodeURIComponent(liveRoomId)}/products`;
      const res = await fetch(url, {
        method: editingProductId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders(session) },
        body: JSON.stringify(payload)
      });
      const data = await readJson<{ items?: ProductQueueItem[]; message?: string }>(res);

      if (!res.ok) {
        throw new Error(data.message ?? "保存商品失败");
      }

      setProductQueue(data.items ?? []);
      setMessage(editingProductId ? "商品已更新" : "商品已新增");
      clearProductForm();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存商品失败");
    } finally {
      setSavingProduct(false);
    }
  }

  async function archiveProduct(productId: string) {
    const res = await fetch(
      `${API_URL}/api/live-rooms/${encodeURIComponent(liveRoomId)}/products/${encodeURIComponent(productId)}`,
      {
        method: "DELETE",
        headers: getAuthHeaders(session)
      }
    );
    const data = await readJson<{ items?: ProductQueueItem[]; message?: string }>(res);

    if (!res.ok) {
      setMessage(data.message ?? "下架商品失败");
      return;
    }

    setProductQueue(data.items ?? []);
    setMessage("商品已下架");
  }

  async function moveProduct(productId: string, direction: -1 | 1) {
    const index = productQueue.findIndex((item) => item.product.id === productId);
    const targetIndex = index + direction;

    if (index < 0 || targetIndex < 0 || targetIndex >= productQueue.length) {
      return;
    }

    const ids = productQueue.map((item) => item.product.id);
    const [product] = ids.splice(index, 1);
    ids.splice(targetIndex, 0, product);

    const res = await fetch(`${API_URL}/api/live-rooms/${encodeURIComponent(liveRoomId)}/products/reorder`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders(session) },
      body: JSON.stringify({ productIds: ids })
    });
    const data = await readJson<{ items?: ProductQueueItem[]; message?: string }>(res);

    if (!res.ok) {
      setMessage(data.message ?? "调整排序失败");
      return;
    }

    setProductQueue(data.items ?? []);
    setMessage("商品排序已更新");
  }

  async function resetDemoData() {
    setResettingDemo(true);

    try {
      const res = await fetch(`${API_URL}/api/admin/reset-demo`, {
        method: "POST",
        headers: getAuthHeaders(session)
      });
      const data = await readJson<{ snapshots?: AuctionSnapshot[]; message?: string }>(res);

      if (!res.ok) {
        throw new Error(data.message ?? "重置演示数据失败");
      }

      const nextSnapshot = data.snapshots?.find((item) => item.auction.liveRoomId === liveRoomId) ?? null;

      if (nextSnapshot) {
        setSnapshot(nextSnapshot);
      }

      setDanmakuMessages([]);
      setDanmakuBlockedUsers([]);
      setOrders([]);
      setHistoryItems([]);
      clearProductForm();
      setMessage("演示数据已重置");
      void refreshProductQueue();
      void refreshArchiveData();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "重置演示数据失败");
    } finally {
      setResettingDemo(false);
    }
  }

  async function refreshDanmakuBlockedUsers() {
    if (viewMode !== "host") {
      return;
    }

    try {
      const res = await fetch(`${API_URL}/api/live-rooms/${encodeURIComponent(liveRoomId)}/danmaku/blocked-users`, {
        headers: getAuthHeaders(session)
      });
      const data = await readJson<{ items?: DanmakuBlockedUser[]; message?: string }>(res);

      if (res.ok) {
        setDanmakuBlockedUsers(data.items ?? []);
      }
    } catch {
      // Moderation list is secondary; keep the live room usable.
    }
  }

  async function retractDanmaku(messageId: string) {
    const res = await fetch(
      `${API_URL}/api/live-rooms/${encodeURIComponent(liveRoomId)}/danmaku/${encodeURIComponent(messageId)}/retract`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getAuthHeaders(session)
        },
        body: JSON.stringify({ reason: "主播撤回" })
      }
    );
    const data = await readJson<{ message?: DanmakuMessage | string }>(res);

    if (!res.ok) {
      setMessage(typeof data.message === "string" ? data.message : "弹幕撤回失败");
      return;
    }

    setDanmakuMessages((current) => current.filter((item) => item.id !== messageId));
    setMessage("弹幕已撤回");
  }

  async function blockDanmakuUser(item: DanmakuMessage) {
    const res = await fetch(`${API_URL}/api/live-rooms/${encodeURIComponent(liveRoomId)}/danmaku/block-user`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getAuthHeaders(session)
      },
      body: JSON.stringify({
        userId: item.userId,
        nickname: item.nickname,
        reason: "主播屏蔽"
      })
    });
    const data = await readJson<{ blockedUser?: DanmakuBlockedUser; message?: string }>(res);

    if (!res.ok || !data.blockedUser) {
      setMessage(data.message ?? "屏蔽用户失败");
      return;
    }

    const blockedUser = data.blockedUser;
    setDanmakuMessages((current) => current.filter((message) => message.userId !== item.userId));
    setDanmakuBlockedUsers((current) => {
      const rest = current.filter((user) => user.userId !== item.userId);
      return [blockedUser, ...rest];
    });
    setMessage(`${item.nickname} 已被屏蔽`);
  }

  async function handleProductFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    setImportingProducts(true);
    setImportResult(null);
    setMessage("正在导入商品模板...");

    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`${API_URL}/api/live-rooms/${encodeURIComponent(liveRoomId)}/products/import`, {
        method: "POST",
        headers: getAuthHeaders(session),
        body: formData
      });
      const data = await readJson<ImportResult & {
        items?: ProductQueueItem[];
        message?: string;
      }>(res);

      if (!res.ok) {
        throw new Error(data.message ?? "导入失败");
      }

      setImportResult({
        importedCount: data.importedCount,
        failedRows: data.failedRows ?? []
      });
      setProductQueue(data.items ?? []);
      setMessage(`导入完成：成功 ${data.importedCount} 件，失败 ${data.failedRows?.length ?? 0} 行`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "导入失败");
    } finally {
      setImportingProducts(false);
      event.target.value = "";
    }
  }

  async function startProductFromQueue(productId: string) {
    const res = await fetch(
      `${API_URL}/api/live-rooms/${encodeURIComponent(liveRoomId)}/products/${encodeURIComponent(productId)}/start`,
      { method: "POST", headers: getAuthHeaders(session) }
    );
    const data = await readJson<AuctionSnapshot & { message?: string }>(res);

    if (!res.ok) {
      setMessage(data.message ?? "开始商品竞拍失败");
      return;
    }

    setSnapshot(data);
    setDurationSeconds(String(data.auction.durationSeconds));
    setIncrementStep(String(data.auction.incrementStep));
    setCeilingPrice(String(data.auction.ceilingPrice));
    setMessage(`已开始：${data.product.name}`);
    void refreshProductQueue();
    void refreshArchiveData();
  }

  async function regenerateProductScript(productId: string) {
    setAiLoading(true);
    setAiTask("script");

    try {
      const res = await fetch(
        `${API_URL}/api/live-rooms/${encodeURIComponent(liveRoomId)}/products/${encodeURIComponent(productId)}/ai-script`,
        { method: "POST", headers: getAuthHeaders(session) }
      );
      const data = await readJson<AiResult>(res);

      if (!res.ok) {
        setMessage(data.message ?? "讲解词生成失败");
        return;
      }

      setAiResult(data);
      if (data.product && snapshot?.product.id === data.product.id) {
        setSnapshot({ ...snapshot, product: data.product });
      }
      setMessage(data.message ?? "讲解词已更新");
      void refreshProductQueue();
    } catch {
      setMessage("讲解词生成失败");
    } finally {
      setAiLoading(false);
      setAiTask(null);
    }
  }

  if (route.home) {
    return (
      <HomeRoute
        liveRoomId={liveRooms[0]?.id ?? DEFAULT_LIVE_ROOM_ID}
        session={session}
        authChecked={authChecked}
        message={authMessage}
        onShowRegister={() => {
          setAuthMode("register");
          navigateTo(`/live/${liveRoomId}`, setRoute);
        }}
        onLogout={handleLogout}
        onGoHost={() => navigateTo("/host", setRoute)}
        onGoLive={(targetLiveRoomId) => navigateTo(`/live/${targetLiveRoomId}`, setRoute)}
      />
    );
  }

  if (!authChecked) {
    return (
      <main className="loading-page">
        {renderFloatingBackButton()}
        <UserCheck className="spin" size={28} />
        <p>正在校验登录状态...</p>
      </main>
    );
  }

  if (!session && !route.notFound) {
    return (
      <>
        {renderFloatingBackButton()}
        <LoginRoute
          message={
            authMessage ||
            (viewMode === "buyer" ? "买家预览需要先登录或注册买家账号" : "商家控制台需要先登录或注册账号")
          }
          mode={authMode}
          preferredRole={viewMode === "buyer" ? "BUYER" : "HOST"}
          onModeChange={setAuthMode}
          onDemoLogin={handleDemoLogin}
          onLogin={handleManualLogin}
          onRegister={handleRegister}
        />
      </>
    );
  }

  if (route.setup) {
    if (currentUser?.role === "BUYER") {
      navigateTo(`/live/${liveRoomId}`, setRoute);
      return null;
    }

    return (
      <>
        {renderFloatingBackButton()}
        <HostSetupRoute
          hostName={currentUser?.nickname ?? ""}
          message={message}
          onCreate={createHostRoom}
        />
      </>
    );
  }

  if (route.notFound || loadError) {
    return (
      <>
        {renderFloatingBackButton()}
        <RouteError
          title={route.notFound ? "页面不存在" : "无法进入直播间"}
          message={loadError ?? "请检查访问路径，主播端使用 /host，观众预览页使用 /live/live-1。"}
          onGoHost={() => navigateTo("/host", setRoute)}
          onGoLive={() => navigateTo(`/live/${DEFAULT_LIVE_ROOM_ID}`, setRoute)}
        />
      </>
    );
  }

  if (!snapshot) {
    return (
      <main className="loading-page">
        {renderFloatingBackButton()}
        <Radio className="spin" size={28} />
        <p>{message}</p>
      </main>
    );
  }

  return (
    <main className="app-shell">
      {renderFloatingBackButton()}
      <section className="live-panel">
        <div className="topbar">
          <div className="topbar-title">
            <div>
              <p className="eyebrow">实时竞拍大师</p>
              <h1>{viewMode === "host" ? "直播间竞拍控制台" : "观众实时竞拍台"}</h1>
              <p className="topbar-meta">
                {syncLabel} / {currentUser ? currentUser.nickname : "未登录访客"} / Socket.IO 多端广播
              </p>
            </div>
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
            {session ? (
              <button className="icon-button" title="退出登录" onClick={handleLogout}>
                <LogOut size={16} />
              </button>
            ) : null}
          </div>
        </div>

        <div className="live-stage">
          <div className="live-badge">
            <Radio size={16} />
            LIVE
          </div>
          <img src={snapshot.product.imageUrl} alt={snapshot.product.name} />
          <div className="danmaku-overlay" aria-live="polite">
            {visibleFlyingDanmaku.slice(0, 10).map((item, index) => (
              <div
                className="danmaku-fly"
                key={item.id}
                style={{
                  top: `${14 + (index % 6) * 12}%`,
                  animationDelay: `${(index % 5) * -1.4}s`,
                  animationDuration: `${10 + (index % 4)}s`
                }}
              >
                <span>{item.nickname}</span>
                {item.content}
              </div>
            ))}
          </div>
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

        <form className="danmaku-bar" onSubmit={sendDanmaku}>
          <input
            value={danmakuText}
            maxLength={80}
            placeholder="发一条弹幕互动"
            onChange={(event) => setDanmakuText(event.target.value)}
          />
          <button disabled={!connected || sendingDanmaku || !danmakuText.trim()}>
            {sendingDanmaku ? "发送中" : "发送弹幕"}
          </button>
        </form>

        {viewMode === "host" ? (
          <section className="danmaku-moderation">
            <div className="section-title">
              <ShieldAlert size={18} />
              <h2>弹幕治理</h2>
            </div>
            <div className="danmaku-moderation-grid">
              <div>
                <strong>最近弹幕</strong>
                <div className="danmaku-review-list">
                  {currentRoomDanmakuMessages.length === 0 ? (
                    <p className="muted">暂无弹幕</p>
                  ) : (
                    currentRoomDanmakuMessages.slice(0, 6).map((item) => (
                      <div className="danmaku-review-row" key={item.id}>
                        <div>
                          <span>{item.nickname}</span>
                          <p>{item.content}</p>
                        </div>
                        <div>
                          <button title="撤回弹幕" onClick={() => retractDanmaku(item.id)}>
                            撤回
                          </button>
                          <button title="屏蔽用户" onClick={() => blockDanmakuUser(item)}>
                            屏蔽
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
              <div>
                <strong>已屏蔽用户</strong>
                <div className="blocked-user-list">
                  {danmakuBlockedUsers.length === 0 ? (
                    <p className="muted">暂无屏蔽用户</p>
                  ) : (
                    danmakuBlockedUsers.slice(0, 6).map((item) => (
                      <div className="blocked-user-row" key={`${item.liveRoomId}-${item.userId}`}>
                        <span>{item.nickname}</span>
                        <small>{item.reason}</small>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </section>
        ) : null}

        <div className="product-strip">
          <div>
            <p className="eyebrow">当前商品</p>
            <h2>{snapshot.product.name}</h2>
            <p>{snapshot.product.description}</p>
            <p className="product-stock">库存：{snapshot.product.stock ?? 1} 件</p>
            {snapshot.product.aiScript ? (
              <p className="product-ai-note">主播讲解：{snapshot.product.aiScript}</p>
            ) : null}
            {snapshot.product.buyerAiScript ? (
              <p className="product-ai-note buyer-script">买家版：{snapshot.product.buyerAiScript}</p>
            ) : null}
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

        {viewMode === "host" ? (
          <div className="queue-summary">
            <Metric label="商品总数" value={`${queueStats.total} 件`} />
            <Metric label="待竞拍" value={`${queueStats.queued} 件`} />
            <Metric label="已成交" value={`${queueStats.sold} 件`} />
            <Metric label="成交金额" value={formatMoney(queueStats.revenue)} />
          </div>
        ) : null}
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
              <div>
                <strong>
                  {lastBid.nickname} / {formatMoney(lastBid.price)}
                </strong>
                {lastBid.risk ? (
                  <small className={`bid-risk bid-risk-${getBidRiskClass(lastBid.risk)}`}>
                    风控{getBidRiskText(lastBid.risk)}：{lastBid.risk.reasons.join("；")}
                  </small>
                ) : null}
              </div>
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

        {viewMode === "buyer" ? (
          <section className="panel-section">
            <div className="section-title">
              <CircleDollarSign size={18} />
              <h2>我要出价</h2>
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
        ) : null}

        {viewMode === "host" ? (
          <>
            <section className="panel-section import-panel">
              <div className="section-title">
                <Upload size={18} />
                <h2>商品管理</h2>
              </div>
              <div className="product-form">
                <label className="field">
                  <span>商品名称</span>
                  <input value={productForm.name} onChange={(event) => updateProductForm("name", event.target.value)} />
                </label>
                <label className="field">
                  <span>商品图片 URL</span>
                  <input value={productForm.imageUrl} placeholder="/static/jewelry.jpg 或 https://..." onChange={(event) => updateProductForm("imageUrl", event.target.value)} />
                </label>
                <label className="field product-form-wide">
                  <span>商品描述</span>
                  <input value={productForm.description} onChange={(event) => updateProductForm("description", event.target.value)} />
                </label>
                <label className="field">
                  <span>起拍价</span>
                  <input type="number" min={0} value={productForm.startPrice} onChange={(event) => updateProductForm("startPrice", event.target.value)} />
                </label>
                <label className="field">
                  <span>最低加价</span>
                  <input type="number" min={1} value={productForm.incrementStep} onChange={(event) => updateProductForm("incrementStep", event.target.value)} />
                </label>
                <label className="field">
                  <span>封顶价</span>
                  <input type="number" min={1} value={productForm.ceilingPrice} onChange={(event) => updateProductForm("ceilingPrice", event.target.value)} />
                </label>
                <label className="field">
                  <span>竞拍时长秒</span>
                  <input type="number" min={15} max={600} value={productForm.durationSeconds} onChange={(event) => updateProductForm("durationSeconds", event.target.value)} />
                </label>
                <label className="field">
                  <span>库存</span>
                  <input type="number" min={1} value={productForm.stock} onChange={(event) => updateProductForm("stock", event.target.value)} />
                </label>
                <label className="field">
                  <span>商品卖点</span>
                  <input value={productForm.sellingPoints} onChange={(event) => updateProductForm("sellingPoints", event.target.value)} />
                </label>
                <label className="field product-form-wide">
                  <span>讲解关键词</span>
                  <input value={productForm.scriptKeywords} onChange={(event) => updateProductForm("scriptKeywords", event.target.value)} />
                </label>
              </div>
              <div className="button-row">
                <button className="primary-button" disabled={savingProduct} onClick={saveProductForm}>
                  <Save size={16} />
                  <span>{savingProduct ? "保存中" : editingProductId ? "保存修改" : "新增商品"}</span>
                </button>
                <button onClick={clearProductForm}>
                  <RotateCcw size={16} />
                  <span>清空表单</span>
                </button>
                <button disabled={resettingDemo} onClick={resetDemoData}>
                  <Trash2 size={16} />
                  <span>{resettingDemo ? "重置中" : "重置演示数据"}</span>
                </button>
              </div>
              <input
                ref={fileInputRef}
                className="hidden-file"
                type="file"
                accept=".xlsx,.csv,.txt"
                onChange={handleProductFileChange}
              />
              <div className="button-row">
                <button disabled={importingProducts} onClick={() => fileInputRef.current?.click()}>
                  <Upload size={16} />
                  <span>{importingProducts ? "导入中" : "上传模板"}</span>
                </button>
                <button onClick={refreshProductQueue}>
                  <RotateCcw size={16} />
                  <span>刷新队列</span>
                </button>
              </div>
              <p className="muted template-hint">
                可上传 docs/product-import-template.csv；表头：商品名称、商品描述、起拍价、最低加价、封顶价、竞拍时长秒、库存、商品卖点、讲解关键词。
              </p>
              {importResult ? (
                <div className="import-result">
                  <strong>成功 {importResult.importedCount} 件</strong>
                  {importResult.failedRows.length > 0 ? (
                    <span>
                      失败 {importResult.failedRows.length} 行：
                      {importResult.failedRows
                        .slice(0, 2)
                        .map((row) => `${row.rowNumber} 行 ${row.reason}`)
                        .join("；")}
                    </span>
                  ) : (
                    <span>全部导入成功</span>
                  )}
                </div>
              ) : null}
            </section>

            <section className="panel-section">
              <div className="section-title">
                <Package size={18} />
                <h2>竞拍商品队列</h2>
              </div>
              {awaitingNextProduct ? (
                <div className="next-confirm">
                  <span>当前商品已结束，等待确认下一件</span>
                  <strong>{nextQueueItem?.product.name}</strong>
                  <button
                    className="primary-button"
                    onClick={() => nextQueueItem && startProductFromQueue(nextQueueItem.product.id)}
                  >
                    <PlayCircle size={16} />
                    <span>确认开始下一件</span>
                  </button>
                </div>
              ) : null}
              {currentQueueItem || nextQueueItem ? (
                <div className="queue-focus">
                  <div>
                    <span>当前</span>
                    <strong>{currentQueueItem?.product.name ?? "暂无当前商品"}</strong>
                  </div>
                  <div>
                    <span>下一件</span>
                    <strong>{nextQueueItem?.product.name ?? "暂无待竞拍商品"}</strong>
                  </div>
                </div>
              ) : null}
              <button
                className="next-product-button"
                disabled={!nextQueueItem || snapshot.auction.status === "ACTIVE"}
                onClick={() => nextQueueItem && startProductFromQueue(nextQueueItem.product.id)}
              >
                <PlayCircle size={16} />
                <span>{nextQueueItem ? `开始下一件：${nextQueueItem.product.name}` : "暂无下一件商品"}</span>
              </button>
              {productQueue.length === 0 ? (
                <p className="muted">暂无导入商品，可先上传固定模板。</p>
              ) : (
                <div className="product-queue">
                  {productQueue.map((item) => (
                    <div className="queue-row" key={item.product.id}>
                      <div>
                        <div className="queue-row-head">
                          <strong>{item.product.name}</strong>
                          <span className={`queue-status queue-${(item.product.queueStatus ?? "QUEUED").toLowerCase()}`}>
                            {getQueueStatusText(item.product.queueStatus)}
                          </span>
                        </div>
                        <span>
                          {formatMoney(item.auction.startPrice)} 起拍 / 加价 {formatMoney(item.auction.incrementStep)} / 封顶{" "}
                          {formatMoney(item.auction.ceilingPrice)} / 库存 {item.product.stock ?? 1} 件
                        </span>
                        {item.product.aiScript ? <p>{item.product.aiScript}</p> : null}
                        {item.product.buyerAiScript ? <p className="buyer-queue-script">{item.product.buyerAiScript}</p> : null}
                      </div>
                      <div className="queue-row-actions">
                        <button
                          disabled={snapshot.auction.status === "ACTIVE" || item.product.queueStatus === "ACTIVE"}
                          title="开始竞拍"
                          onClick={() => startProductFromQueue(item.product.id)}
                        >
                          <PlayCircle size={16} />
                        </button>
                        <button
                          disabled={item.product.queueStatus === "ACTIVE"}
                          title="编辑商品"
                          onClick={() => editProductFromQueue(item)}
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          disabled={item.product.queueStatus === "ACTIVE"}
                          title="上移"
                          onClick={() => moveProduct(item.product.id, -1)}
                        >
                          ↑
                        </button>
                        <button
                          disabled={item.product.queueStatus === "ACTIVE"}
                          title="下移"
                          onClick={() => moveProduct(item.product.id, 1)}
                        >
                          ↓
                        </button>
                        <button
                          disabled={aiLoading}
                          title="重新生成讲解词"
                          onClick={() => regenerateProductScript(item.product.id)}
                        >
                          <Sparkles size={16} />
                        </button>
                        <button
                          disabled={item.product.queueStatus === "ACTIVE"}
                          title="下架商品"
                          onClick={() => archiveProduct(item.product.id)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
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
                    {bid.risk ? (
                      <small className={`bid-risk bid-risk-${getBidRiskClass(bid.risk)}`}>
                        风控{getBidRiskText(bid.risk)}：{bid.risk.reasons.join("；")}
                      </small>
                    ) : null}
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
              <h2>我的竞拍与订单</h2>
            </div>
            <ArchiveList
              emptyText="暂无订单"
              items={orders.slice(0, 5).map((item) => ({
                id: item.id,
                title: item.buyerNickname,
                meta: `${formatMoney(item.finalPrice)} / ${item.status === "PAID" ? "已支付" : "待支付"}`,
                time: item.createdAt
              }))}
            />
            <div className="archive-subtitle">参与记录</div>
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

function LoginRoute(props: {
  message: string;
  mode: "login" | "register";
  preferredRole: "HOST" | "BUYER";
  onModeChange: (mode: "login" | "register") => void;
  onDemoLogin: (role: "HOST" | "BUYER") => void;
  onLogin: (input: { account: string; password: string }) => void;
  onRegister: (input: RegisterInput) => void;
}) {
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [nickname, setNickname] = useState("");
  const [role, setRole] = useState<"HOST" | "BUYER">(props.preferredRole);
  const isRegister = props.mode === "register";
  const nicknamePlaceholder = role === "BUYER" ? "买家昵称" : "主播或店铺名称";

  useEffect(() => {
    setRole(props.preferredRole);
  }, [props.preferredRole]);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    if (isRegister) {
      props.onRegister({
        account,
        password,
        nickname,
        role
      });
      return;
    }

    props.onLogin({
      account,
      password
    });
  }

  return (
    <main className="route-error login-route">
      <div>
        <UserCheck size={28} />
        <p className="eyebrow">账号入口</p>
        <h1>{isRegister ? "注册演示账号" : "登录演示账号"}</h1>
        <p>{props.message}</p>
        <div className="auth-tabs" role="tablist" aria-label="账号操作">
          <button
            className={!isRegister ? "active" : ""}
            type="button"
            onClick={() => props.onModeChange("login")}
          >
            登录
          </button>
          <button
            className={isRegister ? "active" : ""}
            type="button"
            onClick={() => props.onModeChange("register")}
          >
            注册
          </button>
        </div>
        <form className="auth-form" onSubmit={handleSubmit}>
          <label className="field">
            <span>账号</span>
            <input
              value={account}
              maxLength={80}
              placeholder="username / phone / email"
              onChange={(event) => setAccount(event.target.value)}
            />
          </label>
          {isRegister ? (
            <label className="field">
              <span>昵称</span>
              <input
                value={nickname}
                maxLength={40}
                placeholder={nicknamePlaceholder}
                onChange={(event) => setNickname(event.target.value)}
              />
            </label>
          ) : null}
          <label className="field">
            <span>密码</span>
            <input
              type="password"
              value={password}
              maxLength={80}
              placeholder="演示口令"
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {isRegister ? (
            <label className="field">
              <span>角色</span>
              <select value={role} onChange={(event) => setRole(event.target.value as "HOST" | "BUYER")}>
                <option value="HOST">商家/主播</option>
                <option value="BUYER">买家预览</option>
              </select>
            </label>
          ) : null}
          <button className="primary-button" type="submit">
            {isRegister ? <Save size={16} /> : <UserCheck size={16} />}
            {isRegister ? "注册账号" : "账号登录"}
          </button>
        </form>
        <div className="login-actions">
          <button onClick={() => props.onDemoLogin("HOST")}>
            <Radio size={16} />
            使用商家演示账号
          </button>
          <button onClick={() => props.onDemoLogin("BUYER")}>
            <Users size={16} />
            使用买家演示账号
          </button>
        </div>
      </div>
    </main>
  );
}

function HostSetupRoute(props: {
  hostName: string;
  message: string;
  onCreate: (input: CreateRoomInput) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [hostName, setHostName] = useState(props.hostName);
  const [productName, setProductName] = useState("");
  const [productDescription, setProductDescription] = useState("");
  const [startPrice, setStartPrice] = useState("0");
  const [incrementStep, setIncrementStep] = useState("100");
  const [ceilingPrice, setCeilingPrice] = useState("3000");
  const [durationSeconds, setDurationSeconds] = useState("90");
  const [stock, setStock] = useState("1");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setHostName(props.hostName);
  }, [props.hostName]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setSubmitting(true);

    try {
      await props.onCreate({
        title,
        hostName,
        productName,
        productDescription,
        startPrice,
        incrementStep,
        ceilingPrice,
        durationSeconds,
        stock
      });
    } catch (error) {
      setError(error instanceof Error ? error.message : "创建直播间失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="route-error setup-route">
      <div>
        <PlusCircle size={28} />
        <p className="eyebrow">主播开播设置</p>
        <h1>创建直播间</h1>
        <p>{error || props.message || "填写直播间和首件商品信息后进入主播控制台。"}</p>
        <form className="auth-form setup-form" onSubmit={handleSubmit}>
          <label className="field">
            <span>直播间名称</span>
            <input value={title} maxLength={80} placeholder="例如：春季好物专场" onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className="field">
            <span>主播名称</span>
            <input value={hostName} maxLength={40} placeholder="主播或店铺名称" onChange={(event) => setHostName(event.target.value)} />
          </label>
          <label className="field">
            <span>要卖什么</span>
            <input value={productName} maxLength={80} placeholder="商品名称" onChange={(event) => setProductName(event.target.value)} />
          </label>
          <label className="field">
            <span>商品描述</span>
            <input value={productDescription} maxLength={300} placeholder="材质、成色、亮点、适用场景" onChange={(event) => setProductDescription(event.target.value)} />
          </label>
          <div className="settings-grid">
            <label className="field">
              <span>起拍价</span>
              <input type="number" min={0} value={startPrice} onChange={(event) => setStartPrice(event.target.value)} />
            </label>
            <label className="field">
              <span>最低加价</span>
              <input type="number" min={1} value={incrementStep} onChange={(event) => setIncrementStep(event.target.value)} />
            </label>
            <label className="field">
              <span>封顶价</span>
              <input type="number" min={1} value={ceilingPrice} onChange={(event) => setCeilingPrice(event.target.value)} />
            </label>
          </div>
          <div className="settings-grid">
            <label className="field">
              <span>竞拍时长秒</span>
              <input type="number" min={15} max={600} value={durationSeconds} onChange={(event) => setDurationSeconds(event.target.value)} />
            </label>
            <label className="field">
              <span>库存</span>
              <input type="number" min={1} value={stock} onChange={(event) => setStock(event.target.value)} />
            </label>
          </div>
          <button className="primary-button" disabled={submitting}>
            <PlusCircle size={16} />
            {submitting ? "创建中" : "创建并进入直播间"}
          </button>
        </form>
      </div>
    </main>
  );
}

function HomeRoute(props: {
  liveRoomId: string;
  session: WebSession | null;
  authChecked: boolean;
  message: string;
  onShowRegister: () => void;
  onLogout: () => void;
  onGoHost: () => void;
  onGoLive: (liveRoomId: string) => void;
}) {
  return (
    <main className="route-error route-home">
      <div>
        <Radio size={28} />
        <p className="eyebrow">实时竞拍大师</p>
        <h1>选择演示入口</h1>
        <p>
          {props.session
            ? `当前已登录：${props.session.user.nickname}`
            : props.authChecked
              ? "进入后可登录已有账号、注册新账号，或使用演示账号。"
              : "正在校验登录状态..."}
        </p>
        {props.message ? <p className="route-hint">{props.message}</p> : null}
        <div className="route-error-actions">
          <button className="primary-button" onClick={props.onGoHost}>
            <Radio size={16} />
            商家/主播入口
          </button>
          <button onClick={() => props.onGoLive(props.liveRoomId)}>
            <Users size={16} />
            买家预览入口
          </button>
        </div>
        {!props.session ? (
          <button className="link-button" onClick={props.onShowRegister}>
            注册新账号
          </button>
        ) : null}
        {props.session ? (
          <button className="link-button" onClick={props.onLogout}>
            退出当前账号
          </button>
        ) : null}
        <p className="route-hint">商家演示账号 demo-host / demo123，买家演示账号 demo-buyer / demo123。</p>
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
      home: true
    };
  }

  if (cleanPath === "/host/setup") {
    return {
      viewMode: "host",
      liveRoomId: DEFAULT_LIVE_ROOM_ID,
      setup: true
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

async function loginWeb(input: { account: string; password: string }): Promise<WebSession> {
  const res = await fetch(`${API_URL}/api/auth/web/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  const data = await readJson<{
    token?: string;
    user?: AuthUser;
    message?: string;
  }>(res);

  if (!res.ok || !data.token || !data.user) {
    throw new Error(data.message ?? "登录失败");
  }

  return {
    token: data.token,
    user: data.user
  };
}

async function registerWeb(input: RegisterInput): Promise<{ user: AuthUser }> {
  const res = await fetch(`${API_URL}/api/auth/web/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  const data = await readJson<{
    user?: AuthUser;
    message?: string;
  }>(res);

  if (!res.ok || !data.user) {
    throw new Error(data.message ?? "注册失败");
  }

  return { user: data.user };
}

async function resolveHostEntryRoom(session: WebSession) {
  const res = await fetch(`${API_URL}/api/me/live-rooms`, {
    headers: getAuthHeaders(session)
  });
  const data = await readJson<{ items?: LiveRoom[]; message?: string }>(res);

  if (!res.ok) {
    throw new Error(data.message ?? "无法获取主播直播间");
  }

  return data.items?.[0]?.id ?? null;
}

async function readJson<T>(res: Response): Promise<T> {
  const contentType = res.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    return (await res.json()) as T;
  }

  const text = await res.text();
  const preview = text.replace(/\s+/g, " ").slice(0, 80);

  throw new Error(
    preview.startsWith("<!DOCTYPE") || preview.startsWith("<html")
      ? "接口返回了页面 HTML，请确认后端已重启且 VITE_API_URL/代理地址指向后端服务"
      : preview || "接口返回格式不是 JSON"
  );
}

function getAuthHeaders(session: WebSession | null): HeadersInit {
  return session?.token ? { Authorization: `Bearer ${session.token}` } : {};
}

function readStoredSession(): WebSession | null {
  try {
    const value = window.localStorage.getItem(SESSION_STORAGE_KEY);
    return value ? (JSON.parse(value) as WebSession) : null;
  } catch {
    return null;
  }
}

function writeStoredSession(session: WebSession | null) {
  if (!session) {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
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

function isVisibleDanmaku(item: DanmakuMessage, liveRoomId: string) {
  return item.liveRoomId === liveRoomId && (item.status ?? "VISIBLE") === "VISIBLE";
}

function createEmptyProductForm(): ProductFormInput {
  return {
    name: "",
    description: "",
    imageUrl: "",
    startPrice: "0",
    incrementStep: "100",
    ceilingPrice: "3000",
    durationSeconds: "90",
    stock: "1",
    sellingPoints: "",
    scriptKeywords: ""
  };
}

function productToForm(item: ProductQueueItem): ProductFormInput {
  return {
    name: item.product.name,
    description: item.product.description,
    imageUrl: item.product.imageUrl,
    startPrice: String(item.product.startPrice ?? item.auction.startPrice),
    incrementStep: String(item.product.incrementStep ?? item.auction.incrementStep),
    ceilingPrice: String(item.product.ceilingPrice ?? item.auction.ceilingPrice),
    durationSeconds: String(item.product.durationSeconds ?? item.auction.durationSeconds),
    stock: String(item.product.stock ?? 1),
    sellingPoints: item.product.sellingPoints ?? "",
    scriptKeywords: item.product.scriptKeywords ?? ""
  };
}

function getDanmakuSender(input: {
  currentUser: AuthUser | null;
  fallbackUserId: string;
  fallbackNickname: string;
  viewMode: ViewMode;
}) {
  if (input.currentUser) {
    return {
      userId: input.currentUser.id,
      nickname: input.currentUser.nickname
    };
  }

  return {
    userId: input.viewMode === "buyer" ? input.fallbackUserId : "guest-host",
    nickname: input.viewMode === "buyer" ? input.fallbackNickname.trim() || "Web 预览买家" : "演示主播"
  };
}

function getQueueStats(items: ProductQueueItem[], orders: Order[]) {
  const soldProductIds = new Set(
    items.filter((item) => item.product.queueStatus === "SOLD").map((item) => item.product.id)
  );

  return {
    total: items.length,
    queued: items.filter((item) => item.product.queueStatus === "QUEUED").length,
    sold: soldProductIds.size,
    revenue: orders
      .filter((order) => soldProductIds.has(order.productId))
      .reduce((sum, order) => sum + order.finalPrice, 0)
  };
}

function getQueueStatusText(status: ProductQueueItem["product"]["queueStatus"]) {
  if (status === "ACTIVE") {
    return "竞拍中";
  }

  if (status === "SOLD") {
    return "已成交";
  }

  if (status === "UNSOLD") {
    return "已流拍";
  }

  if (status === "CANCELLED") {
    return "已取消";
  }

  return "待竞拍";
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

function getBidRiskClass(risk: BidRisk) {
  if (risk.level === "HIGH") {
    return "high";
  }

  if (risk.level === "MEDIUM") {
    return "medium";
  }

  return "low";
}

function getBidRiskText(risk: BidRisk) {
  if (risk.action === "BLOCK") {
    return "拦截";
  }

  if (risk.action === "REVIEW") {
    return "关注";
  }

  return "正常";
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
