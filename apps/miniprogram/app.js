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

    const nickname = `小程序用户${Math.floor(Math.random() * 90 + 10)}`;
    const result = await loginDemo({ nickname });

    this.globalData.token = result.token;
    this.globalData.user = result.user;
    wx.setStorageSync("auction_token", result.token);
    wx.setStorageSync("auction_user", result.user);

    return this.globalData;
  }
});
