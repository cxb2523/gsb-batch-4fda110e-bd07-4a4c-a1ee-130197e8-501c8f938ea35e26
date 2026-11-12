"""Konstanten der Avarma-Integration."""

DOMAIN = "avarma"
MANUFACTURER = "Hofman Energy / Avarma"

CONF_SLAVE = "slave"
CONF_PROTOCOL = "protocol"
CONF_SCAN_INTERVAL = "scan_interval"
CONF_TECH_CODE = "tech_code"
CONF_NOTIFY = "notify_service"
CONF_CLOCK_SYNC = "clock_sync"
CONF_TECH_SWITCH = "tech_switch"
CONF_DASHBOARD = "dashboard"

DEFAULT_PORT = 502
DEFAULT_SLAVE = 1
DEFAULT_SCAN = 10
USER_CODE = "99"          # Benutzer-Code wie am Display (steht auch in der Anleitung)
UNLOCK_MINUTES = 15

STATIC_URL = "/avarma_static"

PLATFORMS = ["sensor", "binary_sensor", "number", "select", "switch", "button", "text"]

# Register (Spalte "Decimal" der Hofman-Liste)
REG_ON = 4096
REG_MODE = 4097
REG_FORCE_DEFROST = 4103
REG_FAULT_RESET = 4104
REG_CLOCK_DATE = 4106
REG_CLOCK_TIME = 4107
REG_STATUS = 4354
REG_OUTPUTS = 4355
REG_INPUTS = 4356
REG_FREQ = 4373
REG_FREQLIMIT = 4387
REG_FAULTS = (4390, 4391, 4392, 4393)
REG_DRV = (4394, 4395, 4396)
REG_STARTS = 4608
REG_OIL = 4609
REG_R290_KONZ = 4617
REG_R290_ALARM = 4619
REG_HIST = 4628

MODES = {1: "Warmwasser", 2: "Heizen", 3: "Heizen + Warmwasser", 4: "Kühlen", 5: "Kühlen + Warmwasser"}
MODES_SHORT = {1: "Warmwasser", 2: "Heizen", 3: "Heizen+WW", 4: "Kühlen", 5: "Kühlen+WW"}
BETRIEB = {0: "Aus", 1: "Warmwasser", 2: "Heizen", 4: "Kühlen"}

ERR = {1: "Außenfühler defekt", 2: "Lamellenfühler defekt", 3: "Sauggasfühler defekt", 4: "EVI-Eintrittsfühler defekt",
       5: "EVI-Austrittsfühler defekt", 6: "Heißgasfühler defekt", 7: "Warmwasserfühler defekt", 8: "Vorlauffühler defekt",
       9: "Rücklauffühler defekt", 10: "Kältemittel-Flüssigkeitsfühler defekt", 11: "Hochdrucksensor defekt",
       12: "Niederdrucksensor defekt", 13: "Hochdruck-Schutz", 14: "Niederdruck-Schutz", 15: "Wasserdurchfluss zu gering",
       16: "Kommunikationsfehler", 17: "Heißgastemperatur zu hoch", 18: "EEPROM-Parameterfehler",
       99: "Kommunikation Treiberplatine", 20: "IPM-Schutz", 21: "Spannungsfehler", 22: "Spreizung VL/RL zu groß",
       23: "Warmwasser-Frostschutz 2×", 24: "Heizkreis-Frostschutz 2×", 56: "Primärstrom-Schutz", 26: "T6-Fühler defekt",
       27: "Außentemperatur über Grenze", 28: "Rücklauf zu hoch (Kühlen)", 29: "Raumfühler defekt",
       58: "Außentemperatur zu niedrig (T4)", 32: "Vorlauf zu hoch (Heizen)", 36: "Lüftertreiber Kommunikation",
       59: "VL/RL vertauscht oder 4-Wege-Ventil", 40: "Vorlauf zu niedrig (Kühlen)", 44: "DC-Lüftermotor 1",
       45: "DC-Lüftermotor 2", 50: "Kondensator Überhitzung", 51: "Kältemittel-Konzentration hoch (Leck!)"}
# Bit -> Fehlercode je Fehlerregister 4390..4393
FAULT_BITS = (
    {b: b + 1 for b in range(16)},
    dict(enumerate([17, 18, 99, 20, 21, 22, 23, 24, 56, 26, 27, 28, 29, 58, None, 32])),
    {3: 36, 6: 59, 7: 40, 11: 44, 12: 45},
    {1: 50, 2: 51},
)
DRV = {0: "IPM-Fehler", 1: "Kompressor-Treiberfehler", 2: "Kompressor-Überstrom", 5: "IPM-Übertemperatur", 6: "PFC-Fehler",
       7: "DC-Überspannung", 8: "DC-Unterspannung", 9: "AC-Spannung außerhalb", 10: "AC-Überstrom",
       15: "Kommunikation Hauptplatine"}
