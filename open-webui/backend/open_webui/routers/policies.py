import logging
import os
import re
import time
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from open_webui.internal.db import get_async_session
from open_webui.models.policies import (
    Policies,
    PolicyForm,
    PolicyListResponse,
    PolicyUpdateForm,
)
from open_webui.utils.auth import get_current_user
from sqlalchemy.ext.asyncio import AsyncSession

log = logging.getLogger(__name__)

router = APIRouter()

# Policy ids become .rego filenames in MADE: keep them URL-safe and
# traversal-proof (no slashes, no dots-only segments).
POLICY_ID_RE = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9._-]*$')

# Node backend (compile) and MADE (deploy) are sibling containers under
# docker compose; the env vars let a non-compose deployment override them.
POLICY_COMPILER_URL = os.getenv('POLICY_COMPILER_URL', 'http://app:3000')
MADE_URL = os.getenv('MADE_URL', 'http://made:8000')

REQUEST_TIMEOUT = httpx.Timeout(60.0, connect=10.0)


def policy_error(status_code: int, error: str, details: Optional[str] = None) -> JSONResponse:
    """Spec-compliant error shape: {error: str, details?: str}."""
    content: dict = {'error': error}
    if details:
        content['details'] = details
    return JSONResponse(status_code=status_code, content=content)


async def require_admin(user=Depends(get_current_user)):
    """Spec AC-1: non-admin gets 403 (deliberately, not get_admin_user's 401)."""
    if user.role != 'admin':
        return policy_error(403, 'Admin access required')
    return user


def validate_policy_id(policy_id: str) -> Optional[JSONResponse]:
    if not POLICY_ID_RE.match(policy_id):
        return policy_error(400, 'Invalid policy id', 'Use only letters, digits, ".", "_" or "-"')
    return None


async def made_deploy(policy_id: str, rego_content: str) -> tuple[str, Optional[str]]:
    """POST a Rego policy to MADE.

    Returns ('ok', None), ('error', <MADE message>), or ('unreachable', None).
    """
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            response = await client.post(
                f'{MADE_URL}/api/policies/deploy',
                json={'policy_id': policy_id, 'rego_content': rego_content},
            )
    except httpx.HTTPError as exc:
        log.error('deploy-policy: MADE unreachable: %s', exc)
        return ('unreachable', None)

    if response.status_code == 200:
        return ('ok', None)

    try:
        made_error = response.json().get('detail') or response.text
    except Exception:
        made_error = f'MADE returned status {response.status_code}'
    return ('error', str(made_error))


############################
# CreatePolicy
############################


@router.post('')
async def create_policy(
    request: Request,
    form_data: PolicyForm,
    user=Depends(require_admin),
    db: AsyncSession = Depends(get_async_session),
):
    id_error = validate_policy_id(form_data.id)
    if id_error:
        return id_error

    existing = await Policies.get_policy_by_id(form_data.id, db=db)
    if existing:
        return policy_error(409, 'Policy id already exists')

    policy = await Policies.insert_new_policy(user.id, form_data, db=db)
    return JSONResponse(status_code=201, content=policy.model_dump())


############################
# ListPolicies
############################


@router.get('')
async def list_policies(
    request: Request,
    status: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
    user=Depends(require_admin),
    db: AsyncSession = Depends(get_async_session),
):
    if status is not None and status not in ('draft', 'active'):
        return policy_error(400, 'Invalid status filter', "status must be 'draft' or 'active'")
    result = await Policies.get_policies(status=status, skip=offset, limit=limit, db=db)
    return PolicyListResponse.model_validate(result).model_dump()


############################
# GetPolicyById
############################


@router.get('/{policy_id}')
async def get_policy_by_id(
    request: Request,
    policy_id: str,
    user=Depends(require_admin),
    db: AsyncSession = Depends(get_async_session),
):
    policy = await Policies.get_policy_by_id(policy_id, db=db)
    if not policy:
        return policy_error(404, 'Policy not found')
    return policy.model_dump()


############################
# UpdatePolicyById (draft only)
############################


@router.put('/{policy_id}')
async def update_policy_by_id(
    request: Request,
    policy_id: str,
    form_data: PolicyUpdateForm,
    user=Depends(require_admin),
    db: AsyncSession = Depends(get_async_session),
):
    policy = await Policies.get_policy_by_id(policy_id, db=db)
    if not policy:
        return policy_error(404, 'Policy not found')
    if not policy.can_edit:
        return policy_error(400, "Can't edit active policy")

    updated = await Policies.update_policy_markdown(policy_id, form_data, db=db)
    return updated.model_dump()


