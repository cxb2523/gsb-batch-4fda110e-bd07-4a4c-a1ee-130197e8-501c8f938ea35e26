# Parameterliste Avarma / Hofman (Display P00–P208)

Display-Nummer, Modbus-Adresse (Spalte **Decimal** der Hofman-Liste), Darstellung wie am Display, erlaubter Bereich in Home Assistant und Erklärung.

Skalierung: Der Wert im Register ist *Anzeigewert ÷ Faktor* (z. B. Faktor 0,1 → 42,0 °C steht als 420 im Register).

> ⚠️ Werte ohne Hersteller-Bestätigung sind mit „Bedeutung lt. Hofman-Liste offen“ markiert. Ändern auf eigene Gefahr.

> ℹ️ Home Assistant liest diese Liste nur **alle 15 Minuten** neu ein (P02–P05 alle 10 Sekunden). Am Display oder in der Smart-Life-App geänderte Werte erscheinen daher mit bis zu 15 Minuten Verzögerung.


## System & Funktionen

| P | Adresse | Name | Faktor | Einheit | Bereich | Ebene | Erklärung |
|---|---|---|---|---|---|---|---|
| P00 | 8192 | Ein/Aus (Parameterspiegel) | 1 |  | 0 … 10 | nur lesen | Spiegel von Ein/Aus (0 = aus, 1 = ein). Schalten über den EIN/AUS-Knopf. |
| P01 | 8193 | Betriebsart (Parameterspiegel) | 1 |  | 0 … 10 | nur lesen | 0 Aus, 1 Warmwasser, 2 Heizen, 3 Heizen+WW, 4 Kühlen, 5 Kühlen+WW. Umschalten über „Betriebsart“. |
| P62 | 8252 | Heizen/Kühlen-Auswahl | 1 |  | 0 … 2 | Benutzer (Code 99) | 0 = Heizen und Kühlen, 1 = nur Kühlen, 2 = nur Heizen. |
| P66 | 8256 | Wasser-/Luftkühlung Option | 1 |  | 0 … 1 | Techniker | Hersteller-Option. |
| P67 | 8257 | Raumthermostat | 1 |  | 0 … 1 | Benutzer (Code 99) | 0 = kein Raumthermostat, 1 = Thermostat-Eingang aktiv. |
| P70 | 8260 | Wiederanlauf nach Stromausfall | 1 |  | 0 … 1 | Techniker | 0 = aus, 1 = WP läuft nach Stromausfall im letzten Zustand weiter. |
| P79 | 8269 | WLAN Upload-Intervall | 1 | s | 0 … 600 | Techniker | Sendeintervall des WLAN-Moduls. |
| P87 | 8277 | Werksreset | 1 |  | 0 … 0 | nur lesen | Gesperrt – nur am Display auslösen. |
| P98 | 8288 | Ventil G1 invertieren | 1 |  | 0 … 1 | Benutzer (Code 99) | Schaltsignal des Ventils G1 umkehren. |
| P99 | 8289 | Ventil G2 invertieren | 1 |  | 0 … 1 | Benutzer (Code 99) | Schaltsignal des Ventils G2 umkehren. |
| P100 | 8290 | Ventil G3 invertieren | 1 |  | 0 … 1 | Benutzer (Code 99) | Schaltsignal des Ventils G3 umkehren. |
| P108 | 8296 | RS485-Adresse | 1 |  | 1 … 1 | nur lesen | Gesperrt – Änderung würde die HA-Verbindung trennen. |
| P121 | 8311 | PV-Aktivierung | 1 |  | 0 … 1 | Benutzer (Code 99) | PV-Überschuss-/Smart-Grid-Eingang aktivieren. |
| P201 | 4864 | SG-Ready PSG1 | 1 |  | 0 … 100 | Benutzer (Code 99) | Smart-Grid-Ready Definition (0 = aus). |
| P202 | 4865 | SG-Ready PSG2 | 1 |  | 0 … 100 | Benutzer (Code 99) | Smart-Grid-Ready Definition (0 = aus). |
| P203 | 4866 | SG-Ready PSG3 | 1 |  | 0 … 100 | Benutzer (Code 99) | Smart-Grid-Ready Definition (0 = aus). |
| P204 | 4867 | SG-Ready PSG4 | 1 |  | 0 … 100 | Benutzer (Code 99) | Smart-Grid-Ready Definition (0 = aus). |
| P205 | 4868 | SG-Ready PSG5 | 1 |  | 0 … 100 | Benutzer (Code 99) | Smart-Grid-Ready Definition (0 = aus). |
| P206 | 4869 | SG-Ready PSG6 | 1 |  | 0 … 100 | Benutzer (Code 99) | Smart-Grid-Ready Definition (0 = aus). |
| P207 | 4870 | SG-Ready PSG7 | 1 |  | 0 … 100 | Benutzer (Code 99) | Smart-Grid-Ready Definition (0 = aus). |
| P208 | 4871 | SG-Ready PSG8 | 1 |  | 0 … 100 | Benutzer (Code 99) | Smart-Grid-Ready Definition (0 = aus). |

