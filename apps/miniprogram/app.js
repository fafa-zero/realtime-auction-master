const { getDefaultApiBaseUrl, getMe, loginDemo } = require("./utils/api");

const DEFAULT_API_BASE_URL = getDefaultApiBaseUrl();
const TOKEN_STORAGE_KEY = "auction_token";
const USER_STORAGE_KEY = "auction_user";
const EXPLICIT_LOGIN_STORAGE_KEY = "auction_explicit_login";

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
    if (!wx.getStorageSync(EXPLICIT_LOGIN_STORAGE_KEY)) {
      this.clearStoredSession();
      return;
    }

    const storedToken = wx.getStorageSync(TOKEN_STORAGE_KEY);
    const storedUser = wx.getStorageSync(USER_STORAGE_KEY);

    if (storedToken && storedUser) {
      this.globalData.token = storedToken;
      this.globalData.user = storedUser;
    }
  },

  async ensureLogin() {
    if (!wx.getStorageSync(EXPLICIT_LOGIN_STORAGE_KEY)) {
      this.clearStoredSession();
      throw new Error("请先登录后进入专场");
    }

    if (this.globalData.token) {
      try {
        const result = await getMe();
        this.globalData.user = result.user;
        return this.globalData;
      } catch {
        this.clearStoredSession();
      }
    }

    const storedToken = wx.getStorageSync(TOKEN_STORAGE_KEY);
    const storedUser = wx.getStorageSync(USER_STORAGE_KEY);

    if (storedToken && storedUser) {
      this.globalData.token = storedToken;
      this.globalData.user = storedUser;

      try {
        await getMe();
        return this.globalData;
      } catch {
        this.clearStoredSession();
      }
    }

    throw new Error("请先登录后进入专场");
  },

  async loginDemoUser(input = {}) {
    const nickname = input.nickname || wx.getStorageSync("auction_nickname") || "演示买家";
    wx.setStorageSync("auction_nickname", nickname);
    const result = await loginDemo({ nickname });

    this.globalData.token = result.token;
    this.globalData.user = result.user;
    wx.setStorageSync(EXPLICIT_LOGIN_STORAGE_KEY, "1");
    wx.setStorageSync(TOKEN_STORAGE_KEY, result.token);
    wx.setStorageSync(USER_STORAGE_KEY, result.user);

    return result;
  },

  logout() {
    this.clearStoredSession();
  },

  clearStoredSession() {
    this.globalData.token = "";
    this.globalData.user = null;
    wx.removeStorageSync(TOKEN_STORAGE_KEY);
    wx.removeStorageSync(USER_STORAGE_KEY);
    wx.removeStorageSync(EXPLICIT_LOGIN_STORAGE_KEY);
  }
});
