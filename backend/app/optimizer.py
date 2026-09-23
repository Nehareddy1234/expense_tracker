"""Pure budget-rebalancing optimizer. No DB, no FastAPI — just scipy.

When an expense exceeds its category's envelope balance, we must cover the
deficit by moving money out of other envelopes. Each donor category i can
give at most  balance_i * flexibility_i  and causes  pain_i  per paisa moved
(locked categories can never give). We minimize total pain:

    minimize    sum(x_i * pain_i)
    subject to  sum(x_i) >= deficit
                0 <= x_i <= balance_i * flexibility_i / 100
                x_i = 0 for locked categories
"""

from dataclasses import dataclass

from scipy.optimize import linprog


@dataclass(frozen=True)
class Donor:
    id: int
    balance_paise: int
    flexibility_pct: int
    pain: int
    locked: bool = False

    @property
    def capacity_paise(self) -> int:
        if self.locked or self.balance_paise <= 0:
            return 0
        return self.balance_paise * self.flexibility_pct // 100


@dataclass(frozen=True)
class RebalancePlan:
    moves: tuple[tuple[int, int], ...]  # (donor_id, paise_to_move)
    total_pain: float                   # sum(x_i * pain_i), paise-weighted
    pain_score: float                   # average pain per rupee moved (1..10)
    feasible: bool


def plan_rebalance(deficit_paise: int, donors: list[Donor]) -> RebalancePlan:
    if deficit_paise <= 0:
        return RebalancePlan((), 0.0, 0.0, True)
    caps = [d.capacity_paise for d in donors]
    if sum(caps) < deficit_paise:
        return RebalancePlan((), 0.0, 0.0, False)

    n = len(donors)
    res = linprog(
        c=[float(d.pain) for d in donors],
        A_ub=[[-1.0] * n],
        b_ub=[-float(deficit_paise)],
        bounds=[(0.0, float(c)) for c in caps],
        method="highs",
    )
    if not res.success:
        return RebalancePlan((), 0.0, 0.0, False)

    # Solver output is float; floor to whole paise, then greedily assign the
    # rounding remainder (<= n paise) to the least-painful donors with room.
    x = [max(0, min(int(v), caps[i])) for i, v in enumerate(res.x)]
    remainder = deficit_paise - sum(x)
    for i in sorted(range(n), key=lambda i: (donors[i].pain, -caps[i])):
        if remainder <= 0:
            break
        room = min(caps[i] - x[i], remainder)
        x[i] += room
        remainder -= room

    total = sum(x)
    total_pain = float(sum(amt * d.pain for d, amt in zip(donors, x)))
    moves = tuple((d.id, amt) for d, amt in zip(donors, x) if amt > 0)
    return RebalancePlan(moves, total_pain, round(total_pain / (100 * total), 2), True)