############################
# DeletePolicyById (draft only)
############################


@router.delete('/{policy_id}')
async def delete_policy_by_id(
    request: Request,
    policy_id: str,
    user=Depends(require_admin),
    db: AsyncSession = Depends(get_async_session),
):
    policy = await Policies.get_policy_by_id(policy_id, db=db)
    if not policy:
        return policy_error(404, 'Policy not found')
    if not policy.can_edit:
        return policy_error(400, "Can't delete active policy")

    deleted = await Policies.delete_policy_by_id(policy_id, db=db)
    if not deleted:
        return policy_error(500, 'Failed to delete policy')
    return JSONResponse(status_code=204, content=None)


############################
# CompilePolicyById
############################


@router.post('/{policy_id}/compile')
async def compile_policy_by_id(
    request: Request,
    policy_id: str,
    user=Depends(require_admin),
    db: AsyncSession = Depends(get_async_session),
):
    policy = await Policies.get_policy_by_id(policy_id, db=db)
    if not policy:
        return policy_error(404, 'Policy not found')

    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            response = await client.post(
                f'{POLICY_COMPILER_URL}/api/compile-policy',
                json={'markdown': policy.markdown_content},
            )
    except httpx.HTTPError as exc:
        log.error('compile-policy: node backend unreachable: %s', exc)
        return policy_error(503, 'Compiler service unreachable', 'The Node backend could not be reached')

    if response.status_code != 200:
        try:
            detail = response.json().get('error')
        except Exception:
            detail = f'Compiler returned status {response.status_code}'
        return policy_error(400, detail or 'LLM compilation failed')

    body = response.json()
    rego = body.get('rego')
    if not rego:
        return policy_error(400, 'LLM compilation failed', 'Compiler response missing rego')

    await Policies.save_compiled_rego(policy_id, rego, db=db)
    return {'compiled_rego': rego, 'warnings': body.get('warnings', [])}


############################
# DeployPolicyById (to MADE, with rollback)
############################


@router.post('/{policy_id}/deploy')
async def deploy_policy_by_id(
    request: Request,
    policy_id: str,
    user=Depends(require_admin),
    db: AsyncSession = Depends(get_async_session),
):
    policy = await Policies.get_policy_by_id(policy_id, db=db)
    if not policy:
        return policy_error(404, 'Policy not found')
    if policy.is_active:
        return policy_error(400, 'Policy already active')
    if not policy.compiled_rego:
        return policy_error(400, 'Compile first', 'No compiled Rego available; compile before deploying')

    # Backup the last deployed version (if any) so a failed deploy can roll back
    if policy.active_rego:
        await Policies.update_deploy_state(policy_id, previous_rego=policy.active_rego, db=db)

    outcome, made_error = await made_deploy(policy_id, policy.compiled_rego)

    if outcome == 'unreachable':
        # MADE state unknown — no rollback, policy untouched
        return policy_error(502, 'MADE unreachable', 'No rollback attempted; retry deploy later')

    if outcome == 'ok':
        now = int(time.time_ns())
        await Policies.update_deploy_state(
            policy_id,
            status='active',
            active_rego=policy.compiled_rego,
            deployed_at=now,
            clear_error=True,
            db=db,
        )
        return {'status': 'active', 'deployed_at': now, 'message': 'Policy deployed successfully'}

    # MADE rejected the new Rego
    if policy.active_rego:
        rollback_outcome, rollback_error = await made_deploy(policy_id, policy.active_rego)
        await Policies.update_deploy_state(policy_id, status='draft', last_error=made_error or '', db=db)
        if rollback_outcome == 'ok':
            return JSONResponse(
                status_code=400,
                content={
                    'status': 'draft',
                    'error': f'MADE rejected policy: {made_error}',
                    'rolled_back': True,
                    'message': 'Deployment failed. Rolled back to previous version. Fix the Rego and retry.',
                },
            )
        return policy_error(
            400,
            'Deployment failed, and rollback also failed. MADE state may be inconsistent.',
            f'rollback error: {rollback_error or rollback_outcome}',
        )

    # First deploy failed: nothing to roll back to
    await Policies.update_deploy_state(policy_id, last_error=made_error or '', db=db)
    return JSONResponse(
        status_code=400,
        content={
            'status': 'draft',
            'error': f'MADE rejected policy: {made_error}',
            'rolled_back': False,
            'message': 'Deployment failed. Fix the Rego and retry.',
        },
    )
