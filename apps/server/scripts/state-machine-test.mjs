import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "auction-state-machine-"));
process.env.AUCTION_DATA_FILE = join(tempDir, "auction-state.json");
process.env.AUCTION_STORAGE = "json";

try {
  const store = await import("../dist/store.js");

  testDuplicateBid(store);
  testCeilingSettlementAndOrderUniqueness(store);
  testTimedSettlementWithBid(store);
  testBidInFinalWindowExtendsAuction(store);
  testCancelRejectsBids(store);
  testUnbidAuctionBecomesUnsold(store);
  testRestartClearsCurrentBidsAndOrder(store);
  testLowBidRejected(store);
  testOverCeilingBidRejected(store);
  testPendingOrdersBlockBid(store);
  testPaidOrdersDoNotBlockBid(store);
  testBidIdempotencyIsScopedByAuctionAndUser(store);
  testLateOrderPaymentDoesNotMutateCurrentAuction(store);
  testFinishedProductCannotBeEditedOrArchived(store);
  testBlankProductImageUsesDefaultImage(store);

  console.log("state machine ok");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

function testDuplicateBid(store) {
  store.resetDemoState();
  store.startAuction("live-1", {
    durationSeconds: 60,
    incrementStep: 100,
    ceilingPrice: 500
  });

  const first = store.placeBid({
    liveRoomId: "live-1",
    userId: "buyer-a",
    nickname: "买家A",
    price: 100,
    clientRequestId: "duplicate-bid-1"
  });
  const duplicate = store.placeBid({
    liveRoomId: "live-1",
    userId: "buyer-a",
    nickname: "买家A",
    price: 100,
    clientRequestId: "duplicate-bid-1"
  });
  const snapshot = store.getSnapshot("live-1");

  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(snapshot.bids.length, 1);
  assert.equal(snapshot.auction.currentPrice, 100);
}

function testCeilingSettlementAndOrderUniqueness(store) {
  store.resetDemoState();
  store.startAuction("live-1", {
    durationSeconds: 60,
    incrementStep: 100,
    ceilingPrice: 300
  });

  store.placeBid({
    liveRoomId: "live-1",
    userId: "buyer-a",
    nickname: "买家A",
    price: 100,
    clientRequestId: "ceiling-bid-1"
  });
  const result = store.placeBid({
    liveRoomId: "live-1",
    userId: "buyer-b",
    nickname: "买家B",
    price: 300,
    clientRequestId: "ceiling-bid-2"
  });
  const snapshot = store.getSnapshot("live-1");
  const orders = store.getOrders("live-1");
  const stockAfterSold = snapshot.product.stock;

  assert.equal(result.settled, true);
  assert.equal(snapshot.auction.status, "SOLD");
  assert.equal(snapshot.order?.buyerUserId, "buyer-b");
  assert.equal(orders.length, 1);
  assert.equal(stockAfterSold, 0);

  store.settleAuction("live-1");
  assert.equal(store.getOrders("live-1").length, 1);
  assert.equal(store.getSnapshot("live-1").product.stock, stockAfterSold);
}

function testTimedSettlementWithBid(store) {
  store.resetDemoState();
  store.startAuction("live-1", {
    durationSeconds: 60,
    incrementStep: 100,
    ceilingPrice: 500
  });
  store.placeBid({
    liveRoomId: "live-1",
    userId: "buyer-a",
    nickname: "买家A",
    price: 100,
    clientRequestId: "timed-sold-bid-1"
  });

  const result = store.settleAuction("live-1");
  const snapshot = store.getSnapshot("live-1");

  assert.equal(result.settled, true);
  assert.equal(snapshot.auction.status, "SOLD");
  assert.equal(snapshot.order?.buyerUserId, "buyer-a");
  assert.equal(store.getOrders("live-1").length, 1);
}

function testBidInFinalWindowExtendsAuction(store) {
  store.resetDemoState();
  store.startAuction("live-1", {
    durationSeconds: 60,
    incrementStep: 100,
    ceilingPrice: 500
  });
  const auction = store.getAuction("live-1");
  auction.endTime = Date.now() + 5_000;
  const previousEndTime = auction.endTime;

  const result = store.placeBid({
    liveRoomId: "live-1",
    userId: "buyer-a",
    nickname: "买家A",
    price: 100,
    clientRequestId: "extend-bid-1"
  });
  const snapshot = store.getSnapshot("live-1");

  assert.equal(result.extended, true);
  assert.equal(snapshot.auction.extendCount, 1);
  assert.equal(snapshot.auction.endTime, previousEndTime + snapshot.auction.extendSeconds * 1000);
}

function testCancelRejectsBids(store) {
  store.resetDemoState();
  store.startAuction("live-1", {
    durationSeconds: 60,
    incrementStep: 100,
    ceilingPrice: 500
  });
  store.cancelAuction("live-1", "测试取消");

  assert.equal(store.getSnapshot("live-1").auction.status, "CANCELLED");
  assert.throws(
    () =>
      store.placeBid({
        liveRoomId: "live-1",
        userId: "buyer-a",
        nickname: "买家A",
        price: 100,
        clientRequestId: "cancelled-bid-1"
      }),
    /专场未开始/
  );
}

function testUnbidAuctionBecomesUnsold(store) {
  store.resetDemoState();
  store.startAuction("live-1", {
    durationSeconds: 60,
    incrementStep: 100,
    ceilingPrice: 500
  });
  const result = store.settleAuction("live-1");
  const snapshot = store.getSnapshot("live-1");

  assert.equal(result.settled, true);
  assert.equal(snapshot.auction.status, "UNSOLD");
  assert.equal(snapshot.order, null);
  assert.equal(store.getOrders("live-1").length, 0);
}

function testRestartClearsCurrentBidsAndOrder(store) {
  store.resetDemoState();
  store.startAuction("live-1", {
    durationSeconds: 60,
    incrementStep: 100,
    ceilingPrice: 300
  });
  store.placeBid({
    liveRoomId: "live-1",
    userId: "buyer-a",
    nickname: "买家A",
    price: 300,
    clientRequestId: "restart-bid-1"
  });

  assert.equal(store.getSnapshot("live-1").auction.status, "SOLD");
  assert.equal(store.getSnapshot("live-1").bids.length, 1);
  assert.notEqual(store.getSnapshot("live-1").order, null);

  const restarted = store.startAuction("live-1", {
    durationSeconds: 60,
    incrementStep: 100,
    ceilingPrice: 500
  });

  assert.equal(restarted.auction.status, "ACTIVE");
  assert.equal(restarted.auction.currentPrice, 0);
  assert.equal(restarted.bids.length, 0);
  assert.equal(restarted.order, null);
}

function testLowBidRejected(store) {
  store.resetDemoState();
  store.startAuction("live-1", {
    durationSeconds: 60,
    incrementStep: 100,
    ceilingPrice: 500
  });

  assert.throws(
    () =>
      store.placeBid({
        liveRoomId: "live-1",
        userId: "buyer-a",
        nickname: "买家A",
        price: 50,
        clientRequestId: "low-bid-1"
      }),
    /金额过低/
  );
}

function testOverCeilingBidRejected(store) {
  store.resetDemoState();
  store.startAuction("live-1", {
    durationSeconds: 60,
    incrementStep: 100,
    ceilingPrice: 500
  });

  assert.throws(
    () =>
      store.placeBid({
        liveRoomId: "live-1",
        userId: "buyer-a",
        nickname: "买家A",
        price: 600,
        clientRequestId: "over-ceiling-bid-1"
      }),
    /不能超过封顶价/
  );
}

function testPendingOrdersBlockBid(store) {
  store.resetDemoState();
  createPendingOrder(store, "risk-buyer", "pending-order-bid-1");
  store.startAuction("live-1", {
    durationSeconds: 60,
    incrementStep: 100,
    ceilingPrice: 300
  });
  store.placeBid({
    liveRoomId: "live-1",
    userId: "risk-buyer",
    nickname: "风险买家",
    price: 300,
    clientRequestId: "pending-order-bid-2"
  });
  store.startAuction("live-1", {
    durationSeconds: 60,
    incrementStep: 100,
    ceilingPrice: 500
  });

  assert.equal(store.getOrdersForUser("risk-buyer", "live-1").length, 2);
  assert.throws(
    () =>
      store.placeBid({
        liveRoomId: "live-1",
        userId: "risk-buyer",
        nickname: "风险买家",
        price: 100,
        clientRequestId: "pending-order-bid-3"
      }),
    /风控拦截/
  );
}

function testPaidOrdersDoNotBlockBid(store) {
  store.resetDemoState();
  const firstOrder = createPendingOrder(store, "paid-buyer", "paid-order-bid-1");
  store.payOrder(firstOrder.id);
  store.startAuction("live-1", {
    durationSeconds: 60,
    incrementStep: 100,
    ceilingPrice: 300
  });
  const second = store.placeBid({
    liveRoomId: "live-1",
    userId: "paid-buyer",
    nickname: "已支付买家",
    price: 300,
    clientRequestId: "paid-order-bid-2"
  });
  store.payOrder(second.snapshot.order.id);
  store.startAuction("live-1", {
    durationSeconds: 60,
    incrementStep: 100,
    ceilingPrice: 500
  });

  const allowed = store.placeBid({
    liveRoomId: "live-1",
    userId: "paid-buyer",
    nickname: "已支付买家",
    price: 100,
    clientRequestId: "paid-order-bid-3"
  });

  assert.equal(allowed.bid.userId, "paid-buyer");
  assert.equal(allowed.bid.risk, undefined);
}

function testBidIdempotencyIsScopedByAuctionAndUser(store) {
  store.resetDemoState();
  store.startAuction("live-1", {
    durationSeconds: 60,
    incrementStep: 100,
    ceilingPrice: 500
  });
  const first = store.placeBid({
    liveRoomId: "live-1",
    userId: "buyer-a",
    nickname: "买家A",
    price: 100,
    clientRequestId: "shared-request-id"
  });

  store.startAuction("live-2", {
    durationSeconds: 60,
    incrementStep: 200,
    ceilingPrice: 1000
  });
  const second = store.placeBid({
    liveRoomId: "live-2",
    userId: "buyer-b",
    nickname: "买家B",
    price: 200,
    clientRequestId: "shared-request-id"
  });

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, false);
  assert.equal(second.bid.auctionId, store.getAuction("live-2").id);
  assert.equal(store.getSnapshot("live-2").bids.length, 1);
}