## Heizen & Heizkurve

| P | Adresse | Name | Faktor | Einheit | Bereich | Ebene | Erklärung |
|---|---|---|---|---|---|---|---|
| P02 | 4098 | Vorlauf-Soll Heizen | 1 | °C | 10 … 75 | Benutzer (Code 99) | Ziel-Vorlauftemperatur im Heizbetrieb (ohne Heizkurve). Nach einem Neustart der WP evtl. wieder 45 °C. |
| P03 | 4099 | Soll Kühlen | 1 | °C | 7 … 25 | Benutzer (Code 99) | Ziel-Vorlauftemperatur im Kühlbetrieb. |
| P05 | 4101 | Raum-Soll | 1 | °C | 18 … 35 | Benutzer (Code 99) | Raum-Solltemperatur, in der Smart-Life-App „R1_setting“. Nur mit Raumfühler/Thermostat (P67) wirksam. In der App steht R1 bei den Einstellungen zum Nachtmodus (Ein/Aus), hat aber **nichts mit dem Nachtmodus zu tun** (der ist P15–P17). |
| P06 | 8196 | Hysterese Heizen/Kühlen | 0,1 | K | 1 … 15 | Benutzer (Code 99) | Um so viel muss der Vorlauf unter den Sollwert fallen, bis die WP wieder startet. Größer = weniger Takte, aber größere Schwankung. |
| P08 | 8198 | Heizkurve: max. Vorlauf | 0,1 | °C | 35 … 75 | Benutzer (Code 99) | Höchster Vorlauf, den die Heizkurve (AU) bei tiefster Außentemperatur vorgibt. |
| P09 | 8199 | Heizkurve: Verschiebung | 0,1 | K | -10 … 10 | Benutzer (Code 99) | Parallelverschiebung der Heizkurve (+ = wärmer, − = kühler). |
| P19 | 8209 | Heizkurve (AU) aktiv | 1 |  | 0 … 1 | Benutzer (Code 99) | 1 = Vorlauf wird nach Außentemperatur geführt (Heizkurve), 0 = fester Vorlauf-Soll P02. |
| P135 | 8325 | Heizgrenze (Heizkurve) | 0,1 | °C | 5 … 30 | Benutzer (Code 99) | Über dieser Außentemperatur heizt die WP nicht (Sommerabschaltung). |
| P136 | 8326 | Heizkurve: Wiedereinschalten unter | 0,1 | °C | 0 … 30 | Benutzer (Code 99) | Unter dieser Außentemperatur wird wieder geheizt. |

## Warmwasser & Legionellen

