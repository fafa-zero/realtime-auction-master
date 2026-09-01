import assert from "node:assert/strict";
import { createServer } from "node:http";
import { completeWithAgentChat } from "../dist/ai.js";

const serviceToken = "contract-agent-token";
let requestBody;
let requestHeaders;

const mockAgent = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    requestHeaders = req.headers;
    requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "content-type": "application/json", "x-request-id": "agent-response-id" });
    res.end(JSON.stringify({
      ok: true,
      title: "AI 竞拍助手",
      content: "当前竞拍规则以页面快照为准。",
      generatedAt: Date.now(),
      source: "fallback",
      fallback: true,
      message: "契约测试响应",
      sessionId: "contract-session",
      intent: "chat",
      citations: [{ id: "auction-rules", title: "竞拍规则", content: "规则内容", score: 2 }],
      historySize: 2,
      toolsUsed: ["get_live_room_snapshot"],
      toolResults: { get_live_room_snapshot: { auction: { currentPrice: 100 } } }
    }));
  });
});

await new Promise((resolve) => mockAgent.listen(0, "127.0.0.1", resolve));
const port = mockAgent.address().port;
process.env.AGENT_BASE_URL = `http://127.0.0.1:${port}`;
process.env.AGENT_SERVICE_TOKEN = serviceToken;

try {
  const result = await completeWithAgentChat({
    message: "当前竞拍有什么规则？",
    sessionId: "contract-session",
    userId: "buyer-1",
    userRole: "BUYER",
    liveRoomId: "live-1",
    requestId: "node-request-1",
    context: {
      auction: { currentPrice: 100, incrementStep: 10 },
      product: { id: "product-1", name: "翡翠吊坠" }
    }
  });

  assert.equal(requestHeaders["x-agent-service-token"], serviceToken);
  assert.equal(requestHeaders["x-request-id"], "node-request-1");
  assert.equal(requestBody.message, "当前竞拍有什么规则？");
  assert.equal(requestBody.session_id, "contract-session");
  assert.equal(requestBody.user_id, "buyer-1");
  assert.equal(requestBody.user_role, "BUYER");
  assert.equal(requestBody.live_room_id, "live-1");
  assert.deepEqual(requestBody.context.auction, { currentPrice: 100, incrementStep: 10 });
  assert.equal(result.source, "fallback");
  assert.equal(result.sessionId, "contract-session");
  assert.equal(result.citations[0].id, "auction-rules");
  assert.deepEqual(result.toolsUsed, ["get_live_room_snapshot"]);
  console.log("agent contract ok");
} finally {
  await new Promise((resolve, reject) => mockAgent.close((error) => (error ? reject(error) : resolve())));
}
