const { getAuctionSnapshot, getLiveRoom, getMyOrders, payOrder, placeBid } = require("../../utils/api");
const { money, remaining, time } = require("../../utils/format");

const statusMap = {
  PENDING: "待开始",
  ACTIVE: "进行中",
  SOLD: "已成交",
  UNSOLD: "已结束",
  CANCELLED: "已取消"
};

Page({
  data: {
    liveRoomId: "live-1",
    loading: true,
    submitting: false,
    error: "",
    room: null,
    snapshot: null,
    bidPrice: "",
    serverOffset: 0,
    remainingText: "00:00",
    currentPriceText: "¥0",
    incrementText: "¥0",
    ceilingText: "¥0",
    orderPriceText: "¥0",
    statusText: "待开始",
    bidButtonText: "参与",
    hint: "开始后可参与",
    realtimeText: "实时连接准备中",
    canBid: false
  },

  async onLoad(options) {
    this.setData({ liveRoomId: options.liveRoomId || "live-1" });
    await getApp().ensureLogin();
    await this.load();
  },

  onShow() {
    this.connectRealtime();
    this.clockTimer = setInterval(() => this.refreshComputed(), 500);
  },

  onHide() {
    this.closeRealtime();
    clearInterval(this.clockTimer);
  },

  onUnload() {
    this.closeRealtime();
    clearInterval(this.clockTimer);
  },

  async load() {
    this.setData({ loading: true, error: "" });

    try {
      const [roomData, snapshot] = await Promise.all([
        getLiveRoom(this.data.liveRoomId),
        getAuctionSnapshot(this.data.liveRoomId)
      ]);

      this.applySnapshot(snapshot);
      this.setData({ room: roomData.room });
    } catch (error) {
      this.setData({ error: error.message || "进入专场失败" });
    } finally {
      this.setData({ loading: false });
    }
  },

  async loadSnapshot() {
    if (this.data.loading) {
      return;
    }

    try {
      const snapshot = await getAuctionSnapshot(this.data.liveRoomId);
      this.applySnapshot(snapshot);
    } catch {
      this.setData({ hint: "网络波动，正在恢复专场数据" });
    }
  },

  connectRealtime() {
    const app = getApp();

    this.closeRealtime();
    this.setData({ realtimeText: "实时连接中" });

    this.socket = wx.connectSocket({
      url: app.globalData.wsUrl,
      success: () => {}
    });

    this.socket.onOpen(() => {
      this.setData({ realtimeText: "实时已连接" });
      this.socket.send({
        data: JSON.stringify({
          type: "auction:join",
          payload: {
            liveRoomId: this.data.liveRoomId
          }
        })
      });
    });

    this.socket.onMessage((event) => {
      this.handleRealtimeMessage(event.data);
    });

    this.socket.onClose(() => {
      this.setData({ realtimeText: "实时已断开，使用轮询兜底" });
      this.startPollingFallback();
    });

    this.socket.onError(() => {
      this.setData({ realtimeText: "实时连接失败，使用轮询兜底" });
      this.startPollingFallback();
    });
  },

  closeRealtime() {
    if (this.socket) {
      this.socket.close({});
      this.socket = null;
    }

    clearInterval(this.pollTimer);
  },

  startPollingFallback() {
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this.loadSnapshot(), 2000);
  },

  handleRealtimeMessage(raw) {
    try {
      const message = JSON.parse(raw);

      if (
        message.type === "auction:snapshot" ||
        message.type === "auction:started" ||
        message.type === "auction:bid-success" ||
        message.type === "auction:extended" ||
        message.type === "auction:ended" ||
        message.type === "order:paid"
      ) {
        this.applySnapshot(message.payload);
        this.setData({ realtimeText: "实时同步中" });
        return;
      }

      if (message.type === "auction:cancelled") {
        this.applySnapshot(message.payload.snapshot);
        this.setData({ realtimeText: "本场已取消" });
        return;
      }

      if (message.type === "auction:error") {
        this.setData({ hint: message.payload.message || "实时消息错误" });
      }
    } catch {
      this.setData({ hint: "实时消息解析失败" });
    }
  },

  applySnapshot(snapshot) {
    const nextBid = snapshot.auction.currentPrice + snapshot.auction.incrementStep;
    const bids = (snapshot.bids || []).map((bid) => ({
      ...bid,
      priceText: money(bid.price),
      createdAtText: time(bid.createdAt)
    }));

    this.setData({
      snapshot: { ...snapshot, bids },
      serverOffset: snapshot.serverTime - Date.now(),
      bidPrice: String(nextBid),
      currentPriceText: money(snapshot.auction.currentPrice),
      incrementText: money(snapshot.auction.incrementStep),
      ceilingText: money(snapshot.auction.ceilingPrice),
      orderPriceText: snapshot.order ? money(snapshot.order.finalPrice) : "¥0",
      statusText: statusMap[snapshot.auction.status] || snapshot.auction.status
    });
    this.refreshComputed();
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
      remainingText: remaining(snapshot.auction.endTime, this.data.serverOffset),
      canBid,
      bidButtonText: `参与 ${money(Number(this.data.bidPrice || nextBid))}`,
      hint: canBid ? "本次金额满足规则" : snapshot.auction.status === "ACTIVE" ? `最低金额 ${money(nextBid)}` : "开始后可参与"
    });
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
      const clientRequestId = `mp-${Date.now()}-${Math.random().toString(16).slice(2)}`;

      if (this.socket) {
        this.socket.send({
          data: JSON.stringify({
            type: "auction:bid",
            payload: {
              liveRoomId: this.data.liveRoomId,
              token: getApp().globalData.token,
              price: Number(this.data.bidPrice),
              clientRequestId
            }
          })
        });
        this.setData({ hint: "已提交，等待实时同步" });
        return;
      }

      const result = await placeBid(this.data.liveRoomId, {
        price: Number(this.data.bidPrice),
        clientRequestId
      });

      this.applySnapshot(result.snapshot);
      this.setData({ hint: "提交成功" });
    } catch (error) {
      this.setData({ hint: error.message || "提交失败" });
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
    await getMyOrders(this.data.liveRoomId);
    wx.navigateTo({
      url: `/pages/orders/index?liveRoomId=${this.data.liveRoomId}`
    });
  }
});