| P | Adresse | Name | Faktor | Einheit | Bereich | Ebene | Erklärung |
|---|---|---|---|---|---|---|---|
| P04 | 4100 | Warmwasser-Soll | 1 | °C | 10 … 70 | Benutzer (Code 99) | Zieltemperatur des Warmwasserspeichers (10–70 °C, muss ≥ P35 sein). |
| P07 | 8197 | Hysterese Warmwasser | 0,1 | K | 1 … 15 | Benutzer (Code 99) | Einschalt-Differenz für die Warmwasserbereitung. |
| P10 | 8200 | Legionellen: Intervall | 1 | d | 1 … 99 | Benutzer (Code 99) | Alle wie viele Tage die Legionellenschaltung läuft. |
| P11 | 8201 | Legionellen: Startzeit | 1 | h | 0 … 23 | Benutzer (Code 99) | Uhrzeit (Stunde) des Legionellenprogramms. |
| P12 | 8202 | Legionellen: Dauer | 1 | min | 5 … 99 | Benutzer (Code 99) | Haltezeit auf Legionellentemperatur. |
| P13 | 8203 | Legionellen: Temperatur | 0,1 | °C | 50 … 70 | Benutzer (Code 99) | Zieltemperatur der Legionellenschaltung. |
| P14 | 8204 | Legionellen: Modus | 1 |  | 0 … 2 | Benutzer (Code 99) | 0 = automatisch, 1 = manuell, 2 = aus. |
| P18 | 8208 | Warmwasser nach Heizkurve | 1 |  | 0 … 1 | Benutzer (Code 99) | Warmwasser-Soll automatisch nach Außentemperatur (AU). |
| P35 | 8225 | WW: Kompressor-Obergrenze | 0,1 | °C | 0 … 70 | Techniker | Bis zu dieser WW-Temperatur heizt der Kompressor, darüber nur E-Heizung. |
| P63 | 8253 | Warmwasserfunktion | 1 |  | 0 … 1 | Benutzer (Code 99) | 0 = kein Warmwasserspeicher, 1 = WW-Bereitung aktiv. |
| P83 | 8273 | WW-Zirkulationspumpe Betrieb | 1 |  | 0 … 3 | Techniker | 0 = nein, 1 = Zeit, 2 = Temperaturdifferenz, 3 = Zeit + Temperaturdifferenz (nur bei P88 = 1). |
| P84 | 8274 | WW-Zirkulation Differenz | 0,1 | K | 4 … 20 | Techniker | Einschaltdifferenz der Zirkulationspumpe. |

## Nachtmodus

| P | Adresse | Name | Faktor | Einheit | Bereich | Ebene | Erklärung |
|---|---|---|---|---|---|---|---|
| P15 | 8205 | Nachtmodus Start | 1 | h | 0 … 23 | Benutzer (Code 99) | Stunde, ab der der leise Nachtmodus gilt. |
| P16 | 8206 | Nachtmodus Ende | 1 | h | 0 … 23 | Benutzer (Code 99) | Stunde, bis zu der der Nachtmodus gilt. |
| P17 | 8207 | Nachtmodus aktiv | 1 |  | 0 … 1 | Benutzer (Code 99) | 0 = aus, 1 = ein. Im Nachtmodus reduziert die WP Kompressor- und Lüfterleistung (leiser). |

## Pumpen & Durchfluss

| P | Adresse | Name | Faktor | Einheit | Bereich | Ebene | Erklärung |
|---|---|---|---|---|---|---|---|
| P20 | 8210 | Umwälzpumpe Betriebsart | 1 |  | 0 … 1 | Benutzer (Code 99) | 0 = Pumpe läuft durch, 1 = Pumpe stoppt bei erreichter Temperatur. |
| P21 | 8211 | Pumpe Frostschutz-Intervall | 1 | min | 5 … 50 | Benutzer (Code 99) | Intervall, in dem die Pumpe bei Stillstand zum Frostschutz läuft. |
| P58 | 8248 | Pumpe Regel-Spreizung | 0,1 | K | 3 … 8 | Techniker | Auf diese Spreizung VL–RL regelt die drehzahlgeregelte Pumpe. |
| P59 | 8249 | Pumpe Mindestdrehzahl | 1 | ×10 % | 2 … 8 | Techniker | Untere Pumpendrehzahl, entspricht 20–80 % (8 = 80 %). |
| P61 | 8251 | Mindestdurchfluss | 1 | L/min | 3 … 80 | Techniker | Unter diesem Durchfluss → Fehler E15. Nicht ohne Grund absenken. |
| P65 | 8255 | Pumpe C2 Funktion | 1 |  | 0 … 1 | Benutzer (Code 99) | 0 = Zusatzpumpe, 1 = Heizkreis-Umwälzpumpe. |
| P68 | 8258 | Durchflusssensor-Typ | 1 |  | 0 … 1 | Techniker | 0 = Strömungsschalter, 1 = Durchflussmesser (nur mit Hersteller-Freigabe ändern). |
| P88 | 8278 | Pumpe C3 Funktion | 1 |  | 0 … 1 | Benutzer (Code 99) | 0 = WW-Zusatzpumpe, 1 = WW-Zirkulationspumpe. |

