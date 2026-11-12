"""Stellt das Dashboard „Wärmepumpe“ bereit (YAML-Dashboard aus der Integration).

Das Dashboard wird mit jeder neuen Version der Integration automatisch aktualisiert.
Wer es selbst anpassen möchte, schaltet die Option aus und legt sich eine eigene Kopie an
(Inhalt: homeassistant/dashboards/waermepumpe.yaml im Repository).
"""

from __future__ import annotations

import inspect
import logging
import os

from homeassistant.components import frontend, persistent_notification
from homeassistant.components.lovelace import dashboard as ll_dashboard
from homeassistant.components.lovelace.const import LOVELACE_DATA
from homeassistant.core import HomeAssistant, callback

_LOGGER = logging.getLogger(__name__)

URL_PATH = "waermepumpe"
TITLE = "Wärmepumpe"
ICON = "mdi:heat-pump"
FILE = os.path.join(os.path.dirname(__file__), "dashboard.yaml")


@callback
def async_register_dashboard(hass: HomeAssistant) -> bool:
    ll = hass.data.get(LOVELACE_DATA)
    if ll is None:
        _LOGGER.warning("Lovelace ist nicht geladen – Dashboard wird nicht angelegt")
        return False
    existing = ll.dashboards.get(URL_PATH)
    panels = hass.data.get(frontend.DATA_PANELS, {})
    ours = isinstance(existing, ll_dashboard.LovelaceYAML) and getattr(existing, "path", None) == FILE
    if (existing is not None or URL_PATH in panels) and not ours:
        persistent_notification.async_create(
            hass,
            f"Es gibt bereits ein Dashboard mit der Adresse /{URL_PATH}. Die Integration legt ihr Dashboard deshalb "
            "nicht an. Lösche das vorhandene Dashboard (Einstellungen → Dashboards) und lade die Integration neu – "
            "oder schalte in den Optionen der Integration „Dashboard bereitstellen“ aus.",
            "Avarma: Dashboard nicht angelegt", "avarma_dashboard")
        return False
    conf = {"mode": "yaml", "filename": FILE, "title": TITLE, "icon": ICON,
            "show_in_sidebar": True, "require_admin": False}
    kwargs = {"frontend_url_path": URL_PATH, "require_admin": False, "show_in_sidebar": True,
              "sidebar_title": TITLE, "sidebar_icon": ICON, "config": {"mode": "yaml"}, "update": URL_PATH in panels}
    params = inspect.signature(frontend.async_register_built_in_panel).parameters
    kwargs = {k: v for k, v in kwargs.items() if k in params}  # ältere HA-Versionen kennen nicht alle Parameter
    ll.dashboards[URL_PATH] = ll_dashboard.LovelaceYAML(hass, URL_PATH, conf)
    try:
        frontend.async_register_built_in_panel(hass, "lovelace", **kwargs)
    except Exception:  # noqa: BLE001
        ll.dashboards.pop(URL_PATH, None)
        _LOGGER.exception("Dashboard konnte nicht registriert werden")
        return False
    persistent_notification.async_dismiss(hass, "avarma_dashboard")
    return True


@callback
def async_remove_dashboard(hass: HomeAssistant) -> None:
    ll = hass.data.get(LOVELACE_DATA)
    if ll is None:
        return
    existing = ll.dashboards.get(URL_PATH)
    if isinstance(existing, ll_dashboard.LovelaceYAML) and getattr(existing, "path", None) == FILE:
        ll.dashboards.pop(URL_PATH, None)
        frontend.async_remove_panel(hass, URL_PATH)


async def async_ensure_resource(hass: HomeAssistant, version: str, static_url: str) -> bool:
    """Display-Karte als Lovelace-Ressource eintragen (lädt in allen Browsern zuverlässig).

    Ein frühes Laden über extra_module_url schlug in Firefox und Safari fehl. Ressourcen werden – wie bei
    HACS-Karten – erst nach dem Frontend geladen.
    """
    ll = hass.data.get(LOVELACE_DATA)
    res = getattr(ll, "resources", None)
    if res is None or not hasattr(res, "async_create_item"):
        return False  # YAML-Ressourcen: kann nicht automatisch eingetragen werden
    base = f"{static_url}/avarma-cards.js"
    url = f"{base}?v={version}"
    try:
        await res.async_get_info()  # stellt sicher, dass die Ressourcen geladen sind
        found = [i for i in res.async_items() if str(i.get("url", "")).split("?")[0] == base]
        for extra in found[1:]:
            await res.async_delete_item(extra["id"])
        if found:
            if found[0].get("url") != url:
                await res.async_update_item(found[0]["id"], {"res_type": "module", "url": url})
        else:
            await res.async_create_item({"res_type": "module", "url": url})
    except Exception:  # noqa: BLE001
        _LOGGER.exception("Lovelace-Ressource für die Display-Karte konnte nicht eingetragen werden")
        return False
    return True
