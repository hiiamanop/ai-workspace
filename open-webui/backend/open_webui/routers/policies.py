import json
import logging
import os
import re
import time
from typing import Optional
from fastapi.responses import Response

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from open_webui.internal.db import get_async_session
from open_webui.models.policies import (
    Policies,
    PolicyForm,
    PolicyListResponse,
    PolicyUpdateForm,
)
from open_webui.models.policy_audit_log import AUDIT_ACTIONS, PolicyAuditLogs, log_policy_action
from open_webui.models.policy_versions import PolicyVersions
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
    """Spec AC-1: non-admin gets 403 (deliberately, not get_admin_user's 401).

    Raised, not returned: a Response returned from a dependency would be
    passed to the endpoint as its `user` argument in this FastAPI version.
    """
    if user.role != 'admin':
        raise HTTPException(status_code=403, detail='Admin access required')
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

    if response.status_code >= 500:
        # MADE is up but unhealthy (5xx): its state is unknown, so treat it
        # like unreachable — never attempt a rollback against it (spec FR-D1).
        log.error('deploy-policy: MADE returned status %s', response.status_code)
        return ('unreachable', None)

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
    await log_policy_action(policy.id, 'create', user.id, after=policy.model_dump(), db=db)
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
    await log_policy_action(
        policy_id,
        'update',
        user.id,
        before={'markdown_content': policy.markdown_content},
        after={'markdown_content': updated.markdown_content},
        db=db,
    )
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
    # Logged after the delete: the audit row outlives the policy row (no FK),
    # so the trail survives even though the policy is gone.
    await log_policy_action(policy_id, 'delete', user.id, before=policy.model_dump(), db=db)
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
        await log_policy_action(
            policy_id, 'compile', user.id, compile_success=False,
            compile_error='Compiler service unreachable', db=db,
        )
        return policy_error(503, 'Compiler service unreachable', 'The Node backend could not be reached')

    if response.status_code != 200:
        try:
            detail = response.json().get('error')
        except Exception:
            detail = f'Compiler returned status {response.status_code}'
        await log_policy_action(
            policy_id, 'compile', user.id, compile_success=False,
            compile_error=detail or 'LLM compilation failed', db=db,
        )
        return policy_error(400, detail or 'LLM compilation failed')

    body = response.json()
    rego = body.get('rego')
    if not rego:
        await log_policy_action(
            policy_id, 'compile', user.id, compile_success=False,
            compile_error='Compiler response missing rego', db=db,
        )
        return policy_error(400, 'LLM compilation failed', 'Compiler response missing rego')

    await Policies.save_compiled_rego(policy_id, rego, db=db)
    await log_policy_action(
        policy_id, 'compile', user.id, compile_success=True,
        before={'compiled_rego': policy.compiled_rego}, after={'compiled_rego': rego}, db=db,
    )
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

    # Atomic claim (draft→draft): a concurrent deploy of the same policy
    # fails here with 400 and never reaches MADE.
    if not await Policies.reserve_for_deploy(policy_id, db=db):
        return policy_error(400, 'Policy already active', 'A concurrent deploy of this policy is in progress')

    # Backup the last deployed version (if any) so a failed deploy can roll back
    if policy.active_rego:
        await Policies.update_deploy_state(policy_id, previous_rego=policy.active_rego, db=db)

    outcome, made_error = await made_deploy(policy_id, policy.compiled_rego)

    if outcome == 'unreachable':
        # MADE state unknown — no rollback, policy otherwise untouched. The
        # last_error write is deliberate: operators need the signal, and
        # FR-D1's test asserts it (spec C3-D).
        await Policies.update_deploy_state(policy_id, last_error='MADE unreachable', db=db)
        await log_policy_action(
            policy_id, 'deploy', user.id,
            before={'status': policy.status}, made_response={'outcome': 'unreachable'}, db=db,
        )
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
        # Version row only after MADE accepted the Rego; failed deploys never
        # create one (FR-B1).
        await PolicyVersions.create_version(policy_id, policy.compiled_rego, user.id, db=db)
        await log_policy_action(
            policy_id, 'deploy', user.id,
            before={'status': 'draft'}, after={'status': 'active'},
            made_response={'outcome': 'ok'}, db=db,
        )
        return Response(
            content=('{"status":"active","deployed_at":' + str(now) + ',"message":"Policy deployed successfully"}'),
            status_code=200,
            media_type="application/json",
            headers={"no-transform": ""},
        )

    # MADE rejected the new Rego
    if policy.active_rego:
        rollback_outcome, rollback_error = await made_deploy(policy_id, policy.active_rego)
        await Policies.update_deploy_state(policy_id, status='draft', last_error=made_error or '', db=db)
        await log_policy_action(
            policy_id, 'deploy', user.id,
            before={'status': 'draft'}, after={'status': 'draft'},
            made_response={
                'outcome': 'error', 'error': made_error,
                'rolled_back': rollback_outcome == 'ok',
            },
            db=db,
        )
        if rollback_outcome == 'ok':
            content_dict = {
                'status': 'draft',
                'error': f'MADE rejected policy: {made_error}',
                'rolled_back': True,
                'message': 'Deployment failed. Rolled back to previous version. Fix the Rego and retry.',
            }
            return Response(
                content=json.dumps(content_dict),
                status_code=400,
                media_type="application/json",
                headers={"no-transform": ""},
            )
        return policy_error(
            400,
            'Deployment failed, and rollback also failed. MADE state may be inconsistent.',
            f'rollback error: {rollback_error or rollback_outcome}',
        )

    # First deploy failed: nothing to roll back to
    await Policies.update_deploy_state(policy_id, last_error=made_error or '', db=db)
    await log_policy_action(
        policy_id, 'deploy', user.id,
        before={'status': 'draft'}, after={'status': 'draft'},
        made_response={'outcome': 'error', 'error': made_error, 'rolled_back': False}, db=db,
    )
    content_dict = {
        'status': 'draft',
        'error': f'MADE rejected policy: {made_error}',
        'rolled_back': False,
        'message': 'Deployment failed. Fix the Rego and retry.',
    }
    return Response(
        content=json.dumps(content_dict),
        status_code=400,
        media_type="application/json",
        headers={"no-transform": ""},
    )


