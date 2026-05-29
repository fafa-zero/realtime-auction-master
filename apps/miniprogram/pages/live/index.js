const {
  getApiBaseUrl,
  getAuctionSnapshot,
  getLiveRoom,
  getMyOrders,
  payOrder,
  placeBid
} = require("../../utils/api");
const { money, remaining, time } = require("../../utils/format");

const POLLING_INTERVAL_MS = 1500;

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
    submitting: false,
    error: "",
    room: fallbackRoom,
    snapshot: fallbackSnapshot,
    bidPrice: "",
    serverOffset: 0,
    remainingText: "00:00",
    currentPriceText: "¥0",
    incrementText: "¥0",
    ceilingText: "¥0",
    orderPriceText: "¥0",
    statusText: "待开始",
    liveBadgeText: "待开始",
    leaderText: "暂无领先用户",
    bidCountText: "0 条记录",
    bidButtonText: "参与",
    hint: "开始后可参与",
    buyerText: "买家未登录",
    aiScriptText: "",
    realtimeText: "实时连接准备中",
    debugText: "",
    canBid: false
  },

  async onLoad(options) {
    const liveRoomId = options.liveRoomId || "live-1";
    this.setData({ liveRoomId, loading: false, error: "" });
    await this.ensurePageLogin();
    this.applySnapshot({
      ...fallbackSnapshot,
      auction: { ...fallbackSnapshot.auction, liveRoomId },
      serverTime: Date.now()
    });
  },

  onShow() {
    this.ensurePageLogin().then(() => this.load());
    this.clockTimer = setInterval(() => this.refreshComputed(), 500);
    this.pollingTimer = setInterval(() => this.loadSnapshot(), POLLING_INTERVAL_MS);
  },

  onHide() {
    this.closeRealtime();
    clearInterval(this.clockTimer);
    clearInterval(this.pollingTimer);
  },

  onUnload() {
    this.closeRealtime();
    clearInterval(this.clockTimer);
    clearInterval(this.pollingTimer);
  },

  async load() {
    this.setData({ error: "" });

    try {
      const [roomData, snapshot] = await Promise.all([
        getLiveRoom(this.data.liveRoomId),
        getAuctionSnapshot(this.data.liveRoomId)
      ]);

      this.applySnapshot(snapshot);
      this.setData({ room: roomData.room });
    } catch (error) {
      this.setData({
        error: "",
        debugText: error.message || "后端暂不可用，当前使用本地兜底数据"
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  async ensurePageLogin() {
    try {
      await getApp().ensureLogin();
      const user = getApp().globalData.user;
      this.setData({
        buyerText: user ? `当前买家：${user.nickname}` : "买家未登录"
      });
    } catch (error) {
      wx.redirectTo({ url: "/pages/index/index" });
      throw error;
    }
  },

  async loadSnapshot() {
    if (this.data.loading || this.snapshotLoading) {
      return;
    }

    this.snapshotLoading = true;

    try {
      const snapshot = await getAuctionSnapshot(this.data.liveRoomId);
      this.applySnapshot(snapshot);
      this.setData({
        realtimeText: `轮询同步中：${getApiBaseUrl()}`,
        debugText: `最近同步成功 ${time(Date.now())}`
      });
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

  usePollingRealtime() {
    this.setData({ realtimeText: `轮询同步中：${getApiBaseUrl()}` });
    this.loadSnapshot();
  },

  refreshNow() {
    this.usePollingRealtime();
  },

  closeRealtime() {
    this.snapshotLoading = false;
  },

  applySnapshot(snapshot) {
    const nextBid = snapshot.auction.currentPrice + snapshot.auction.incrementStep;
    const product = {
      ...snapshot.product,
      imageUrl: this.resolveProductImageUrl(snapshot.product)
    };
    const bids = (snapshot.bids || []).map((bid) => ({
      ...bid,
      priceText: money(bid.price),
      createdAtText: time(bid.createdAt)
    }));
    const currentBidPrice = Number(this.data.bidPrice);
    const shouldUseNextBid =
      snapshot.auction.status !== "ACTIVE" ||
      !Number.isFinite(currentBidPrice) ||
      currentBidPrice < nextBid;

    this.setData({
      snapshot: { ...snapshot, product, bids },
      serverOffset: snapshot.serverTime - Date.now(),
      bidPrice: shouldUseNextBid ? String(nextBid) : this.data.bidPrice,
      currentPriceText: money(snapshot.auction.currentPrice),
      incrementText: money(snapshot.auction.incrementStep),
      ceilingText: money(snapshot.auction.ceilingPrice),
      orderPriceText: snapshot.order ? money(snapshot.order.finalPrice) : "¥0",
      statusText: statusMap[snapshot.auction.status] || snapshot.auction.status,
      liveBadgeText: badgeMap[snapshot.auction.status] || snapshot.auction.status,
      leaderText: snapshot.auction.winnerNickname || "暂无领先用户",
      bidCountText: `${bids.length} 条记录`,
      aiScriptText: product.aiScript ? product.aiScript.slice(0, 120) : "主播正在准备 AI 好物讲解"
    });
    this.refreshComputed();
  },

  resolveProductImageUrl(product) {
    if (!product.imageUrl) {
      return "";
    }

    if (product.imageUrl.startsWith("/static/")) {
      return "";
    }

    return this.resolveAssetUrl(product.imageUrl);
  },

  resolveAssetUrl(url) {
    if (!url || /^https?:\/\//.test(url)) {
      return url;
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
    const canBid =
      snapshot.auction.status === "ACTIVE" &&
      Number.isFinite(bidAmount) &&
      bidAmount >= nextBid;

    this.setData({
      remainingText:
        snapshot.auction.status === "ACTIVE"
          ? remaining(snapshot.auction.endTime, this.data.serverOffset)
          : "00:00",
      canBid,
      bidButtonText: `参与 ${money(Number(this.data.bidPrice || nextBid))}`,
      hint: this.hintLockedUntil && Date.now() < this.hintLockedUntil
        ? this.data.hint
        : canBid
          ? "本次金额满足规则"
          : snapshot.auction.status === "ACTIVE"
            ? `最低金额 ${money(nextBid)}`
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
    this.setData({ bidPrice: event.detail.value });
    this.refreshComputed();
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
      this.applySnapshot(result.snapshot);
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
