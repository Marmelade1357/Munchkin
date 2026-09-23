# Übergabe für eine andere Claude-Session

Diese Datei entstand, weil der Nutzer gefragt hat "was muss noch getan werden,
und wenn was fehlt, erstelle eine Übergabe-MD für eine andere Claude-Session".
Sie richtet sich an eine **neue** Claude-Session ohne Gesprächskontext und
beschreibt: (1) welche Architektur/Muster in diesem Projekt bereits etabliert
sind, (2) was inzwischen automatisiert ist, (3) was bewusst/aus Kapazitäts-
oder Datengründen offen bleibt, und (4) wie hier praktisch gearbeitet wird
(Lieferweg, Tests, Verifikation).

Kontext: Der Nutzer wollte ursprünglich, dass **möglichst viele** der
hunderten individuellen Karten-Sonderregeln (die laut ursprünglichem
Server-Design bewusst "Trust-Prinzip"-manuell blieben) tatsächlich im Server
nachgebildet werden - inklusive eines komplett neuen dritten Charakter-Merkmals
("Machtgruppe", Pathfinder-Set). Das ist über mehrere Runden passiert; diese
Datei ist der Stand nach der Runde vom **2026-09-11**.

**Wer hier neu anfängt, liest zuerst Abschnitt 8.** Dort steht der Stand der
Runde vom 2026-09-12 (fehlende Basis-Set-Kartenkräfte), die zur Hälfte fertig
ist: zehn von dreizehn Aufgaben sind umgesetzt, drei sind offen,
und Abschnitt 8 sagt genau, wie man sie zu Ende bringt.

Abschnitt 7 ist weiterhin gültig und beschreibt die Runde davor
(Dauerwirkungen von Karten, nur Basis-Set).

Stand der vorherigen Runde (2026-09-10): Verifikation des
Basis-Set-Fluch-Nachtrags, ALUFOLIE-Gleichstand behoben, die passiven
Machtgruppen-Kräfte (Höllenritter, Assassine) ergänzt.

## 1. Architektur / etablierte Muster

Alles in `server.js` (Node/Express + Socket.IO, ein In-Memory `rooms`-Map,
keine Datenbank).

- **Kuratierte Override-Tabellen**, jeweils exakt per Kartennamen (Groß-/
  Kleinschreibung wie in `data/cards.json`) indiziert. Jeder Eintrag ist eine
  Funktion `(player, room) => actionSpec | null | undefined`:
  - `CONSEQUENCE_OVERRIDES` - Flüche/Monster-"Schlimme Dinge". `null` heißt
    "bewusst nicht automatisch" (wird als solches im Client trotzdem als
    Fluch/Konsequenz erkannt, aber ohne automatische Wirkung). `undefined`
    (kein Eintrag) fällt durch zu `parseAutoConsequence()` (generischer
    Regex-Parser für Standardformulierungen wie "Verliere 1 Stufe").
  - `TREASURE_POWER_OVERRIDES` - Schatzkarten-Sonderkräfte (`treasure_other`).
  - `COMBAT_POTION_OVERRIDES` - Kampf-Tränke mit Sonderlogik (über die
    generische "+N für Seite X"-Erkennung hinaus).
  - `ITEM_CONDITIONAL_BONUS` - Gegenstände mit monster-/rassenabhängigem
    Kampfbonus (z. B. Vorpale Klinge: +10 gegen Monster mit "J" im Namen).
- **`DOOR_OTHER_AS_CURSE`** (Set von Kartennamen): Karten, die in den
  Rohdaten als `door_other` (normale Türkarte) geführt werden, aber textlich
  eindeutig Sofort-Flüche sind (Pathfinder-Set UND, seit dem letzten
  Nachtrag, ca. 25 Basis-Set/Erweiterungs-Karten). `handleDrawDoor()` prüft
  `c.category === 'curse' || DOOR_OTHER_AS_CURSE.has(c.name)` und behandelt
  beide Fälle über denselben Fluch-Mechanismus (`resolveConsequenceSpec` →
  `CONSEQUENCE_OVERRIDES` → `parseAutoConsequence`-Fallback).
- **`applyPrimitiveAction(room, player, action)`**: zentraler Dispatcher, der
  ein `actionSpec` (`{ type: '...', ... }`) tatsächlich ausführt (Stufe
  ändern, Gegenstand ablegen, Hand ablegen, Rassen-/Klassenkarte tauschen,
  ...). Neue Konsequenz-Arten werden hier als neuer `case` ergänzt.
- **Generisches "Pending Card Action"-System** (`room.pendingCardAction`,
  Resolver in `room._pendingCardActionResolvers`), für Sonderkräfte, die
  echte Spieler-Interaktion brauchen: `choice` (Buttons), `targetPlayer`
  (Mitspieler wählen), `chooseCard` (Karte aus einem Ablagestapel wählen).
  Server: `openCardChoice()`, `openCardTarget()`, `openCardCardChoice()`,
  `handleResolveCardChoice()`, `handleResolveCardTarget()`,
  `handleResolveCardCardChoice()`. Client: `renderCardAction()` in
  `public/client.js`, Ziel-Div `#cardActionArea` in `public/index.html`.
  (Es gibt daneben noch das ältere `pendingConsequence.choice`-System nur für
  Konsequenz-Wahlmöglichkeiten - beide bestehen parallel, nicht
  zusammengeführt.)
- **Machtgruppe** (`powerGroups` auf jedem Spieler, `POWER_GROUP_NAMES` Set,
  `powerGroupCapCard`): drittes Charakter-Merkmal neben Rasse/Klasse,
  spezifisch für das Pathfinder-Set. Cap-Karten (analog zu "Super Munchkin"):
  HALB-BLUT (Rasse), SUPER MUNCHKIN (Klasse), DOPPELLEBEN (Machtgruppe).
  `handlePlayRaceOrClass()` wurde entsprechend erweitert, inkl.
  Log-Feedback, wenn eine Karte wegen Cap nicht spielbar ist.
- **Kampf-Tränke** (`treasure_other`, "Im Kampf spielen"/"Während beliebigem
  Kampf spielen"): `COMBAT_PLAYABLE_RE`, `parseCombatPotion()`,
  `isCombatPotionCard()`, `applyCombatPotionAction()`.
- **Bedingter Item-Kampfbonus**: zusätzlich zum pauschalen
  `equippedBonusSum` gibt es `conditionalItemBonusSum(player, monsters)`,
  die nur innerhalb von `combatTotals()`/`combatConditionalBonusFields()`
  einfließt (abhängig vom/von den aktuellen Monster(n) im Kampf).
- **Tests**: `tests/run.js` führt alle `tests/*.test.js` aus.
  - `tests/basic-game-flow.test.js`: Integrationstest mit echten
    Socket.IO-Bots, prüft grob auf Abstürze/Plausibilität.
  - `tests/auto-consequence.test.js`: Abdeckungs-Regressionscheck für
    Flüche/Monster-Konsequenzen.
  - `tests/card-abilities.test.js`: gezielte Verhaltenstests + Abdeckungs-
    Regressionscheck für die neueren Mechanismen (Level-Up-Karten,
    Kampf-Tränke, Machtgruppen, `DOOR_OTHER_AS_CURSE`, bedingte Item-Boni).
- **Verifikation über Playwright** (`/opt/pw-browsers/chromium`, bereits
  vorinstalliert): Skripte wie `/tmp/verify_cards2.js` starten einen
  Solo-Raum mit Bots und klicken sich durch viele Runden. **Wichtige Falle**:
  nie ein `ElementHandle` über einen State-Wechsel hinweg cachen - immer
  direkt vor jedem `.click()` per `page.$(selector)` neu abfragen (siehe
  `tryClick()`-Helper in den Skripten), sonst "Element is not attached to
  the DOM"-Fehler.

## 2. Lieferweg

**Erledigt/überholt.** Eine frühere Session musste über
`SendUserFile` + `device_commit_files` ausliefern, weil kein Shell-Zugriff
auf den PC des Nutzers bestand. Seit der Session vom 2026-09-10 läuft Claude
Code direkt in `C:\git\Munchkin` mit normalem Datei- und `git`-Zugriff -
einfach direkt im Repo arbeiten.

Einziger Stolperstein: `node_modules` ist nicht eingecheckt. Nach einem
frischen Clone zuerst `npm install`, sonst schlagen alle Tests mit
`Cannot find module 'express'` fehl (das sieht nach Regression aus, ist aber
nur die fehlende Installation).

## 3. Was in dieser Runde neu ergänzt wurde (Nachtrag Basis-Set-Flüche)

Bei einer erneuten, gründlichen Prüfung ("was fehlt noch") wurde entdeckt,
dass die vorherige Runde nur die **Pathfinder**-Fehlkategorisierungen erfasst
hatte. Ein systematischer Scan aller `door_other`-Karten (gefiltert nach
"nicht bereits über Monster-Verstärker/Machtgruppen/Cap-Karten abgedeckt" und
"textlich eindeutig ein Fluch") ergab ca. 25 weitere, echte Basis-Set/
Erweiterungs-Karten, die ebenfalls fälschlich als normale Türkarte statt als
Fluch geführt werden (mehrere enthalten wörtlich "der Fluch"). Diese wurden
jetzt ergänzt:

- Neu in `CONSEQUENCE_OVERRIDES` **mit** automatischer Wirkung: Rüstung
  verlieren, Kopfbedeckung verlieren, SCHUHWERK VERLIEREN, VERLIERE 1 STUFE,
  VERLIERE DEINE KLASSE (inkl. echter Wahl bei 2 Klassen dank Super
  Munchkin), VERLIERE DEINE RASSE, KLASSE WECHSELN, RASSE WECHSELN
  (`replaceTraitFromDiscard` wurde dafür generalisiert, unterstützt jetzt
  auch `category: 'race'`), QUANTEN (bedingt: nur falls Schuhwerk getragen
  wird), REGELN DER NEUAUFLAGE (neuer Fall `levelDeltaAllPlayers`, betrifft
  alle am Tisch), VERLIERE ZWEI KARTEN (neuer Fall
  `giveHandCardsToNeighbors`: Vorgänger/Nachfolger in der Zugreihenfolge
  ziehen je eine Zufallskarte aus der Hand des Opfers).
- Neue `applyPrimitiveAction`-Fälle dafür: `discardSpecificClassCard`,
  `giveHandCardsToNeighbors`, `levelDeltaAllPlayers`.
- Neu in `CONSEQUENCE_OVERRIDES` mit `() => null` (bewusst weiterhin
  manuell, aber jetzt korrekt als Fluch erkannt/angezeigt): VERLIERE 1
  GROSSEN GEGENSTAND, VERLIERE 1 KLEINEN GEGENSTAND, GESCHLECHTSUMWANDLUNG,
  HUHN AUF DEINEM KOPF, NARRENGOLD, BLUTSCHLEIER, RAUSCHPOCKEN,
  TOURISTENFALLE, EDELMUT, HUNGRIGER RUCKSACK, KLEINER FEHLER, TEMPORÄRE
  ANMNESIE, MIESER SPIEGEL, STINKER, WINZIGE HÄNDE.
- **DU STOLPERST ÜBER DEINE EIGENE TRUHE** war in den Rohdaten ohne jeden
  Text und wurde in 96495e5 deshalb entfernt; der gedruckte Wortlaut kam
  später nach. Sie ist wieder in `data/cards.json` (mit derselben Id, das Bild
  passte noch) und hat jetzt eine echte Wirkung: `discardMaxGoldItem` -
  wertvollster ANGELEGTER Gegenstand nach Goldwert, dasselbe Primitiv wie bei
  der PACKRATTE. Handkarten bleiben unangetastet.
- ENTE DES SCHRECKENS braucht keinen Override (fällt sauber unter den
  generischen `parseAutoConsequence`-Fallback: "Verliere 2 Stufen").
- Alle oben genannten wurden zusätzlich zu `DOOR_OTHER_AS_CURSE` hinzugefügt,
  damit sie beim Ziehen überhaupt über den Fluch-Mechanismus laufen (auch
  die `null`-Fälle - sie werden dann korrekt als Fluch mit Original-Text
  angezeigt, nur ohne automatische Spielzustandsänderung).
- Neue Tests in `tests/card-abilities.test.js`: Abdeckungs-Untergrenze für
  `DOOR_OTHER_AS_CURSE.size`, gezielte Verhaltenschecks für Rüstung
  verlieren/VERLIERE DEINE RASSE/VERLIERE DEINE KLASSE (0/1/2-Klassen-Fälle)/
  QUANTEN.
- `node -c server.js` und die volle Testsuite (`node tests/run.js`) laufen
  danach fehlerfrei (3/3 Testdateien grün).
- README-Zeile zu "Was automatisiert ist" aktualisiert (nicht mehr nur
  "Pathfinder-Flüche", sondern "Basis-Set und Erweiterungen").

**Verifikation nachgeholt (2026-09-10), aber anders als hier empfohlen.**
Der vorgeschlagene Playwright-Lauf wäre der schlechtere Test gewesen: er
hätte die fraglichen Karten nur zufällig gezogen und Playwright hätte erst
einen Browser-Download gebraucht. Stattdessen prüft
`tests/card-abilities.test.js` jetzt **deterministisch alle 46** Karten aus
`DOOR_OTHER_AS_CURSE`: Karte auf den Türstapel legen, `handleDrawDoor()`
aufrufen, und dann sicherstellen, dass sie als Fluch aufläuft
(`pendingConsequence.kind === 'curse'`), **nicht** auf der Hand landet, auf
dem Türablagestapel landet und nicht als offene Türkarte hängen bleibt. Dazu
eine Gegenprobe mit einer normalen Türkarte (muss weiterhin auf der Hand
landen), damit der Check nicht trivial durchläuft. Der Test wurde per
Mutation gegengeprüft: entfernt man `DOOR_OTHER_AS_CURSE.has(c.name)` aus
`handleDrawDoor()`, schlägt er fehl.

Zusätzlich neu: ein Check, dass **kein** Eintrag in `CONSEQUENCE_OVERRIDES`,
`TREASURE_POWER_OVERRIDES`, `COMBAT_POTION_OVERRIDES`,
`ITEM_CONDITIONAL_BONUS`, `DOOR_OTHER_AS_CURSE`, `POWER_GROUP_NAMES` oder
`GUARANTEED_FLEE_CARDS` ins Leere zeigt. Ein Tippfehler im Kartennamen wäre
sonst ein still wirkungsloser Eintrag - der wahrscheinlichste Fehler beim
Pflegen dieser Tabellen. Aktueller Stand: 0 Treffer, alle 170 Namen passen.

**Client-Rendering** braucht dafür keinen eigenen Browser-Test:
`renderConsequence()` in `public/client.js` rendert ausschließlich aus
`state.pendingConsequence` und verzweigt nirgends nach Kartenkategorie oder
-name. Eine `DOOR_OTHER_AS_CURSE`-Karte erzeugt exakt dasselbe
`pendingConsequence`-Objekt wie ein echter Fluch (`server.js`, in
`handleDrawDoor()`) und damit exakt dieselbe Anzeige.

Weiterhin offen: eine echte Sichtprüfung im Browser. In der Session vom
2026-09-10 war die Chrome-Erweiterung nicht verbunden ("Browser extension is
not connected"), der Server selbst lief und lieferte aus (HTTP 200 auf `/`
und `/client.js`).

## 4. Was weiterhin bewusst offen bleibt (nicht trivial nachrüstbar)

### 4.1 Fehlende Datenpunkte in `data/cards.json`
Diese Punkte sind **nicht** mit vertretbarem Aufwand lösbar, ohne die
Kartendaten selbst zu erweitern:
- Kein "Großer Gegenstand"-Flag → alle "wähle 1 großen/kleinen Gegenstand
  ab"-Karten bleiben manuelle Auswahl.
- Keine "Untot"-/Feuerimmunitäts-Kennzeichnung auf Monsterkarten → z. B.
  GHOULPEITSCHE (bedingte Item-Boni gegen Untote) bleibt unberechnet.
  (REDI-FLOW, das zweite Beispiel dieser Sorte, ist mit dem
  Pixels-&-Paper-Promo-Set entfallen.)
- Keine Machtgruppen-Zugehörigkeit auf Monsterkarten → die "+N gegen
  [Machtgruppe]"-Kampfmodifikatoren auf ca. 20 Pathfinder-`door_other`-Karten
  (TENGU, GHOULER FREITAG, STRIX, HOBBES GOBLIN, MILBCHEN, WELPWAMPI,
  CHARAU-KA, GOBLINHUND, BIENEMOTH, MOBOGO, LINDNORM, FLÜSTERTYRANN,
  SANDTEUFEL, WINTERHEXE, KUPFERKOCH, BOGGARD, HEMOGOBLIN, AKATA, DIV, GEB,
  TODESNETZ, BLÄHMAGIER, OGERGEIZLING) sind nicht automatisierbar.

### 4.2 Fehlender persistenter Fluch-/Status-Tracker
Der Server führt aktuell keinen laufenden "aktiver Fluch X wirkt noch"-
Zustand (z. B. für Wunschring-Aufhebung). Betrifft u. a.: BLUTSCHLEIER,
RAUSCHPOCKEN, TOURISTENFALLE, NARRENGOLD, MIESER SPIEGEL, STINKER, WINZIGE
HÄNDE, HUHN AUF DEINEM KOPF, GESCHLECHTSUMWANDLUNG (permanenter Malus).

### 4.3 Machtgruppen-Sonderkräfte (teilweise umgesetzt)
Umgesetzt sind inzwischen alle **passiven** Kräfte, also die, die ohne jede
Spieler-Interaktion auskommen:
- Alchemist: "Blei zu Gold" (Verkauf), "Tränkemeister" (doppelter Bonus bei
  "nur einmal einsetzbar"-Karten)
- Höllenritter: "Höllenritterrüstung" (+5 im Kampf) - seit 2026-09-10, siehe
  `hellknightArmorBonus()`. Der Bonus zählt nur, solange Rüstungs- **und**
  Kopf-Slot frei sind. Die Karte sagt zwar "du darfst keine andere Rüstung
  tragen", aber die Bonus-Bedingung ist die kürzere Variante: sie ist in
  jeder Reihenfolge korrekt (Ausrüstung zuerst oder Machtgruppe zuerst) und
  braucht keine Blockier-Logik im Anlegen-Pfad.
- Assassine der Roten Mantis: "Heimlichkeit" (+1 auf Weglaufen) - seit
  2026-09-10, in `handleAttemptFlee()`. Wird **nach** der Begrenzung des
  Client-Modifikators addiert, weil der Bonus serverseitig feststeht.

Weiterhin manuell, weil jede dieser Kräfte echte Spieler-Interaktion braucht
(Karten auswählen, Ziel wählen) - der `pendingCardAction`-Mechanismus
(`choice` / `targetPlayer` / `chooseCard`) wäre dafür jeweils das Werkzeug:
- Adlerritter "Standhaft bleiben" und Assassine "Auftragsmörder": bis zu 3
  Handkarten ablegen für je +2 im Kampf. **Die beiden einfachsten
  verbleibenden Fälle** - nur eine Kartenauswahl aus der eigenen Hand plus
  ein Kampfmodifikator, kein neuer Zustand. (Adlerritter zusätzlich −1 auf
  Weglaufen je abgelegter Karte, das braucht einen Zähler am Kampf.)
- Paktmagier "Eidolon" (Monster aus der Hand als Bonus = 2× `treasureCount`)
  und "Beschwören" (oberstes Monster vom Türablagestapel auf die Hand)
- Hexe "Hex" (Schlimme Dinge eines Monsters einem anderen Spieler als Fluch
  zufügen) und "Begleitung" (Fluch-Schutz beim Türeintreten)
- Kundschafter "Das Geheimnis aufdecken" (oberste 2 Türkarten ansehen, eine
  zurücklegen, eine ablegen). Die "Verliere den Pfad"-Ausweichoption für
  Kundschafter IST bereits automatisiert, siehe `VERLIERE DEN PFAD` in
  `CONSEQUENCE_OVERRIDES`.
- Nekromant "Reanimation" / "Geheimnisse der Untoten": **zusätzlich durch
  fehlende Daten blockiert**, nicht nur durch Aufwand - beide hängen am
  Begriff "untotes Monster", und eine Untot-Kennzeichnung gibt es in
  `data/cards.json` nicht (siehe 4.1). Eine frühere Fassung dieser Datei
  empfahl Nekromant als guten Einstieg; das ist irreführend.

### 4.4 Architektonisch aufwändigere Einzelfälle (brauchen mehr als einen
Override-Eintrag)
- **HUNGRIGER RUCKSACK**: braucht einen wiederkehrenden Rundenend-Hook (am
  Ende JEDES eigenen Zuges würfeln), nicht nur eine Einmal-Konsequenz beim
  Ziehen. Aktuelle Zug-Phasen-Logik hat keinen "Ende jedes Zuges"-Hook dieser
  Art.
