export interface MiniprogramLoginCodeInput {
  code?: string;
}

export interface ResolvedMiniprogramLogin {
  openId?: string;
  source: "wechat" | "dev";
}

const WECHAT_CODE_SESSION_URL = "https://api.weixin.qq.com/sns/jscode2session";

export async function resolveMiniprogramLogin(input: MiniprogramLoginCodeInput): Promise<ResolvedMiniprogramLogin> {
  const code = input.code?.trim();
  const appId = process.env.WECHAT_MINIPROGRAM_APPID || process.env.WX_MINIPROGRAM_APPID;
  const secret = process.env.WECHAT_MINIPROGRAM_SECRET || process.env.WX_MINIPROGRAM_SECRET;

  if (!code) {
    return { source: "dev" };
  }

  if (!appId && !secret) {
    return { source: "dev" };
  }

  if (!appId || !secret) {
    throw new Error("微信登录配置不完整，请同时配置 WECHAT_MINIPROGRAM_APPID 和 WECHAT_MINIPROGRAM_SECRET");
  }

  const url = new URL(WECHAT_CODE_SESSION_URL);
  url.searchParams.set("appid", appId);
  url.searchParams.set("secret", secret);
  url.searchParams.set("js_code", code);
  url.searchParams.set("grant_type", "authorization_code");

  const response = await fetch(url);
  const data = (await response.json()) as {
    openid?: string;
    errcode?: number;
    errmsg?: string;
  };

  if (!response.ok || data.errcode) {
    throw new Error(data.errmsg || "微信登录失败，请稍后重试");
  }

  if (!data.openid) {
    throw new Error("微信登录未返回 openid");
  }

  return {
    openId: data.openid,
    source: "wechat"
  };
}
