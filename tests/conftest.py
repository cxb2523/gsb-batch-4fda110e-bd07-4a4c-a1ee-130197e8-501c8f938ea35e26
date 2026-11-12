"""Gemeinsame Vorbereitung der Tests (pytest-homeassistant-custom-component)."""

from __future__ import annotations

import asyncio
from pathlib import Path
import sys

import pytest
import pytest_socket

# Integration als importierbares Paket bereitstellen (custom_components.avarma)
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

pytest_plugins = "pytest_homeassistant_custom_component"


@pytest.fixture
def event_loop():
    """Eigene Loop-Fixture: Auf Windows legt der Proactor-Loop einen socketpair an,
    den das HA-Testplugin sonst blockiert. Die Tests selbst brauchen keinen Netzwerkzugriff."""
    pytest_socket.enable_socket()
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations) -> None:
    """Erlaubt das Laden von custom_components während der Tests."""
    return None
