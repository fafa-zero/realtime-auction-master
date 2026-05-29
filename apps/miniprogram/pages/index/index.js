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
    loggingIn: false,
    loggedIn: false,
    error: "",
    rooms: fallbackRooms,
    nickname: "演示买家",
    userText: "请先登录",
    apiText: `后端：${getApiBaseUrl()}`
  },

  async onShow() {
    const app = getApp();
    this.setData({
      loading: false,
      error: "",
      loggedIn: Boolean(app.globalData.token && app.globalData.user),
      nickname: wx.getStorageSync("auction_nickname") || app.globalData.user?.nickname || "演示买家",
      userText: app.globalData.user ? `当前用户：${app.globalData.user.nickname}` : "请先登录后进入专场"
    });

    if (app.globalData.token && app.globalData.user) {
      this.load();
    }
  },

  onNicknameInput(event) {
    this.setData({ nickname: event.detail.value });
  },

  async loginBuyer() {
    const nickname = String(this.data.nickname || "").trim() || "演示买家";
    this.setData({ loggingIn: true, error: "" });

    try {
      const result = await getApp().loginDemoUser({ nickname });
      this.setData({
        loggedIn: true,
        userText: `当前用户：${result.user.nickname}`,
        nickname: result.user.nickname
      });
      await this.load();
    } catch (error) {
      this.setData({ error: error.message || "登录失败" });
    } finally {
      this.setData({ loggingIn: false });
    }
  },

  logout() {
    getApp().logout();
    this.setData({
      loggedIn: false,
      userText: "请先登录后进入专场",
      rooms: fallbackRooms
    });
  },

  async load() {
    if (!getApp().globalData.token) {
      this.setData({ loggedIn: false, userText: "请先登录后进入专场" });
      return;
    }

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
    if (!this.data.loggedIn) {
      this.setData({ error: "请先登录后进入专场" });
      return;
    }

    const liveRoomId = event.currentTarget.dataset.id;
    wx.navigateTo({
      url: `/pages/live/index?liveRoomId=${liveRoomId}`
    });
  }
});
