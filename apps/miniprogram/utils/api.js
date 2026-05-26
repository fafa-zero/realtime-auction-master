const DEFAULT_API_BASE_URL = "http://localhost:4200";

function getAppConfig() {
  const app = getApp();
  return app.globalData || {};
}

function getApiBaseUrl() {
  return getAppConfig().apiBaseUrl || DEFAULT_API_BASE_URL;
}

function request(path, options = {}) {
  const token = options.token || getAppConfig().token || wx.getStorageSync("auction_token");
  const headers = {
    "Content-Type": "application/json",
    ...(options.header || {})
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return new Promise((resolve, reject) => {
    wx.request({
      url: `${getApiBaseUrl()}${path}`,
      method: options.method || "GET",
      data: options.data || {},
      header: headers,
      success(res) {
        const data = res.data || {};

        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
          return;
        }

        reject(new Error(data.message || "请求失败"));
      },
      fail(error) {
        reject(new Error(error.errMsg || "网络连接失败"));
      }
    });
  });
}

function loginDemo(input = {}) {
  let mockCode = wx.getStorageSync("auction_mock_code");

  if (!mockCode) {
    mockCode = `mock-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    wx.setStorageSync("auction_mock_code", mockCode);
  }

  return request("/api/auth/miniprogram/login", {
    method: "POST",
    data: {
      mockCode,
      nickname: input.nickname || "小程序用户",
      avatarUrl: input.avatarUrl || ""
    },
    token: ""
  });
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
  getLiveRoom,
  getLiveRooms,
  getMyOrders,
  loginDemo,
  payOrder,
  placeBid,
  request
};