## E-Heizung & 2. Wärmeerzeuger

| P | Adresse | Name | Faktor | Einheit | Bereich | Ebene | Erklärung |
|---|---|---|---|---|---|---|---|
| P22 | 8212 | E-Heizung Heizen: Start unter | 0,1 | °C | -30 … 20 | Benutzer (Code 99) | Unter dieser Außentemperatur darf der Heizstab beim Heizen zuschalten. |
| P23 | 8213 | E-Heizung WW: Start unter | 0,1 | °C | -30 … 20 | Benutzer (Code 99) | Unter dieser Außentemperatur darf der Heizstab beim Warmwasser zuschalten. |
| P24 | 8214 | E-Heizung E1/E2: Stopp-Hysterese | 0,1 | K | 1 … 15 | Benutzer (Code 99) | Hysterese der Außentemperatur, bei der E1/E2 wieder abschalten. |
| P36 | 8226 | Verzögerung Kompressor → E1 | 1 | min | 0 … 999 | Techniker | Wartezeit, bevor nach Kompressorstart der Heizstab dazuschalten darf. |
| P81 | 8271 | E1/E2 Funktion | 1 |  | 0 … 3 | Techniker | 0 = E-Zusatzheizung, 1 = zweiter Wärmeerzeuger, 2 = mit E-Heizer, 3 = mit Kessel. |
| P82 | 8272 | 2. Wärmeerzeuger: Start unter | 0,1 | °C | -30 … 10 | Techniker | Unter dieser Außentemperatur wird ein 2. Wärmeerzeuger freigegeben. |
| P116 | 8304 | E-Heizung Leistungsberechnung | 1 |  | 0 … 1 | Benutzer (Code 99) | Heizstab-Leistung in die Energiebilanz einrechnen (0/1). |
| P117 | 8305 | E0 Leistung | 0,1 | kW | 0 … 9 | Benutzer (Code 99) | Leistung Heizstab E0 (für die Energiebilanz). |
| P118 | 8306 | E1 Leistung | 0,1 | kW | 0 … 9 | Benutzer (Code 99) | Leistung Heizstab E1. |
| P119 | 8307 | E2 Leistung | 0,1 | kW | 0 … 9 | Benutzer (Code 99) | Leistung Heizstab E2. |

## Schutzfunktionen

