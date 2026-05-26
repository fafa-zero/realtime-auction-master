const { getLiveRooms } = require("../../utils/api");

Page({
  data: {
    loading: true,
    error: "",
    rooms: [],
    userText: "正在登录..."
  },

  async onShow() {
    await this.load();
  },

  async load() {
    this.setData({ loading: true, error: "" });

    try {
      const app = getApp();
      await app.ensureLogin();
      const data = await getLiveRooms();

      this.setData({
        rooms: data.items || [],
        userText: app.globalData.user ? `当前用户：${app.globalData.user.nickname}` : "演示登录用户"
      });
    } catch (error) {
      this.setData({ error: error.message || "加载失败" });
    } finally {
      this.setData({ loading: false });
    }
  },

  openLive(event) {
    const liveRoomId = event.currentTarget.dataset.id;
    wx.navigateTo({
      url: `/pages/live/index?liveRoomId=${liveRoomId}`
    });
  }
});
