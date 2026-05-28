const { getApiBaseUrl, getLiveRooms } = require("../../utils/api");

const fallbackRooms = [
  {
    id: "live-1",
    title: "珠宝严选竞拍直播间",
    hostName: "主播小雅",
    viewerCount: 1286
  },
  {
    id: "live-2",
    title: "腕表收藏竞拍直播间",
    hostName: "主播阿辰",
    viewerCount: 842
  }
];

Page({
  data: {
    loading: false,
    error: "",
    rooms: fallbackRooms,
    userText: "演示登录用户",
    apiText: `后端：${getApiBaseUrl()}`
  },

  async onShow() {
    this.setData({ loading: false, error: "" });
  },

  async load() {
    this.setData({ loading: true, error: "" });

    try {
      const app = getApp();
      const data = await getLiveRooms();

      this.setData({
        rooms: data.items || fallbackRooms,
        userText: app.globalData.user ? `当前用户：${app.globalData.user.nickname}` : "演示登录用户",
        apiText: `后端：${app.globalData.apiBaseUrl}`
      });
    } catch (error) {
      this.setData({
        rooms: fallbackRooms,
        error: "",
        userText: "演示登录用户",
        apiText: `后端：${getApp().globalData.apiBaseUrl}，列表使用本地兜底`
      });
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