| P | Adresse | Name | Faktor | Einheit | Bereich | Ebene | Erklärung |
|---|---|---|---|---|---|---|---|
| P25 | 8215 | Frostschutz-Temperatur | 0,1 | °C | -15 … 5 | Techniker | Unter dieser Wassertemperatur startet der Frostschutz. |
| P42 | 8232 | Strom: keine Frequenzerhöhung ab | 0,1 | A | 1 … 50 | Techniker | Ab diesem Kompressorstrom wird die Frequenz nicht mehr erhöht. |
| P43 | 8233 | Strom: Frequenzabsenkung ab | 0,1 | A | 1 … 50 | Techniker | Ab diesem Strom wird die Frequenz reduziert. |
| P44 | 8234 | Strom: Abschaltung ab | 0,1 | A | 1 … 50 | Techniker | Ab diesem Strom schaltet der Kompressor ab. |
| P51 | 8241 | Hochdruck: keine Frequenzerhöhung ab | 0,1 | bar | 20 … 45 | Techniker | Ab diesem Hochdruck keine Frequenzerhöhung mehr. |
| P52 | 8242 | Hochdruck: Sperre aufheben ab | 0,1 | bar | 20 … 45 | Techniker | Unter diesem Hochdruck darf die Frequenz wieder steigen. |
| P53 | 8243 | Hochdruck-Abschaltung | 0,1 | bar | 20 … 45 | Techniker | Schutzabschaltung bei zu hohem Druck. |
| P54 | 8244 | Niederdruck-Abschaltung | 0,1 | bar | 0.1 … 1.0 | Techniker | Schutzabschaltung bei zu niedrigem Druck. |
| P55 | 8245 | Hochdruck-Schutz Hysterese | 0,1 | bar | 1 … 10 | Techniker | Rückschaltdifferenz Hochdruckschutz. |
| P56 | 8246 | Niederdruck-Schutz Hysterese | 0,01 | bar | 0.1 … 5 | Techniker | Rückschaltdifferenz Niederdruckschutz. |
| P57 | 8247 | Heißgas-Schutztemperatur | 1 | °C | 100 … 125 | Techniker | Abschaltung bei zu hoher Druckgastemperatur (Td). |
| P73 | 8263 | Drucksensor/Druckschalter | 1 |  | 0 … 1 | Techniker | 0 = Drucksensor, 1 = Druckschalter. |
| P102 | 8292 | Schutzgrenze Spreizung VL/RL | 0,1 | K | 8 … 20 | Techniker | Maximal zulässige Spreizung, sonst Schutz. |
| P109 | 8297 | Heißgas-Grenze 1 | 1 | °C | 80 … 125 | Techniker | Frequenzbegrenzung ab dieser Druckgastemperatur (Stufe 1). |
| P110 | 8298 | Heißgas-Grenze 2 | 1 | °C | 80 … 125 | Techniker | Stufe 2. |
| P111 | 8299 | Heißgas-Grenze 3 | 1 | °C | 80 … 125 | Techniker | Stufe 3. |
| P115 | 8303 | Vorlauf-Übertemperaturschutz | 1 | °C | 70 … 90 | Techniker | Schutzabschaltung bei zu hohem Vorlauf. |

## Abtauung

| P | Adresse | Name | Faktor | Einheit | Bereich | Ebene | Erklärung |
|---|---|---|---|---|---|---|---|
| P26 | 8216 | Abtau: Intervall-Faktor | 1 |  | 0 … 4 | Techniker | 0 = keine Abtauung, 1–4 = Intervall-Faktor (×4). |
| P27 | 8217 | Abtau: Zyklus | 1 | min | 15 … 99 | Techniker | Mindest-Laufzeit zwischen zwei Abtauungen. |
| P28 | 8218 | Abtaumodus | 1 |  | 0 … 1 | Techniker | 0 = automatisch. 1 = Abtauung manuell auslösen (springt danach auf 0). |
| P29 | 8219 | Abtau-Start Lamellentemp. | 0,1 | °C | -8 … 5 | Techniker | Lamelle (Tc) muss unter diesen Wert fallen, damit abgetaut wird. |
| P30 | 8220 | Abtau-Ende Lamellentemp. | 0,1 | °C | 5 … 30 | Techniker | Abtauung endet, wenn die Lamelle diese Temperatur erreicht. |
| P31 | 8221 | Abtau: max. Dauer | 1 | min | 2 … 20 | Techniker | Abtauung wird spätestens nach dieser Zeit beendet. |
| P47 | 8237 | Abtau-Frequenz | 1 | Hz | 30 … 90 | Techniker | Kompressorfrequenz während der Abtauung. |
| P85 | 8275 | Abtau: max. Außentemperatur | 0,1 | °C | 0 … 20 | Techniker | Über dieser Außentemperatur taut die WP nicht selbst ab (Community-Tipp: 15 °C). |
| P86 | 8276 | Abtau ΔT Außen–Lamelle (≥ −7 °C) | 0,1 | K | 0 … 20 | Techniker | Geforderte Differenz Außenluft–Lamelle für den Abtaustart. |
| P91 | 8281 | Abtau ΔT Außen–Lamelle (< −7 °C) | 0,1 | K | 0 … 20 | Techniker | Wie P86, für Außentemperaturen unter −7 °C. |
| P101 | 8291 | EEV-Schritte beim Abtauen | 1 | P | 0 … 480 | Techniker | Ventilöffnung während der Abtauung. |

## Expansionsventil / EVI / Überhitzung

