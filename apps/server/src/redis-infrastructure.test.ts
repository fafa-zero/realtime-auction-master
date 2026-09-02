import assert from "node:assert/strict";
import {
  extractSnapshot,
  getAuctionSnapshotForRead,
  isAuctionSnapshotForRoom,
  parseRealtimeEvent,
  snapshotKey
} from "./redis-infrastructure.js";
import type { AuctionSnapshot } from "./types.js";

const snapshot = {
  product: { id: "product-1", name: "翡翠吊坠" },
  auction: { liveRoomId: "live-1", currentPrice: 200 },
  bids: [],
  order: null,
  participantCount: 0,
  serverTime: 1
};

assert.equal(snapshotKey("live-1"), "auction:snapshot:live-1");
assert.deepEqual(extractSnapshot(snapshot), snapshot);
assert.deepEqual(extractSnapshot({ snapshot }), snapshot);
assert.equal(extractSnapshot({ auction: {} }), null);
assert.equal(isAuctionSnapshotForRoom(snapshot, "live-1"), true);
assert.equal(isAuctionSnapshotForRoom(snapshot, "live-2"), false);
assert.equal(isAuctionSnapshotForRoom({ ...snapshot, bids: null }, "live-1"), false);

const raw = JSON.stringify({
  id: "event-1",
  origin: "instance-1",
  liveRoomId: "live-1",
  type: "auction:bid-success",
  payload: snapshot,
  createdAt: 100
});
assert.equal(parseRealtimeEvent(raw)?.type, "auction:bid-success");
assert.equal(parseRealtimeEvent("bad-json"), null);
assert.equal(parseRealtimeEvent(JSON.stringify({ id: "missing-fields" })), null);

delete process.env.REDIS_SNAPSHOT_CACHE_READS;
const localSnapshot = snapshot as unknown as AuctionSnapshot;
assert.equal(await getAuctionSnapshotForRead("live-1", () => localSnapshot), localSnapshot);

console.log("redis infrastructure ok");
