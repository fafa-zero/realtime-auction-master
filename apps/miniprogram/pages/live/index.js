const {
  getApiBaseUrl,
  getApiBaseUrlCandidates,
  getAuctionSnapshot,
  getDanmakuMessages,
  getLiveRoom,
  getMiniprogramWsUrl,
  getMyOrders,
  payOrder,
  placeBid,
  recordLiveRoomView,
  sendDanmaku,
  setApiBaseUrl
} = require("../../utils/api");
const { money, remaining, time } = require("../../utils/format");

const POLLING_INTERVAL_MS = 1500;
const CONNECTED_POLLING_INTERVAL_MS = 8000;
const REALTIME_RECONNECT_DELAY_MS = 3000;
const LOCAL_PRODUCT_IMAGES = {
  "/static/jewelry.jpg": "/assets/jewelry.jpg",
  "/static/products/shuilanlan.jpg": "/assets/products/shuilanlan.jpg",
  "/static/products/liduxiuluo.jpg": "/assets/products/liduxiuluo.jpg",
  "/static/products/chixin-yongshi.jpg": "/assets/products/chixin-yongshi.jpg",
  "/static/products/luoyin.jpg": "/assets/products/luoyin.jpg",
  "/static/products/jimie-gulong.jpg": "/assets/products/jimie-gulong.jpg"
};

const statusMap = {
  PENDING: "待开始",
  ACTIVE: "进行中",
  SOLD: "已成交",
  UNSOLD: "已结束",
  CANCELLED: "已取消"
};

const badgeMap = {
  PENDING: "待开始",
  ACTIVE: "ON",
  SOLD: "已成交",
  UNSOLD: "已结束",
  CANCELLED: "已取消"
};

const fallbackRoom = {
  id: "live-1",
  title: "珠宝严选竞拍直播间",
  hostName: "主播小雅",
  viewerCount: 1286
};

const fallbackSnapshot = {
  product: {
    id: "product-1",
    name: "天然翡翠吊坠",
    imageUrl: "",
    description: "模拟直播间竞拍商品，适合用于演示实时出价、自动延时和封顶成交流程。"
  },
  auction: {
    id: "auction-1",
    productId: "product-1",
    liveRoomId: "live-1",
    startPrice: 0,
    currentPrice: 0,
    incrementStep: 100,
    ceilingPrice: 3000,
    durationSeconds: 600,
    startTime: null,
    endTime: null,
    extendThresholdSeconds: 10,
    extendSeconds: 20,
    maxExtendCount: 3,
    extendCount: 0,
    status: "PENDING",
    winnerUserId: null,
    winnerNickname: null,
    version: 1
  },
  bids: [],
  order: null,
  participantCount: 0,
  serverTime: Date.now()
};

