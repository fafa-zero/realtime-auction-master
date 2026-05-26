const { getMyOrders } = require("../../utils/api");
const { money } = require("../../utils/format");

Page({
  data: {
    liveRoomId: "",
    loading: true,
    error: "",
    orders: []
  },

  async onLoad(options) {
    this.setData({ liveRoomId: options.liveRoomId || "" });
    await getApp().ensureLogin();
    await this.load();
  },

  async onShow() {
    if (!this.data.loading) {
      await this.load();
    }
  },

  async load() {
    this.setData({ loading: true, error: "" });

    try {
      const data = await getMyOrders(this.data.liveRoomId || undefined);
      const orders = (data.items || []).map((order) => ({
        ...order,
        shortId: order.id.slice(0, 8),
        finalPriceText: money(order.finalPrice),
        statusText: order.status === "PAID" ? "已支付" : "待支付"
      }));

      this.setData({ orders });
    } catch (error) {
      this.setData({ error: error.message || "订单加载失败" });
    } finally {
      this.setData({ loading: false });
    }
  }
});
