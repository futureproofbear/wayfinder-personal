"""Single-day itinerary optimisation with OR-Tools.

This is a travelling-salesman variant with time windows (one vehicle = one
traveller group, one day). The AI layer picks *which* places are worth
visiting; this module decides the order and timing so that everything fits
opening hours and the day's limits while minimising travel.

Times are seconds since local midnight on the day being planned.
"""

from __future__ import annotations

from dataclasses import dataclass

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

DAY = 24 * 3600


@dataclass
class Stop:
    id: str
    visit_s: int
    open_s: int = 0
    close_s: int = DAY
    # Mandatory stops must be scheduled or the plan is infeasible. Optional stops
    # may be dropped, and higher-priority ones cost more to drop.
    mandatory: bool = False
    priority: float = 1.0


@dataclass
class ScheduledStop:
    id: str
    arrive_s: int
    depart_s: int
    travel_from_prev_s: int


@dataclass
class DayPlan:
    stops: list[ScheduledStop]
    dropped: list[str]
    return_s: int
    total_travel_s: int


class InfeasibleDay(ValueError):
    pass


def plan_day(
    stops: list[Stop],
    durations_s: list[list[float]],
    day_start_s: int = 9 * 3600,
    day_end_s: int = 21 * 3600,
    return_to_start: bool = True,
    max_travel_s: int | None = None,
    time_limit_s: float = 1.0,
) -> DayPlan:
    """Order and time the stops for one day.

    ``durations_s`` is an (n+1) x (n+1) travel-time matrix where index 0 is the
    start point (usually the hotel) and index k is ``stops[k-1]``.
    """
    n = len(stops) + 1
    if len(durations_s) != n or any(len(row) != n for row in durations_s):
        raise ValueError(f"durations_s must be {n}x{n}")

    travel = [[int(round(v)) for v in row] for row in durations_s]
    service = [0] + [s.visit_s for s in stops]

    manager = pywrapcp.RoutingIndexManager(n, 1, 0)
    routing = pywrapcp.RoutingModel(manager)

    def travel_cb(from_index: int, to_index: int) -> int:
        i, j = manager.IndexToNode(from_index), manager.IndexToNode(to_index)
        if j == 0 and not return_to_start:
            return 0
        return travel[i][j]

    def time_cb(from_index: int, to_index: int) -> int:
        return travel_cb(from_index, to_index) + service[manager.IndexToNode(from_index)]

    travel_idx = routing.RegisterTransitCallback(travel_cb)
    time_idx = routing.RegisterTransitCallback(time_cb)
    routing.SetArcCostEvaluatorOfAllVehicles(travel_idx)

    # Waiting (slack) is allowed, e.g. arriving before a museum opens.
    routing.AddDimension(time_idx, DAY, DAY, False, "Time")
    time_dim = routing.GetDimensionOrDie("Time")
    time_dim.CumulVar(routing.Start(0)).SetRange(day_start_s, day_start_s)
    time_dim.CumulVar(routing.End(0)).SetRange(day_start_s, day_end_s)

    if max_travel_s is not None:
        routing.AddDimension(travel_idx, 0, max_travel_s, True, "Travel")

    # Penalties are in the same unit as the objective (seconds of travel), so an
    # optional stop is kept unless reaching it costs more than it is worth.
    base_penalty = 2 * 3600
    for k, stop in enumerate(stops, start=1):
        index = manager.NodeToIndex(k)
        latest_arrival = stop.close_s - stop.visit_s
        if latest_arrival < stop.open_s:
            raise InfeasibleDay(f"{stop.id}: visit is longer than its opening hours")
        time_dim.CumulVar(index).SetRange(stop.open_s, latest_arrival)
        if not stop.mandatory:
            routing.AddDisjunction([index], int(base_penalty * stop.priority))

    params = pywrapcp.DefaultRoutingSearchParameters()
    params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    params.local_search_metaheuristic = (
        routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    )
    params.time_limit.FromMilliseconds(int(time_limit_s * 1000))

    solution = routing.SolveWithParameters(params)
    if solution is None:
        raise InfeasibleDay("no schedule satisfies the mandatory stops and time windows")

    scheduled: list[ScheduledStop] = []
    visited: set[int] = set()
    total_travel = 0
    index = routing.Start(0)
    while not routing.IsEnd(index):
        prev_index, index = index, solution.Value(routing.NextVar(index))
        leg = travel_cb(prev_index, index)
        total_travel += leg
        if routing.IsEnd(index):
            break
        node = manager.IndexToNode(index)
        arrive = solution.Min(time_dim.CumulVar(index))
        scheduled.append(
            ScheduledStop(
                id=stops[node - 1].id,
                arrive_s=arrive,
                depart_s=arrive + service[node],
                travel_from_prev_s=leg,
            )
        )
        visited.add(node)

    return DayPlan(
        stops=scheduled,
        dropped=[s.id for k, s in enumerate(stops, start=1) if k not in visited],
        return_s=solution.Min(time_dim.CumulVar(routing.End(0))),
        total_travel_s=total_travel,
    )
