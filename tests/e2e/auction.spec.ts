import { expect, test } from "@playwright/test";


test("host can open the auction dashboard", async ({ page }) => {
  await page.goto("/host");
  await page.getByRole("button", { name: "使用商家演示账号" }).click();
  await expect(page.getByRole("heading", { name: "直播间竞拍控制台" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "AI 竞拍助手" })).toBeVisible();
});


test("host can use the Agent conversation surface", async ({ page }) => {
  await page.route("**/api/agent/chat", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        title: "AI 竞拍助手",
        content: "当前最高价 200 元，下一口 300 元起。",
        generatedAt: Date.now(),
        source: "agent",
        fallback: false,
        message: "测试 Agent 返回成功",
        intent: "host-cue",
        sessionId: "playwright",
        historySize: 2,
        toolsUsed: ["get_live_room_snapshot", "generate_host_script"],
        citations: []
      })
    });
  });
  await page.goto("/host");
  await page.getByRole("button", { name: "使用商家演示账号" }).click();
  await expect(page.getByText("Agent 对话", { exact: true })).toBeVisible();
  await page.getByLabel("Agent 消息").fill("给我一句主播话术");
  await page.getByRole("button", { name: "发送 Agent 消息" }).click();
  await expect(page.getByText("当前最高价 200 元，下一口 300 元起。")).toBeVisible();
  await expect(page.getByText("get_live_room_snapshot / generate_host_script")).toBeVisible();
});
