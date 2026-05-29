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
    registering: false,
    loggedIn: false,
    authMode: "login",
    error: "",
    success: "",
    rooms: fallbackRooms,
    nickname: "演示买家",
    userText: "请先登录",
    apiText: `后端：${getApiBaseUrl()}`
  },

  async onShow() {
    const app = getApp();
    const storedNickname = wx.getStorageSync("auction_nickname") || app.globalData.user?.nickname || "演示买家";

    this.setData({
      loading: false,
      error: "",
      success: "",
      nickname: storedNickname
    });

    if (app.globalData.token && app.globalData.user) {
      try {
        await app.ensureLogin();
        this.setData({
          loggedIn: true,
          userText: `当前用户：${app.globalData.user.nickname}`
        });
        this.load();
      } catch {
        this.setData({
          loggedIn: false,
          userText: "请先登录后进入专场"
        });
      }
      return;
    }

    this.setData({
      loggedIn: false,
      userText: "请先登录后进入专场"
    });
  },

  onNicknameInput(event) {
    this.setData({ nickname: event.detail.value });
  },

  setAuthMode(event) {
    this.setData({
      authMode: event.currentTarget.dataset.mode,
      error: "",
      success: ""
    });
  },

  async loginBuyer() {
    const nickname = String(this.data.nickname || "").trim() || "演示买家";
    this.setData({ loggingIn: true, error: "", success: "" });

    try {
      const result = await getApp().loginBuyer({ nickname });
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

  async registerBuyer() {
    const nickname = String(this.data.nickname || "").trim() || "演示买家";
    this.setData({ registering: true, error: "", success: "" });

    try {
      const result = await getApp().registerBuyer({ nickname });
      this.setData({
        authMode: "login",
        nickname: result.user.nickname,
        success: `买家 ${result.user.nickname} 注册成功，请登录后进入专场`
      });
    } catch (error) {
      this.setData({ error: error.message || "注册失败" });
    } finally {
      this.setData({ registering: false });
    }
  },

  logout() {
    getApp().logout();
    this.setData({
      loggedIn: false,
      success: "",
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
        success: "",
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
