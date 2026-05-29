const { getDefaultApiBaseUrl, getMe, loginDemo } = require("./utils/api");

const DEFAULT_API_BASE_URL = getDefaultApiBaseUrl();

App({
  globalData: {
    token: "",
    user: null,
    apiBaseUrl: DEFAULT_API_BASE_URL
  },

  onLaunch() {
    wx.removeStorageSync("auction_api_base_url");
    this.globalData.apiBaseUrl = DEFAULT_API_BASE_URL;
    this.restoreStoredSession();
  },

  restoreStoredSession() {
    const storedToken = wx.getStorageSync("auction_token");
    const storedUser = wx.getStorageSync("auction_user");

    if (storedToken && storedUser) {
      this.globalData.token = storedToken;
      this.globalData.user = storedUser;
    }
  },

  async ensureLogin() {
    if (this.globalData.token) {
      try {
        const result = await getMe();
        this.globalData.user = result.user;
        return this.globalData;
      } catch {
        this.globalData.token = "";
        this.globalData.user = null;
      }
    }

    const storedToken = wx.getStorageSync("auction_token");
    const storedUser = wx.getStorageSync("auction_user");

    if (storedToken && storedUser) {
      this.globalData.token = storedToken;
      this.globalData.user = storedUser;

      try {
        await getMe();
        return this.globalData;
      } catch {
        this.globalData.token = "";
        this.globalData.user = null;
        wx.removeStorageSync("auction_token");
        wx.removeStorageSync("auction_user");
      }
    }

    await this.loginDemoUser();

    return this.globalData;
  },

  async loginDemoUser(input = {}) {
    const nickname = input.nickname || wx.getStorageSync("auction_nickname") || "演示买家";
    wx.setStorageSync("auction_nickname", nickname);
    const result = await loginDemo({ nickname });

    this.globalData.token = result.token;
    this.globalData.user = result.user;
    wx.setStorageSync("auction_token", result.token);
    wx.setStorageSync("auction_user", result.user);

    return result;
  },

  logout() {
    this.globalData.token = "";
    this.globalData.user = null;
    wx.removeStorageSync("auction_token");
    wx.removeStorageSync("auction_user");
  }
});
