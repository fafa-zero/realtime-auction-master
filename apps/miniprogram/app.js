const { getDefaultApiBaseUrl, getMe, loginBuyer, logoutBuyer, registerBuyer } = require("./utils/api");

const DEFAULT_API_BASE_URL = getDefaultApiBaseUrl();
const TOKEN_STORAGE_KEY = "auction_token";
const USER_STORAGE_KEY = "auction_user";
const EXPLICIT_LOGIN_STORAGE_KEY = "auction_explicit_login";
const ACCOUNT_STORAGE_KEY = "auction_account";
const NICKNAME_STORAGE_KEY = "auction_nickname";

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

  async registerBuyer(input = {}) {
    const account = input.account || wx.getStorageSync(ACCOUNT_STORAGE_KEY) || "";
    const password = input.password || "";
    const nickname = input.nickname || wx.getStorageSync(NICKNAME_STORAGE_KEY) || account || "买家用户";

    wx.setStorageSync(ACCOUNT_STORAGE_KEY, account);
    wx.setStorageSync(NICKNAME_STORAGE_KEY, nickname);

    return registerBuyer({ account, password, nickname });
  },

  async loginBuyer(input = {}) {
    const account = input.account || wx.getStorageSync(ACCOUNT_STORAGE_KEY) || "";
    const password = input.password || "";
    const result = await loginBuyer({ account, password });

    if (result.user?.role !== "BUYER") {
      throw new Error("请使用买家账号登录小程序");
    }

    this.globalData.token = result.token;
    this.globalData.user = result.user;
    wx.setStorageSync(ACCOUNT_STORAGE_KEY, result.user.account || account);
    wx.setStorageSync(NICKNAME_STORAGE_KEY, result.user.nickname);
    wx.setStorageSync(EXPLICIT_LOGIN_STORAGE_KEY, "1");
    wx.setStorageSync(TOKEN_STORAGE_KEY, result.token);
    wx.setStorageSync(USER_STORAGE_KEY, result.user);

    return result;
  },

  logout() {
    if (this.globalData.token) {
      logoutBuyer().catch(() => {
        // Local logout should still clear stale client state if the network is unavailable.
      });
    }

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