############################
# RollbackPolicyById (spec FR-4, implemented in C1)
############################


@router.post('/{policy_id}/rollback')
async def rollback_policy_by_id(
    request: Request,
    policy_id: str,
    user=Depends(require_admin),
    db: AsyncSession = Depends(get_async_session),
):
    """Revert an active policy to draft for editing.

    Without this, an active policy is frozen forever (deploy, edit and
    delete all refuse 'active') — the plan's rollback tests and the
    fix-then-redeploy workflow both need this transition.
    """
    policy = await Policies.get_policy_by_id(policy_id, db=db)
    if not policy:
        return policy_error(404, 'Policy not found')
    if not policy.is_active:
        return policy_error(400, 'Policy is not active', 'Only active policies can be rolled back')

    # First deployment: nothing previous to restore. Take the policy offline
    # for editing; MADE keeps running the current Rego.
    # ponytail: spec FR-4's 'previous_rego must exist' precondition is
    # unreachable on first deploys (deploy-on-active returns 400), so relaxed.
    if not policy.previous_rego:
        await Policies.update_deploy_state(policy_id, status='draft', db=db)
        await log_policy_action(
            policy_id, 'rollback', user.id,
            before={'status': 'active'}, after={'status': 'draft'},
            made_response={'outcome': 'ok', 'note': 'no previous version; policy taken offline for editing'}, db=db,
        )
        return {'status': 'draft', 'message': 'Policy reverted to draft. MADE keeps running the current Rego.'}

    outcome, made_error = await made_deploy(policy_id, policy.previous_rego)
    if outcome == 'unreachable':
        await log_policy_action(
            policy_id, 'rollback', user.id,
            before={'status': 'active'}, after={'status': 'active'},
            made_response={'outcome': 'unreachable'}, db=db,
        )
        return policy_error(502, 'MADE unreachable', 'No rollback attempted; policy stays active')
    if outcome == 'error':
        await log_policy_action(
            policy_id, 'rollback', user.id,
            before={'status': 'active'}, after={'status': 'active'},
            made_response={'outcome': 'error', 'error': made_error}, db=db,
        )
        return policy_error(400, f'MADE rejected rollback: {made_error}', 'Policy stays active; fix MADE and retry')

    await Policies.update_deploy_state(
        policy_id,
        status='draft',
        active_rego=policy.previous_rego,
        clear_previous=True,
        db=db,
    )
    # FR-C1: rollback is NOT a deployment — no version row is created.
    await log_policy_action(
        policy_id, 'rollback', user.id,
        before={'status': 'active'}, after={'status': 'draft'},
        made_response={'outcome': 'ok'}, db=db,
    )
    return {'status': 'draft', 'message': 'Rolled back to previous version'}


############################
# AuditLogPolicyById (C3-A reader)
############################


@router.get('/{policy_id}/audit')
async def get_policy_audit_log(
    request: Request,
    policy_id: str,
    action: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
    user=Depends(require_admin),
    db: AsyncSession = Depends(get_async_session),
):
    """Immutable audit trail for a policy, newest first (FR-A3, optional).

    No policy-exists check: the trail must stay readable after the policy is
    deleted (the audit row outlives the policy row).
    """
    if action is not None and action not in AUDIT_ACTIONS:
        return policy_error(400, 'Invalid action filter', f"action must be one of {', '.join(AUDIT_ACTIONS)}")

    entries, total = await PolicyAuditLogs.get_for_policy(
        policy_id, action=action, skip=offset, limit=limit, db=db
    )
    return {'entries': [e.model_dump() for e in entries], 'total': total}


############################
# VersionsPolicyById (C3-B reader)
############################


@router.get('/{policy_id}/versions')
async def get_policy_versions(
    request: Request,
    policy_id: str,
    limit: int = 50,
    offset: int = 0,
    user=Depends(require_admin),
    db: AsyncSession = Depends(get_async_session),
):
    """Immutable changelog of deployed Rego, newest first (FR-B3, optional)."""
    policy = await Policies.get_policy_by_id(policy_id, db=db)
    if not policy:
        return policy_error(404, 'Policy not found')

    versions, total = await PolicyVersions.get_versions(policy_id, skip=offset, limit=limit, db=db)
    return {'versions': [v.model_dump() for v in versions], 'total': total}