- **KLEINER FEHLER**: müsste mitten in der Konsequenz-Auflösung einen NEUEN
  Kampf starten (wiederbelebtes Monster aus dem Ablagestapel). Der aktuelle
  `pendingConsequence` → `handleAckConsequence`-Fluss geht von genau einer
  Konsequenz ohne Folge-Kampf aus.
- **TEMPORÄRE ANMNESIE**: braucht einen neuen persistenten "Rasse/Klasse
  unterdrückt, bis X passiert"-Zustand pro Spieler.
- **EDELMUT**: braucht eine sequenzielle "jedem anderen Spieler einen
  Gegenstand geben, du wählst wem was"-UI (verteilt über mehrere
  Interaktionsschritte) statt einer einfachen Wahl/Zielauswahl.

### 4.5 69 verbleibende, wirklich manuelle `treasure_other`-Karten
Mit echtem Kartentext, aber ohne Override (zu individuell/erfordern freie
Verhandlung zwischen Spielern/Wertgrenzen-Suche im ganzen Ablagestapel).
Beispiele: DOPPELGÄNGER, KLEBERFLÄSCHCHEN, GEZINKTER WÜRFEL, MAGISCHE LAMPE,
WUNSCHRING, MIETLING, "...DER VERDAMMNIS"-Reihe, VERGIFTET, GESEGNET,
FLOHMARKT, EINHEITSGRÖSSE, ALUFOLIE, SONNENORCHIDEE-ELIXIER, RÜSTUNG DER
BELEIDIGUNG, DECEMVIRI-HELM, ZEPTER DER ZEITALTER, u. v. m. (28 weitere
Pathfinder-Karten haben in den Rohdaten gar keinen Text/keine Werte - siehe
README "Bekannte Einschränkungen"). Die vollständige, kommentierte Liste
lässt sich jederzeit reproduzieren mit einem kurzen Node-Skript, das
`ALL_CARDS` nach `category === 'treasure_other'` filtert und die bereits
über `isInstantLevelUpCard`/`isCombatPotionCard`/`TREASURE_POWER_OVERRIDES`
abgedeckten Namen ausschließt.

