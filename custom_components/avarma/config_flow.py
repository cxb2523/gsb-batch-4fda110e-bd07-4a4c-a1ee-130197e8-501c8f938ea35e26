"""Einrichtung über die Oberfläche."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.core import callback
from homeassistant.helpers import selector

from .const import (
    CONF_CLOCK_SYNC, CONF_DASHBOARD, CONF_NOTIFY, CONF_PROTOCOL, CONF_SCAN_INTERVAL, CONF_SLAVE, CONF_TECH_CODE, CONF_TECH_SWITCH,
    DEFAULT_PORT, DEFAULT_SCAN, DEFAULT_SLAVE, DOMAIN,
)
from .modbus import PROTO_RTU_OVER_TCP, PROTO_TCP, AvarmaModbus, ModbusError

PROTO_SEL = selector.SelectSelector(selector.SelectSelectorConfig(
    options=[PROTO_RTU_OVER_TCP, PROTO_TCP], translation_key="protocol", mode=selector.SelectSelectorMode.LIST))


async def _test(host: str, port: int, slave: int, proto: str) -> str | None:
    client = AvarmaModbus(host, port, slave, proto)
    try:
        vals = await client.read_holding(4354, 1)
        return None if vals else "cannot_connect"
    except ModbusError:
        return "cannot_connect"
    finally:
        await client.close()


class AvarmaConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            await self.async_set_unique_id(f"{user_input[CONF_HOST]}:{user_input[CONF_PORT]}:{user_input[CONF_SLAVE]}")
            self._abort_if_unique_id_configured()
            err = await _test(user_input[CONF_HOST], user_input[CONF_PORT], user_input[CONF_SLAVE], user_input[CONF_PROTOCOL])
            if err:
                errors["base"] = err
            else:
                return self.async_create_entry(title=f"Avarma Wärmepumpe ({user_input[CONF_HOST]})", data=user_input)
        schema = vol.Schema({
            vol.Required(CONF_HOST): str,
            vol.Required(CONF_PORT, default=DEFAULT_PORT): vol.All(vol.Coerce(int), vol.Range(1, 65535)),
            vol.Required(CONF_SLAVE, default=DEFAULT_SLAVE): vol.All(vol.Coerce(int), vol.Range(1, 247)),
            vol.Required(CONF_PROTOCOL, default=PROTO_RTU_OVER_TCP): PROTO_SEL,
        })
        return self.async_show_form(step_id="user", data_schema=self.add_suggested_values_to_schema(schema, user_input or {}),
                                    errors=errors)

    async def async_step_reconfigure(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """IP, Port, Slave-ID und Protokoll nachträglich ändern – Optionen und Zähler bleiben erhalten."""
        entry = self._get_reconfigure_entry()
        errors: dict[str, str] = {}
        if user_input is not None:
            uid = f"{user_input[CONF_HOST]}:{user_input[CONF_PORT]}:{user_input[CONF_SLAVE]}"
            if uid != entry.unique_id:
                await self.async_set_unique_id(uid)
                self._abort_if_unique_id_configured()
            err = await _test(user_input[CONF_HOST], user_input[CONF_PORT], user_input[CONF_SLAVE], user_input[CONF_PROTOCOL])
            if err:
                errors["base"] = err
            else:
                return self.async_update_reload_and_abort(
                    entry, unique_id=uid, title=f"Avarma Wärmepumpe ({user_input[CONF_HOST]})",
                    data={**entry.data, **user_input})
        d = {**entry.data, **(user_input or {})}
        schema = vol.Schema({
            vol.Required(CONF_HOST, default=d.get(CONF_HOST, "")): str,
            vol.Required(CONF_PORT, default=d.get(CONF_PORT, DEFAULT_PORT)): vol.All(vol.Coerce(int), vol.Range(1, 65535)),
            vol.Required(CONF_SLAVE, default=d.get(CONF_SLAVE, DEFAULT_SLAVE)): vol.All(vol.Coerce(int), vol.Range(1, 247)),
            vol.Required(CONF_PROTOCOL, default=d.get(CONF_PROTOCOL, PROTO_RTU_OVER_TCP)): PROTO_SEL,
        })
        return self.async_show_form(step_id="reconfigure", data_schema=schema, errors=errors)

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return AvarmaOptionsFlow()


class AvarmaOptionsFlow(OptionsFlow):
    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(data=user_input)
        o = self.config_entry.options
        schema = vol.Schema({
            vol.Optional(CONF_TECH_CODE, description={"suggested_value": o.get(CONF_TECH_CODE, "")}):
                selector.TextSelector(selector.TextSelectorConfig(type=selector.TextSelectorType.PASSWORD)),
            vol.Required(CONF_TECH_SWITCH, default=o.get(CONF_TECH_SWITCH, False)): bool,
            vol.Optional(CONF_NOTIFY, description={"suggested_value": o.get(CONF_NOTIFY, "")}): str,
            vol.Required(CONF_CLOCK_SYNC, default=o.get(CONF_CLOCK_SYNC, True)): bool,
            vol.Required(CONF_DASHBOARD, default=o.get(CONF_DASHBOARD, True)): bool,
            vol.Required(CONF_SCAN_INTERVAL, default=o.get(CONF_SCAN_INTERVAL, DEFAULT_SCAN)):
                vol.All(vol.Coerce(int), vol.Range(5, 120)),
        })
        return self.async_show_form(step_id="init", data_schema=schema)
