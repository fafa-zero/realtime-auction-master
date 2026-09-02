import hmac
import json
import os
import time

from fastapi import Depends, FastAPI, Header, HTTPException, Response

from .agent import model_circuit_breaker, run_agent
from .config import load_local_env
from .dynamic_agent import run_dynamic_agent
from .evaluation import run_evaluation
from .graph_agent import run_graph_agent
from .metrics import prometheus_snapshot
from .metrics import snapshot as metrics_snapshot
from .observability import logger, new_request_id, request_id_var
from .orchestrator import run_chat
from .prometheus import render_metrics
from .schemas import AgentRunRequest, AiResult, ChatRequest, ChatResponse
from .tools import list_tools

load_local_env()


app = FastAPI(
    title="Realtime Auction Agent",
    version="0.1.0",
    description="Python Agent service for the realtime auction project",
)


@app.middleware("http")
async def request_observability(request, call_next):
    request_id = request.headers.get("X-Request-Id", "").strip() or new_request_id()
    token = request_id_var.set(request_id)
    started = time.perf_counter()
    try:
        response = await call_next(request)
        response.headers["X-Request-Id"] = request_id
        return response
    finally:
        logger.info(
            json.dumps(
                {
                    "event": "http_request",
                    "requestId": request_id,
                    "method": request.method,
                    "path": request.url.path,
                    "status": getattr(locals().get("response"), "status_code", 500),
                    "latencyMs": round((time.perf_counter() - started) * 1000, 2),
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
        request_id_var.reset(token)


async def require_service_auth(x_agent_service_token: str | None = Header(default=None)) -> None:
    """Protect the internal endpoint when a service token is configured."""
    expected = os.getenv("AGENT_SERVICE_TOKEN", "").strip()
    if expected and not hmac.compare_digest(x_agent_service_token or "", expected):
        raise HTTPException(status_code=401, detail="Agent 服务鉴权失败")


@app.get("/health")
async def health() -> dict[str, object]:
    return {"ok": True, "service": "auction-agent"}


@app.get("/api/health")
async def api_health() -> dict[str, object]:
    return await health()


@app.get("/v1/tools", dependencies=[Depends(require_service_auth)])
async def tools() -> dict[str, object]:
    return {"ok": True, "items": list_tools()}


@app.get("/v1/metrics", dependencies=[Depends(require_service_auth)])
async def metrics() -> dict[str, object]:
    """Expose aggregate Agent telemetry for the host console or monitoring."""
    payload = metrics_snapshot()
    circuit = model_circuit_breaker.snapshot()
    payload["modelCircuit"] = {
        "state": circuit.state,
        "consecutiveFailures": circuit.consecutive_failures,
    }
    return payload


@app.get("/metrics", dependencies=[Depends(require_service_auth)])
async def prometheus_metrics() -> Response:
    """Expose aggregate telemetry in the Prometheus text exposition format."""
    circuit = model_circuit_breaker.snapshot()
    body = render_metrics(
        prometheus_snapshot(),
        circuit_state=circuit.state,
        circuit_failures=circuit.consecutive_failures,
    )
    return Response(content=body, media_type="text/plain; version=0.0.4")


@app.get("/v1/evaluation", dependencies=[Depends(require_service_auth)])
async def evaluation() -> dict[str, object]:
    """Run the dependency-free routing/tool regression suite on demand."""
    return run_evaluation()


@app.post("/v1/agent/run", response_model=AiResult, dependencies=[Depends(require_service_auth)])
async def run(request: AgentRunRequest) -> AiResult:
    return await run_agent(request)


@app.post("/v1/agent/dynamic", response_model=AiResult, dependencies=[Depends(require_service_auth)])
async def run_dynamic(request: AgentRunRequest) -> AiResult:
    """Run the native dynamic tool-calling loop (model chooses tools)."""
    return await run_dynamic_agent(request)


@app.post("/v1/agent/graph", response_model=AiResult, dependencies=[Depends(require_service_auth)])
async def run_graph(request: AgentRunRequest) -> AiResult:
    """Run the LangGraph variant of the dynamic tool-calling loop."""
    return await run_graph_agent(request)


async def _run_task(request: AgentRunRequest, task: str) -> AiResult:
    # Pydantic v1 and v2 both support copy(update=...) for this small adapter.
    return await run_agent(request.copy(update={"task": task}))


@app.post("/api/agent/product-script", response_model=AiResult, dependencies=[Depends(require_service_auth)])
async def product_script(request: AgentRunRequest) -> AiResult:
    return await _run_task(request, "product-script")


@app.post("/api/agent/auction-summary", response_model=AiResult, dependencies=[Depends(require_service_auth)])
async def auction_summary(request: AgentRunRequest) -> AiResult:
    return await _run_task(request, "auction-summary")


@app.post("/api/agent/host-cue", response_model=AiResult, dependencies=[Depends(require_service_auth)])
async def host_cue(request: AgentRunRequest) -> AiResult:
    return await _run_task(request, "host-cue")


@app.post("/api/agent/bid-risk", response_model=AiResult, dependencies=[Depends(require_service_auth)])
async def bid_risk(request: AgentRunRequest) -> AiResult:
    return await _run_task(request, "bid-risk")


@app.post("/v1/agent/chat", response_model=ChatResponse, dependencies=[Depends(require_service_auth)])
async def agent_chat(request: ChatRequest) -> ChatResponse:
    return await run_chat(request)


@app.post("/api/agent/chat", response_model=ChatResponse, dependencies=[Depends(require_service_auth)])
async def api_agent_chat(request: ChatRequest) -> ChatResponse:
    return await run_chat(request)
