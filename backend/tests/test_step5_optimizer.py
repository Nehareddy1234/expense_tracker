"""Unit tests for the pure optimizer — no FastAPI, no DB."""

from backend.app.optimizer import Donor, plan_rebalance


def totals(plan):
    return sum(amt for _, amt in plan.moves)


def test_feasible_prefers_low_pain():
    donors = [
        Donor(id=1, balance_paise=40000, flexibility_pct=50, pain=2),   # cap 20000
        Donor(id=2, balance_paise=50000, flexibility_pct=100, pain=5),  # cap 50000
        Donor(id=3, balance_paise=90000, flexibility_pct=100, pain=9),  # cap 90000
    ]
    plan = plan_rebalance(50000, donors)
    assert plan.feasible
    assert totals(plan) == 50000                       # covers deficit exactly
    moves = dict(plan.moves)
    assert moves[1] == 20000                           # cheapest pain drained first
    assert moves.get(2, 0) == 30000
    assert 3 not in moves                              # highest pain untouched
    assert plan.total_pain == 20000 * 2 + 30000 * 5
    assert plan.pain_score == round(plan.total_pain / (100 * 50000), 2)


def test_infeasible_when_capacity_short():
    donors = [
        Donor(id=1, balance_paise=10000, flexibility_pct=50, pain=2),   # cap 5000
        Donor(id=2, balance_paise=20000, flexibility_pct=10, pain=3),   # cap 2000
    ]
    plan = plan_rebalance(50000, donors)               # only 7000 available
    assert plan.feasible is False
    assert plan.moves == ()


def test_locked_only_is_infeasible():
    donors = [Donor(id=1, balance_paise=999999, flexibility_pct=100, pain=1, locked=True)]
    plan = plan_rebalance(1, donors)
    assert plan.feasible is False and plan.moves == ()


def test_exact_fit_uses_all_capacity():
    donors = [
        Donor(id=1, balance_paise=10000, flexibility_pct=50, pain=2),   # cap 5000
        Donor(id=2, balance_paise=4000, flexibility_pct=50, pain=8),    # cap 2000
    ]
    plan = plan_rebalance(7000, donors)
    assert plan.feasible and dict(plan.moves) == {1: 5000, 2: 2000}


def test_zero_flexibility_cannot_give():
    donors = [
        Donor(id=1, balance_paise=500000, flexibility_pct=0, pain=1),
        Donor(id=2, balance_paise=30000, flexibility_pct=50, pain=7),   # cap 15000
    ]
    plan = plan_rebalance(15000, donors)
    assert plan.feasible and dict(plan.moves) == {2: 15000}
    assert plan_rebalance(15001, donors).feasible is False


def test_no_deficit_is_trivially_feasible():
    plan = plan_rebalance(0, [Donor(id=1, balance_paise=10, flexibility_pct=50, pain=1)])
    assert plan.feasible and plan.moves == ()
    assert Donor(id=1, balance_paise=-500, flexibility_pct=50, pain=1).capacity_paise == 0


def test_awkward_paise_values_stay_integral_and_cover():
    donors = [Donor(id=1, balance_paise=1001, flexibility_pct=100, pain=3),
              Donor(id=2, balance_paise=997, flexibility_pct=33, pain=4)]  # cap 329
    plan = plan_rebalance(1000, donors)
    assert plan.feasible
    assert totals(plan) >= 1000
    assert all(isinstance(amt, int) for _, amt in plan.moves)
    caps = {d.id: d.capacity_paise for d in donors}
    assert all(amt <= caps[cid] for cid, amt in plan.moves)
