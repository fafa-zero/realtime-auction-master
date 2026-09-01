import json
import os

import pytest
import websockets


WS_URL = os.getenv("AUCTION_WS_URL", "ws://127.0.0.1:4300/miniprogram-ws")


@pytest.mark.asyncio
async def test_miniprogram_receives_snapshot_and_join_snapshot():
    async with websockets.connect(WS_URL) as socket:
        initial = json.loads(await socket.recv())
        assert initial["type"] == "auction:snapshot"
        assert initial["payload"]["auction"]["liveRoomId"] == "live-1"

        await socket.send(json.dumps({"type": "auction:join", "payload": {"liveRoomId": "live-2"}}))
        joined = json.loads(await socket.recv())
        assert joined["type"] == "auction:snapshot"
        assert joined["payload"]["auction"]["liveRoomId"] == "live-2"

