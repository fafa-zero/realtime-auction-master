const { loginDemo } = require("./utils/api");

App({
  globalData: {
    token: "",
    user: null,
    apiBaseUrl: "http://localhost:4200"
  },

  async ensureLogin() {
    if (this.globalData.token) {
      return this.globalData;
    }

    const storedToken = wx.getStorageSync("auction_token");
    const storedUser = wx.getStorageSync("auction_user");

    if (storedToken && storedUser) {
      this.globalData.token = storedToken;
      this.globalData.user = storedUser;
      return this.globalData;
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
