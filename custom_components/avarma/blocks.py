"""Abfrage eines Registerblocks, der nur selten gelesen wird.

Der Zustand wird nicht beim Lesen eingefroren, sondern aus ``last_success`` und
der aktuellen Zeit abgeleitet. Dadurch fällt ein Block auch dann als „veraltet“
auf, wenn der Koordinator wegen Fehlern im schnellen Block gar nicht mehr zum
Lesen kommt – und ein Fehlschlag im schnellen Block löscht den letzten Erfolg
nicht.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

BLOCK_OK = "normal"
BLOCK_FAILED = "fehler"
BLOCK_STALE = "veraltet"
BLOCK_NOT_READY = "nicht bereit"

STALE_PERIODS = 2  # nach mehr als so vielen Abfrageperioden ohne Erfolg gilt ein Block als veraltet


@dataclass
class SlowBlock:
    """Zustand eines langsam abgefragten Registerblocks."""

    key: str
    name: str
    interval: int
    blocks: list[tuple[int, int]]
    last_success: datetime | None = None
    last_failure: datetime | None = None
    last_failure_reason: str | None = None
    last_attempt: datetime | None = None
    consecutive_failures: int = 0
    due: float = 0.0

    @property
    def start(self) -> int:
        return self.blocks[0][0]

    @property
    def ranges(self) -> list[str]:
        return [f"{start}+{count}" for start, count in self.blocks]

    def status(self, now: datetime) -> str:
        """normal / fehler / veraltet / nicht bereit."""
        if self.last_success is None:
            return BLOCK_NOT_READY
        if now - self.last_success > timedelta(seconds=STALE_PERIODS * self.interval):
            return BLOCK_STALE
        if self.consecutive_failures:
            return BLOCK_FAILED
        return BLOCK_OK

    def mark_success(self, now: datetime) -> None:
        self.last_success = now
        self.last_attempt = now
        self.consecutive_failures = 0

    def mark_failure(self, now: datetime, reason: str) -> None:
        self.last_attempt = now
        self.last_failure = now
        self.last_failure_reason = reason
        self.consecutive_failures += 1

    def attributes(self, now: datetime) -> dict[str, Any]:
        return {
            "block": self.name,
            "start_adresse": self.start,
            "registerbloecke": self.ranges,
            "intervall_s": self.interval,
            "letzter_erfolg": self.last_success.isoformat() if self.last_success else None,
            "letzter_versuch": self.last_attempt.isoformat() if self.last_attempt else None,
            "letzter_fehler": self.last_failure_reason,
            "letzter_fehler_zeit": self.last_failure.isoformat() if self.last_failure else None,
            "fehlversuche": self.consecutive_failures,
            "status": self.status(now),
        }