### 4.6 Kampf-Gleichstand / ALUFOLIE - BEHOBEN (2026-09-10)
`handleEvaluateCombat()` nutzte striktes `playerStrength > monsterStrength`,
ein Gleichstand ging also immer ans Monster, und ALUFOLIE ("Du gewinnst bei
einem Gleichstand im Kampf") war wirkungslos.

**Achtung, die frühere Fassung dieser Datei lag hier falsch**: sie empfahl
eine `equippedItems`-Prüfung auf "ALUFOLIE". Das wäre toter Code gewesen -
ALUFOLIE hat `category: "treasure_other"`, und `handleEquipItem()` lehnt
alles ab, was nicht `category === 'item'` ist. Die Karte kann also gar nicht
angelegt werden, sie liegt auf der Hand.

Umgesetzt ist deshalb: bei Gleichstand sucht `findTieBreaker()` die Karte auf
der Hand der kämpfenden **oder** der helfenden Person, verbraucht sie
(Ablagestapel) und der Kampf gilt als gewonnen. Bewusst **ohne** Rückfrage-UI
- ein Gleichstand ist ohne die Karte immer eine Niederlage, sie einzusetzen
ist also nie schlechter als sie liegen zu lassen, und damit gibt es nichts zu
entscheiden. Als Einwegkarte behandelt (der Kartentext nennt keine
Dauerwirkung), markiert mit einem `ponytail:`-Kommentar.

## 5. Empfohlene nächste Schritte für eine neue Session

> **Veraltet - die aktuelle Arbeitsliste steht in Abschnitt 7.7.** Dieser
> Abschnitt stammt aus der Runde vom 2026-09-10 und bleibt nur als
> Verlaufsprotokoll stehen. Punkt 1 (Sichtprüfung im Browser) ist weiterhin
> offen, die übrigen sind von Abschnitt 7 überholt.

Die drei Punkte, die hier vorher standen, sind erledigt (siehe 3., 4.3, 4.6).
Was sinnvollerweise als Nächstes kommt:

1. **Sichtprüfung im Browser**, sobald die Chrome-Erweiterung verbunden ist:
   Server mit `PORT=3111 node server.js` starten, Raum mit Bots aufmachen,
   und einmal mit eigenen Augen einen Fluch, einen Kampf-Gleichstand mit
   Alufolie und die Höllenritter-Kampfstärke ansehen. Die Logik ist getestet,
   die Optik nicht.
2. **Adlerritter "Standhaft bleiben" / Assassine "Auftragsmörder"** (4.3) -
   die beiden einfachsten verbleibenden Machtgruppen-Kräfte, weil sie nur
   eine Kartenauswahl aus der eigenen Hand brauchen und keinen neuen
   dauerhaften Zustand.
3. Alles Weitere in Abschnitt 4 ist bewusst offen und sollte nur angefasst
   werden, wenn der Nutzer es ausdrücklich will - 4.1 (fehlende Datenpunkte
   in `cards.json`) und 4.2 (Fluch-/Status-Tracker) sind echte
   Vorbedingungen, keine Fleißarbeit.

Bei jedem neuen Karten-Feature: zuerst `data/cards.json` nach dem exakten
Kartentext durchsuchen (`node -e "..."`-Einzeiler, siehe Muster oben), dann
Override + ggf. `applyPrimitiveAction`-Fall + Test ergänzen, dann
`node -c server.js` + `node tests/run.js`.

**Und: nicht ungeprüft aus dieser Datei heraus arbeiten.** Zwei Angaben hier
waren schlicht falsch (ALUFOLIE als anlegbarer Gegenstand, Nekromant als
guter Einstieg) - beides wäre beim Nachlesen von `data/cards.json` bzw.
`handleEquipItem()` in einer Minute aufgefallen. Erst die Karte und den
Code-Pfad nachschlagen, dann bauen.

## 6. Repo-Durchsicht 2026-09-10: gefundene und behobene Fehler

Alle vier waren vorher unbemerkt und sind jetzt behoben und durch Tests
abgesichert. Alle Fixes wurden per Mutation gegengeprüft (Fehler wieder
einbauen -> Test schlägt fehl).

### 6.1 Jeder Client konnte den Server abschießen (kritisch, behoben)
Ein Socket-Event **ohne Payload** beendete den kompletten Node-Prozess: die
Handler destrukturieren ihr Argument im Funktionskopf (`({ botId }) => ...`),
und das wirft bei `undefined`, bevor irgendeine Prüfung im Rumpf greift. Kein
Raum-Beitritt nötig, keine Authentifizierung. Da alle Räume nur im
Arbeitsspeicher liegen, war jedes laufende Spiel weg (der Container startet
per `restart: unless-stopped` zwar neu, aber ohne Spielstand). Betroffen
waren ~20 Handler, dazu Payloads mit falschem Typ (etwa eine Zahl, wo der
Handler eine Liste erwartet und darüber iteriert).

Behoben durch `onSafe()`: alle Handler werden nicht mehr über `socket.on()`
registriert, sondern zentral über diese eine Funktion (fehlender Payload ->
`{}`, fehlender Callback -> No-Op, Fehler beendet nur das eine Event). Damit
greift der Schutz automatisch für jeden künftig ergänzten Handler.
Regressionstest: `tests/malformed-input.test.js` feuert 765 fehlerhafte
Events ab und prüft, dass der Server danach noch normal antwortet.

### 6.2 XSS über den Spielernamen (kritisch, behoben)
`public/client.js` escapte den Namen an **einer** Stelle nicht: der
"X bittet dich um Hilfe im Kampf"-Kasten schrieb ihn roh per `innerHTML`.
Der Server kürzt Namen nur auf 20 Zeichen und filtert kein HTML - und 20
Zeichen genügen für ein selbstauslösendes Tag. Ausgeführt wurde das im
Browser der **angegriffenen** Person, und im `localStorage` liegt unter
`munchkin_session` der Wiederverbinden-Token: Skript liest Token, meldet sich
per `joinRoom` als diese Person an, übernimmt deren Platz. Alle anderen ~30
Einbaustellen benutzen korrekt `escapeHtml()`, diese eine war übersehen.

### 6.3 Tod verunreinigte beide Kartenstapel (behoben)
`applyDeathConsequence()` legte die **angelegten Gegenstände** pauschal auf
den **Tür**-Ablagestapel. Alle 58 anlegbaren Gegenstände sind aber
Schatzkarten (`handleEquipItem()` lässt nur `category: 'item'` zu, und die
gibt es ausschließlich als `type: 'treasure'`). Folge: Nach jedem Tod
wanderten Schatzkarten in den Türstapel, wurden beim Neumischen zu Türkarten
und landeten beim "Tür eintreten" wortlos auf der Hand - und fehlten dem
Schatzstapel dauerhaft. Behoben, indem die vorhandene Hilfsfunktion
`discardCard()` benutzt wird, die nach Kartentyp auf den richtigen Stapel
legt. Der Test prüft zusätzlich generell, dass auf jedem Ablagestapel nur
Karten des passenden Typs liegen.

### 6.4 Sitzungs-Token aus `Math.random()` (behoben)
`makeId()` erzeugte den Wiederverbinden-Token aus `Math.random()`. Dessen
interner Zustand lässt sich aus wenigen beobachteten Werten rekonstruieren -
und wer den Token kennt, übernimmt den Platz (siehe 6.2). Jetzt
`crypto.randomBytes(16)`.

### 6.5 Kleinigkeit: Aufräum-Timer (behoben)
Beim Löschen eines leeren Raums wurden `cleanupTimer`/`botTimer` nicht
gestoppt, der Raum blieb also bis zu 3 Stunden im Speicher. Harmlos, aber
jetzt mit aufgeräumt.

### 6.6 Bewusst nicht angefasst
- Die `setTimeout`-Rückrufe der Bot-Logik haben kein `try/catch`. Ein Fehler
  dort beendet weiterhin den Prozess. Anders als 6.1 ist das aber kein
  Angriffsweg (der Zustand kommt vom Server selbst), und ein pauschales
  `catch` würde echte Fehler verstecken. Wenn Abstürze im Betrieb auftauchen:
  hier zuerst schauen.
- Der Docker-Build kopiert nur `package.json`, keine `package-lock.json` -
  Builds sind damit nicht reproduzierbar.
- Raumcodes sind 4 Zeichen aus 32 (~1 Mio) und werden ebenfalls über
  `Math.random()` erzeugt. Beitreten ist aber nur in der Lobby möglich, und
  mehr als "in eine fremde Lobby stolpern" geht damit nicht.

## 7. Kartenauswertung: Dauerwirkungen (Runde vom 2026-09-11) - **nur Basis-Set**

**Das ist der Abschnitt, an dem eine neue Session weitermacht.** Was hier
entstand, deckt ausschließlich das **Basis-Set** ab. Die Muster und die
Mechanik darunter sind fertig und getestet; für die Erweiterungs-Sets fehlen
im Wesentlichen nur die Tabelleneinträge - mit einer großen Ausnahme, siehe
7.4.

### 7.1 Worum es geht

Bis zu dieser Runde wertete der Server nur Kartentexte aus, die jemand **aktiv
ausspielt** (`CONSEQUENCE_OVERRIDES`, `TREASURE_POWER_OVERRIDES`,
Kampf-Tränke) oder die als Konsequenz auflaufen. Kartentexte, die **ohne Zutun
dauerhaft gelten**, gab es im Code überhaupt nicht als Konzept.

Aufgefallen ist das am Bericht des Nutzers: "ich hatte Schutzsandalen im
Schuh-Slot, die sollten mich vor Flüchen schützen, ich habe den Fluch
trotzdem abbekommen". Die Karte sagt wörtlich: *"Flüche, die du ziehst,
nachdem du eine Tür eintrittst, haben keine Wirkung."* Der Server hat den Text
nie gelesen. Die anschließende Durchsicht des Basis-Sets fand knapp 40 weitere
Karten derselben Art - darunter 12 Monster mit "+N gegen Elfen/Zwerge/..."
und 6 Bossmonster, die niedrigstufige Charaktere gar nicht angreifen dürfen.

### 7.2 Der Mechanismus (fertig, gilt für alle Sets)

Neuer Abschnitt in `server.js` ab **Zeile ~1523**, Überschrift
*"Dauerwirkungen von Karten (Basis-Set)"*. Aufbau exakt wie die bereits
etablierten Override-Tabellen (siehe Abschnitt 1): kuratierte, per exaktem
Kartennamen indizierte Tabellen, jeder Eintrag mit dem Original-Kartentext im
Kommentar.

**Bewusst kuratiert statt Regex.** Das wurde beim Bauen geprüft und
verworfen: Die Formulierungen sind zu uneinheitlich (*"Elfen haben -4!"*
gegenüber *"+6 gegen Elfen"* - dasselbe Spielresultat, völlig anderer Text),
und ein Regex fängt Karten mit ein, bei denen dieselbe Formel eine **aktiv
auszuspielende** Kraft beschreibt. Konkreter Fehlalarm: Der ZAUBERER hat *"+1
Bonus auf Weglaufen"* - aber nur pro abgelegter Handkarte. Ein Textscan hätte
ihm einen permanenten Bonus gegeben.

| Tabelle | Zeile | Deckt ab |
|---|---|---|
| `CURSE_PROOF_ITEMS` | 1562 | Getragene Gegenstände, die gezogene Flüche neutralisieren |
| `MONSTER_REFUSES` | 1573 | "Greift niemanden mit Stufe X oder niedriger an" + ANWALT/Dieb |
| `MONSTER_TRAIT_BONUS` | 1596 | "+N gegen Elfen/Zwerge/Krieger/..." |
| `MONSTER_IGNORES_LEVEL` | 1625 | "Deine Stufe zählt nicht im Kampf" |
| `MONSTER_IGNORES_BONUSES` | 1628 | "Kämpfe nur mit deiner Charakterstufe" |
| `MONSTER_FORBIDS_HELP` | 1630 | "Niemand kann dir helfen" |
| `FLEE_ITEM_BONUS` | 1639 | Getragene Gegenstände mit festem Weglaufen-Bonus |
| `FLEE_MONSTER_MOD` | 1643 | "Du hast ±N auf Weglaufen" (Monsterkarte) |
| `FLEE_IMPOSSIBLE` | 1651 | "Denen kannst du nicht entkommen" |
| `FLEE_AUTOMATIC` | 1653 | "Automatische Flucht" |
| `FLEE_PENALTY` | 1655 | Stufenverlust **trotz** gelungener Flucht |
| `FLEE_TREASURE_ITEMS` | 1662 | Schatz beim erfolgreichen Entkommen |
| `MONSTER_EXTRA_LEVEL` | 1690 | "Zusätzliche Stufe, wenn du es besiegst" |
| `FIRE_ITEMS` | 1696 | Was als "Feuer oder Flammen" zählt |
| `CLASS_COMBAT_DISCARD` | 1723 | Klassenkräfte, die Handkarten kosten |
| `UNDEAD_MONSTERS` | 1732 | Was als "untot" gilt |
| `CLASS_FLEE_DISCARD` | 1739 | Dasselbe, aber auf den Weglaufwurf |
| `GUARANTEED_FLEE_MAX_MONSTER_LEVEL` | 2325 | Stufengrenze garantierter Fluchtkarten |

Dazu die auswertenden Funktionen: `monsterTraitBonusSum`,
`fleeModifierParts` (1666), `monsterVictoryExtras` (1698), `handLimit` (1796),
`classDiscardPower`. Alle hängen bereits in `combatTotals`,
`handleDrawDoor`, `handleAttemptFlee`, `resolveCombatWin` und
`handleEvaluateCombat` - **wer nur Tabelleneinträge ergänzt, muss an keinem
Handler etwas ändern.**

Zwei Nebenwirkungen, die man kennen muss:

- **`combatConditionalBonusFields` liefert jetzt fertige Summen**
  (`playerStrength`/`monsterStrength`) an den Client. Der hat sie früher
  selbst nachgerechnet und kannte die neuen Monsterboni nicht - zwei
  Rechenwege, die auseinanderlaufen. Neue Regeln, die die Kampfstärke
  verändern, brauchen daher **nichts** am Client; sie erscheinen automatisch.
- **Bereit-Check vor der Auswertung** (`combatSignature`, Zeile 1857): Der
  Bereit-Status aller Mitspielenden verfällt, sobald sich an den Kampfwerten
  etwas ändert. Die Signatur enthält die fertigen Summen - eine neue
  Tabellenzeile, die die Stärke beeinflusst, setzt den Bereit-Status also von
  allein korrekt zurück. Nicht kaputtmachen, indem man Werte an der Signatur
  vorbeirechnet.

### 7.3 Abdeckung je Set - die eigentliche offene Arbeit

Gemessen am 2026-09-11 durch Textscan über `data/cards.json`. "Offen" heißt:
Der Kartentext passt auf ein Muster, für das eine Tabelle existiert, aber die
Karte steht nicht drin.

| Muster | base | Unnatural Axe | Clerical Errors | Pathfinder |
|---|---|---|---|---|
| `MONSTER_TRAIT_BONUS` | 12 ✅ | **10 offen** | **13 offen** | 27 offen, s. 7.4/7.5 |
| `MONSTER_REFUSES` | 7 ✅ (+AMAZONE, s. 7.6) | **4 offen** | **1 offen** | s. 7.4 |
| `FLEE_MONSTER_MOD` | 4 ✅ | - | **1 offen** | s. 7.4 |
| `FLEE_ITEM_BONUS` | 2 ✅ | **1 offen** | - | s. 7.4 |
| `FLEE_PENALTY` / `FLEE_IMPOSSIBLE` / `FLEE_AUTOMATIC` | 5 ✅ | - | - | - |
| `MONSTER_IGNORES_*` / `FORBIDS_HELP` | 3 ✅ | - | - | - |
| `CURSE_PROOF_ITEMS` | 1 ✅ | - | - | - |

Die konkreten offenen Karten:

**Unnatural Axe** - `MONSTER_TRAIT_BONUS`: RIESENKAKERLAKE, JABBERWOCK,
JUDGE FREDD, M.T.-ANZUG, MONSTER, DAS DER SL SICH SELBST AUSGEDACHT HAT,
WEIHNACHTSMANN, FÜRCHTERLICHE CLOWNS, ROTZ-ELEMENTAR, TENTAKELDÄMON, DING MIT
EINEM ÜBERLANGEN NAMEN, DESSEN BILD NICHT AUF DIE KARTE PASST.
`MONSTER_REFUSES`: FEUERLÖSCHER, JABBERWOCK, PSYCHO-EICHHÖRNCHEN,
TENTAKELDÄMON. `FLEE_ITEM_BONUS`: BELAGERUNGSMASCHINE.

**Clerical Errors** - `MONSTER_TRAIT_BONUS`: STRICHMÄNNCHEN, FÜRST YAHOO,
AFFENBANDE, KAMIKAZE-KOBOLDE, DIE TROLLE VOM TOTEN MEER, REDNECK-BAUM,
ÜBERBÄR, GIFTEFEU KUDZU-FLIEGENFALLE, FEDERFEIND, SIEBENJÄHRIGER LICH, TANTE
PALADIN, MEDUSA, KALI. `MONSTER_REFUSES`: SIEBENJÄHRIGER LICH.
`FLEE_MONSTER_MOD`: DIE TROLLE VOM TOTEN MEER.

**Zwei Karten brauchen mehr als eine Zeile:** JABBERWOCK und FEDERFEIND haben
je **zwei** Trait-Boni ("+3 gegen Zwerge" *und* "+6 gegen Zwerge" bzw. "+5
gegen Priester" und "+3 gegen Zauberer"). `MONSTER_TRAIT_BONUS` kennt pro
Karte nur **einen** Eintrag `{races|classes, bonus}`. Für diese beiden entweder
den Wert auf eine Liste von Regeln erweitern oder - lazy - den jeweils
höheren Eintrag nehmen und das im Kommentar festhalten.

Ebenfalls prüfen: MONSTER, DAS DER SL SICH SELBST AUSGEDACHT HAT (+4 Zwerge,
**-3** Zauberer) und WEIHNACHTSMANN (**-5** Elfen) haben *negative* Boni. Die
Tabelle kann das (die Zahl wird nur addiert), aber `monsterTraitBonusSum`
wurde nur mit positiven Werten getestet.

**UNDEAD_MONSTERS** (1732) ist eine reine Einschätzung, keine Datenlage -
`cards.json` kennt kein Untot-Merkmal, im Basis-Set steht das Wort auf keiner
einzigen Monsterkarte. Aktuell eingetragen: MR. BONES, UNTOTES PFERD, KÖNIG
TUT, GRUFTIGE GEBRÜDER. **Vor dem Erweitern gegen die echten Karten
abgleichen** - davon hängt ab, wann der Priester "Vertreiben" (+3 pro Karte)
einsetzen darf. In Clerical Errors ist mindestens SIEBENJÄHRIGER LICH ein
Kandidat.

### 7.4 Blocker: Pathfinder hat überhaupt keine auswertbaren Kartendaten

> **ERLEDIGT durch Entfernen.** Das Pathfinder-Set wurde auf Wunsch komplett
> aus dem Spiel genommen: 144 Karten aus `data/cards.json`, die zugehörigen
> Bilder in `public/images/`, der Set-Schlüssel in `SET_KEYS`/`SET_LABELS` und
> den Voreinstellungen sowie 52 Tabelleneinträge, die auf entfernte Karten
> zeigten (`CONSEQUENCE_OVERRIDES`, `DOOR_OTHER_AS_CURSE`,
> `COMBAT_POTION_OVERRIDES`, `TREASURE_POWER_OVERRIDES`, `POWER_GROUP_NAMES`).
> Der folgende Abschnitt bleibt als Begründung stehen - er beschreibt, warum
> das Set nie spielbar war. Zurückholen ginge über die Git-Historie.

**Das war die größte offene Baustelle und keine Fleißarbeit.**

Alle **145** Pathfinder-Karten in `data/cards.json` haben nur die Kategorien
`door_other` (74) oder `treasure_other` (71). Gemessen:

- `level`: **0 von 145** Karten haben einen Wert
- `treasureCount`: **0 von 145**
- `bonus`: **0 von 145**
- `slotKind`: **0 von 145**

Gleichzeitig haben **37** dieser `door_other`-Karten ein `badstuff`-Feld, sind
also eindeutig **Monster** (TENGU, RUNENRIESE, GEB, LINDNORM, MOBOGO,
GOBLINSCHLANGE, ...). Zum Vergleich: Bei Unnatural Axe und Clerical Errors
haben *alle* 27 bzw. 27 Monster sowohl `level` als auch `treasureCount`.

**Praktische Folge:** Pathfinder ist in `settings.sets` standardmäßig **aktiv**
(siehe Raum-Initialisierung). Zieht jemand TENGU, behandelt `handleDrawDoor`
die Karte als harmlose "sonstige Türkarte" und legt sie auf die Hand. Es
entsteht kein Kampf, kein Schatz, keine Stufe - die 37 Pathfinder-Monster sind
im Spiel schlicht wirkungslose Sammelkarten. Das ist unabhängig von dieser
Runde schon länger so und fällt nur nicht auf, weil niemand die Karte
vermisst.

Ohne `level` **kann** keine Kampfregel greifen, egal wie viele Tabellenzeilen
man schreibt. Reihenfolge für eine neue Session:

1. Entscheiden, woher Stufe und Schatzanzahl kommen. Entweder die Datenquelle
   nachbessern, aus der `cards.json` erzeugt wurde, oder eine kuratierte
   Korrekturtabelle im Stil von `DOOR_OTHER_AS_CURSE` anlegen
   (`PATHFINDER_MONSTER_STATS: name -> {level, treasureCount}`, 37 Einträge).
2. Erst danach `MONSTER_TRAIT_BONUS` und die Weglaufen-Tabellen für
   Pathfinder füllen.
3. Alternative, falls das zu viel ist: Pathfinder in den Voreinstellungen
   **abwählen** und im Lobby-Hinweis kennzeichnen. Ehrlicher als 37 kaputte
   Karten im Stapel.

Nebenbei fehlen Pathfinder auch Rassen-, Klassen- und Gegenstandskarten als
solche - `race`/`class`/`item` kommen im Set nicht vor. Ob das an den echten
Karten liegt oder ebenfalls an den Daten, wurde nicht geprüft.

### 7.5 `MONSTER_TRAIT_BONUS` kennt noch keine Machtgruppen

Pathfinder nutzt statt Rassen/Klassen die **Machtgruppen** (`POWER_GROUP_NAMES`,
8 Stück: Kundschafter, Nekromant, Hexe, Höllenritter, Adlerritter, Paktmagier,
Alchemist, Assassine der Roten Mantis). Der Textscan findet **27 Boni gegen
Machtgruppen** auf Pathfinder-Karten, zum Beispiel:

```
TENGU        +3 gegen Kundschafter
GEB          -4 gegen Adlerritter
MOBOGO       +4 gegen Paktmagier, -4 gegen Hexen
HEMOGOBLIN   -3 gegen Kundschafter, +4 gegen Assassinen
```

`MONSTER_TRAIT_BONUS` unterstützt bisher nur `races` und `classes`. Die
Erweiterung ist klein und lokal: ein drittes Feld `powerGroups` im
Tabelleneintrag und eine zusätzliche `.some()`-Bedingung in
`monsterTraitBonusSum` (Zeile ~1612) - `hasPowerGroup` existiert bereits.
Beachten: Die Machtgruppen-Adjektive im Kartentext stehen im Plural
("Kundschafter", "Nekromanten", "Hexen", "Assassinen") und weichen von den
Kartennamen ab, genau wie `RACE_ADJECTIVE_DE`/`CLASS_ADJECTIVE_DE` das für
Rassen/Klassen abbilden. **Sinnvoll erst nach 7.4**, weil ohne Monsterstufe
kein Kampf stattfindet, in dem der Bonus zählen könnte.

Ebenfalls offen, aber kleiner: `ADLERRITTER` hat mit *"Im Kampf darfst du bis
zu 3 Karten aus deiner Hand ablegen"* exakt die Form von
`CLASS_COMBAT_DISCARD` (1723). Da `classDiscardPower` derzeit nur über
`hasClass` sucht, bräuchte es dort einen Zweig für Machtgruppen.

### 7.6 Bewusst manuell geblieben (nicht nachtragen ohne Anlass)

Alles, was eine **echte Entscheidung** verlangt oder auf Daten beruht, die
dieser Server nicht führt. Für all das gibt es weiterhin das manuelle
Bonus-Zahlenfeld im Kampf und das Ablege-Dropdown:

- **DIEB "In den Rücken fallen"** (-2 für eine *andere* Person). Kräfte gegen
  Mitspielende sind im ganzen Projekt manuell, siehe Kommentar am Dateianfang.
- **ZWERG**: "beliebig viele Große Gegenstände" - es gibt kein Groß-Flag in
  den Daten, also gibt es auch keine Beschränkung, die die Ausnahme bräuchte.
- **AMAZONE** ("greift keine Spielerinnen an") - Geschlecht wird nicht
  erfasst, siehe 4.1.
- **LAUFENDE NASE (Bestechung), MÖCHTEGERN-VAMPIR, PIT BULL, ANWALT** (die
  Dieb-Tauschoption): Wahlmöglichkeiten, keine Dauerwirkungen.
- **ZAUBERER "Flugzauber"** ist umgesetzt, weicht aber bewusst vom Text ab:
  Die Karte sagt "*nachdem* du deinen Weglaufwurf gemacht hast", der Server
  bietet den Abwurf **vor** dem Wurf an. Grund: `handleAttemptFlee` löst den
  Wurf sofort auf, eine Zwischenphase "gewürfelt, aber noch nicht
  entschieden" gibt es nirgends im Projekt. Wer das wortgetreu will, baut
  genau diese Phase - dann lohnt sich auch der HALBLING-Wiederholungswurf, der
  dieselbe Phase braucht.
- **PIKOTZU** und **GROSSES WUTENDES HUHN** stehen bewusst *nicht* in
  `MONSTER_EXTRA_LEVEL`, sondern als Sonderfälle in `monsterVictoryExtras`
  (1698) - sie haben Bedingungen ("ohne Hilfe und Boni", "mit Feuer"). Ein
  Textscan meldet sie als "offen"; sie sind es nicht.

### 7.6b Inzwischen doch umgesetzt (HALBLING & Co.)

Diese vier standen in 7.6 als "bewusst manuell" und sind es nicht mehr - wer
hier etwas ändert, findet die Regel jeweils an der genannten Stelle:

- **HALBLING, doppelter Verkaufspreis**: `handleSellItems` verdoppelt den
  teuersten der verkauften Gegenstände, `player.halblingSaleUsed` wird in
  `endTurn` zurückgesetzt.
- **HALBLING, Weglaufwurf wiederholen**: die in 7.6 vermisste Phase
  "gewürfelt, aber noch nicht entschieden" gibt es jetzt -
  `combat.fleeRerollOffer` plus `handleFleeReroll`. Der Zauberer-Flugzauber
  könnte darauf aufsetzen, wenn er wortgetreu werden soll.
- **GEWALTIGER BAZILLUS** ("Halblinge können sie einstampfen"):
  `MONSTER_AUTO_KILL_BY_RACE` - das Monster zählt in `combatTotals` mit
  Stärke 0, Stufe und Schatz kommen aus der normalen Auswertung.
- **BEKIFFTER GOLEM** ("kämpfen oder vorbeigehen", Halblinge müssen
  kämpfen): `MONSTER_PASS_OPTION` in `handleDrawDoor`, umgesetzt als
  `openCardChoice` mit den Aktionen `startRevealedCombat`/`passMonster`.
  Bots entscheiden selbst (Staerkevergleich), sonst würde die Partie auf
  einen Wahldialog warten.

### 7.6c Nach dem Basis-Set-Audit nachgezogen

- **Monster-Verstärker-Beute** (BABY, INTELLIGENT, WUTEND, GIGANTISCH,
  URALT): `combat.treasureDelta`, ausgezahlt in `resolveCombatWin`, Untergrenze
  1 wegen BABY ("mindestens 1").
- **ZAUBERER "Verzauberung"**: `enchantInfo` / `handleEnchantMonster` - ganze
  Hand (min. 3 Karten) gegen Monster + Schatz, keine Stufe. Nutzt denselben
  Pfad wie das VERZAUBERARMBAND (`endCombatNoLevel` + `leavesTreasure`).
- **UNSICHTSBARKEITSTRANK** (Kartenname mit S!): `POST_FLEE_ESCAPE_CARDS` +
  `handleFleeEscape`. Wirkt NACH dem verpatzten Wurf und nutzt dafür das
  Entscheidungsfenster, das für den Halbling-Wiederholungswurf entstand
  (`combat.fleeRerollOffer`, `combat.canReroll`). Die `GUARANTEED_FLEE_CARDS`
  wirken dagegen weiter VOR dem Wurf.
- **MAHLZEIT!**: `DOOR_COMBAT_CARDS` - Türkarten mit eigener Kampfwirkung,
  die keine Monster-Verstärker sind. Feste 2 Schätze über `fixedTreasures`.
- **DOPPELGÄNGER**: `COMBAT_POTION_OVERRIDES` + Aktion `doubleStrength` ->
  `combat.doubleActor`, verdoppelt in `combatTotals` die Munchkin-Summe; nur
  ohne Helfer:in spielbar.

Weiter bewusst offen (jeweils ein eigener Mechanismus, kein Tabelleneintrag):
WUNSCHRING und FLUCH! EINKOMMENSSTEUER (brauchen einen Tracker für *aktive*
Flüche), ILLUSION (Monster im Kampf gegen ein Handmonster tauschen),
KLEBERFLÄSCHCHEN, GEZINKTER WÜRFEL, MAGISCHE LAMPE, KNIESCHÜTZER DER
VERLOCKUNG, ÜBERFALLTRANK, SCHUMMELN!, HILF MIR, GÖTTLICHE INTERVENTION,
KUMPEL, WANDERNDES MONSTER, PRIESTER "Auferstehung", DIEB (beide Kräfte
richten sich gegen Mitspielende, siehe 7.6).

### 7.7 Nächste Schritte, in dieser Reihenfolge

1. **Unnatural Axe und Clerical Errors nachtragen** (~30 Tabellenzeilen, keine
   Logikänderung). Das ist die gesamte Arbeit für diese beiden Sets. Die
   Kartenlisten in 7.3 sind vollständig; Kartentexte mit
   `node -e` aus `data/cards.json` holen und jeweils als Kommentar mitnehmen,
   so wie es die bestehenden Einträge tun.
2. **`UNDEAD_MONSTERS` gegen die echten Karten prüfen** und für die beiden
   Sets erweitern.
3. **JABBERWOCK/FEDERFEIND**: entscheiden, ob `MONSTER_TRAIT_BONUS` mehrere
   Regeln pro Karte können soll.
4. ~~**Pathfinder-Datenlage klären** (7.4)~~ - erledigt, das Set ist entfernt.
5. ~~**Machtgruppen in `MONSTER_TRAIT_BONUS`** (7.5)~~ - entfällt mit dem Set.
   `POWER_GROUP_NAMES` ist leer, die Maschinerie drumherum steht aber noch.

### 7.8 Verifikation

`npm test` - fünf Dateien, laufen einzeln in eigenen Kindprozessen.

- **`tests/card-passives.test.js`** ist in dieser Runde neu und der relevante
  für alles aus Abschnitt 7. Er prüft **Verhalten**, nicht Tabelleninhalt:
  jeder Fall baut ein echtes Raum-Objekt und ruft den vollständigen Handler.
  Eine Tabelle, die nirgends ausgewertet wird, bestünde einen reinen
  Tabellentest - dieser Test nicht.
- **`tests/card-abilities.test.js`** enthält einen
  Namens-Abdeckungscheck (`nameSources`): Jeder Schlüssel jeder kuratierten
  Tabelle muss zu einer Karte in `cards.json` passen. **Neue Tabellen dort
  eintragen**, sonst fällt ein Tippfehler im Kartennamen nie auf - der Eintrag
  wäre einfach still wirkungslos.
- **`tests/basic-game-flow.test.js`** spielt mit echten Sockets gegen Bots.
  Er hat beim Bereit-Check korrekt zugeschlagen: Der Testclient bestätigte
  nicht, ein Kampf unter Bot-Führung stand für immer. Wer Spielfluss ändert,
  schaut hier zuerst.

Das Scan-Skript, das die Zahlen in 7.3 erzeugt hat, liegt bewusst nicht im
Repo (Einmalwerkzeug). Kurzform zum Nachbauen: `data/cards.json` laden,
`server.js` requiren, Kartentexte normalisieren
(`\n`, `<br>`, `<i>` entfernen), pro Muster-Regex über alle Karten laufen und
gegen die jeweilige Tabelle prüfen.

## 8. Fehlende Basis-Set-Kartenkräfte (Runde vom 2026-09-12) - **abgeschlossen**

Diese Runde begann mit einem Audit aller 147 Basis-Set-Karten gegen den Code.
Ergebnis: 12 Karten waren **vollständig wirkungslos** (kein Ausspielweg,
nur "Ablegen"), 2 Klassenkräfte fehlten ganz, mehrere funktionierende Karten
hatten stillschweigend fallengelassene Teilwirkungen, und es gab 2 echte
Regelabweichungen.

**Alle dreizehn Aufgaben sind erledigt und geprüft** (Stand 2026-09-13).

### 8.1 Die maßgeblichen Dokumente

Lies sie in dieser Reihenfolge. Sie sind vollständig, dieser Abschnitt ist nur
die Landkarte:

| Datei | Inhalt |
|---|---|
| `docs/superpowers/specs/2026-09-12-basis-set-kartenkraefte-design.md` | Das Design. Die **bindende** Instanz bei Widersprüchen. |
| `docs/superpowers/plans/2026-09-12-basis-set-kartenkraefte.md` | Der Umsetzungsplan, 13 Aufgaben mit fertigem Code und Tests. |
| `.superpowers/sdd/2026-09-12-basis-set-kartenkraefte/progress.md` | Das Protokoll: was fertig ist, jede getroffene Entscheidung, jede zurückgestellte Kleinigkeit. **Nicht löschen, solange Tasks offen sind.** |

Im selben Verzeichnis liegen je Aufgabe ein `task-N-brief.md` (die Anforderung)
und ein `task-N-report.md` (was die umsetzende Session gemacht hat).

### 8.2 Was fertig ist (Tasks 1-12)

23 Commits, `10641fc..53ed4a2`. `npm test` = **17/17 grün**, Server startet
sauber. Jede Aufgabe wurde nach der Umsetzung von einer zweiten, unabhängigen
Instanz geprüft; fünf Prüfungen fanden echte Fehler, die in einer Fix-Runde
behoben und erneut geprüft wurden.

**Nachgeprüft am 2026-09-13:** die Fix-Runde von Task 10 (`b2db73a`) und der
Task-11-Diff (`db17bf1`) sind gegengeprüft und in Ordnung. Bei Task 10 stimmen
Freischaltung (`hatGegenstandAbGold`) und Bezahlung (`bribeMonster`) überein,
PIT BULL bleibt korrekt equipped-only. Bei Task 11 liegt `traitImmun` an der
richtigen Stelle (`monsterTraitBonusSum`, also innerhalb von `combatTotals`
und damit in `combatSignature`), und `VERSTÜMMLE DIE LEICHEN` fällt sauber auf
den `null`-Zweig von `handleUseCardPower` zurück, wenn noch kein Kampf war.
Ein Nachtrag zur Auslassungsliste in `server.js` bei `traitImmun`: **KRAKZILLA**
("greift Stufe 4 oder niedriger nicht an, außer Elfen") ist eine vierte Stelle,
an der eine Rasse ein Nachteil ist - sie fehlt in der Aufzählung dort.

| # | Was | Commits |
|---|---|---|
| 1 | Kartentabellen nach `src/cards/*.js` ausgelagert (verhaltensneutral, `server.js` von 3340 auf 2860 Zeilen) | `a4c9f7d`, `44a2cd9`, `11be45e` |
| 2 | **Große Gegenstände**: kuratierte 8er-Liste, Traglimit 1 für Nicht-Zwerge, schaltet GALLERT-OKTAEDER, VERLIERE 1 GROSSEN GEGENSTAND, GRÜNSCHLEIM und die Zwergen-Rassenkraft frei | `e72fd07`, `7542a21` |
| 3 | **Aktions-Warteschlange**: Karten, die mehrere Spieler nacheinander handeln lassen, plus der generische Bot-Auflöser | `23f9efe`, `5a230da` |
| 4 | **Reaktionsfenster**: GEZINKTER WÜRFEL, KLEBERFLÄSCHCHEN, MAGISCHE LAMPE | `91b6add` |
| 5 | **Siegregel**: Verkaufen gewinnt nicht mehr, GOTTLICHE INTERVENTION wird die gedruckte Ausnahme | `365ef1d` |
| 6 | **Kartenanhänge**: SCHUMMELN!, KNIESCHÜTZER DER VERLOCKUNG | `ebb76e9`, `35f027b` |
| 7 | **Fluch-Tracker**: MIESER SPIEGEL, GESCHLECHTSUMWANDLUNG, HUHN AUF DEINEM KOPF, WINZIGE HÄNDE, WUNSCHRING | `1279897` |
| 8 | **Kampfreaktionen**: KUMPEL, WANDERNDES MONSTER, ILLUSION, HILF MIR, ÜBERFALLTRANK | `4b0306d`, `b66feb1` |
| 9 | **Schlimme Dinge mit Fremdbeteiligung**: HIPPOGREIF, ANWALT, LEPRACHAUN, NETZ-TROLL, VERSICHERUNGSVERTRETER, SCHNECKEN AUF SPEED, FLUCH! EINKOMMENSSTEUER | `7bc2d70`, `0acca45` |
| 10 | **Kampf-Alternativen**: MÖCHTEGERN-VAMPIR, LAUFENDE NASE, PIT BULL, ZUNGENDÄMON | `d1602f0`, `b2db73a` |
| 11 | **Kleinkram**: SUPER MUNCHKIN / HALB-BLUT ohne Nachteile, VERSTÜMMLE DIE LEICHEN nur nach einem Kampf | `db17bf1` |
| 12 | **Klassenkräfte**: DIEB (In den Rücken fallen, Diebstahl), PRIESTER (Auferstehung) | `53ed4a2` |

Dazu ein Einschub auf Zuruf: die **Kartengroßansicht zeigt jetzt die Werte**
(Stufe/Schätze bei Monstern, Slot/Hände/Bonus/Gold bei Gegenständen) und
kennzeichnet Große Gegenstände (`80fcdf0`). Das `big`-Flag hängt dafür am
Kartenobjekt selbst (`server.js`, beim Einlesen von `ALL_CARDS`), nicht als
fünfte handgepflegte Namensliste im Client - siehe die Driftquelle in 8.5.

### 8.3 Was noch offen ist (Task 13)

Der Plan enthält für die Aufgabe den vollständigen Ablauf.

- **Task 13 - Abnahme.** Volle Testsuite, Abdeckung neu messen, Durchlauf im
  Browser, README-Abschnitt "Was automatisiert ist" nachziehen.

### 8.4 Fünf Dinge, die eine neue Session vorher wissen muss

Das sind Entscheidungen und Fallen aus den ersten zehn Aufgaben. Wer sie nicht
kennt, verliert Zeit oder baut Fehler ein.

1. **Der Plan enthält zwei Fehler im Test-Gerüst.** Jedes `makeRoom` im Plan
   benutzt `log: []`. Das echte Feld heißt `logs: []` (`server.js:172`), und
   `log()` schreibt dorthin - mit `log` stürzt der Server beim ersten
   Logeintrag ab. Außerdem **müssen** Tests `clearTimeout(room.cleanupTimer)`
   (und `botTimer`) aufrufen, sonst hängt der Testlauf: `touchRoom` setzt einen
   3-Stunden-Timer, der Node am Leben hält. Vorbild ist der `done(room)`-Helfer
   in `tests/card-reactions.test.js`.

2. **Die Abdeckungs-Schranke in `tests/auto-consequence.test.js` ist bereits
   erledigt - nicht noch einmal anfassen.** Sie stand auf `manual >= 20`, Task 9
   automatisierte sieben Karten innerhalb des Scans (27 -> 20), und die Schranke
   steht jetzt korrekt auf `>= 15` (Zeile 123). Das war die **einzige** erlaubte
   Änderung an einer bestehenden Testdatei im ganzen Plan, und sie ist
   verbraucht. Wird ab jetzt irgendein Test angepasst, um grün zu werden, ist ein
   echter Fehler versteckt worden.

   Zur Warnung, weil der Plan an dieser Stelle zweimal falsch lag: der Plan sagte
   „auf 12 senken", ich korrigierte das auf „19, also Schranke 15", und richtig
   waren am Ende 20 - GALLERT-OKTAEDER war schon in Task 2 automatisiert worden
   und zählte nicht mit. Der Scan iteriert **nur** über die Kategorien `monster`
   und `curse`; `door_other`-Karten tauchen dort gar nicht auf. Wer die Zahl
   erneut verschieben will, misst sie vorher, statt sie zu rechnen.

3. **Die Zeilennummern im Plan sind veraltet.** Task 1 hat `server.js`
   umgebaut, Tasks 2-10 haben es erweitert. Immer über den Funktionsnamen
   suchen, nie über die Nummer im Plan.

4. **Alles, was die Kampfstärke verändert, muss durch `combatTotals` laufen.**
   `combatSignature` bildet `playerStrength`/`monsterStrength` daraus ab und
   setzt damit den Bereit-Status der Mitspielenden zurück. Wer daneben rechnet,
   lässt den Bereit-Status veralten, während sich die Zahlen ändern - das fällt
   in keinem Unittest auf und zeigt sich erst als desynchronisierter Tisch.
   Nach jeder Änderung an einem laufenden Kampf `refreshCombatReady(room)`
   aufrufen.

5. **Jede neue Interaktion braucht einen Bot-Pfad.** Ein Bot, der auf einen
   Dialog warten muss, lässt die Partie stehen. Task 3 hat dafür den
   generischen Auflöser gebaut (`resolveBotCardAction`); `combatReadyRequired`
   schließt Bots ohnehin aus. Getrennte Spieler werden übersprungen, nie
   abgewartet.

### 8.5 Bewusst zurückgestellte Kleinigkeiten

Keine davon blockiert etwas. Sie stehen hier, damit sie nicht als neue
Entdeckungen noch einmal Zeit kosten.

- **MAGISCHE LAMPE** war ursprünglich rein an `c.fleeRerollOffer` gebunden.
  Inzwischen vollständig umgesetzt: im eigenen Zug zu jedem Zeitpunkt im Kampf
  (vor dem Fliehen, beim Fliehen oder nach verpatztem Wurf) über das Kampf-Panel
  sowie direkt an der Handkarte einsetzbar; bei mehreren Monstern mit freier
  Monster-Auswahl.
- **Die Warteschlangen-Reihenfolge ist kartenspezifisch.** Jede Karte sagt
  etwas anderes ("beginnend mit dem Spieler **vor** dir" gegen "**nach** dir",
  nur die Nachbarn, nur die Höchststufigen, alle anderen), und eine verdrehte
  Reihenfolge löst diese Karte still für immer falsch auf - kein Test merkt das.
  `playerQueueFrom(room, player, mode)` hat dafür fünf Modi. Wer eine Karte
  ergänzt: den Modus aus dem echten Kartentext ableiten, nicht raten.
- **`curseIncomeTax`** wählt für die ziehende Person automatisch ihren
  *teuersten* Gegenstand als "Gegenstand deiner Wahl". Ein eigennütziger Mensch
  gäbe den billigsten her, um die Latte für alle anderen niedrig zu halten - die
  Richtung ist also fragwürdig, aber offengelegt.
- **`handleAckConsequence`** prüft `room.pendingCardAction` nicht, die ziehende
  Person könnte also theoretisch "Fertig" drücken, bevor die anderen ihre
  Warteschlange abgearbeitet haben. Clientseitig durch das `myTurn`-Gating
  entschärft, daher kosmetisch.
- **GOTTLICHE INTERVENTION** muss laut Karte sofort beim Erhalten gespielt
  werden; umgesetzt ist sie als freiwillige Sonderkraft.
- **`combatConditionalBonusFields`** ist nicht durch
  `curseSuppressesItemBonuses` gefiltert. Unter MIESER SPIEGEL könnte dort ein
  bedingter Bonus veröffentlicht werden, den `combatTotals` gar nicht zählt.
  Aktuell harmlos, weil `public/client.js` diese beiden Felder nirgends
  anzeigt - relevant erst, wenn sie in die Oberfläche wandern.
- **`public/client.js` spiegelt Kartennamen in fest verdrahteten Sets**
  (`DOOR_POWER_NAMES`, `TREASURE_POWER_NAMES`, `GUARANTEED_FLEE_NAMES`,
  `TRAIT_CAP_CARD_NAMES`). Die müssen von Hand mit den Servertabellen
  synchron gehalten werden. Altes Muster, nicht in dieser Runde entstanden,
  aber eine dauerhafte Driftquelle.
- **ILLUSION** setzt `monsterModifier` auf 0. Exakt bei einem Monster im
  Kampf; bei mehreren würde es auch fremde Boni löschen. `startCombat` nimmt
  seit jeher ein Array, zwei Monster sind also ohne jede neue Karte
  erreichbar. Eine saubere Lösung braucht einen Modifikator **pro Monster**.

### 8.6 Weiterhin nicht umsetzbar

Unverändert gegenüber der Design-Spec, Abschnitt 5:

- **AMAZONE** - Geschlecht wird nicht erfasst und soll es nicht.
- **ANWALT, Dieb-Tauschoption** - toter Code: `MONSTER_REFUSES` verhindert den
  Angriff auf Diebe schon, die Alternative tritt nie ein.
- **SCHATZHORT!, verdecktes Ziehen** - es gibt kein Konzept "offen/verdeckt"
  für Schätze.
- **34 Basis-Karten ohne `text` in `data/cards.json`** - eigenständiges
  Datenproblem. Klassen-/Rassen-/Geschlechtsbeschränkungen auf Gegenständen
  (VERDUNKELUNGSUMHANG nur Dieb, SPITZER HUT DER MACHT nur Zauberer, ...)
  fehlen dadurch ebenfalls. Für SCHUMMELN! nicht nötig, seit es das
  Gross-Flag gibt.

**`BIG_ITEMS` (`src/cards/bigitems.js`) ist eine kuratierte, vom Nutzer
bestätigte Liste von acht Karten**, keine aus `data/cards.json` abgeleitete
Eigenschaft - die Rohdaten kennen kein Gross-Flag. Wer eine Karte ergänzt oder
streicht, ändert damit Traglimits, GALLERT-OKTAEDER, GRÜNSCHLEIM, VERLIERE 1
GROSSEN/KLEINEN GEGENSTAND und die Zwergen-Rassenkraft auf einmal. Nicht ohne
Rückfrage anfassen.

### 8.7 Wie man weitermacht

Der Ablauf der ersten zehn Aufgaben war: je Aufgabe eine frische Instanz mit
dem `task-N-brief.md` beauftragen, danach eine **zweite, unabhängige** Instanz
denselben Diff prüfen lassen, Fehler in einer Fix-Runde beheben, erneut prüfen,
erst dann weiter.

Das hat sich gelohnt. Fünf der zehn Aufgaben hatten echte Fehler, die so
gefunden wurden - und **jeder einzelne davon war grün getestet**, bevor der
Reviewer ihn fand:

- ein Fluch, der den SCHUMMELN!-Anhang nicht löste und die Person damit dauerhaft
  daran hinderte, je wieder eine SCHUMMELN!-Karte zu spielen,
- eine Zielauswahl in der Warteschlange, die einen leeren Resolver baute und
  deshalb wirkungslos blieb - ohne Fehler, ohne Logzeile,
- KUMPEL, das dieselbe Karte zweimal auf den Ablagestapel gelegt und damit den
  Stapel dauerhaft verfälscht hätte,
- ÜBERFALLTRANK, das die ursprüngliche Person über zwei Kampfenden hinweg in die
  falsche Phase schickte,
- und zwei Warteschlangen, die sich bei einem verlorenen Kampf mit mehreren
  Monstern gegenseitig verschluckten, während das Log die verschluckte Wirkung
  weiterhin meldete.

Daraus die Lehre für die restlichen Aufgaben: **grüne Tests heißen hier wenig.**
Die Fehler dieser Runde saßen durchweg in Pfaden, die kein Test beschritt -
mehrere Monster gleichzeitig, ein Bot an der Reihe, eine Karte in der Hand statt
angelegt. Wer prüft, sollte gezielt nach genau solchen Kombinationen suchen.

Wer den Prozess nachbauen will: das Skill `superpowers:subagent-driven-development`
beschreibt ihn, und `progress.md` ist der Wiederaufsetzpunkt - Aufgaben mit
einer `complete`-Zeile sind fertig und dürfen nicht erneut vergeben werden.

Nach Task 13 gehört noch eine Gesamtdurchsicht des ganzen Zweigs dazu; die ist
in dieser Runde noch nicht gelaufen.

---

## 9. Clerical Errors (Runde vom 2026-09-13) - **abgeschlossen**

Das zweite Set ist auf dem Stand des Basis-Sets. Plan und Audit:
`docs/superpowers/plans/2026-09-13-clerical-errors-kartenkraefte.md`.

Ausgangslage laut Audit: von 102 Karten hatten 40 keinen Weg durch die Engine.
Heute meldet `node tools/coverage-scan.js clericalerrors` noch fünf Zeilen -
alle bewusst manuell, siehe 9.3.

### 9.1 Was dazugekommen ist

| Bereich | Inhalt |
|---|---|
| Rassen/Klassen | `TRAIT_DOOR_CARDS` - ORK, GNOM und BARDE stehen in den Rohdaten als `door_other` und waren deshalb **gar nicht spielbar**. Dazu Ork-Extrastufe, Gnom-G/N-Bonus, Gnom-als-Halbling, Gnom-Autoflucht vor „Nase"-Monstern, Bardenglück. |
| Monsterboni | `MONSTER_TRAIT_BONUS` kann jetzt negative Boni, mehrere Boni je Karte (Array) und Bedingungen jenseits von Rasse/Klasse (`wennErfuellt`). 16 neue Zeilen. |
| Geschlecht | `player.gender` (`'m'`/`'w'`/`null`). Alle starten männlich, **niemand wählt etwas aus** - so mit dem Nutzer abgesprochen. Geändert wird es nur durch GESCHLECHTSUMWANDLUNG und STRICHMÄNNCHEN. `istGeschlecht()` ist die einzige Abfragestelle; die FREUD'SCHEN SLIPPER heben dort alle Strafen auf. |
| Kartenanhänge | `room.itemAttachments` (Gegenstands-Id → Karten-Ids). Am **Raum**, nicht an der Person: „Diese Karte bleibt beim Gegenstand, egal ob er verloren, gestohlen oder abgelegt wird". Trägt VERGIFTET, GESEGNET und NÜTZLICHE GRIFFE. Letztere machen aus einem Großen Gegenstand einen kleinen - dafür gibt es neben `isBigItem(card)` jetzt `istGrosserGegenstand(room, id)`. |
| Verstärker im Kampf | `combat.enhancerIds`. Zwei Klauseln wirken über den Moment des Ausspielens hinaus: „… aus der Hölle." (+5 gegen Priester) und UNTOT (Monster gilt als untot). `combatHasUndead(room)` beantwortet „untot?" an einer Stelle für Priester-„Vertreiben" und die GHOULPEITSCHE. |
| Fluch-Abwehr | `fluchZiel(room, ziel, karte)` - **beide** Fluchwege (gezogen und von jemandem gespielt) laufen hindurch. PRÄCHTIGER HUT wirft den Fluch per Würfelrunde weiter, DAS MANCHMAL VERLÄSSLICHE AMULETT blockt ihn bei 4-6. |
| Monsterstufen | `combat.levelOverrides` - TYPOGRAFISCHER FEHLER (Stufe 1) und DER GANZ NORMALE HASE (bei einer 6 Stufe 15). |
| Kartensperre | `room.kartenSperren` für EINSTWEILIGE VERFÜGUNG, geleert beim Zugwechsel. Die Karte selbst ist derzeit deaktiviert (siehe unten), der Mechanismus bleibt aber stehen. |

### 9.2 Neue Primitive in `applyPrimitiveAction`

`queuedDiscardOwn` (N eigene Karten/Gegenstände selbst aussuchen),
`queuedDiscardEachOther`, `levelUpLowerPlayersAndLose`, `setGender`,
`packratteGeschenk` / `nimmEinenVonZweien`, `dungeonCasino`, `schatzTauschen`,
`kartenSperre` (Ziel-Aktion), `enteDerVielenSachen` sowie im Kampf
`treatMonsterAsLevel1`, `tripleItemBonus`, `forceSelfAsHelper`,
`schatzUmtauschAnmelden`.

`enteDerVielenSachen` (ENTE DER VIELEN SACHEN) ist die einzige Karte, deren
sieben Schritte „in dieser Reihenfolge" ablaufen müssen: sie legt eine
`openQueuedCardAction`-Warteschlange auf dieselbe Person und schiebt pro Eintrag
einen Schritt ab. Schritte ohne Entscheidung (zufällige Karte vom Nachbarn,
Ständchen, Stufe) liefern `null` und die Warteschlange rückt sofort weiter.
Dafür kennt der `chooseCard`-Wähler jetzt neben `takeFrom` und `discardOwn` ein
drittes Ziel: `giveTo` schenkt die eigene Wahl jemand anderem.

### 9.3 Bewusst manuell geblieben (fünf Karten)

- **GUMMI-GOLEM** (Schlimme Dinge): „Du musst in jedem Kampf deine Hilfe
  anbieten, darfst keinen Schatz annehmen, bis du einen verlierst" - eine
  Dauerpflicht über viele Züge ohne Tracker.
- **TEMPORÄRE ANMNESIE**, **KLEINER FEHLER**, **HUNGRIGER RUCKSACK**,
  **TOURISTENFALLE** - dieselben, die schon im Basis-Set-Audit (§8.6)
  zurückgestellt wurden: freie
  Handelsreihenfolge, wiederkehrender Rundenend-Hook, ein neuer Kampf mitten
  in der Konsequenz-Auflösung, unterdrückter Rassen/Klassen-Status.

**Entfernte Sets:** Neben Pathfinder (7.4) ist auch **Pixels & Paper Promos**
raus. Zwei seiner fünf Karten wurden auf Wunsch ins Basis-Set übernommen und
dabei erst spielbar gemacht:

- **STEAM-CODE**: die +3 (`egal für welche Seite`) erkannte der generische
  Trank-Parser schon. Neu ist der zweite Satz - "wenn der Kampf verloren wird,
  erhalten die Munchkins +1 auf Weglaufen": `FLEE_BONUS_WHEN_PLAYED` setzt beim
  Ausspielen `combat.playedFleeBonus`, `fleeModifierParts` rechnet es mit
  eigenem Label ein. Bewusst VOR der Seitenwahl, weil der Zuschlag laut Karte
  unabhängig von der gewählten Seite gilt.
- **MECHA-DIRE-WOLF**: Stufe auf Wunsch von 14 auf 13 gesetzt und der Text
  "-2 gegen alle, die das Spiel digital spielen" durch "Ein großer
  Metall-Köter." ersetzt - hier spielen alle digital, die Klausel wäre entweder
  immer oder nie erfüllt gewesen. Seine Schlimmen Dinge ("Lege drei Karten aus
  deiner Hand ab") erkennt der generische Parser nicht und laufen jetzt über
  einen `CONSEQUENCE_OVERRIDES`-Eintrag mit `queuedDiscardOwn`.

**Deaktivierte Karten:** `DEAKTIVIERTE_KARTEN` in `server.js` (direkt über
`buildDecks`) ist eine Namensliste, die beim Deckbau übersprungen wird -
Kartendaten, Bild und Effektcode bleiben liegen, zum Reaktivieren reicht das
Streichen des Namens. Drin liegt zurzeit **EINSTWEILIGE VERFÜGUNG**: die Sperre
funktioniert, aber bereits gespielte Karten werden nicht zurückgenommen, und
dafür müsste der Server zugweit mitschreiben, wer welche Karte gespielt hat
(bei Monsterverstärkern machbar, bei Tränken/Reaktionskarten/Flüchen nicht
sinnvoll rückabwickelbar).

Halb umgesetzt, jeweils mit `// ponytail:` am Code vermerkt: der Rücknahme-Teil
der EINSTWEILIGEN VERFÜGUNG, der Schatz-gegen-Stufenkarten-Handel bei MONSTER
SIND BESCHÄFTIGT, das Barden-„Verzaubern", die Ork-Fluchwahl und die
Kampfbeginn-Frage der ZAUBERCOUCH (sie ist hier immer in Benutzung).

### 9.4 Verifikation

`npm test` → 24/24 (fünf neue Dateien `tests/card-clerical-*.test.js`).
`node tools/coverage-scan.js base` → weiterhin 0 Lücken.
`node tools/smoke-run.js` mit 40 Zugwechseln → ohne Hänger, keine Server-Fehler.

Zwei bestehende Tests hielten den alten Stand fest und wurden bewusst
nachgezogen: die Abdeckungs-Schranke in `auto-consequence` (15 → 10) und die
„bewusst manuell"-Zeile für GESCHLECHTSUMWANDLUNG in `card-curses`. Dazu die
Zusicherung in `card-abilities`, dass jede Spezialausrüstung einen Kampfbonus
hat - FALSCHE OHREN und ZAUBERCOUCH verleihen stattdessen eine Rasse/Klasse.

---

## 10. Weglaufen betrifft alle Beteiligten (2026-09-13)

**Der Fehler:** Nur `actor` lief weg und nur `actor` bekam die Schlimmen
Dinge. Wer im Kampf geholfen hatte, kam ohne Wurf und ohne Folgen davon —
`finishFleeSuccess` sagte das sogar ausdrücklich im Kommentar. Nachgewiesen
gegen den alten Stand: nach dem Wurf der kämpfenden Person war
`room.combat` sofort `null`, die Helfer:in hatte nie gewürfelt.

**Der Umbau:** Statt an fünf Stellen `c.actorId !== playerId` zu prüfen, gibt
es jetzt eine Fluchtreihe am Kampf:

| Feld | Bedeutung |
|---|---|
| `combat.fleeQueue` | wer noch weglaufen muss (kämpfende Person zuerst, dann Helfer:in) |
| `combat.fleeingId` | wer gerade dran ist |
| `combat.fleeFailed` | wen es erwischt hat |

`fluechtenderId(room)` ist die einzige Antwort auf „wer läuft gerade?" — und
legt die Reihe an, falls sie fehlt. Damit gilt „`mustFlee` heißt: alle
Beteiligten laufen einzeln weg" auch dort, wo `mustFlee` anders gesetzt wird
(Testaufbauten, künftige Kartenwege). Die fünf Handler (`handleAttemptFlee`,
`handleFleeEscape`, `handleUseLamp`, `handleFleeReroll`,
`handleUseGuaranteedFlee`) fragen alle nur noch diese eine Funktion.

`naechsterFluechtling` rückt weiter und setzt die personenbezogenen
Zwischenstände zurück (Halbling-Wiederholung, Kleberfläschchen-Fenster),
sonst erbt die nächste Person sie. Getrennte werden übersprungen.

`beendeFluchtphase` räumt erst auf, wenn **alle** gewürfelt haben — hätten wir
je Person sofort aufgelöst, wäre der Kampf weg, bevor die zweite überhaupt
würfelt. Das Miese Zeug kommt danach:

- Helfer:innen zuerst (`keepPhase: true`, ihre Bestätigung bewegt die Zugphase
  nicht), die kämpfende Person zuletzt — **ihre** Bestätigung gibt den Zug frei.
- Ist die kämpfende Person entkommen, wechselt die Phase sofort.
- `room._pendingConsequenceBacklog` reiht die zweite Konsequenz ein;
  `room.pendingConsequence` ist ein einzelner Platz. Gleiche Bauform wie
  `_queuedCardActionBacklog`.

**Bots**: `scheduleBotActionsIfNeeded` plant beim Weglaufen für
`fluechtenderId`, nicht mehr für die Person am Zug — sonst stünde die Partie,
sobald eine Bot-Helfer:in dran ist. `botSituation` enthält `fleeingId`, damit
ein Wechsel der fliehenden Person neu einplant.

**Nicht geprüft in der Praxis**: Bots helfen aktuell grundsätzlich nicht
(`handleRespondHelp(room, helper.id, false)`), der Bot-Helfer-Pfad kommt im
Durchlauf also nie vor. Abgedeckt ist er nur durch `tests/flee-helper.test.js`.

**Bewusst nicht mitgemacht**: die Regel „bei mehreren Monstern würfelst du
für jedes einzeln" (so steht es auch auf WANDERNDES MONSTER). Es bleibt bei
einem Wurf je Person gegen alle Monster; wer scheitert, bekommt die Schlimmen
Dinge aller. Mit dem Nutzer abgestimmt, eigene Runde.

`GUARANTEED_FLEE_CARDS` beenden weiterhin nur die eigene Flucht ohne
Stufenstrafe und ohne Kleberfläschchen-Fenster (`// ponytail:` am Code) — neu
ist nur, dass danach die Helfer:in trotzdem selbst laufen muss.

---

## 11. Unnatural Axe: Monsterkarten (Runde vom 2026-09-16)

Drittes Set, gleiche Bauform wie Clerical Errors. Spec und Plan:
`docs/superpowers/specs/2026-09-16-unnatural-axe-monster-design.md` und
`docs/superpowers/plans/2026-09-16-unnatural-axe-monster.md` (16 Tasks,
alle abgehakt).

### 11.1 Was jetzt läuft

- **Monsterboni** über `MONSTER_TRAIT_BONUS` (src/cards/passives.js): der
  Normalfall bleibt `{ races/classes: [...], bonus }`, alles Textliche ohne
  Rasse/Klasse (Geschlecht, Wochentag, Ausrüstungszahl, Kampfzustand) läuft
  über `{ wennErfuellt: (p, room) => bool, bonus }`.
- **Stufengrenzen** (`monsterRefusesTarget`/`MONSTER_REFUSES`) und
  **Weglauf-Modifikatoren** (`FLEE_MONSTER_MOD`, `FLEE_IMPOSSIBLE`) um die
  Unnatural-Axe-Monster erweitert (FEUERLÖSCHER, TENTAKELDÄMON, JABBERWOCK,
  PSYCHO-EICHHÖRNCHEN, PESTRATTEN, DIE SCHATTENNASE).
- **`istMensch(p)`** (src/cards/passives.js): "keine Rassenkarte" - für
  RIESENKAKERLAKE und GRASGNOLL, die beide gegen Menschen bonusieren.
- **`wennErfuellt` bekommt jetzt den Raum** (zweiter Parameter, optional),
  nicht nur den Spieler - nötig für alles, was am Kampfzustand statt an der
  Person hängt: FEUERLÖSCHER ("+5 ohne Hilfe"), ROTZ-ELEMENTAR mit LAUFENDE
  NASE/DIE SCHATTENNASE im selben Kampf.
- **Würfel-Ablege-Primitiv** `diceDiscardHand` (server.js, `applyPrimitiveAction`):
  würfelt und legt so viele Handkarten ab wie gewürfelt, gedeckelt auf die
  tatsächliche Handkartenzahl. Träger: KATZENMÄDCHEN.
- **Waffen-Ausblendung** `MONSTER_IGNORES_WEAPONS` (Set): MONDJUNGFERN zählt
  keinen Waffenbonus - "Waffe" heißt wie bei `waffenAnzahl` "belegt eine
  Hand", ein Schild zählt mit.
- **Feuer-Verdopplung**: `conditionalItemBonusSum` verdoppelt gegen den
  EISRIESEN jeden Gegenstand aus `FIRE_ITEMS` (Feuer/Flamme-Text), generisch
  statt kuratierte Liste - neue Feuergegenstände zählen automatisch mit.
- **Gigantischer Fungus**: `handlePlayCombatCard` erkennt GIGANTISCH auf
  einem FUNGUS und gibt +25 statt der gedruckten +10 (`zuschlag` statt
  `c.bonus`, siehe Commit "Einblendung im Kampf nennt jetzt denselben Bonus
  wie der Verlauf" - Verlauf und `room.cardPlay.hinweis` bezogen sich vorher
  auf unterschiedliche Werte).
- **PIÑATA**: Niederlage kostet die nachfolgende Person die Wahl eines
  Gegenstands des Opfers (der Gegenstand geht in den Ablagestapel, nicht an
  die wählende Person - Spiegelbild zu `queuedTakeItem`, siehe
  `discardVictim`). Sieg gibt einen Sieg-Hook für den **ganzen Tisch**:
  `resolveCombatWin` erkennt PIÑATA unter den Monstern und lässt jede Person
  am Tisch einen Schatz ziehen, unabhängig von der Kampfteilnahme.

### 11.2 Was bewusst nur teilweise abgedeckt ist

Markiert im Code mit `// ponytail:`, jeweils mit Aufrüstweg:

- **Gigantischer Fungus, Strafenverdopplung** (`src/cards/consequences.js`,
  Eintrag `'FUNGUS'`): die Schlimmen Dinge verdoppeln sich laut Text
  ebenfalls, wenn der Fungus Gigantisch ist - die Konsequenz-Funktion sieht
  aber nur `player`, nicht den Verstärker-Zustand des Kampfs. Aufrüstweg: den
  Verstärker-Zustand in die Konsequenz durchreichen.
- **GRASGNOLL, Trank-Rückgabe** (`src/cards/consequences.js`, Eintrag
  `'GRASGNOLL'`): "+1 Stufe zurück je sofort abgelegtem Trank" fehlt - dafür
  bräuchte es ein Zeitfenster für freiwilliges Ablegen während der Konsequenz,
  das es aktuell nicht gibt. Nur der garantierte Basis-Verlust (3 Stufen)
  läuft.
- **PSYCHO-EICHHÖRNCHEN, Genitalschoner-Klausel** (`src/cards/passives.js`,
  `MONSTER_REFUSES`): "Greift keine Frauen an oder Träger des Stacheligen
  Genitalschoners" - nur die Geschlechts-Klausel ist umgesetzt. Der
  STACHELIGE GENITALSCHONER liegt in den Rohdaten als `treasure_other` ohne
  `slotKind` und lässt sich deshalb gar nicht anlegen; die Klausel kommt erst
  in der Runde, in der die Unnatural-Axe-Schatzkarten ihren Ausrüstungsplatz
  bekommen.

### 11.3 Welle 3 (Runde vom 2026-09-17)

Die vier Karten aus der alten Fassung dieses Abschnitts laufen jetzt
vollständig. Spec und Plan:
`docs/superpowers/specs/2026-09-17-unnatural-axe-welle3-design.md` und
`docs/superpowers/plans/2026-09-17-unnatural-axe-welle3.md` (9 Tasks, alle
abgehakt).

**Befund, der die Runde klein gehalten hat:** zugübergreifenden Zustand gab
es schon (`player.activeCurses`), es fehlte nur der Zugang dazu. Neu sind
ein Primitiv (`lingeringCurse`), drei `kind`s (`noHelpHalfGold`,
`noHandItemBonus`, `noTreasure`) und eine Kampfsperre nach dem Vorbild von
`kartenSperreAktiv` (EINSTWEILIGE VERFÜGUNG).

- **RIESENSTINKTIER**: Kampfsperre (niemand darf helfen, hintergehen oder
  Karten für/gegen die kämpfende Person spielen, weiße Liste in
  `stinktierSperre`) und Schlimme Dinge (`noHelpHalfGold` - keine Hilfe,
  bis alle Kleidung und Rüstung abgelegt ist; halbierter Goldwert).
- **LUSTMONSTER**: Kampftext (Hilfe des anderen Geschlechts zwingend, sonst
  automatische Flucht) und Schlimme Dinge (Stufenverlust plus
  Kampf-Fluch `noHandItemBonus` auf Hand-Gegenstände).
- **WEIHNACHTSMANN**: Schlimme Dinge (`noTreasure`, "Störerliste" - kein
  Schatz mehr, auch nicht von anderen, bis ein Monster ohne Hilfe getötet
  wird). Der Kampfbonus (-5 gegen Elfen) lief schon seit Task 1 der
  vorigen Runde.
- **EISKALTES HÄNDCHEN**: neuer `COMBAT_START_OPTIONS`-Eintrag - ein
  Wunschring statt Kampf macht die Karte zu einem +3-Gegenstand in der Hand
  (`haendchenBesaenftigen`).

`node tools/coverage-scan.js unnaturalaxe` zeigt im Abschnitt MONSTER jetzt
keine der vier Karten mehr.

**Auslegungen, die nicht wörtlich aus dem Kartentext folgen** - jemand
könnte sie später anders entscheiden:

- Das Stinktier sperrt die *anderen* am Tisch, nicht die kämpfende Person
  selbst.
- Ein Weihnachtsmann-Sieg ohne Hilfe zahlt schon aus; die Störerliste
  greift erst für den nächsten Fund, nicht rückwirkend auf den gerade
  gewonnenen Schatz.
- Der halbierte Goldwert des Stinktiers trifft die Endsumme beim Verkauf,
  nicht den einzelnen Gegenstand.

Der WUNSCHRING beendet alle drei Monsterstrafen (Stinktier, Lustmonster,
Weihnachtsmann) mit - bewusst so entschieden (`clearActiveCurseByKind`).

**Zwei Stellen, an denen die Runde über die eigene Spec hinausging:**

- **Spec §4.2** versprach "eine Prüfstelle statt fünf Aufräumstellen" für
  die Stinktier-Strafe. Das ist nicht mehr ganz richtig: ein Read-and-Clear
  räumt nur auf, wenn jemand liest, deshalb ruft auch `handleUnequipItem`
  `stinktierStrafeAktiv` - drei Lesestellen derselben gemeinsamen Funktion
  statt einer. Immer noch deutlich weniger als fünf eigene Aufräumstellen,
  aber die Spec-Formulierung ist überholt.
- **Spec §6** nannte für die Weihnachtsmann-Störerliste nur zwei
  Aufrufstellen (`resolveCombatWin`, `finishTrade`). Zwei Audit-Runden
  fanden sieben weitere Wege, auf denen Schätze eine Hand erreichen -
  PESTRATTEN, weggejagte Monster, das AMAZONE-Geschenk, PACKRATTE-Bonuszüge
  und mehr. Statt zehn weitere Ad-hoc-Guards zu verteilen, wurde daraus ein
  Choke-Point: `zieheSchaetzeFuer(room, player, n)` zieht gar nicht erst,
  wenn die Person gesperrt ist. Alle zwölf `drawTreasure`-Aufrufstellen in
  `server.js` sind damit Bestand geführt; zwei bleiben bewusst außen vor
  (die Anfangsverteilung bei Spielstart, `schatzTauschen`).

**Bewusst nur teilweise abgedeckt** (siehe `ponytail:`-Kommentar über
`zieheSchaetzeFuer` in `server.js`): DIEB "Diebstahl" (`stealItemFrom`) und
ENTE DER VIELEN SACHEN ("klauen") verschieben Schatzkarten direkt von einer
Hand in die andere, ohne über `drawTreasure` zu laufen - die Störerliste
greift dort nicht. Ein sauberer Fix bräuchte ein Audit der gesamten
`.hand.push(`-Fläche in `server.js` (~30 Stellen), nicht nur dieser zwei.
Beide Auslöser sind seltener als PESTRATTEN oder das AMAZONE-Geschenk, an
denen eine Halbumsetzung am Tisch sofort auffallen würde.

### 11.4 Der Konsequenz-Wächter in `auto-consequence.test.js`

Der frühere Wartungshinweis ist erledigt: der Wächter misst seit dieser
Runde direkt, dass `parseAutoConsequence` eine feste Liste von
Kartentexten (`PARSER_TABU`) nicht auflöst, statt eine Untergrenze auf der
Anzahl manuell gebliebener Karten zu ziehen. Er muss deshalb nicht mehr je
Runde nachgezogen werden.

### 11.5 Tuerkarten Welle A (Runde vom 2026-09-18)

Fuenf der zwoelf offenen Unnatural-Axe-Tuerkarten laufen. Spec und Plan:
`docs/superpowers/specs/2026-09-18-unnatural-axe-tuerkarten-welle-a-design.md`
und `docs/superpowers/plans/2026-09-18-unnatural-axe-tuerkarten-welle-a.md`
(13 Tasks).

Neue Wirkungsarten im vorhandenen Fluch-Tracker (`player.activeCurses`):

- **STINKER** (`noHelp`, naechster Kampf) - niemand hilft. Wird jemand
  mitten im Kampf verflucht, verlaesst die Helfer:in ihn straffrei, und
  LAUFENDE NASE / DIE SCHATTENNASE fliehen und lassen ihren Schatz da.
- **NARRENGOLD** (`noCombatTreasure`, naechster Kampf) - keine Kampfbeute.
  Bewusst NICHT in `zieheSchaetzeFuer`: der Fluch sperrt nur die Beute,
  nicht Geschenke oder Bonuszuege. Das unterscheidet ihn von der
  Stoererliste des WEIHNACHTSMANNS (`noTreasure`), die jede Schatzkarte
  sperrt und deshalb im Choke-Point sitzt.
- **TODESANGST** (`fearUndead`, dauerhaft) - drei Klauseln: keine Zusage
  gegen Untote, Rauswurf der helfenden Person, sobald Untote dazukommen,
  und der eigene Kampf gegen Untote ist unabhaengig von der Kampfstaerke
  verloren (gleicher Pfad wie beim LUSTMONSTER).
- **VERFLUCHTER GEGENSTAND** (`cursedItem`, dauerhaft) - haengt an einer
  Gegenstands-Id am Eintrag selbst. Das Opfer waehlt; Kraefte zaehlen
  nicht mehr (dieselbe Ausschlussmenge wie MONDJUNGFERN, also samt
  Anhaengen); ablegen, verkaufen und handeln sind gesperrt; beim
  Pluendern einer Leiche wandert der Fluch mit der Karte.

Dazu ist **EISKALTES HÄNDCHEN (KLEINE FREUNDIN)** anlegbar (Spezialplatz,
+3) - die Deckkarte zur besaenftigten Monsterseite aus Welle 3.

**Auslegungen, die jemand anders entscheiden koennte:**

- Fluchziel sind nur ANGELEGTE Gegenstaende - eine Handkarte verleiht
  keine Kraefte.
- "Besondere Kraft" wird ueber die neun vorhandenen Gegenstands-Tabellen
  bestimmt (`gegenstandHatSonderkraft`), nicht ueber eine eigene Liste.
  Dadurch faellt der Begriff etwas weiter aus als der Kartentext ihn
  vermutlich meint: ein blosser Weglauf-Bonus zaehlt mit.
- `cursedItemIds` misst am BESITZ (Hand oder angelegt), nicht am
  Getragenen - sonst waere die Uebertragung beim Pluendern wirkungslos.
- TODESANGST endet nur per WUNSCHRING. Jeder Untoten-Kampf ist bis dahin
  automatisch verloren.
- Eine per NARRENGOLD gesperrte Person bekommt ihre PIÑATA-Karte
  weiterhin (die laeuft ueber `zieheSchaetzeFuer`, wo nur die
  Stoererliste sperrt).

**Nebenbei mitgefixt:** der Verstaerker-Zweig in `handlePlayCombatCard`
rief `refreshCombatReady` nicht - Bereit-Meldungen blieben nach einem
gespielten "+X fuers Monster" faelschlich stehen.

**Offen im Set:** 21 Karten, davon 7 Tuerkarten (EDELMUT, TOD,
ABGEBRANNT, SCHICKSALHAFTE KARTEN, FINDE EINE KARTE, FREUNDLICH, MAMI -
geplant als Wellen B und C) und 14 Schatzkarten. Drei davon (SÜSSER
SCHULTERDRACHE, STACHELIGER GENITALSCHONER, TASCHE MIT KRÄHENFÜSSEN)
haben keinen `slotKind` und sind deshalb gar nicht anlegbar; daran haengt
die Halbumsetzung beim PSYCHO-EICHHÖRNCHEN.

## 12. Regellücken Welle 3: Barde und Verstärker pro Monster (Runde vom 2026-09-22)

Zwei letzte große Lücken aus der Prüfung vom 2026-09-22. Spec:
`docs/superpowers/specs/2026-09-22-regelluecken-welle3-design.md`. Branch
`fix/welle3-barde-verstaerker`.

**Monster-Verstärker pro Monster statt kampfweit:** `room.combat.enhancers`
ist jetzt eine Liste `{ cardId, monsterId }` je gespielter Verstärkerkarte;
`enhancerIds`/`enhancerBonus`/`enhancerTreasure` sind weg, ihre Leser
rechnen über `enhancerBonusSumme()`/`enhancerTreasureSumme()`/
`aktiveEnhancers()` aus der Liste. Bei mehr als einem *unterschiedlichen*
Monster im Kampf öffnet das Ausspielen eine Zielwahl (gleiche Bauform wie
die MAGISCHE LAMPE); bei genau einem Monster im Kampf (auch KUMPEL: zwei
gleiche Monster-Ids zählen als eines) läuft es ohne Rückfrage direkt durch.
Verschwindet ein Monster, gehen seine Verstärker mit - GIGANTISCH auf dem FUNGUS (+25
statt +10, inklusive doppeltem Miesem Zeug), RAPIER-TROTTEL (verdoppelt nur
eigene Verstärker) und UNTOT (nur das Zielmonster gilt als untot) lesen
jetzt alle das Zielmonster aus der Liste statt "irgendein Monster im
Kampf". BABY/MAMI-Sonderrechnung und die Hilfe-Obergrenze pro Monster
(`kampfSchatzZahl`, jetzt Teil des öffentlichen Zustands) laufen über
dieselbe Liste.

**BARDE "Verzaubern"** (`bardenVerzauberInfo`/`handleBardeVerzaubern`):
Karte abwerfen, Rivalen wählen, beide würfeln über das normale Wurf-Fenster
(GEZINKTER WÜRFEL/KATZENINTERVENTION dürfen reagieren). Höherer Wurf des
Barden zwingt Hilfe ohne Belohnung und ohne Ablehnmöglichkeit - gleiche
Bauform wie der KNIESCHÜTZER DER VERLOCKUNG (`helperPending.compelled`),
aber mit eigenem Sperrfeld `bardenZwang` statt `noWinLevel`: "kann das
Spiel damit nicht gewinnen" ist eine andere Regel als "keine Siegesstufe".
Angeboten wird die Kraft nur, solange der Kampf noch keine Hilfe hat, im
eigenen Zug, und die Rivalenliste geht durch dieselbe Sperrprüfung wie ein
normales "Um Hilfe bitten" (`hilfeVerbotenGrund`: Stinktier, PAVILLON,
Todesangst).

**BARDE "Bardenglück"**: der Extraschatz nach einem gewonnenen Kampf öffnet
sofort eine Abwurf-Wahl über die ganze Hand (`pendingConsequence`/
Kartenwähler, kein zweiter Wartezustand neben der Beute). Ohne Handkarten
entfällt die Wahl.

**Nebenbei mitgefixt (Review-Runde, Findings in
`.superpowers/sdd/2026-09-22-regelluecken-welle3/final-findings.md`,
Fix-Report `final-fix-report.md` im selben Ordner):**

- Zweiter Verstärker während einer offenen Zielwahl überschrieb
  `room.pendingCardAction` der ersten Wahl ersatzlos - die Karte bleibt
  jetzt auf der Hand, bis die laufende Wahl entschieden ist.
- `bardenVerzauberInfo` bot die Kraft fälschlich noch während einer Flucht,
  eines offenen Wurfs oder einer anderen Kartenwahl an.
- Ein Helfer, der während des asynchronen Wurf-Fensters eines
  Verzauber-Versuchs zustande kam (GEZINKTER WÜRFEL macht das Fenster
  asynchron), konnte vom verspätet abgeschlossenen Versuch überschrieben
  werden.
- `bardenZwang` blieb hängen, wenn die erzwungene Hilfe endete
  (`removeHelper`, Todesangst-Rauswurf, Kampfübergabe, Stinker) oder eine
  neue Zusage kam - jetzt an jeder Stelle zurückgesetzt, an der
  `c.helperId` gesetzt oder geleert wird.

**Weiterhin bewusst offen** (unverändert seit der Spec, nicht Teil dieser
Runde): die DRYADE liest Klassen direkt statt eine Zaubercouch-Zusage zu
respektieren; "Verzaubern" bietet auch Rivalen an, die selbst bei Erfolg nie
helfen könnten (z.B. gegen ein LUSTMONSTER mit falschem Geschlecht oder mit
Todesangst gegen Untote - die Wahl steht trotzdem da, das Scheitern zeigt
sich erst nach dem Wurf); der UNGLÄUBIGKEITSTRANK entfernt kein
Verstärker-Schatzguthaben des Monsters, das er aus dem Kampf nimmt.
`node tools/coverage-scan.js base` bleibt dadurch unverändert.

## 13. Regellücken Welle 4: drei Flüche aus Clerical Errors

Die drei anhaltenden Flüche aus Clerical Errors wurden automatisiert:
- **TOURISTENFALLE**: Sperrt die Phase "Auf Ärger aus sein" (`handlePlayMonsterFromHand`), bis das Opfer jemand anderem geholfen hat, einen Kampf zu gewinnen. Ende-Bedingung in `finishCombatWin` (`clearActiveCurseByKind(helper, 'keinAerger')`).
- **HUNGRIGER RUCKSACK**: Neue Funktion `setzeZugphase(room, phase)` fängt den Übergang zur Phase `gabe` ab und lässt würfeln. Entsprechend dem Wurf werden Handkarten gefressen (`discardCard`). Bei Wurf 6 endet der Fluch.
- **TEMPORÄRE ANMNESIE**: Unterdrückt alle Boni und Effekte von Klassen und Rassen, bis das Opfer ein Monster besiegt oder dabei geholfen hat. Die neuen Hilfsfunktionen `aktiveKlassen(player)` und `aktiveRassen(player)` ersetzen direkte Zugriffe auf `player.classes`/`player.races`, wenn diese eine **Wirkung** (z.B. Boni) repräsentieren. Wenn es um **Besitz** geht (Obergrenzen, Ablegen), bleibt der direkte Zugriff bestehen.

**Bewusst offen / Besonderheiten:**
- Die ZAUBERCOUCH wirkt auch unter Amnesie weiter (da sie ein Gegenstand ist, keine Erinnerung).
- Monster ohne Kampfsieg beenden die Amnesie nicht.
- Der Verlauf nennt die gefressenen Karten des Hungrigen Rucksacks nicht beim Namen, da Handkarten geheim sind.

**Hinweis 2026-09-23:** Der oben beschriebene Mechanismus (`kind: 'keinAerger'`,
`aktiveKlassen`/`aktiveRassen`) stammt aus einer separaten Session, deren
Branch nach diesem Merge einen anderen, gleichzeitig entwickelten
Mechanismus fuer dieselben drei Flueche vorfand (Welle 2, siehe unten) - per
Reviewer-Entscheidung wurde Welle 2s Mechanismus behalten
(`kind: 'keinAergerSuchen'`/`'hungrigerRucksack'`/`'traitsVergessen'`, siehe
`src/cards/reactions.js`). Dieser Abschnitt beschreibt also nicht mehr den
tatsaechlichen Code - nachfolgende Sessions sollten `LINGERING_CURSES` direkt
nachschlagen statt diesem Text zu vertrauen.

## 14. Regellücken: GUMMI-GOLEM (Ueberarbeitung) und TROJANISCHER PFERD

**GUMMI-GOLEM ("Zuckerschock")** war bereits automatisiert (Welle 2), aber
mit einer anderen Lesart als der Kartentext hergibt: die Schatzsperre endete
dort, sobald die Anzahl besessener Schatzkarten unter den Stand beim
Verfluchen fiel (`zuckerschockAktiv`/`besesseneSchaetze`, beim Lesen
geprueft), und die verfluchte Person konnte selbst eine Anfrage nicht
ablehnen, wenn sie (von wem auch immer) um Hilfe gebeten wurde.
Nutzerentscheidung 2026-09-23: "bis du
einen verlierst" bezieht sich auf einen **Kampf**, nicht auf eine
Schatzkarte, und "Keiner muss deine Hilfe annehmen" gilt wörtlich (Trust-Prinzip,
keine erzwungene Annahme). Geaendert:
- Ende jetzt event-getrieben in `beendeFluchtphase` (`clearActiveCurseByKind`),
  nicht mehr beim Lesen einer geschrumpften Hand. Reihenfolge wichtig: die
  Loeschung laeuft VOR `oeffneVerlustKonsequenz`, sonst wuerde ein frischer
  Zuckerschock aus demselben verlorenen Kampf sich selbst wieder loeschen.
- `hatSchatzSperre()` prueft direkt `kind === 'zuckerschock'` (gleicher
  Choke-Point wie die Weihnachtsmann-Stoererliste `noTreasure`).
- `handleRespondHelp` erzwingt keine Annahme mehr; nur eine Logzeile bei
  Kampfbeginn erinnert an die Hilfe-Pflicht der verfluchten Person selbst.
- `zuckerschockAktiv`/`besesseneSchaetze` sowie das `schatzStand`-Feld
  wurden entfernt (nur fuer diese Karte gebraucht).

**TROJANISCHER PFERD** (Unnatural Axe, treasure_other) war ein
halbfertiges Reaktionsfenster (`combat.trojanerOffer`, seit einem frueheren
Commit, aber nie zu Ende gefuehrt): jetzt vollstaendig.
- Nach einem Kampfsieg (`resolveCombatWin`) oeffnet sich ein Fenster fuer
  alle, die die Karte auf der Hand halten (`reactionHolders`,
  `TREASURE_REACTION_CARDS`).
- Spielen (`handlePlayTrojaner`) entfernt die Karte und oeffnet den
  vorhandenen generischen Kartenwahl-Dialog (`openCardChoice`, gleiches
  Muster wie WANDERNDES MONSTER/ILLUSION) mit "ohne Monster" plus einer
  Option je Handmonster - keine eigene Client-UI fuer die Monsterwahl noetig.
- Zwei neue Faelle in `applyCombatPotionAction`
  (`trojanerOhneMonster`/`trojanerMitMonster`) blockieren die GESAMTE
  Kampfbeute (`finishCombatWin` liest `c.trojanerNoTreasure`) und starten bei
  einem gewaehlten Monster einen neuen Kampf (`startCombat`), ausser das
  Spiel ist durch den ersten Kampf schon gewonnen (`!room.winner`).
- Absagen/Verbindungsabbruch/Bots: `handlePassReaction`,
  `loeseReaktionsfensterOhne` und `scheduleBotActionsIfNeeded` behandeln
  `trojanerOffer` wie das bestehende Kleberflaeschchen-Fenster.

**Zusaetzlich behoben:** "Kampf auswerten" liess sich waehrend eines offenen
oder gerade aufgeloesten Trojaner-Fensters erneut druecken und zog dann die
Kampfbeute normal ein, obwohl gerade noch ein Trojanisches Pferd gespielt
wurde/wird - `handleEvaluateCombat` sperrt das jetzt
(`trojanerOffer`/`trojanerDone`), der Client blendet den Knopf entsprechend aus.

**Bewusst offen:** PIÑATA und TROJANISCHER PFERD im selben Kampf bleiben
unberuecksichtigt (PIÑATA zieht weiterhin fuer alle, unabhaengig von der
Trojaner-Blockade) - seltener Kombinationsfall.
