import os

from locust import HttpUser, between, task


class AuctionReadUser(HttpUser):
    """Read-only smoke load for public auction endpoints.

    Keep bid mutations out of the default load profile. A separate scenario
    should supply real buyer tokens and unique clientRequestId values.
    """

    host = os.getenv("AUCTION_HTTP_URL", "http://127.0.0.1:4300")
    wait_time = between(0.2, 1.0)

    @task(3)
    def read_snapshot(self):
        self.client.get("/api/live-rooms/live-1/auction", name="auction snapshot")

    @task(2)
    def read_live_rooms(self):
        self.client.get("/api/live-rooms", name="live rooms")

    @task(1)
    def health(self):
        self.client.get("/api/health", name="health")