| P | Adresse | Name | Faktor | Einheit | Bereich | Ebene | Erklärung |
|---|---|---|---|---|---|---|---|
| P32 | 8222 | EEV Regelart | 1 |  | 0 … 4 | Techniker | 0 keine, 1 Tabelle, 2 manuell, 3 Sauggas-Überhitzung, 4 Heißgas-Überhitzung. |
| P33 | 8223 | EEV manuell Heizen | 1 | P | 50 … 480 | Techniker | Feste Ventilöffnung im manuellen Modus (Heizen). |
| P34 | 8224 | EEV manuell Kühlen | 1 | P | 50 … 480 | Techniker | Feste Ventilöffnung im manuellen Modus (Kühlen). Achtung: Display zeigt 0, Register liest 400. |
| P49 | 8239 | Heißgas-Überhitzung P | 1 |  | 0 … 99 | Techniker | Regelparameter (Proportional). |
| P50 | 8240 | Heißgas-Überhitzung D | 1 |  | 0 … 99 | Techniker | Regelparameter (Differential). |
| P64 | 8254 | EEV Mindestöffnung | 1 | P | 0 … 480 | Techniker | Kleinste Öffnung des Expansionsventils. |
| P74 | 8264 | EVI-Ventil Regelart | 0,1 |  | 0 … 100 | Techniker | Regelung des EVI-(Einspritz-)Ventils. |
| P75 | 8265 | EVI Anfangsöffnung | 1 | P | 0 … 500 | Techniker | Startöffnung EVI-Ventil. |
| P76 | 8266 | EVI Parameter 76 | 0,1 |  | 0 … 50 | Techniker | EVI-Regelparameter. |
| P77 | 8267 | EVI Überhitzung Heizen | 1 |  | 0 … 500 | Techniker | EVI-Regelparameter Heizen. |
| P78 | 8268 | EVI Überhitzung Kühlen | 1 |  | 0 … 500 | Techniker | EVI-Regelparameter Kühlen. |
| P89 | 8279 | Sauggas-Überhitzung P | 1 |  | 0 … 20 | Techniker | Regelparameter (Proportional). |
| P90 | 8280 | Sauggas-Überhitzung D | 1 |  | 0 … 20 | Techniker | Regelparameter (Differential). |
| P92 | 8282 | Soll-Überhitzung Heizen (Außen ≤ −5 °C) | 0,1 | K | -5 … 10 | Techniker | Ziel-Überhitzung Sauggas (Außentemperatur-Bereich 1). |
| P93 | 8283 | Soll-Überhitzung Heizen (−5…5 °C) | 0,1 | K | -5 … 10 | Techniker | Ziel-Überhitzung Sauggas (Bereich 2). |
| P94 | 8284 | Soll-Überhitzung Heizen (5…25 °C) | 0,1 | K | -5 … 10 | Techniker | Ziel-Überhitzung Sauggas (Bereich 3). |
| P95 | 8285 | Soll-Überhitzung Kühlen | 0,1 | K | -5 … 10 | Techniker | Ziel-Überhitzung im Kühlbetrieb. |
| P96 | 8286 | Soll-Überhitzung Heizen (25…45 °C) | 0,1 | K | -5 … 10 | Techniker | Ziel-Überhitzung bei hohem Vorlauf. |
| P103 | 8293 | EEV Anfangsöffnung Haltezeit | 1 | s | 0 … 300 | Techniker | So lange bleibt das EEV nach dem Start auf Anfangsöffnung. |
| P112 | 8300 | EEV-Korrektur ab Heißgas | 1 | °C | 80 … 125 | Techniker | Ab dieser Druckgastemperatur öffnet das EEV zusätzlich. |
| P113 | 8301 | EEV-Korrektur Intervall | 1 | s | 1 … 120 | Techniker | Zeitintervall der Korrektur. |

## Lüfter

