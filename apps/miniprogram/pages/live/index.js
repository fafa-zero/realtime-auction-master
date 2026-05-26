const { getAuctionSnapshot, getLiveRoom, getMyOrders, payOrder, placeBid } = require("../../utils/api");
const { money, remaining, time } = require("../../utils/format");

const statusMap = {
  PENDING: "待开始",
  ACTIVE: "竞拍中",
  SOLD: "已成交",
  UNSOLD: "已流拍",
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
    bidButtonText: "出价",
    hint: "竞拍开始后可出价",
    canBid: false
  },

  async onLoad(options) {
    this.setData({ liveRoomId: options.liveRoomId || "live-1" });
    await getApp().ensureLogin();
    await this.load();
  },

  onShow() {
    this.pollTimer = setInterval(() => this.loadSnapshot(), 2000);
    this.clockTimer = setInterval(() => this.refreshComputed(), 500);
  },

  onHide() {
    clearInterval(this.pollTimer);
    clearInterval(this.clockTimer);
  },

  onUnload() {
    clearInterval(this.pollTimer);
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
      this.setData({ error: error.message || "进入直播间失败" });
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
      this.setData({ hint: "网络波动，正在恢复直播间数据" });
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
      bidButtonText: `出价 ${money(Number(this.data.bidPrice || nextBid))}`,
      hint: canBid ? "本次出价满足规则" : snapshot.auction.status === "ACTIVE" ? `最低出价 ${money(nextBid)}` : "竞拍开始后可出价"
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

    this.setData({ submitting: true, hint: "正在提交出价..." });

    try {
      const result = await placeBid(this.data.liveRoomId, {
        price: Number(this.data.bidPrice),
        clientRequestId: `mp-${Date.now()}-${Math.random().toString(16).slice(2)}`
      });

      this.applySnapshot(result.snapshot);
      this.setData({ hint: "出价成功" });
    } catch (error) {
      this.setData({ hint: error.message || "出价失败" });
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
