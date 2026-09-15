"""Budget and cost-alert-policy routes.

Split into its own router rather than growing cost.py, which is already the
read surface for six analytic endpoints. These are the write surface, and they
carry different permissions: reading a budget is `cost:view`, changing one is
`cost:manage_budgets`, and changing what pages people is `cost:manage_alerts`.

Every mutation records who did it. A budget threshold quietly lowered is
indistinguishable from a budget that was never breached, so `created_by` and
`updated_by` are populated from the authenticated principal rather than left
to the caller to supply.
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api import rbac
from app.api.deps import get_db
from app.models.cost_budget import (
    BUDGET_PERIODS,
    DEFAULT_COOLDOWN_HOURS,
    DEFAULT_THRESHOLDS,
    POLICY_KINDS,
    CloudCostAlertPolicy,
    CloudCostBudget,
)

router = APIRouter(prefix="/cloud/cost", tags=["Cost Budgets"])


class BudgetIn(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    amount: float = Field(gt=0)
    # Required, not defaulted. A budget without a currency cannot be compared
    # to anything, and guessing one would decide which spend it governs.
    currency: str = Field(min_length=1, max_length=8)
    period: str = "MONTHLY"
    account_id: Optional[uuid.UUID] = None
    provider: Optional[str] = None
    service: Optional[str] = None
    region: Optional[str] = None
    cost_component: Optional[str] = None
    thresholds: List[int] = Field(default_factory=lambda: list(DEFAULT_THRESHOLDS))
    cooldown_hours: int = Field(default=DEFAULT_COOLDOWN_HOURS, ge=0, le=720)
    alert_on_forecast: bool = False
    enabled: bool = True


class PolicyIn(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    kind: str
    account_id: Optional[uuid.UUID] = None
    provider: Optional[str] = None
    service: Optional[str] = None
    threshold_amount: Optional[float] = Field(default=None, gt=0)
    threshold_currency: Optional[str] = None
    threshold_percent: Optional[float] = Field(default=None, gt=0)
    min_absolute: Optional[float] = Field(default=None, ge=0)
    severity: str = "MEDIUM"
    cooldown_hours: int = Field(default=DEFAULT_COOLDOWN_HOURS, ge=0, le=720)
    enabled: bool = True


def _validate_budget(payload: BudgetIn) -> None:
    if payload.period not in BUDGET_PERIODS:
        raise HTTPException(
            status_code=400,
            detail=f"period must be one of {', '.join(BUDGET_PERIODS)}",
        )
    if not payload.thresholds:
        raise HTTPException(
            status_code=400,
            detail="At least one threshold is required, or the budget can never alert.",
        )
    if any(t <= 0 or t > 1000 for t in payload.thresholds):
        raise HTTPException(
            status_code=400, detail="Thresholds are percentages between 1 and 1000.",
        )


@router.get("/budgets")
async def list_budgets(
    account_id: Optional[uuid.UUID] = None,
    db: AsyncSession = Depends(get_db),
    _: rbac.Principal = Depends(rbac.require(rbac.COST_VIEW)),
):
    """Budgets, optionally narrowed to one account.

    Organisation-wide budgets (account_id NULL) are always included: they
    govern the account being viewed too, and hiding them would make a breach
    look like it came from nowhere.
    """
    stmt = select(CloudCostBudget)
    if account_id is not None:
        stmt = stmt.where(
            (CloudCostBudget.account_id == account_id)
            | (CloudCostBudget.account_id.is_(None))
        )
    rows = (await db.execute(stmt.order_by(CloudCostBudget.created_at.desc()))).scalars().all()
    return {"budgets": [b.to_dict() for b in rows], "count": len(rows)}


@router.post("/budgets", status_code=201)
async def create_budget(
    payload: BudgetIn,
    db: AsyncSession = Depends(get_db),
    principal: rbac.Principal = Depends(rbac.require(rbac.COST_MANAGE_BUDGETS)),
):
    _validate_budget(payload)
    budget = CloudCostBudget(
        **payload.model_dump(),
        created_by=principal.name or principal.role,
        updated_by=principal.name or principal.role,
    )
    budget.currency = budget.currency.upper()
    db.add(budget)
    await db.commit()
    await db.refresh(budget)
    return budget.to_dict()


@router.put("/budgets/{budget_id}")
async def update_budget(
    budget_id: uuid.UUID,
    payload: BudgetIn,
    db: AsyncSession = Depends(get_db),
    principal: rbac.Principal = Depends(rbac.require(rbac.COST_MANAGE_BUDGETS)),
):
    _validate_budget(payload)
    budget = await db.get(CloudCostBudget, budget_id)
    if budget is None:
        raise HTTPException(status_code=404, detail="Budget not found")

    before = budget.to_dict()
    for key, value in payload.model_dump().items():
        setattr(budget, key, value)
    budget.currency = budget.currency.upper()
    budget.updated_by = principal.name or principal.role
    await db.commit()
    await db.refresh(budget)
    # The previous values travel with the response so the caller can show what
    # changed; an audit that records only the new state answers half the question.
    return {"budget": budget.to_dict(), "previous": before}


@router.delete("/budgets/{budget_id}", status_code=204)
async def delete_budget(
    budget_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: rbac.Principal = Depends(rbac.require(rbac.COST_MANAGE_BUDGETS)),
):
    budget = await db.get(CloudCostBudget, budget_id)
    if budget is None:
        raise HTTPException(status_code=404, detail="Budget not found")
    await db.delete(budget)
    await db.commit()


@router.get("/budgets/status")
async def budget_status(
    account_id: Optional[uuid.UUID] = None,
    db: AsyncSession = Depends(get_db),
    _: rbac.Principal = Depends(rbac.require(rbac.COST_VIEW)),
):
    """Current utilisation of every budget in scope, evaluated from stored facts.

    Read-only: evaluating for display must never raise an alert, or opening the
    budgets page would page whoever is on call.
    """
    from app.services import cost_budget_service

    stmt = select(CloudCostBudget).where(CloudCostBudget.enabled.is_(True))
    if account_id is not None:
        stmt = stmt.where(
            (CloudCostBudget.account_id == account_id)
            | (CloudCostBudget.account_id.is_(None))
        )
    budgets = (await db.execute(stmt)).scalars().all()
    return {
        "budgets": [
            await cost_budget_service.evaluate_budget(db, b) for b in budgets
        ],
        "count": len(budgets),
    }


@router.post("/budgets/evaluate")
async def evaluate_budgets(
    account_id: Optional[uuid.UUID] = None,
    dry_run: bool = Query(
        default=False,
        description="Report what WOULD alert without recording anything.",
    ),
    db: AsyncSession = Depends(get_db),
    _: rbac.Principal = Depends(rbac.require(rbac.COST_MANAGE_ALERTS)),
):
    """Evaluate budgets and raise alerts for newly-crossed thresholds.

    Requires `cost:manage_alerts` because it can page people. `dry_run` reports
    exactly what would be announced, and why anything was suppressed, without
    writing an alert — use it to preview a new budget before arming it.
    """
    from app.services import cost_budget_service

    stmt = select(CloudCostBudget).where(CloudCostBudget.enabled.is_(True))
    if account_id is not None:
        stmt = stmt.where(
            (CloudCostBudget.account_id == account_id)
            | (CloudCostBudget.account_id.is_(None))
        )
    budgets = (await db.execute(stmt)).scalars().all()
    return await cost_budget_service.evaluate_and_alert(db, budgets, dry_run=dry_run)


# ── Alert policies ────────────────────────────────────────────────────────────

@router.get("/alert-policies")
async def list_policies(
    db: AsyncSession = Depends(get_db),
    _: rbac.Principal = Depends(rbac.require(rbac.COST_VIEW)),
):
    """Cost alert policies, each labelled with whether it can actually be
    evaluated from the data this product stores today."""
    from app.services.cost_budget_service import (
        SUPPORTED_POLICY_KINDS, UNSUPPORTED_REASONS,
    )

    rows = (await db.execute(
        select(CloudCostAlertPolicy).order_by(CloudCostAlertPolicy.created_at.desc())
    )).scalars().all()
    return {
        "policies": [
            {
                **p.to_dict(),
                "evaluable": p.kind in SUPPORTED_POLICY_KINDS,
                "not_evaluable_reason": (
                    None if p.kind in SUPPORTED_POLICY_KINDS
                    else UNSUPPORTED_REASONS.get(p.kind)
                ),
            }
            for p in rows
        ],
        "count": len(rows),
        "supported_kinds": sorted(SUPPORTED_POLICY_KINDS),
        "unsupported_kinds": UNSUPPORTED_REASONS,
    }


@router.post("/alert-policies", status_code=201)
async def create_policy(
    payload: PolicyIn,
    db: AsyncSession = Depends(get_db),
    principal: rbac.Principal = Depends(rbac.require(rbac.COST_MANAGE_ALERTS)),
):
    if payload.kind not in POLICY_KINDS:
        raise HTTPException(
            status_code=400, detail=f"kind must be one of {', '.join(POLICY_KINDS)}",
        )
    if payload.threshold_amount is not None and not payload.threshold_currency:
        raise HTTPException(
            status_code=400,
            detail=(
                "threshold_currency is required alongside threshold_amount — an "
                "amount without a currency cannot be compared to spend."
            ),
        )
    policy = CloudCostAlertPolicy(
        **payload.model_dump(),
        created_by=principal.name or principal.role,
        updated_by=principal.name or principal.role,
    )
    if policy.threshold_currency:
        policy.threshold_currency = policy.threshold_currency.upper()
    db.add(policy)
    await db.commit()
    await db.refresh(policy)
    return policy.to_dict()


@router.delete("/alert-policies/{policy_id}", status_code=204)
async def delete_policy(
    policy_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: rbac.Principal = Depends(rbac.require(rbac.COST_MANAGE_ALERTS)),
):
    policy = await db.get(CloudCostAlertPolicy, policy_id)
    if policy is None:
        raise HTTPException(status_code=404, detail="Policy not found")
    await db.delete(policy)
    await db.commit()


@router.post("/alert-policies/evaluate")
async def evaluate_policies(
    dry_run: bool = Query(default=False),
    db: AsyncSession = Depends(get_db),
    _: rbac.Principal = Depends(rbac.require(rbac.COST_MANAGE_ALERTS)),
):
    from app.services import cost_budget_service

    policies = (await db.execute(
        select(CloudCostAlertPolicy).where(CloudCostAlertPolicy.enabled.is_(True))
    )).scalars().all()
    return await cost_budget_service.evaluate_policies(db, policies, dry_run=dry_run)
