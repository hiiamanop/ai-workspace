"""Admin-only proxy to MADE's /privacy/mappings* and /privacy/leaks.

MADE has no auth and these endpoints return decrypted PII, so MADE stays on
the internal Docker network and this router is the auth boundary — same
shape as routers/policies.py. org_id is the requesting admin's own user id
(matching openwebui-filters/confidential_redaction.py's __user__.id scope).
"""
import logging
import os
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse, Response
from open_webui.utils.auth import get_current_user

log = logging.getLogger(__name__)

router = APIRouter()

MADE_URL = os.getenv("MADE_URL", "http://made:8000")
REQUEST_TIMEOUT = httpx.Timeout(30.0, connect=10.0)


async def require_admin(user=Depends(get_current_user)):
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


async def _made(method: str, path: str, *, params: dict, json: Optional[dict] = None):
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            resp = await client.request(method, f"{MADE_URL}{path}", params=params, json=json)
    except httpx.HTTPError as exc:
        log.error("privacy proxy: MADE unreachable: %s", exc)
        raise HTTPException(status_code=502, detail="Redaction service unreachable") from exc

    if resp.status_code == 204:
        return Response(status_code=204)
    body = resp.json() if resp.content else None
    if resp.status_code >= 400:
        detail = (body or {}).get("detail") if isinstance(body, dict) else None
        raise HTTPException(status_code=resp.status_code, detail=detail or "Request failed")
    return JSONResponse(content=body)


@router.get("/mappings")
async def list_mappings(limit: int = 200, offset: int = 0, user=Depends(require_admin)):
    return await _made(
        "GET", "/privacy/mappings", params={"org_id": user.id, "limit": limit, "offset": offset}
    )


@router.patch("/mappings/{mapping_id}")
async def update_mapping(mapping_id: str, body: dict, user=Depends(require_admin)):
    return await _made(
        "PATCH",
        f"/privacy/mappings/{mapping_id}",
        params={"org_id": user.id},
        json={
            "original_value": body.get("original_value"),
            "placeholder": body.get("placeholder"),
        },
    )


@router.delete("/mappings/{mapping_id}")
async def delete_mapping(mapping_id: str, user=Depends(require_admin)):
    return await _made("DELETE", f"/privacy/mappings/{mapping_id}", params={"org_id": user.id})


@router.get("/leaks")
async def list_leaks(limit: int = 200, offset: int = 0, user=Depends(require_admin)):
    return await _made(
        "GET", "/privacy/leaks", params={"org_id": user.id, "limit": limit, "offset": offset}
    )
