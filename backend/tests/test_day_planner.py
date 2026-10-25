import pytest

from app.optimiser.day_planner import InfeasibleDay, Stop, plan_day

H = 3600


def line_matrix(positions: list[float], speed: float = 1.0) -> list[list[float]]:
    """Travel times between points on a line (seconds = distance / speed)."""
    return [[abs(a - b) / speed for b in positions] for a in positions]


def test_orders_stops_to_minimise_travel():
    # Hotel at 0; stops listed out of order along a street.
    stops = [Stop("c", visit_s=600), Stop("a", visit_s=600), Stop("b", visit_s=600)]
    matrix = line_matrix([0, 3000, 1000, 2000])
    plan = plan_day(stops, matrix, time_limit_s=0.5)
    assert [s.id for s in plan.stops] in (["a", "b", "c"], ["c", "b", "a"])
    assert plan.total_travel_s == 6000
    assert plan.dropped == []


def test_respects_opening_hours():
    # "late" is closest but only opens at 14:00, so it must come after "early".
    stops = [
        Stop("late", visit_s=H, open_s=14 * H, mandatory=True),
        Stop("early", visit_s=H, close_s=12 * H, mandatory=True),
    ]
    matrix = line_matrix([0, 100, 5000])
    plan = plan_day(stops, matrix, time_limit_s=0.5)
    assert [s.id for s in plan.stops] == ["early", "late"]
    late = plan.stops[1]
    assert late.arrive_s >= 14 * H
    assert plan.stops[0].depart_s <= 12 * H


def test_drops_optional_stop_that_does_not_fit():
    stops = [
        Stop("must", visit_s=6 * H, mandatory=True),
        Stop("nice", visit_s=6 * H),
    ]
    matrix = line_matrix([0, 100, 200])
    plan = plan_day(stops, matrix, day_start_s=9 * H, day_end_s=17 * H, time_limit_s=0.5)
    assert [s.id for s in plan.stops] == ["must"]
    assert plan.dropped == ["nice"]


def test_infeasible_mandatory_stops_raise():
    stops = [Stop("a", visit_s=5 * H, mandatory=True), Stop("b", visit_s=5 * H, mandatory=True)]
    with pytest.raises(InfeasibleDay):
        plan_day(stops, line_matrix([0, 1, 2]), day_end_s=17 * H, time_limit_s=0.5)


def test_visit_longer_than_opening_hours_is_rejected():
    with pytest.raises(InfeasibleDay):
        plan_day([Stop("x", visit_s=3 * H, open_s=10 * H, close_s=12 * H)], line_matrix([0, 1]))


def test_matrix_shape_is_checked():
    with pytest.raises(ValueError):
        plan_day([Stop("x", visit_s=60)], [[0.0]])
