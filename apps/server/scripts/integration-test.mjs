import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(scriptDir, "..");
const tempDir = mkdtempSync(join(tmpdir(), "auction-integration-"));
const port = 4600 + Math.floor(Math.random() * 1000);
const api = `http://127.0.0.1:${port}`;
const dataFile = join(tempDir, "auction-state.json");

const child = spawn(process.execPath, ["dist/index.js"], {
  cwd: serverDir,
  env: {
    ...process.env,
    PORT: String(port),
    CLIENT_URL: api,
    AUCTION_DATA_FILE: dataFile
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let serverOutput = "";
child.stdout.on("data", (chunk) => {
  serverOutput += String(chunk);
});
child.stderr.on("data", (chunk) => {
  serverOutput += String(chunk);
});

try {
  await waitForServer();
  await runIntegrationFlow();
  console.log("integration ok");
} finally {
  child.kill();
  rmSync(tempDir, { recursive: true, force: true });
}

async function runIntegrationFlow() {
  const suffix = Date.now();
  const host = await registerAndLogin({
    account: `host-${suffix}`,
    password: "demo123",
    nickname: "集成主播",
    role: "HOST"
  });
  const buyer = await registerAndLogin({
    account: `buyer-${suffix}`,
    password: "demo123",
    nickname: "集成买家",
    role: "BUYER"
  });
  const otherBuyer = await registerAndLogin({
    account: `buyer-other-${suffix}`,
    password: "demo123",
    nickname: "旁路买家",
    role: "BUYER"
  });

  const noTokenStart = await post("/api/live-rooms/live-1/auction/start", {
    durationSeconds: 60,
    incrementStep: 50,
    ceilingPrice: 100
  });
  assert.equal(noTokenStart.status, 401);

  const buyerStart = await post(
    "/api/live-rooms/live-1/auction/start",
    {
      durationSeconds: 60,
      incrementStep: 50,
      ceilingPrice: 100
    },
    buyer.token
  );
  assert.equal(buyerStart.status, 403);

  const started = await post(
    "/api/live-rooms/live-1/auction/start",
    {
      durationSeconds: 60,
      incrementStep: 50,
      ceilingPrice: 100
    },
    host.token
  );
  assert.equal(started.status, 200);
  assert.equal(started.data.auction.status, "ACTIVE");

  const hostBid = await post(
    "/api/live-rooms/live-1/auction/bids",
    {
      price: 50,
      clientRequestId: `host-bid-${suffix}`
    },
    host.token
  );
  assert.equal(hostBid.status, 400);
  assert.match(hostBid.data.message, /只有买家/);

  const bid = await post(
    "/api/live-rooms/live-1/auction/bids",
    {
      price: 100,
      clientRequestId: `buyer-bid-${suffix}`
    },
    buyer.token
  );
  assert.equal(bid.status, 200);
  assert.equal(bid.data.snapshot.auction.status, "SOLD");
  assert.equal(bid.data.snapshot.order.buyerUserId, buyer.user.id);

  const otherPay = await post(`/api/orders/${bid.data.snapshot.order.id}/pay`, {}, otherBuyer.token);
  assert.equal(otherPay.status, 403);

  const ownerPay = await post(`/api/orders/${bid.data.snapshot.order.id}/pay`, {}, buyer.token);
  assert.equal(ownerPay.status, 200);
  assert.equal(ownerPay.data.order.status, "PAID");

  const danmaku = await post(
    "/api/live-rooms/live-1/danmaku",
    {
      content: "集成弹幕"
    },
    buyer.token
  );
  assert.equal(danmaku.status, 200);
  assert.equal(danmaku.data.message.nickname, buyer.user.nickname);

  const otherRoomDanmaku = await get("/api/live-rooms/live-2/danmaku", buyer.token);
  assert.equal(otherRoomDanmaku.status, 200);
  assert.equal(
    otherRoomDanmaku.data.items.some((item) => item.id === danmaku.data.message.id),
    false
  );

  const buyerRetract = await post(
    `/api/live-rooms/live-1/danmaku/${danmaku.data.message.id}/retract`,
    {},
    buyer.token
  );
  assert.equal(buyerRetract.status, 403);

  const hostRetract = await post(
    `/api/live-rooms/live-1/danmaku/${danmaku.data.message.id}/retract`,
    {},
    host.token
  );
  assert.equal(hostRetract.status, 200);

  const sensitive = await post(
    "/api/live-rooms/live-1/danmaku",
    {
      content: "这是骗子"
    },
    buyer.token
  );
  assert.equal(sensitive.status, 400);

  for (let index = 0; index < 5; index += 1) {
    const response = await post(
      "/api/live-rooms/live-2/danmaku",
      {
        content: `限频弹幕 ${index}`
      },
      otherBuyer.token
    );
    assert.equal(response.status, 200);
  }

  const rateLimited = await post(
    "/api/live-rooms/live-2/danmaku",
    {
      content: "限频弹幕 6"
    },
    otherBuyer.token
  );
  assert.equal(rateLimited.status, 400);
  assert.match(rateLimited.data.message, /发送过快/);
}

async function registerAndLogin(input) {
  const registered = await post("/api/auth/web/register", input);
  assert.equal(registered.status, 200);

  const loggedIn = await post("/api/auth/web/login", {
    account: input.account,
    password: input.password
  });
  assert.equal(loggedIn.status, 200);
  assert.ok(loggedIn.data.token);

  return loggedIn.data;
}

async function get(path, token = "") {
  const response = await fetch(`${api}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });

  return {
    status: response.status,
    data: await response.json()
  };
}

async function post(path, body, token = "") {
  const response = await fetch(`${api}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });

  return {
    status: response.status,
    data: await response.json()
  };
}

async function waitForServer() {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 10_000) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early\n${serverOutput}`);
    }

    try {
      const response = await fetch(`${api}/api/health`);

      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until the server is ready.
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`server did not start\n${serverOutput}`);
}
