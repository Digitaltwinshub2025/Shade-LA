from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

try:
    from dotenv import load_dotenv
except Exception:  # pragma: no cover
    load_dotenv = None

from server.api.direct_sun_hours import router as direct_sun_hours_router
from server.api.epw import router as epw_router


if load_dotenv:
    try:
        load_dotenv(dotenv_path=Path(__file__).resolve().parents[1] / ".env", override=False)
    except Exception:
        pass


app = FastAPI(title="Terrain Solar Analysis API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://balanin.github.io",
        "https://digitaltwinshub2025.github.io",
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:5174",
        "http://localhost:5174",
        "http://127.0.0.1:5175",
        "http://localhost:5175",
        "http://127.0.0.1:5176",
        "http://localhost:5176",
    ],
    allow_origin_regex=r"^https://.*\.github\.io$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(epw_router)
app.include_router(direct_sun_hours_router)


@app.get("/health")
def health():
    return {"ok": True}
