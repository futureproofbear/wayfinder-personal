"""Destination recommendation score.

    S = w_i*I + w_r*R + w_p*P + w_g*G + w_b*B + w_c*C

I interest match, R review quality, P popularity, G geographical convenience,
B budget fit, C data confidence/freshness. Each signal is in [0, 1]. The
weights are starting hypotheses to be calibrated from saved/removed/rated
feedback, not tuned values.
"""

from __future__ import annotations

from typing import Annotated

from pydantic import BaseModel, Field

Unit = Annotated[float, Field(ge=0.0, le=1.0)]


class Signals(BaseModel):
    interest: Unit
    reviews: Unit
    popularity: Unit
    geography: Unit
    budget: Unit
    confidence: Unit


class Weights(BaseModel):
    interest: float = 0.35
    reviews: float = 0.15
    popularity: float = 0.10
    geography: float = 0.20
    budget: float = 0.10
    confidence: float = 0.10


DEFAULT_WEIGHTS = Weights()


def score(signals: Signals, weights: Weights = DEFAULT_WEIGHTS) -> float:
    w = weights.model_dump()
    total = sum(w.values())
    if total <= 0:
        raise ValueError("weights must sum to a positive number")
    s = signals.model_dump()
    return sum(w[k] * s[k] for k in w) / total