| P | Adresse | Name | Faktor | Einheit | Bereich | Ebene | Erklärung |
|---|---|---|---|---|---|---|---|
| P37 | 8227 | Lüfter-Kennlinie Heizen | 0,1 |  | 2 … 15 | Techniker | Faktor für die Lüfterdrehzahl im Heizbetrieb. |
| P38 | 8228 | Lüfter-Kennlinie Kühlen | 0,1 |  | 3 … 18 | Techniker | Faktor für die Lüfterdrehzahl im Kühlbetrieb. |
| P60 | 8250 | Lüfter max. Drehzahl | 1 | ×10 U/min | 50 … 150 | Techniker | Höchste Lüfterdrehzahl in 10 U/min (63 = 630 U/min, Bereich 500–1500). |
| P69 | 8259 | Lüftertyp | 1 |  | 0 … 3 | Techniker | 0 = AC, 1 = erster DC, 2 = zweiter DC, 3 = zwei DC-Lüfter. |
| P71 | 8261 | Lüftersteuerung | 1 |  | 0 … 1 | Techniker | 1 = automatisch, 0 = manuell mit P72 (Vereisungsgefahr!). |
| P72 | 8262 | Lüfter manuelle Drehzahl | 1 | ×10 U/min | 0 … 150 | Techniker | Nur bei P71 = 0. 40 = 400 U/min. |

## Kompressor

| P | Adresse | Name | Faktor | Einheit | Bereich | Ebene | Erklärung |
|---|---|---|---|---|---|---|---|
| P39 | 8229 | Kompressormodell | 1 |  | 0 … 255 | nur lesen | Werkseinstellung – NICHT ändern. |
| P40 | 8230 | Festfrequenz-Funktion | 1 |  | 0 … 1 | Techniker | 0 = manuell, 1 = automatisch. |
| P41 | 8231 | Ölrückführung Frequenz | 1 | Hz | 10 … 100 | Techniker | Frequenz für die periodische Ölrückführung. |
| P45 | 8235 | Kompressor max. Frequenz | 1 | Hz | 50 … 120 | Techniker | Höchste Kompressorfrequenz (Leistungsgrenze, auch beim Abtauen wirksam). |
| P46 | 8236 | Kompressor min. Frequenz | 1 | Hz | 0 … 90 | Techniker | Niedrigste Frequenz. Kleiner = weiter herunter modulieren = weniger Takten. |
| P48 | 8238 | Warmwasser max. Frequenz | 1 | % | 2 … 10 | Techniker | Höchstfrequenz im WW-Betrieb als Faktor der höchsten eingestellten Frequenz. |
| P80 | 8270 | Mindestfrequenz-Berechnung | 0,1 |  | 0 … 10 | Techniker | Faktor für die Mindestfrequenz-Ermittlung. |
| P104 | 8294 | Kompressor Startfrequenz | 1 | Hz | 20 … 60 | Techniker | Startfrequenz für die Leistungsberechnung Heizen/Kühlen. |
| P105 | 8194 | Startplateau Frequenz | 1 | Hz | 20 … 60 | Techniker | Frequenz des Anlaufplateaus (Plattform A). |
| P106 | 8195 | Startplateau Dauer | 1 | s | 0 … 300 | Techniker | Haltezeit auf dem Anlaufplateau. |
| P114 | 8302 | Frequenzreduktion bei VL-Soll | 1 | % | 0 … 60 | Techniker | Wie weit der Kompressor bei erreichtem Soll herunter modulieren darf. Größer = weniger Takten (Community: 3 % statt 2 %). |

## Sonstige

