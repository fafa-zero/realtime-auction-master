import { expect, test } from "@playwright/test";


test("host can open the auction dashboard", async ({ page }) => {
  await page.goto("/host");
  await page.getByRole("button", { name: "使用商家演示账号" }).click();
  await expect(page.getByRole("heading", { name: "直播间竞拍控制台" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Agent 运营工作台" })).toBeVisible();
  await expect(page.getByRole("button", { name: "库存预警" })).toBeVisible();
  await expect(page.getByRole("button", { name: "订单查询" })).toBeVisible();
  await expect(page.getByRole("button", { name: "售后建议" })).toBeVisible();
  await expect(page.getByRole("button", { name: "直播复盘" })).toBeVisible();
  await expect(page.locator(".connection")).toContainText("实时连接");
});


test("auction dashboard does not overflow on a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/host");
  await page.getByRole("button", { name: "使用商家演示账号" }).click();
  await expect(page.getByRole("heading", { name: "直播间竞拍控制台" })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
    .toBe(true);
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
  await expect(page.getByRole("heading", { name: "Agent 运营工作台" })).toBeVisible();
  await page.getByRole("textbox", { name: "Agent 消息" }).fill("给我一句主播话术");
  await page.getByRole("button", { name: "发送 Agent 消息" }).click();
  await expect(page.getByText("当前最高价 200 元，下一口 300 元起。")).toBeVisible();
  await expect(page.getByText("get_live_room_snapshot / generate_host_script")).toBeVisible();
});


test("inventory alert runs inside the unified Agent workbench", async ({ page }) => {
  let submittedMessage = "";
  await page.route("**/api/agent/chat", async (route) => {
    submittedMessage = String(route.request().postDataJSON().message ?? "");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        title: "Agent 运营工作台",
        content: "库存巡检：共 5 件商品，低库存 2 件。",
        generatedAt: Date.now(),
        source: "agent",
        fallback: false,
        message: "库存预警生成成功",
        intent: "inventory-alert",
        sessionId: "playwright-inventory",
        historySize: 2,
        toolsUsed: ["get_live_room_snapshot", "get_inventory_status"],
        citations: [{ id: "inventory-operations", title: "库存运营", content: "低库存规则", score: 2 }]
      })
    });
  });

  await page.goto("/host");
  await page.getByRole("button", { name: "使用商家演示账号" }).click();
  await page.getByRole("button", { name: "库存预警" }).click();
  await expect(page.getByText("库存巡检：共 5 件商品，低库存 2 件。")).toBeVisible();
  await expect(page.getByText("get_live_room_snapshot / get_inventory_status")).toBeVisible();
  expect(submittedMessage).toContain("库存");
  expect(submittedMessage).toContain("补货优先级");
});