Page({
  data: {
    liveRoomId: "live-1",
    loading: false,
    checkingLogin: true,
    authorized: false,
    submitting: false,
    error: "",
    room: fallbackRoom,
    snapshot: fallbackSnapshot,
    safeProductImageUrl: "",
    bidPrice: "",
    serverOffset: 0,
    remainingText: "00:00",
    currentPriceText: "¥0",
    nextBidText: "¥0",
    incrementText: "¥0",
    ceilingText: "¥0",
    stockText: "库存 1 件",
    orderPriceText: "¥0",
    statusText: "待开始",
    liveBadgeText: "待开始",
    leaderText: "暂无领先用户",
    bidCountText: "0 条记录",
    bidButtonText: "参与",
    hint: "开始后可参与",
    buyerText: "买家未登录",
    aiScriptText: "",
    productStateText: "等待主播开始竞拍",
    progressPercent: 0,
    progressText: "0%",
    ruleText: "起拍价 ¥0 / 最低加价 ¥0 / 封顶价 ¥0",
    realtimeText: "实时连接准备中",
    lastSyncText: "--:--:--",
    debugText: "",
    canBid: false,
    danmakuText: "",
    danmakuMessages: [],
    stageDanmakuMessages: [],
    sendingDanmaku: false
  },

  async onLoad(options) {
    const liveRoomId = options.liveRoomId || "live-1";
    this.setData({ liveRoomId, loading: false, checkingLogin: true, authorized: false, error: "" });
    this.applySnapshot({
      ...fallbackSnapshot,
      auction: { ...fallbackSnapshot.auction, liveRoomId },
      serverTime: Date.now()
    });
  },

  onShow() {
    this.pageActive = true;
    this.ensurePageLogin()
      .then(() => {
        clearInterval(this.clockTimer);
        clearTimeout(this.pollingTimer);
        this.load();
        this.connectRealtime();
        this.clockTimer = setInterval(() => this.refreshComputed(), 500);
        this.schedulePolling();
      })
      .catch(() => {
        this.closeRealtime();
      });
  },

  onHide() {
    this.pageActive = false;
    this.closeRealtime();
    clearInterval(this.clockTimer);
    clearTimeout(this.pollingTimer);
  },

  onUnload() {
    this.pageActive = false;
    this.closeRealtime();
    clearInterval(this.clockTimer);
    clearTimeout(this.pollingTimer);
  },

  async load() {
    if (!this.data.authorized) {
      return;
    }

    this.setData({ error: "" });

    try {
      const [roomData, snapshot] = await Promise.all([
        this.recordViewOnce(),
        getAuctionSnapshot(this.data.liveRoomId)
      ]);

      this.applySnapshot(snapshot);
      this.setData({ room: roomData.room });
      this.loadDanmakuHistory();
    } catch (error) {
      this.setData({
        error: "",
        debugText: error.message || "后端暂不可用，当前使用本地兜底数据"
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  recordViewOnce() {
    if (this.viewRecordedFor === this.data.liveRoomId) {
      return getLiveRoom(this.data.liveRoomId);
    }

    this.viewRecordedFor = this.data.liveRoomId;
    return recordLiveRoomView(this.data.liveRoomId).catch(() => getLiveRoom(this.data.liveRoomId));
  },

  async ensurePageLogin() {
    try {
      await getApp().ensureLogin();
      const user = getApp().globalData.user;
      this.setData({
        authorized: true,
        checkingLogin: false,
        buyerText: user ? `当前买家：${user.nickname}` : "买家未登录"
      });
    } catch (error) {
      this.closeRealtime();
      clearInterval(this.clockTimer);
      clearTimeout(this.pollingTimer);
      this.setData({
        authorized: false,
        checkingLogin: false,
        error: "",
        buyerText: "买家未登录"
      });
      wx.showToast({ title: "请先登录", icon: "none" });
      wx.redirectTo({ url: "/pages/index/index" });
      throw error;
    }
  },

  goLogin() {
    wx.redirectTo({ url: "/pages/index/index" });
  },

  logout() {
    getApp().logout();
    this.closeRealtime();
    clearInterval(this.clockTimer);
    clearTimeout(this.pollingTimer);
    this.setData({
      authorized: false,
      checkingLogin: false,
      error: "",
      buyerText: "买家未登录"
    });
    wx.redirectTo({ url: "/pages/index/index" });
  },

  async loadSnapshot(force = false) {
    if (!this.data.authorized || this.data.loading || this.snapshotLoading || (this.realtimeConnected && !force)) {
      return;
    }

    this.snapshotLoading = true;

    try {
      const snapshot = await getAuctionSnapshot(this.data.liveRoomId);
      this.applySnapshot(snapshot);
      if (!this.realtimeConnected) {
        this.loadDanmakuHistory();
      }
      if (!this.realtimeConnected) {
        this.setData({
          realtimeText: `轮询同步中：${getApiBaseUrl()}`,
          debugText: `最近同步成功 ${time(Date.now())}`
        });
      } else if (force) {
        this.setData({
          realtimeText: `WebSocket 实时同步中：${getApiBaseUrl()}`,
          debugText: `HTTP 快照校准成功 ${time(Date.now())}`
        });
      }
    } catch (error) {
      this.setData({
        hint: error.message || "网络波动，正在恢复专场数据",
        realtimeText: `轮询失败：${getApiBaseUrl()}`,
        debugText: error.message || "同步失败"
      });
    } finally {
      this.snapshotLoading = false;
    }
  },

  async loadDanmakuHistory() {
    try {
      const data = await getDanmakuMessages(this.data.liveRoomId);
      const messages = this.formatDanmakuMessages(data.items || []);
      this.setData({
        danmakuMessages: messages,
        stageDanmakuMessages: messages.slice(0, 5)
      });
    } catch {
      // 弹幕不影响竞拍主流程。
    }
  },

  formatDanmakuMessages(items) {
    return items
      .filter((item) => (item.status || "VISIBLE") === "VISIBLE")
      .slice(0, 20)
      .map((item) => ({
        ...item,
        createdAtText: time(item.createdAt)
      }));
  },

  applyDanmakuMessage(item) {
    if (!item || item.liveRoomId !== this.data.liveRoomId || (item.status || "VISIBLE") !== "VISIBLE") {
      return;
    }

    const message = {
      ...item,
      createdAtText: time(item.createdAt)
    };
    const messages = [
      message,
      ...this.data.danmakuMessages.filter((current) => current.id !== message.id)
    ].slice(0, 20);

    this.setData({
      danmakuMessages: messages,
      stageDanmakuMessages: messages.slice(0, 5)
    });
  },

  removeDanmakuMessage(messageId) {
    const messages = this.data.danmakuMessages.filter((item) => item.id !== messageId);
    this.setData({
      danmakuMessages: messages,
      stageDanmakuMessages: messages.slice(0, 5)
    });
  },

  removeDanmakuUser(userId) {
    const messages = this.data.danmakuMessages.filter((item) => item.userId !== userId);
    this.setData({
      danmakuMessages: messages,
      stageDanmakuMessages: messages.slice(0, 5)
    });
  },

  usePollingRealtime() {
    if (!this.realtimeConnected) {
      this.setData({ realtimeText: `轮询同步中：${getApiBaseUrl()}` });
    }
    this.loadSnapshot();
    this.schedulePolling();
  },

  refreshNow() {
    this.setData({ realtimeText: `正在刷新专场：${getApiBaseUrl()}` });
    this.loadSnapshot(true);
  },

  schedulePolling() {
    clearTimeout(this.pollingTimer);
    const interval = this.realtimeConnected ? CONNECTED_POLLING_INTERVAL_MS : POLLING_INTERVAL_MS;
    this.pollingTimer = setTimeout(async () => {
      await this.loadSnapshot(!this.realtimeConnected || Boolean(this.lastRealtimeAt));
      this.schedulePolling();
    }, interval);
  },

  scheduleReconnect() {
    if (!this.pageActive || this.realtimeConnected || this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.pageActive && !this.realtimeConnected) {
        this.connectRealtime();
      }
    }, REALTIME_RECONNECT_DELAY_MS);
  },

  closeRealtime() {
    this.snapshotLoading = false;
    this.realtimeConnected = false;
    clearTimeout(this.pollingTimer);
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.realtimeSocket) {
      this.realtimeSocket.close();
      this.realtimeSocket = null;
    }
  },

  connectRealtime() {
    if (!wx.connectSocket) {
      this.usePollingRealtime();
      return;
    }

    this.closeRealtime();
    const baseUrls = getApiBaseUrlCandidates();
    const attemptId = Date.now();
    this.realtimeAttemptId = attemptId;
    this.connectRealtimeCandidate(baseUrls, 0, attemptId);
  },

  connectRealtimeCandidate(baseUrls, index, attemptId) {
    const baseUrl = baseUrls[index];

    if (!baseUrl) {
      this.usePollingRealtime();
      return;
    }

    this.setData({ realtimeText: `正在连接实时通道：${baseUrl}` });

    const socket = wx.connectSocket({
      url: getMiniprogramWsUrl(baseUrl)
    });
    let opened = false;
    this.realtimeSocket = socket;

    const tryNext = (message) => {
      if (this.realtimeSocket !== socket || this.realtimeAttemptId !== attemptId) {
        return;
      }

      this.realtimeConnected = false;
      this.realtimeSocket = null;

      if (index < baseUrls.length - 1) {
        this.connectRealtimeCandidate(baseUrls, index + 1, attemptId);
        return;
      }

      this.setData({
        realtimeText: `实时通道不可用，轮询同步中：${getApiBaseUrl()}`,
        debugText: message || "WebSocket 连接失败，已切换轮询"
      });
      this.usePollingRealtime();
      this.scheduleReconnect();
    };

    socket.onOpen(() => {
      if (this.realtimeSocket !== socket) {
        return;
      }

      opened = true;
      this.realtimeConnected = true;
      this.lastRealtimeAt = Date.now();
      setApiBaseUrl(baseUrl);
      this.setData({
        realtimeText: `WebSocket 实时同步中：${baseUrl}`,
        debugText: `实时通道已连接 ${time(Date.now())}`
      });
      this.sendRealtimeMessage("auction:join", { liveRoomId: this.data.liveRoomId });
      this.schedulePolling();
    });

    socket.onMessage((event) => {
      if (this.realtimeSocket !== socket) {
        return;
      }

      this.handleRealtimeMessage(event.data);
    });

    socket.onError((error) => {
      if (this.realtimeSocket !== socket) {
        return;
      }

      if (!opened) {
        tryNext(error.errMsg || "WebSocket 连接异常");
        return;
      }

      this.realtimeConnected = false;
      this.setData({
        realtimeText: `实时通道异常，轮询同步中：${getApiBaseUrl()}`,
        debugText: error.errMsg || "WebSocket 连接异常"
      });
      this.schedulePolling();
      this.scheduleReconnect();
    });

    socket.onClose(() => {
      if (this.realtimeSocket !== socket) {
        return;
      }

      if (!opened) {
        tryNext("WebSocket 连接关闭");
        return;
      }

      this.realtimeConnected = false;
      this.realtimeSocket = null;
      this.setData({
        realtimeText: `实时通道已断开，轮询同步中：${getApiBaseUrl()}`
      });
      this.schedulePolling();
      this.scheduleReconnect();
    });
  },

  sendRealtimeMessage(type, payload) {
    if (!this.realtimeSocket || !this.realtimeConnected) {
      return;
    }

    this.realtimeSocket.send({
      data: JSON.stringify({ type, payload })
    });
  },

  handleRealtimeMessage(raw) {
    let event;

    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }

    const payload = event.payload;
    this.lastRealtimeAt = Date.now();

    if (
      event.type === "auction:snapshot" ||
      event.type === "auction:started" ||
      event.type === "auction:bid-success" ||
      event.type === "auction:extended" ||
      event.type === "auction:ended"
    ) {
      if (this.applySnapshot(payload)) {
        this.setData({ debugText: `实时同步 ${time(Date.now())}` });
      }
      return;
    }

    if (event.type === "order:paid") {
      if (payload && payload.snapshot) {
        this.applySnapshot(payload.snapshot);
      } else if (payload && payload.order && payload.order.liveRoomId === this.data.liveRoomId) {
        this.loadSnapshot();
      }

      this.setData({ debugText: `订单支付状态已更新 ${time(Date.now())}` });
      return;
    }

    if (event.type === "danmaku:history" && Array.isArray(payload)) {
      const messages = this.formatDanmakuMessages(payload);
      this.setData({
        danmakuMessages: messages,
        stageDanmakuMessages: messages.slice(0, 5)
      });
      return;
    }

    if (event.type === "danmaku:new") {
      this.applyDanmakuMessage(payload);
      return;
    }

    if (event.type === "danmaku:retracted") {
      this.removeDanmakuMessage(payload && payload.id);
      return;
    }

    if (event.type === "danmaku:user-blocked") {
      this.removeDanmakuUser(payload && payload.userId);
      return;
    }

    if (event.type === "auction:error") {
      this.showHint(payload?.message || "实时同步异常");
    }
  },

  applySnapshot(snapshot) {
    if (!snapshot || !snapshot.auction || snapshot.auction.liveRoomId !== this.data.liveRoomId) {
      return false;
    }

    if (
      this.data.snapshot &&
      (snapshot.auction.version < this.data.snapshot.auction.version ||
        (snapshot.auction.version === this.data.snapshot.auction.version &&
          snapshot.serverTime < this.data.snapshot.serverTime)) &&
      !this.isDemoResetSnapshot(snapshot)
    ) {
      return false;
    }

    const nextBid = snapshot.auction.currentPrice + snapshot.auction.incrementStep;
    const safeProductImageUrl = this.resolveProductImageUrl(snapshot.product);
    const product = {
      ...snapshot.product,
      imageUrl: safeProductImageUrl
    };
    const bids = (snapshot.bids || []).map((bid) => ({
      ...bid,
      priceText: money(bid.price),
      createdAtText: time(bid.createdAt)
    }));
    const bidPriceText = String(this.data.bidPrice || "").trim();
    const currentBidPrice = Number(bidPriceText);
    const hasManualBidInput = bidPriceText.length > 0;
    const shouldKeepManualBid = snapshot.auction.status === "ACTIVE" && this.isEditingBidPrice;
    const shouldUseNextBid =
      !shouldKeepManualBid &&
      (snapshot.auction.status !== "ACTIVE" ||
        !hasManualBidInput ||
        !Number.isFinite(currentBidPrice) ||
        currentBidPrice < nextBid);
    const progressPercent =
      snapshot.auction.ceilingPrice > 0
        ? Math.min(100, Math.round((snapshot.auction.currentPrice / snapshot.auction.ceilingPrice) * 100))
        : 0;

    this.setData({
      snapshot: { ...snapshot, product, bids },
      safeProductImageUrl,
      serverOffset: snapshot.serverTime - Date.now(),
      bidPrice: shouldUseNextBid ? String(nextBid) : this.data.bidPrice,
      currentPriceText: money(snapshot.auction.currentPrice),
      nextBidText: money(nextBid),
      incrementText: money(snapshot.auction.incrementStep),
      ceilingText: money(snapshot.auction.ceilingPrice),
      stockText: `库存 ${product.stock === undefined ? 1 : product.stock} 件`,
      orderPriceText: snapshot.order ? money(snapshot.order.finalPrice) : "¥0",
      statusText: statusMap[snapshot.auction.status] || snapshot.auction.status,
      liveBadgeText: badgeMap[snapshot.auction.status] || snapshot.auction.status,
      leaderText: snapshot.auction.winnerNickname || "暂无领先用户",
      bidCountText: `${bids.length} 条记录`,
      aiScriptText: product.buyerAiScript
        ? product.buyerAiScript.slice(0, 120)
        : product.aiScript
          ? product.aiScript.slice(0, 120)
          : "主播正在准备 AI 好物讲解",
      productStateText: this.getProductStateText(snapshot),
      progressPercent,
      progressText: `${progressPercent}%`,
      ruleText: `起拍价 ${money(snapshot.auction.startPrice)} / 最低加价 ${money(snapshot.auction.incrementStep)} / 封顶价 ${money(snapshot.auction.ceilingPrice)}`,
      lastSyncText: time(Date.now())
    });
    this.refreshComputed();
    return true;
  },

  isDemoResetSnapshot(snapshot) {
    return (
      snapshot.auction.status === "PENDING" &&
      snapshot.auction.version === 1 &&
      snapshot.auction.startTime === null &&
      snapshot.auction.endTime === null &&
      snapshot.bids.length === 0 &&
      snapshot.order === null
    );
  },

  getProductStateText(snapshot) {
    if (snapshot.auction.status === "ACTIVE") {
      return `正在竞拍，当前最低可参与 ${money(snapshot.auction.currentPrice + snapshot.auction.incrementStep)}`;
    }

    if (snapshot.auction.status === "SOLD" && snapshot.order) {
      return `已成交，买家 ${snapshot.order.buyerNickname}，等待主播确认下一件`;
    }

    if (snapshot.auction.status === "UNSOLD") {
      return "本件已流拍，等待主播确认下一件";
    }

    if (snapshot.auction.status === "CANCELLED") {
      return "本件已取消，等待主播确认下一件";
    }

    return "等待主播开始竞拍";
  },

  resolveProductImageUrl(product) {
    if (!product.imageUrl) {
      return "";
    }

    const localImageUrl = this.resolveLocalProductImageUrl(product.imageUrl);

    if (localImageUrl) {
      return localImageUrl;
    }

    return this.resolveAssetUrl(product.imageUrl);
  },

  resolveLocalProductImageUrl(url) {
    if (!url) {
      return "";
    }

    if (LOCAL_PRODUCT_IMAGES[url]) {
      return LOCAL_PRODUCT_IMAGES[url];
    }

    const localHttpPrefix = /^http:\/\/(?:localhost|127\.0\.0\.1|172\.29\.96\.253):4300(\/[^?#]*)/;
    const localHttpMatch = String(url).match(localHttpPrefix);

    if (localHttpMatch) {
      return LOCAL_PRODUCT_IMAGES[localHttpMatch[1]] || "";
    }

    return "";
  },

  resolveAssetUrl(url) {
    if (!url) {
      return "";
    }

    if (/^https:\/\//.test(url)) {
      return url;
    }

    if (/^http:\/\//.test(url)) {
      return "";
    }

    return `${getApiBaseUrl()}${url.startsWith("/") ? url : `/${url}`}`;
  },

  refreshComputed() {
    const snapshot = this.data.snapshot;

    if (!snapshot) {
      return;
    }

    const nextBid = snapshot.auction.currentPrice + snapshot.auction.incrementStep;
    const bidAmount = Number(this.data.bidPrice);
    const hasValidBidAmount = Number.isFinite(bidAmount);
    const isActive = snapshot.auction.status === "ACTIVE";
    const isOverCeiling = hasValidBidAmount && bidAmount > snapshot.auction.ceilingPrice;
    const canBid =
      isActive &&
      hasValidBidAmount &&
      bidAmount >= nextBid &&
      !isOverCeiling;

    this.setData({
      remainingText:
        isActive
          ? remaining(snapshot.auction.endTime, this.data.serverOffset)
          : "00:00",
      canBid,
      bidButtonText: `参与 ${money(Number(this.data.bidPrice || nextBid))}`,
      hint: this.hintLockedUntil && Date.now() < this.hintLockedUntil
        ? this.data.hint
        : canBid
          ? "本次金额满足规则"
          : isActive
            ? isOverCeiling
              ? `不能超过封顶价 ${money(snapshot.auction.ceilingPrice)}`
              : `最低金额 ${money(nextBid)}`
            : snapshot.auction.status === "SOLD"
              ? "本场已成交，请主播重开后参与"
              : "开始后可参与"
    });
  },

  showHint(hint) {
    this.hintLockedUntil = Date.now() + 2500;
    this.setData({ hint });
  },

  onBidInput(event) {
    this.isEditingBidPrice = true;
    this.setData({ bidPrice: event.detail.value });
    this.refreshComputed();
  },

  onBidInputFocus() {
    this.isEditingBidPrice = true;
  },

  onBidInputBlur() {
    this.isEditingBidPrice = false;
    this.refreshComputed();
  },

  fillNextBid() {
    const snapshot = this.data.snapshot;

    if (!snapshot || snapshot.auction.status !== "ACTIVE") {
      return;
    }

    const nextBid = snapshot.auction.currentPrice + snapshot.auction.incrementStep;
    this.isEditingBidPrice = false;
    this.setData({ bidPrice: String(nextBid) });
    this.refreshComputed();
  },

  fillCeilingBid() {
    const snapshot = this.data.snapshot;

    if (!snapshot || snapshot.auction.status !== "ACTIVE") {
      return;
    }

    this.isEditingBidPrice = false;
    this.setData({ bidPrice: String(snapshot.auction.ceilingPrice) });
    this.refreshComputed();
  },

  onDanmakuInput(event) {
    this.setData({ danmakuText: event.detail.value });
  },

  async submitDanmaku() {
    const content = String(this.data.danmakuText || "").trim();

    if (!content) {
      this.showHint("请输入弹幕内容");
      return;
    }

    if (content.length > 80) {
      this.showHint("弹幕内容不能超过 80 个字符");
      return;
    }

    this.setData({ sendingDanmaku: true });

    try {
      await getApp().ensureLogin();
      const result = await sendDanmaku(this.data.liveRoomId, { content });
      const message = {
        ...result.message,
        createdAtText: time(result.message.createdAt)
      };
      const messages = [message, ...this.data.danmakuMessages].slice(0, 20);

      this.setData({
        danmakuText: "",
        danmakuMessages: messages,
        stageDanmakuMessages: messages.slice(0, 5),
        debugText: "弹幕发送成功"
      });
      wx.showToast({ title: "弹幕已发送", icon: "success" });
    } catch (error) {
      const message = error.message || "弹幕发送失败";
      this.showHint(message);
      wx.showToast({ title: message.slice(0, 16), icon: "none" });
    } finally {
      this.setData({ sendingDanmaku: false });
    }
  },

  async submitBid() {
    if (!this.data.snapshot || !this.data.canBid) {
      return;
    }

    this.setData({ submitting: true, hint: "正在提交..." });

    try {
      await getApp().ensureLogin();
      const clientRequestId = `mp-${Date.now()}-${Math.random().toString(16).slice(2)}`;

      const result = await placeBid(this.data.liveRoomId, {
        price: Number(this.data.bidPrice),
        clientRequestId
      });

      this.applySnapshot(result.snapshot);
      this.setData({
        hint: "提交成功",
        realtimeText: `接口提交成功：${getApiBaseUrl()}`,
        debugText: `出价成功 ${money(result.snapshot.auction.currentPrice)}`
      });
    } catch (error) {
      this.setData({ debugText: error.message || "提交失败" });
      this.showHint(error.message || "提交失败");
    } finally {
      this.setData({ submitting: false });
    }
  },

  async payCurrentOrder() {
    const order = this.data.snapshot && this.data.snapshot.order;

    if (!order || order.status === "PAID") {
      return;
    }

    try {
      const result = await payOrder(order.id);
      if (result.snapshot) {
        this.applySnapshot(result.snapshot);
      } else {
        this.applySnapshot({
          ...this.data.snapshot,
          order: result.order || result
        });
      }
      wx.showToast({ title: "支付成功", icon: "success" });
    } catch (error) {
      wx.showToast({ title: error.message || "支付失败", icon: "none" });
    }
  },

  async openOrders() {
    try {
      await getMyOrders(this.data.liveRoomId);
      wx.navigateTo({
        url: `/pages/orders/index?liveRoomId=${this.data.liveRoomId}`
      });
    } catch (error) {
      this.showHint(error.message || "订单加载失败");
    }
  }
});
