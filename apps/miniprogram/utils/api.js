const API_BASE_URL_CANDIDATES = [
  "http://localhost:4300",
  "http://127.0.0.1:4300"
];
const DEFAULT_API_BASE_URL = API_BASE_URL_CANDIDATES[0];
const REQUEST_TIMEOUT_MS = 10000;
const FALLBACK_STATUS_CODES = [502, 503, 504];
const IGNORED_API_BASE_URLS = [
  "http://172.29.96.253:4300"
];

function getAppConfig() {
  const app = getApp();
  return app.globalData || {};
}

function getApiBaseUrl() {
  return normalizeBaseUrl(getAppConfig().apiBaseUrl || DEFAULT_API_BASE_URL);
}

function getDefaultApiBaseUrl() {
  return DEFAULT_API_BASE_URL;
}

function getApiBaseUrlCandidates() {
  const current = getApiBaseUrl();
  const candidates = [...API_BASE_URL_CANDIDATES, current].map(normalizeBaseUrl);
  return candidates.filter((candidate, index) => candidates.indexOf(candidate) === index);
}

function setApiBaseUrl(apiBaseUrl) {
  const normalized = normalizeBaseUrl(apiBaseUrl || DEFAULT_API_BASE_URL);
  const appConfig = getAppConfig();
  appConfig.apiBaseUrl = normalized;
  return normalized;
}

function normalizeBaseUrl(apiBaseUrl) {
  const normalized = String(apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, "");
  return IGNORED_API_BASE_URLS.includes(normalized) ? DEFAULT_API_BASE_URL : normalized;
}

function getErrorMessage(error) {
  if (!error) {
    return "未知错误";
  }

  if (typeof error === "string") {
    return error;
  }

  return error.message || error.errMsg || "未知错误";
}

function getResponseMessage(data) {
  if (!data) {
    return "请求失败";
  }

  if (typeof data === "string") {
    return data.slice(0, 80) || "请求失败";
  }

  return data.message || "请求失败";
}

function shouldTryNextBaseUrl(statusCode, index, baseUrls) {
  return FALLBACK_STATUS_CODES.includes(statusCode) && index < baseUrls.length - 1;
}

function request(path, options = {}) {
  const baseUrls = getApiBaseUrlCandidates();
  const shouldAttachToken = options.token !== "";
  const token = shouldAttachToken
    ? options.token || getAppConfig().token || wx.getStorageSync("auction_token")
    : "";
  const headers = {
    "Content-Type": "application/json",
    ...(options.header || {})
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return requestWithFallback(baseUrls, path, options, headers);
}

function requestWithFallback(baseUrls, path, options, headers) {
  let index = 0;
  let lastError = null;

  return new Promise((resolve, reject) => {
    const tryNext = () => {
      const baseUrl = baseUrls[index];

      if (!baseUrl) {
        reject(lastError || new Error("网络连接失败"));
        return;
      }

      wx.request({
        url: `${baseUrl}${path}`,
        method: options.method || "GET",
        data: options.data || {},
        header: headers,
        timeout: options.timeout || REQUEST_TIMEOUT_MS,
        success(res) {
          const data = res.data || {};

          if (res.statusCode >= 200 && res.statusCode < 300) {
            setApiBaseUrl(baseUrl);
            resolve(data);
            return;
          }

          const message = getResponseMessage(data);

          if (shouldTryNextBaseUrl(res.statusCode, index, baseUrls)) {
            lastError = new Error(`${message} (${res.statusCode}, ${baseUrl})`);
            index += 1;
            tryNext();
            return;
          }

          reject(new Error(`${message} (${res.statusCode}, ${baseUrl})`));
        },
        fail(error) {
          lastError = new Error(`${getErrorMessage(error)}，已尝试 ${baseUrl}`);
          index += 1;
          tryNext();
        }
      });
    };

    tryNext();
  });
}

function getSharedBuyerAuthData(input = {}) {
  return {
    account: String(input.account || "").trim(),
    password: String(input.password || "").trim(),
    nickname: String(input.nickname || input.account || "").trim()
  };
}

function registerBuyer(input = {}) {
  const data = getSharedBuyerAuthData(input);

  return request("/api/auth/web/register", {
    method: "POST",
    data: {
      ...data,
      role: "BUYER"
    },
    token: ""
  });
}

function loginBuyer(input = {}) {
  const data = getSharedBuyerAuthData(input);

  return request("/api/auth/web/login", {
    method: "POST",
    data: {
      account: data.account,
      password: data.password
    },
    token: ""
  });
}

function getMe() {
  return request("/api/me");
}

function getLiveRooms() {
  return request("/api/live-rooms");
}

function getLiveRoom(liveRoomId) {
  return request(`/api/live-rooms/${encodeURIComponent(liveRoomId)}`);
}

function getAuctionSnapshot(liveRoomId) {
  return request(`/api/live-rooms/${encodeURIComponent(liveRoomId)}/auction`);
}

function getDanmakuMessages(liveRoomId) {
  return request(`/api/live-rooms/${encodeURIComponent(liveRoomId)}/danmaku`);
}

function sendDanmaku(liveRoomId, input) {
  return request(`/api/live-rooms/${encodeURIComponent(liveRoomId)}/danmaku`, {
    method: "POST",
    data: input
  });
}

function placeBid(liveRoomId, input) {
  return request(`/api/live-rooms/${encodeURIComponent(liveRoomId)}/auction/bids`, {
    method: "POST",
    data: input
  });
}

function getMyOrders(liveRoomId) {
  const query = liveRoomId ? `?liveRoomId=${encodeURIComponent(liveRoomId)}` : "";
  return request(`/api/me/orders${query}`);
}

function payOrder(orderId) {
  return request(`/api/orders/${encodeURIComponent(orderId)}/pay`, {
    method: "POST"
  });
}

module.exports = {
  getAuctionSnapshot,
  getApiBaseUrl,
  getApiBaseUrlCandidates,
  getDanmakuMessages,
  getDefaultApiBaseUrl,
  getMe,
  getLiveRoom,
  getLiveRooms,
  getMyOrders,
  loginBuyer,
  payOrder,
  placeBid,
  registerBuyer,
  request,
  sendDanmaku,
  setApiBaseUrl
};
