"""Sensoren der Avarma-Wärmepumpe."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import BETRIEB, DOMAIN, MODES_SHORT
from .coordinator import AvarmaCoordinator
from .entity import AvarmaEntity
from .params import P, addr

T, F, V, A, H = (SensorDeviceClass.TEMPERATURE, SensorDeviceClass.FREQUENCY, SensorDeviceClass.VOLTAGE,
                 SensorDeviceClass.CURRENT, SensorDeviceClass.DURATION)
# (Register, Schlüssel, Name, signed, Faktor, Einheit, Nachkommastellen, device_class, diagnostisch)
LIVE = [
    (4360, "aussen", "Außentemperatur", 1, 0.1, "°C", 1, T, 0),
    (4366, "vorlauf", "Vorlauf TOut", 1, 0.1, "°C", 1, T, 0),
    (4365, "ruecklauf", "Rücklauf TIn", 1, 0.1, "°C", 1, T, 0),
    (4358, "lamelle", "Verdampfer Tc", 1, 0.1, "°C", 1, T, 0),
    (4359, "heissgas", "Heißgas Td", 1, 0.1, "°C", 1, T, 0),
    (4361, "sauggas", "Sauggas Ts", 1, 0.1, "°C", 1, T, 0),
    (4362, "evi_ein", "EVI Eintritt", 1, 0.1, "°C", 1, T, 0),
    (4363, "evi_aus", "EVI Austritt", 1, 0.1, "°C", 1, T, 0),
    (4384, "raum_t2", "Raumtemperatur T2", 1, 0.1, "°C", 1, T, 0),
    (4380, "ipm", "IPM Temperatur", 1, 1, "°C", 0, T, 0),
    (4369, "diff_hk", "Temperaturdifferenz Hauptkreis", 1, 0.1, "K", 1, None, 0),
    (4373, "freq_ist", "Kompressor Frequenz", 0, 1, "Hz", 0, F, 0),
    (4378, "freq_soll", "Kompressor Frequenz Soll", 0, 1, "Hz", 0, F, 0),
    (4379, "strom", "Kompressor Strom", 0, 0.1, "A", 1, A, 0),
    (4374, "luefter", "Lüfter Drehzahl", 0, 1, "rpm", 0, None, 0),
    (4376, "eev", "EEV Schritte", 0, 1, "P", 0, None, 0),
    (4368, "durchfluss", "Durchfluss Q", 0, 0.1, "L/min", 1, None, 0),
    (4611, "pumpe", "Pumpe C1 Leistung", 0, 1, "%", 0, None, 0),
    (4371, "hochdruck", "Hochdruck Pd", 0, 0.01, "MPa", 2, None, 0),
    (4372, "niederdruck", "Niederdruck Ps", 0, 0.01, "MPa", 2, None, 0),
    (4381, "netzspannung", "Netzspannung", 0, 1, "V", 0, V, 0),
    (4367, "tdhw", "Warmwasser TDHW", 1, 0.1, "°C", 1, T, 0),
    (4364, "ty", "Ty Kältemittel flüssig", 1, 0.1, "°C", 1, T, 0),
    (4098, "vl_soll", "Vorlauf Soll (P2)", 0, 1, "°C", 0, T, 0),
    (4099, "kuehl_soll", "Kühlen Soll", 0, 1, "°C", 0, T, 0),
    (4100, "ww_soll", "Warmwasser Soll", 0, 1, "°C", 0, T, 0),
    (4101, "raum_soll", "Raum Soll", 0, 1, "°C", 0, T, 0),
    (4354, "status_roh", "Betriebsstatus (roh)", 0, 1, None, 0, None, 1),
    (4390, "fehler0", "Fehlerregister 0", 0, 1, None, 0, None, 1),
    (4391, "fehler1", "Fehlerregister 1", 0, 1, None, 0, None, 1),
    (4387, "freqlimit", "Frequenzbegrenzung (Bits)", 0, 1, None, 0, None, 1),
    (4609, "oelrueck", "Ölrückführung (roh)", 0, 1, None, 0, None, 1),
    (4610, "betriebsstd", "Kompressor Betriebsstunden", 0, 1, "h", 0, H, 0),
    (4612, "modus_roh", "Betriebsmodus (roh)", 0, 1, None, 0, None, 1),
    (4613, "abtau_anz", "Abtauvorgänge", 0, 1, None, 0, None, 0),
    (6666, "abtau_gesperrt", "Abtauung gesperrt (roh)", 0, 1, None, 0, None, 1),
    (4096, "ein_aus", "Ein/Aus (roh)", 0, 1, None, 0, None, 1),
    (4097, "modus_wahl", "Modus Wahl (roh)", 0, 1, None, 0, None, 1),
    (4103, "abtau_erzw", "Abtauung erzwungen (roh)", 0, 1, None, 0, None, 1),
    (4370, "evi_diff", "EVI Temperaturdifferenz", 1, 0.1, "K", 1, None, 0),
    (4375, "luefter2", "Lüfter 2 Drehzahl", 0, 1, "rpm", 0, None, 0),
    (4377, "evi_eev", "EVI-EEV Schritte", 0, 1, "P", 0, None, 0),
    (4382, "dc_spannung", "DC-Zwischenkreis Spannung", 0, 1, "V", 0, V, 0),
    (4383, "t6", "T6 Fühler", 1, 0.1, "°C", 1, T, 0),
    (4385, "verdampfer_temp", "Verdampfungstemperatur", 1, 0.1, "°C", 1, T, 0),
    (4386, "kondensator_temp", "Kondensationstemperatur", 1, 0.1, "°C", 1, T, 0),
    (4388, "soll_ww_calc", "Berechnete Soll-Temp. 1", 1, 0.1, "°C", 1, T, 0),
    (4389, "otc", "Heizkurven-Soll OTC", 1, 0.1, "°C", 1, T, 0),
    (4355, "ausgaenge", "Ausgänge (Bits)", 0, 1, None, 0, None, 1),
    (4356, "eingaenge", "Schalteingänge (Bits)", 0, 1, None, 0, None, 1),
    (4392, "fehler2", "Fehlerregister 2", 0, 1, None, 0, None, 1),
    (4393, "fehler3", "Fehlerregister 3", 0, 1, None, 0, None, 1),
    (4394, "fehler_drv0", "Treiber-Fehler 0", 0, 1, None, 0, None, 1),
    (4395, "fehler_drv1", "Treiber-Fehler 1", 0, 1, None, 0, None, 1),
    (4396, "fehler_drv2", "Treiber-Fehler 2", 0, 1, None, 0, None, 1),
    (4397, "pumpe_pwm", "Pumpe C1 PWM-Ausgang", 0, 1, None, 0, None, 1),
    (4398, "phasenstrom", "Kompressor Phasenstrom", 0, 0.1, "A", 1, A, 0),
    (4608, "starts_wp", "Kompressor-Starts gesamt", 0, 1, "Starts", 0, None, 0),
    (4614, "pumpe_c2", "Pumpe C2 Leistung", 0, 1, "%", 0, None, 0),
    (4615, "sw_pcb", "Software Platine", 0, 1, None, 0, None, 1),
    (4616, "sw_hmi", "Software Display", 0, 1, None, 0, None, 1),
    (4617, "r290_konz", "Kältemittel-Konzentration", 0, 0.1, "%", 1, None, 0),
    (4618, "r290_grenze", "Kältemittel-Alarmgrenze", 0, 0.1, "%", 1, None, 1),
    (4619, "r290_alarm", "Kältemittel-Alarm (roh)", 0, 1, None, 0, None, 1),
    (4106, "uhr_datum", "Uhr Monat/Tag (roh)", 0, 1, None, 0, None, 1),
    (4107, "uhr_zeit", "Uhr Stunde/Minute (roh)", 0, 1, None, 0, None, 1),
    (5251, "e_ren_m", "Energie erneuerbar Monat (roh)", 0, 0.1, "kWh", 1, None, 1),
] + [(4628 + i, f"hist{i}", f"Fehlerspeicher {i + 1}", 0, 1, None, 0, None, 1) for i in range(8)]
NAN_REGS = {4362, 4363, 4364, 4367, 4384}
LIVE_P = {2, 3, 4, 5}
NOT_MEASUREMENT = {"betriebsstd"}


class RegisterSensor(AvarmaEntity, SensorEntity):
    def __init__(self, c, key, name, reg, signed, scale, unit, prec, dclass, diag, state_class=None) -> None:
        super().__init__(c, key, name)
        self.reg, self.signed, self.scale = reg, signed, scale
        self._attr_native_unit_of_measurement = unit
        self._attr_suggested_display_precision = prec
        self._attr_device_class = dclass
        if diag:
            self._attr_entity_category = EntityCategory.DIAGNOSTIC
        self._attr_state_class = state_class

    @property
    def native_value(self):
        raw = self.coordinator.s(self.reg) if self.signed else self.coordinator.u(self.reg)
        if raw is None or (self.reg in NAN_REGS and raw == -32768):
            return None
        v = raw * self.scale
        return round(v, 2) if self.scale != 1 else int(v)


class CalcSensor(AvarmaEntity, SensorEntity):
    def __init__(self, c, key, name, fn: Callable[[AvarmaCoordinator], Any], unit=None, dclass=None,
                 sclass=None, icon=None, attrs: Callable[[AvarmaCoordinator], dict] | None = None, prec=None) -> None:
        super().__init__(c, key, name)
        self.fn, self.attrs_fn = fn, attrs
        self._attr_native_unit_of_measurement = unit
        self._attr_device_class = dclass
        self._attr_state_class = sclass
        self._attr_suggested_display_precision = prec
        if icon:
            self._attr_icon = icon

    @property
    def native_value(self):
        try:
            return self.fn(self.coordinator)
        except (TypeError, ZeroDivisionError, KeyError, IndexError):
            return None

    @property
    def extra_state_attributes(self):
        return self.attrs_fn(self.coordinator) if self.attrs_fn else None


def _t(c, reg):
    v = c.s(reg)
    return None if v is None or v == -32768 else v / 10


def _diff(a, b):
    return None if a is None or b is None else round(a - b, 1)


def _kk(a, b):
    def fn(c):
        return _diff(_t(c, a), _t(c, b)) if c.compressor_running else None
    return fn


def _ratio(w, s):
    return round(w / s, 2) if w is not None and s else 0


def _clock(c):
    d, t = c.u(4106), c.u(4107)
    if d is None or t is None:
        return None
    return f"{d % 256:02d}.{d // 256:02d}. {t // 256:02d}:{t % 256:02d}"


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, add: AddEntitiesCallback) -> None:
    c: AvarmaCoordinator = hass.data[DOMAIN][entry.entry_id]
    ents: list[SensorEntity] = []
    for reg, key, name, signed, sc, unit, prec, dclass, diag in LIVE:
        sclass = None
        if unit and dclass != H and key not in NOT_MEASUREMENT:
            sclass = SensorStateClass.MEASUREMENT
        if key in ("betriebsstd", "starts_wp"):
            sclass = SensorStateClass.TOTAL_INCREASING
        ents.append(RegisterSensor(c, key, name, reg, signed, sc, unit, prec, dclass, diag, sclass))
    for p, sc, unit, mn, mx, lvl, grp, name, desc in P:
        if p in LIVE_P:
            continue
        prec = 2 if sc == 0.01 else (1 if sc == 0.1 else 0)
        ents.append(RegisterSensor(c, f"p{p:03d}", f"P{p:02d} {name}", addr(p), True, sc, unit, prec, None, True))

    E, TI, MS = SensorDeviceClass.ENERGY, SensorStateClass.TOTAL_INCREASING, SensorStateClass.MEASUREMENT
    calc = [
        ("spreizung", "Spreizung VL-RL", lambda c: _diff(_t(c, 4366), _t(c, 4365)), "K", None, MS, None),
        ("waermeleistung", "Thermische Leistung",
         lambda c: max(round((c.u(4368) / 10) * (_t(c, 4366) - _t(c, 4365)) * 0.0698, 2), 0),
         "kW", SensorDeviceClass.POWER, MS, None),
        ("modus_text", "Modus", lambda c: MODES_SHORT.get(c.u(4097), c.u(4097)), None, None, None, None),
        ("avg_laufzeit", "Ø Laufzeit pro Start heute",
         lambda c: round(c.runtime_today_h() * 60 / c.starts("heute")) if c.starts("heute") else 0,
         "min", None, None, "mdi:timer-outline"),
        ("waerme_heute", "Wärme heute", lambda c: c.energy_today("waerme"), "kWh", E, TI, None),
        ("strom_heute", "Strom heute", lambda c: c.energy_today("strom"), "kWh", E, TI, None),
        ("waerme_monat_disp", "Wärme Monat (Display)", lambda c: c.energy_month_display("waerme"), "kWh", E, None, None),
        ("strom_monat_disp", "Strom Monat (Display)", lambda c: c.energy_month_display("strom"), "kWh", E, None, None),
        ("cop_heute", "COP heute", lambda c: _ratio(c.energy_today("waerme"), c.energy_today("strom")),
         None, None, None, "mdi:approximately-equal"),
        ("betrieb_text", "Betrieb aktuell", lambda c: BETRIEB.get(c.u(4612), "unbekannt"), None, None, None, None),
        ("uhr", "Uhr", _clock, None, None, None, "mdi:clock-outline"),
        ("erneuerbar_heute", "Erneuerbar heute", lambda c: c.energy_today("ren"), "kWh", E, None, None),
        ("waerme_jahr_wp", "Wärme Jahr (WP-Zähler)", lambda c: c.energy_year("waerme"), "kWh", E, None, None),
        ("strom_jahr_wp", "Strom Jahr (WP-Zähler)", lambda c: c.energy_year("strom"), "kWh", E, None, None),
        ("ren_monat_disp", "Erneuerbar Monat (Display)", lambda c: c.energy_month_display("ren"), "kWh", E, None, None),
        ("ren_jahr_wp", "Erneuerbar Jahr (WP-Zähler)", lambda c: c.energy_year("ren"), "kWh", E, None, None),
        ("cop_woche", "COP Woche", lambda c: _ratio(c.acc.get("e_waerme_week"), c.acc.get("e_strom_week")),
         None, None, None, "mdi:approximately-equal"),
        ("cop_monat", "COP Monat", lambda c: _ratio(c.energy_month_display("waerme"), c.energy_month_display("strom")),
         None, None, None, "mdi:approximately-equal"),
        ("jaz", "JAZ Jahr", lambda c: _ratio(c.energy_year("waerme"), c.energy_year("strom")),
         None, None, None, "mdi:approximately-equal"),
        ("ueberhitzung", "Überhitzung", _kk(4361, 4385), "K", None, MS, "mdi:thermometer-chevron-up"),
        ("unterkuehlung", "Unterkühlung", _kk(4386, 4364), "K", None, MS, "mdi:thermometer-chevron-down"),
        ("temphub", "Temperaturhub", _kk(4386, 4385), "K", None, MS, "mdi:arrow-expand-vertical"),
        ("laufzeit_heute", "Kompressor Laufzeit heute", lambda c: c.runtime_today_h(), "h", H, MS, "mdi:timer"),
        ("starts_24h", "Kompressor Starts 24 h", lambda c: c.starts_24h(), "Starts", None, MS, "mdi:counter"),
    ]
    for key, name, fn, unit, dclass, sclass, icon in calc:
        ents.append(CalcSensor(c, key, name, fn, unit, dclass, sclass, icon))
    for name, label in (("heute", "heute"), ("woche", "Woche"), ("monat", "Monat"), ("jahr", "Jahr")):
        ents.append(CalcSensor(c, f"um_starts_{name}", f"Kompressor-Starts {label}",
                               (lambda n: lambda c: c.starts(n))(name), "Starts", None, TI, "mdi:counter"))
    for kind, label in (("waerme", "Wärme"), ("strom", "Strom"), ("ren", "Erneuerbar")):
        for p, plabel in (("week", "Woche"), ("month", "Monat"), ("year", "Jahr")):
            if kind == "ren" and p != "week":
                continue  # Monat/Jahr kommen direkt aus den WP-Zählern
            k = f"{kind}_{p}"
            ents.append(CalcSensor(c, f"um_{k}", f"{label} {plabel}",
                                   (lambda k: lambda c: c.acc.get(f"e_{k}"))(k), "kWh", E, TI, None, prec=1))
    for key, name, start in (("e_prod_h", "Energie erzeugt Stunden (roh)", 5120),
                             ("e_verb_h", "Energie verbraucht Stunden (roh)", 5254)):
        s = CalcSensor(c, key, name, (lambda a: lambda c: None if c.u(a) is None
                                      else ",".join(str(c.s(a + i)) for i in range(24)))(start))
        s._attr_entity_category = EntityCategory.DIAGNOSTIC
        ents.append(s)
    ents.append(CalcSensor(
        c, "fehler_text", "Aktive Fehler",
        lambda c: None if c.fault_list() is None else (", ".join(f[:3] for f in c.fault_list()) or "keine"),
        icon="mdi:alert-circle-outline", attrs=lambda c: {"details": c.fault_list() or []}))
    ents.append(CalcSensor(
        c, "fehlerspeicher", "Fehlerspeicher", lambda c: len(c.fault_history()),
        icon="mdi:history", attrs=lambda c: {"liste": c.fault_history()}))
    add(ents)