function testLateOrderPaymentDoesNotMutateCurrentAuction(store) {
  store.resetDemoState();
  const order = createPendingOrder(store, "late-buyer", "late-pay-bid-1");
  const current = store.startAuction("live-1", {
    durationSeconds: 60,
    incrementStep: 100,
    ceilingPrice: 500
  });

  const paid = store.payOrder(order.id);
  const after = store.getSnapshot("live-1");

  assert.equal(paid.status, "PAID");
  assert.equal(paid.liveRoomId, "live-1");
  assert.equal(after.auction.id, current.auction.id);
  assert.equal(after.auction.status, "ACTIVE");
  assert.equal(after.order, null);
  assert.equal(store.getOrders("live-1").find((item) => item.id === order.id)?.status, "PAID");
}

function testFinishedProductCannotBeEditedOrArchived(store) {
  store.resetDemoState();
  createPendingOrder(store, "locked-buyer", "locked-product-bid-1");

  assert.throws(
    () =>
      store.updateAuctionProduct("live-1", "product-1", {
        name: "已成交后改名",
        description: "不允许修改",
        startPrice: 10,
        incrementStep: 5,
        ceilingPrice: 50,
        durationSeconds: 60,
        stock: 1
      }),
    /不能编辑/
  );
  assert.throws(() => store.archiveAuctionProduct("live-1", "product-1"), /不能下架/);
}

function testBlankProductImageUsesDefaultImage(store) {
  store.resetDemoState();
  const created = store.createAuctionProduct("live-1", {
    name: "空图商品",
    description: "应该使用默认图",
    imageUrl: "",
    startPrice: 0,
    incrementStep: 100,
    ceilingPrice: 300,
    durationSeconds: 60,
    stock: 1
  });

  assert.equal(created.item.product.imageUrl.startsWith("/static/"), true);
}

function createPendingOrder(store, userId, clientRequestId) {
  store.startAuction("live-1", {
    durationSeconds: 60,
    incrementStep: 100,
    ceilingPrice: 300
  });
  const result = store.placeBid({
    liveRoomId: "live-1",
    userId,
    nickname: userId,
    price: 300,
    clientRequestId
  });

  return result.snapshot.order;
}