| P | Adresse | Name | Faktor | Einheit | Bereich | Ebene | Erklärung |
|---|---|---|---|---|---|---|---|
| P97 | 8287 | Parameter 97 (Frequenz) | 1 | Hz | 10 … 100 | Techniker | Hersteller-Parameter. |
| P107 | 8295 | PRt Berechnung | 1 |  | 0 … 10 | Techniker | Hersteller-Parameter. |
| P137 | 8327 | Parameter 137 | 1 |  | 0 … 100 | Techniker | Bedeutung lt. Hofman-Liste offen. |
| P138 | 8328 | Parameter 138 | 1 |  | 0 … 100 | Techniker | Bedeutung lt. Hofman-Liste offen. |
| P139 | 8329 | Parameter 139 | 1 |  | 0 … 100 | Techniker | Bedeutung lt. Hofman-Liste offen. |
| P140 | 8330 | Parameter 140 | 1 |  | 0 … 100 | Techniker | Bedeutung lt. Hofman-Liste offen. |
| P141 | 8331 | Parameter 141 | 1 |  | 0 … 100 | Techniker | Bedeutung lt. Hofman-Liste offen. |
| P142 | 8332 | Parameter 142 | 1 |  | 0 … 100 | Techniker | Bedeutung lt. Hofman-Liste offen. |
| P143 | 8333 | Parameter 143 | 1 |  | 0 … 100 | Techniker | Bedeutung lt. Hofman-Liste offen. |
| P144 | 8334 | Parameter 144 | 1 |  | 0 … 100 | Techniker | Bedeutung lt. Hofman-Liste offen. |
| P145 | 8335 | Parameter 145 | 1 |  | 0 … 100 | Techniker | Bedeutung lt. Hofman-Liste offen. |
| P146 | 8336 | Parameter 146 | 0,1 | °C | 0 … 50 | Benutzer (Code 99) | Bedeutung lt. Hofman-Liste offen (Wert 25,0). |
| P147 | 8337 | Parameter 147 | 1 |  | 0 … 100 | Benutzer (Code 99) | Bedeutung lt. Hofman-Liste offen. |
| P148 | 8338 | Parameter 148 (App: R2_setting) | 0,1 | °C | 18 … 35 | Benutzer (Code 99) | In der Smart-Life-App „R2_setting“ (18–35 °C, Werk 25,0); steht dort wie R1 beim Nachtmodus (Ein/Aus), hat aber **nichts mit dem Nachtmodus zu tun**. Bedeutung offen, vermutlich Raum-Soll Kühlen; wie P05 nur mit Raumfühler (P67) wirksam. Zuordnung R1/R2 dank Hinweis aus der Community, an einer Anlage bestätigt. |
| P149 | 8339 | Parameter 149 | 1 |  | 0 … 100 | Benutzer (Code 99) | Bedeutung lt. Hofman-Liste offen (Wert 15). |
| P150 | 8340 | Parameter 150 | 1 |  | 0 … 100 | Benutzer (Code 99) | Bedeutung lt. Hofman-Liste offen. |

## Estrichtrocknung

| P | Adresse | Name | Faktor | Einheit | Bereich | Ebene | Erklärung |
|---|---|---|---|---|---|---|---|
| P122 | 8312 | Estrichtrocknung aktiv | 1 |  | 0 … 1 | Benutzer (Code 99) | Startet das Estrich-Aufheizprogramm (Perioden P123–P134). |
| P123 | 8313 | Periode 1 Dauer | 1 | d | 0 … 30 | Benutzer (Code 99) | Dauer Periode 1. |
| P124 | 8314 | Periode 1 Start | 0,1 | °C | 15 … 55 | Benutzer (Code 99) | Vorlauf zu Beginn von Periode 1. |
| P125 | 8315 | Periode 1 Ende | 0,1 | °C | 15 … 55 | Benutzer (Code 99) | Vorlauf am Ende von Periode 1. |
| P126 | 8316 | Periode 2 Dauer | 1 | d | 0 … 30 | Benutzer (Code 99) | Dauer Periode 2. |
| P127 | 8317 | Periode 2 Start | 0,1 | °C | 15 … 55 | Benutzer (Code 99) |  |
| P128 | 8318 | Periode 2 Ende | 0,1 | °C | 15 … 55 | Benutzer (Code 99) |  |
| P129 | 8319 | Periode 3 Dauer | 1 | d | 0 … 30 | Benutzer (Code 99) |  |
| P130 | 8320 | Periode 3 Start | 0,1 | °C | 15 … 55 | Benutzer (Code 99) |  |
| P131 | 8321 | Periode 3 Ende | 0,1 | °C | 15 … 55 | Benutzer (Code 99) |  |
| P132 | 8322 | Periode 4 Dauer | 1 | d | 0 … 30 | Benutzer (Code 99) |  |
| P133 | 8323 | Periode 4 Start | 0,1 | °C | 15 … 55 | Benutzer (Code 99) |  |
| P134 | 8324 | Periode 4 Ende | 0,1 | °C | 15 … 55 | Benutzer (Code 99) |  |
