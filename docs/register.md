# Modbus-Registerübersicht (Avarma / Hofman R290 Monoblock)

Quelle: Hofman-Datenblatt *HE-AI-290-00-000V-V03 TDB (2025-11)*, abgeglichen mit einer laufenden Avarma 9 kW.
Modbus RTU, **9600 Baud, 8N1, Slave 1**, Funktionscode 0x03 (lesen) / 0x06 (schreiben).
**Immer die Spalte „Decimal“ verwenden**, nicht „Decimal+1“.

## Steuerung (lesen/schreiben)
| Register | Inhalt | Werte |
|---|---|---|
| 4096 | Ein/Aus | 0 aus, 1 ein |
| 4097 | Betriebsart | 1 WW, 2 Heizen, 3 Heizen+WW, 4 Kühlen, 5 Kühlen+WW |
| 4098 | Vorlauf-Soll Heizen (P02) | 10–75 °C |
| 4099 | Soll Kühlen (P03) | 7–25 °C |
| 4100 | Warmwasser-Soll (P04) | 10–70 °C |
| 4101 | Raum-Soll (P05) | 18–35 °C |
| 4103 | Abtauung erzwingen | 1 = Start |
| 4104 | **Fehler quittieren** | 1 schreiben |
| 4105 | Parameter-Reset | ⚠️ nicht verwenden |
| 4106 / 4107 | Uhr | Monat·256+Tag / Stunde·256+Minute |

## Betriebswerte (nur lesen)
| Register | Inhalt | Faktor |
|---|---|---|
| 4354 | Status-Bits (3 Alarm, 4 Abtauen, 8 Legionellen, 9 Frostschutz, 10 Estrich, 11 PV) | – |
| 4355 | Ausgänge (0 4-Wege-Ventil, 1 Öl-Heizung (Verdichter), 3/4/5 Pumpe C1–C3, 6/7 E1/E2, 8/9 Ventil G1/G2) | – |
| 4356 | Schalteingänge K1–K8 | – |
| 4358 | Lamelle Tc | 0,1 °C |
| 4359 | Heißgas Td | 0,1 °C |
| 4360 | Außentemperatur | 0,1 °C |
| 4361 | Sauggas Ts | 0,1 °C |
| 4362 / 4363 | EVI Ein/Aus (-32768 = kein Fühler) | 0,1 °C |
| 4364 | Kältemittel flüssig (Ty) | 0,1 °C |
| 4365 | Rücklauf TIn | 0,1 °C |
| 4366 | Vorlauf TOut | 0,1 °C |
| 4367 | Warmwasser TDHW (70,0 = kein Fühler oder nicht ausgewertet, solange P63 = 0) | 0,1 °C |
| 4368 | Durchfluss | 0,1 L/min |
| 4369 / 4370 | Temperaturdifferenz Hauptkreis / EVI | 0,1 K |
| 4371 / 4372 | Hochdruck Pd / Niederdruck Ps | 0,01 MPa |
| 4373 / 4378 | Kompressor Ist- / Soll-Frequenz | 1 Hz |
| 4374 / 4375 | Lüfter 1 / 2 | 1 U/min |
| 4376 / 4377 | EEV / EVI-EEV | 1 Schritt |
| 4379 | Kompressorstrom | 0,1 A |
| 4380 | IPM-Temperatur | 1 °C |
| 4381 / 4382 | AC-Netzspannung / DC-Zwischenkreis | 1 V |
| 4383 | T6 | 0,1 °C |
| 4384 | Raumtemperatur (27,0 = nicht ausgewertet, solange P67 = 0 – auch mit angeschlossenem Raumfühler, Klemmen 13/14) | 0,1 °C |
| 4385 / 4386 | Verdampfungs- / Kondensationstemperatur | 0,1 °C |
| 4387 | Frequenzbegrenzung (Bits) | – |
| 4388 / 4389 | Berechnete Solltemperaturen (4389 = OTC Heizkurve) | 0,1 °C |
| 4390–4393 | Fehlergruppen 0–3 (E01–E51) | Bits |
| 4394–4396 | Treiber-Fehler | Bits |
| 4397 / 4398 | Pumpe C1 PWM / Kompressor-Phasenstrom | – / 0,1 A |
| 4608 | **Kompressor-Starts gesamt** | 1 |
| 4609 | Ölrückführung aktiv | 0/1 |
| 4610 | Kompressor-Betriebsstunden | 1 h |
| 4611 / 4614 | Pumpe C1 / C2 | 1 % |
| 4612 | Aktueller Betrieb (0 aus, 1 WW, 2 Heizen, 4 Kühlen) | – |
| 4613 | Abtauvorgänge | 1 |
| 4615 / 4616 | Software Platine / Display | – |
| 4617 / 4618 / 4619 | R290-Konzentration / Alarmgrenze / Alarm | 0,1 % |
| 4628–4635 | Fehlerspeicher (8 Einträge, Code = E-Nummer) | – |

## Parameter
| Register | Inhalt |
|---|---|
| 8192–8326 | Parameter P00–P136 (siehe [parameter.md](parameter.md)) |
| 8327–8340 | P137–P150 |
| 4864–4871 | SG-Ready P201–P208 |

## Energiezähler (0,1 kWh)
| Register | Inhalt |
|---|---|
| 5120–5143 / 5144–5174 / 5175–5186 | Wärme erzeugt: Stunden heute / Tage im Monat / Monate |
| 5187–5210 / 5211–5241 / 5242–5253 | davon erneuerbar: Stunden / Tage / Monate |
| 5254–5277 / 5278–5308 / 5309–5320 | Strom verbraucht: Stunden / Tage / Monate |

## Fehlercodes
| Code | Bedeutung | Code | Bedeutung |
|---|---|---|---|
| E01 | Außenfühler defekt | E21 | Spannungsfehler |
| E02 | Lamellenfühler defekt | E22 | Spreizung VL/RL zu groß |
| E03 | Sauggasfühler defekt | E23 | Warmwasser-Frostschutz 2× |
| E04 | EVI-Eintrittsfühler defekt | E24 | Heizkreis-Frostschutz 2× |
| E05 | EVI-Austrittsfühler defekt | E26 | T6-Fühler defekt |
| E06 | Heißgasfühler defekt | E27 | Außentemperatur über Grenze |
| E07 | Warmwasserfühler defekt | E28 | Rücklauf zu hoch (Kühlen) |
| E08 | Vorlauffühler defekt | E29 | Raumfühler defekt |
| E09 | Rücklauffühler defekt | E32 | Vorlauf zu hoch (Heizen) |
| E10 | Kältemittel-Flüssigkeitsfühler defekt | E36 | Lüftertreiber Kommunikation |
| E11 | Hochdrucksensor defekt | E40 | Vorlauf zu niedrig (Kühlen) |
| E12 | Niederdrucksensor defekt | E44 | DC-Lüftermotor 1 |
| E13 | Hochdruck-Schutz | E45 | DC-Lüftermotor 2 |
| E14 | Niederdruck-Schutz | E50 | Kondensator Überhitzung |
| E15 | Wasserdurchfluss zu gering | E51 | Kältemittel-Konzentration hoch |
| E16 | Kommunikationsfehler | E56 | Primärstrom-Schutz |
| E17 | Heißgastemperatur zu hoch | E58 | Außentemperatur zu niedrig (T4) |
| E18 | EEPROM-Parameterfehler | E59 | VL/RL vertauscht oder 4-Wege-Ventil |
| E20 | IPM-Schutz | E99 | Kommunikation Treiberplatine |
