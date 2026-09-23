// Munchkin - Online
// Selbst-gehosteter Mehrspieler-Server auf Basis von Express + Socket.IO,
// nach demselben Muster wie die anderen Spiele (Wizard, Tempel des Schreckens, ...).
// Regelwerk: siehe README.md (Originalspiel von Steve Jackson Games / Pegasus Spiele).
//
// WICHTIG zum Umfang: Munchkin hat hunderte Karten mit jeweils eigenem,
// individuellem Regeltext ("Wanderndes Monster", "Kumpel", spezielle Rassen-/
// Klassen-Kräfte, jede Menge Flüche mit unterschiedlichsten Effekten, ...).
// Das alles einzeln zu kodieren ist nicht machbar. Der Server automatisiert
// daher die MECHANISCHEN Grundregeln vollständig (Phasen, Decks, Kampf-Mathe,
// Stufen, Ausrüstung, Gold/Aufstieg, Fluchtwurf) und zeigt bei allem
// Kartenspezifischen (Boni, Schlimme Dinge, Fluch-Effekte, Sonderkräfte) den
// Originaltext an, den die Spieler:innen - wie am echten Tisch - selbst
// anwenden ("Trust"-Prinzip, genau wie bei den Bluffs in "Tempel des
// Schreckens"). Siehe README.md, Abschnitt "Was automatisiert ist / Was
// manuell bleibt".

const path = require('path');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
// Ganz oben, weil das big-Flag schon beim Einlesen der Kartendaten gebraucht
// wird (siehe ALL_CARDS weiter unten).
const { BIG_ITEMS, isBigItem } = require('./src/cards/bigitems.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Kartendaten
// ---------------------------------------------------------------------------

const ALL_CARDS = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'cards.json'), 'utf8'));
// Zwei Kartennamen tragen ein <BR> aus der Vorlage mit sich herum ("SINGENDES
// &<BR>TANZENDES SCHWERT") - einmal hier begradigt, dann stimmt es in Logs,
// Kartenkacheln und Ausruestungsplaetzen gleichzeitig.
ALL_CARDS.forEach((c) => { c.name = String(c.name).replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim(); });
// "Grosser Gegenstand" einmalig ans Kartenobjekt haengen, statt die Namensliste
// im Client ein zweites Mal zu pflegen: ALL_CARDS_MIN geht ohnehin komplett an
// die Clients, damit kennt die Grossansicht das Flag ohne eigene Tabelle - und
// es kann gar nicht erst von der Serverliste abweichen.
ALL_CARDS.forEach((c) => { c.big = isBigItem(c); });
const CARDS_BY_ID = new Map(ALL_CARDS.map((c) => [c.id, c]));
const SET_KEYS = ['base', 'clericalerrors', 'unnaturalaxe'];
const SET_LABELS = {
  base: 'Base (Grundspiel)',
  clericalerrors: 'Clerical Errors',
  unnaturalaxe: 'Unnatural Axe',
};

function card(id) { return CARDS_BY_ID.get(id) || null; }

// ---------------------------------------------------------------------------
// Konstanten
// ---------------------------------------------------------------------------

const MIN_PLAYERS = 1; // Munchkin braucht offiziell 3+, aber solo/zu zweit testen soll möglich sein
const MAX_PLAYERS = 6;
const MAX_ROOMS = 500;
// Zuschauer:innen zaehlen NICHT gegen MAX_PLAYERS (sie spielen nicht mit),
// bekommen aber ein eigenes, grosszuegiges Limit gegen Missbrauch.
const MAX_SPECTATORS = 30;
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_LEVEL = 10;
const HAND_LIMIT = 5;

const BOT_NAME_POOL = [
  'Bot Grabschänder', 'Bot Kellerkind', 'Bot Fallenfreund', 'Bot Rattenfänger',
  'Bot Türsteher', 'Bot Beutejäger', 'Bot Schleimschlucker', 'Bot Levelheini',
];

function makeRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}

// Wird u.a. für den Wiederverbinden-Token benutzt. Wer den Token einer anderen
// Person kennt, übernimmt deren Platz im Spiel (siehe joinRoom) - deshalb aus
// crypto und nicht aus Math.random(), dessen Zustand sich aus wenigen
// beobachteten Werten rekonstruieren lässt.
function makeId() {
  return crypto.randomBytes(16).toString('hex');
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function rollDie() { return 1 + Math.floor(Math.random() * 6); }

// ---------------------------------------------------------------------------
// Rate-Limiting (wie bei den anderen Spielen)
// ---------------------------------------------------------------------------

function getClientIp(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return socket.handshake.address || 'unknown';
}

const rateLimitHits = new Map();
function isRateLimited(key, limit, windowMs) {
  const now = Date.now();
  const hits = (rateLimitHits.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) { rateLimitHits.set(key, hits); return true; }
  hits.push(now);
  rateLimitHits.set(key, hits);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of rateLimitHits) {
    const fresh = hits.filter((t) => now - t < 10 * 60 * 1000);
    if (fresh.length) rateLimitHits.set(key, fresh); else rateLimitHits.delete(key);
  }
}, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Raumverwaltung
// ---------------------------------------------------------------------------

const rooms = new Map();
const ROOM_CLEANUP_MS = 3 * 60 * 60 * 1000;

function newPlayer(name, socketId, isBot) {
  return {
    id: makeId(),
    token: isBot ? null : makeId(),
    name,
    socketId: socketId || null,
    connected: true,
    isBot: !!isBot,
    level: 1,
    races: [],
    classes: [],
    powerGroups: [], // Machtgruppe (Pathfinder-Set): drittes Merkmal wie Rasse/Klasse
    raceCapCard: null, // HALB-BLUT, falls gehalten -> Rassen-Obergrenze 2 statt 1
    classCapCard: null, // SUPER MUNCHKIN, falls gehalten -> Klassen-Obergrenze 2 statt 1
    powerGroupCapCard: null, // DOPPELLEBEN, falls gehalten -> Machtgruppen-Obergrenze 2 statt 1
    hand: [], // card ids, privat
    equipped: newEquipped(),
    // SCHUMMELN!: hebt fuer genau einen Gegenstand die Anlege-Regeln auf.
    attachments: { cheatedItemId: null },
    // Anhaltende Flueche (MIESER SPIEGEL, GESCHLECHTSUMWANDLUNG, HUHN AUF
    // DEINEM KOPF, WINZIGE HÄNDE) - siehe LINGERING_CURSES/addActiveCurse.
    activeCurses: [],
    // Geschlecht: 'm' | 'w' | null (geschlechtslos, siehe STRICHMÄNNCHEN).
    // Alle starten maennlich und waehlen nichts aus - geaendert wird es nur
    // durch Karten (GESCHLECHTSUMWANDLUNG, STRICHMÄNNCHEN).
    gender: 'm',
    // FREUD'SCHEN SLIPPER: das Geschlecht beim Anlegen der Slipper, fuer die
    // "-5, wenn es nicht das Geschlecht ist, das du beim Ausspielen hattest"-
    // Klausel beim Verlust. null = keine Slipper im Spiel.
    genderBeiSlippern: null,
    // KALI: "Stirb, stirb, stirb - und setze auch deinen naechsten Zug aus."
    skipTurns: 0,
  };
}

// Zuschauer:innen sind KEINE Spieler:innen: kein hand/equipped/level, keine
// Spielaktionen (act() prueft socket.data.playerId, das Zuschauer-Sockets nie
// gesetzt bekommen - siehe joinAsSpectator/socket.data.spectatorId). Sie
// duerfen laut Bugreport per Dropdown IRGENDEINE Hand ansehen, siehe
// sendSpectatorInfo - deshalb reicht hier Name/Verbindung/Token.
function newSpectator(name, socketId) {
  return { id: makeId(), token: makeId(), name, socketId: socketId || null, connected: true };
}

// Gemeinsame Logik fuer den Zuschauer-Beitritt: sowohl fuer den expliziten
// "Nur zuschauen"-Schalter (joinAsSpectator) als auch fuer den Fall, dass
// jemand ganz normal ueber "Beitreten" in einen Raum will, dessen Partie
// schon laeuft (joinRoom faellt dann hierher zurueck, statt einen Fehler
// zu zeigen - siehe dort). `auto` steuert nur die Log-Meldung.
function trySpectatorJoin(room, name, socket, cb, { auto = false } = {}) {
  if (room.spectators.length >= MAX_SPECTATORS) {
    return cb({ ok: false, error: 'Gerade zu viele Zuschauer:innen in diesem Raum.' });
  }
  name = (name || '').trim().slice(0, 20) || 'Zuschauer:in';
  const vergeben = room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())
    || room.spectators.some((s) => s.name.toLowerCase() === name.toLowerCase());
  if (vergeben) return cb({ ok: false, error: 'Dieser Name ist bereits vergeben.' });
  const spectator = newSpectator(name, socket.id);
  room.spectators.push(spectator);
  socket.join(room.code);
  socket.data.roomCode = room.code;
  socket.data.spectatorId = spectator.id;
  log(room, auto
    ? `${name} wollte beitreten, aber die Partie läuft schon - schaut jetzt als Zuschauer:in zu.`
    : `${name} schaut als Zuschauer:in zu.`);
  cb({ ok: true, code: room.code, spectatorId: spectator.id, token: spectator.token, autoSpectator: auto });
  broadcastState(room);
}

function createRoom() {
  const code = makeRoomCode();
  const room = {
    code,
    hostId: null,
    players: [],
    spectators: [],
    settings: { sets: { base: true, clericalerrors: true, unnaturalaxe: true } },
    phase: 'lobby', // lobby | playing | gameend
    turnIndex: 0,
    turnPhase: null, // tuer | aerger | pluendern | gabe
    combatHappenedThisTurn: false,
    lastCombatWinnerId: null,
    lastCombatWinnerTurnIndex: null,
    doorDeck: [], doorDiscard: [],
    treasureDeck: [], treasureDiscard: [],
    revealedDoorCard: null,
    doorReveal: null, // {cardId, seq} - nur fuer die Aufdeck-Animation im Client
    dieRoll: null, // {seq, roll, mod, total, success, playerId, playerName} - nur fuer die Wuerfel-Animation im Client
    cardPlay: null, // {seq, cardId, playerName, hinweis} - nur fuer die Kartenanimation im Client
    combat: null,
    pendingConsequence: null,
    pendingCardAction: null,
    pendingRoll: null, // {playerId, purpose, roll, holders, onResolve} - siehe rollWithWindow
    winner: null,
    // Kartenanhaenge: Gegenstands-Id -> [Karten-Ids]. VERGIFTET/GESEGNET
    // ("Diese Karte bleibt beim Gegenstand, egal ob er verloren, gestohlen
    // oder abgelegt wird") und NÜTZLICHE GRIFFE haengen am GEGENSTAND, nicht
    // an der Person - deshalb liegt die Tabelle am Raum.
    itemAttachments: {},
    // EINSTWEILIGE VERFÜGUNG: [{ geschuetzt, gesperrt }] fuer den laufenden
    // Zug - wird beim Zugwechsel geleert.
    kartenSperren: [],
    logs: [],
    lastActivity: Date.now(),
    cleanupTimer: null,
    botTimer: null,
  };
  rooms.set(code, room);
  touchRoom(room);
  return room;
}

function touchRoom(room) {
  room.lastActivity = Date.now();
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => { rooms.delete(room.code); }, ROOM_CLEANUP_MS);
}

function log(room, text, cardIds) {
  // cardIds: optionale Liste öffentlich bekannter Karten, auf die sich dieser
  // Eintrag bezieht (z.B. eine aufgedeckte Türkarte) - der Client macht daraus
  // im Verlauf anklickbare Kartenverweise. NIE für private/verdeckte Karten
  // befüllen (z.B. verdeckt gezogene Türkarten beim Plündern)!
  room.logs.push({ text, at: Date.now(), cardIds: (cardIds && cardIds.length) ? cardIds.filter(Boolean) : undefined });
  if (room.logs.length > 300) room.logs.shift();
}

function findPlayer(room, playerId) { return room.players.find((p) => p.id === playerId); }
function currentPlayer(room) { return room.players[room.turnIndex] || null; }

// Reihenfolge, in der Mitspielende von einer Karte betroffen werden. Die
// Karten sagen Unterschiedliches ("beginnend mit dem Spieler VOR dir" gegen
// "NACH dir"), deshalb ein Modus je Formulierung statt einer festen Regel.
function playerQueueFrom(room, player, mode) {
  const n = room.players.length;
  const self = room.players.findIndex((p) => p.id === player.id);
  if (self < 0 || n < 2) return [];
  if (mode === 'after') {
    return Array.from({ length: n - 1 }, (_, i) => room.players[(self + 1 + i) % n].id);
  }
  if (mode === 'before') {
    return Array.from({ length: n - 1 }, (_, i) => room.players[((self - 1 - i) % n + n) % n].id);
  }
  if (mode === 'neighbours') {
    const vor = room.players[((self - 1) % n + n) % n].id;
    const danach = room.players[(self + 1) % n].id;
    return vor === danach ? [vor] : [vor, danach];
  }
  if (mode === 'topLevel') {
    const others = room.players.filter((p) => p.id !== player.id);
    if (!others.length) return [];
    const max = Math.max.apply(null, others.map((p) => p.level));
    return others.filter((p) => p.level === max).map((p) => p.id);
  }
  return room.players.filter((p) => p.id !== player.id).map((p) => p.id); // 'allOthers'
}

// ---------------------------------------------------------------------------
// Decks
// ---------------------------------------------------------------------------

function activeSetKeys(room) {
  return SET_KEYS.filter((k) => room.settings.sets[k]);
}

// Vorerst aus dem Spiel genommen: die Karte sperrt zwar korrekt, nimmt aber
// bereits gespielte Karten nicht zurueck (siehe src/cards/treasures.js).
// Kartendaten und Effekt bleiben liegen - zum Reaktivieren den Namen hier
// streichen. Der Schluessel ist der NAME, nicht die Id: ein Eintrag entfernt
// die Karte aus allen Sets, in denen sie vorkommt.
const DEAKTIVIERTE_KARTEN = new Set(['EINSTWEILIGE VERFÜGUNG']);

function buildDecks(room) {
  const sets = activeSetKeys(room);
  const doorCards = ALL_CARDS.filter((c) => sets.includes(c.set) && c.type === 'door'
    && !DEAKTIVIERTE_KARTEN.has(c.name)).map((c) => c.id);
  const treasureCards = ALL_CARDS.filter((c) => sets.includes(c.set) && c.type === 'treasure'
    && !DEAKTIVIERTE_KARTEN.has(c.name)).map((c) => c.id);
  room.doorDeck = shuffle(doorCards);
  room.doorDiscard = [];
  room.treasureDeck = shuffle(treasureCards);
  room.treasureDiscard = [];
}

function drawDoor(room) {
  if (room.doorDeck.length === 0) {
    if (room.doorDiscard.length === 0) return null;
    room.doorDeck = shuffle(room.doorDiscard);
    room.doorDiscard = [];
    log(room, 'Türstapel war leer - Ablagestapel wurde neu gemischt.');
  }
  return room.doorDeck.pop();
}

function drawTreasure(room) {
  if (room.treasureDeck.length === 0) {
    if (room.treasureDiscard.length === 0) return null;
    room.treasureDeck = shuffle(room.treasureDiscard);
    room.treasureDiscard = [];
    log(room, 'Schatzstapel war leer - Ablagestapel wurde neu gemischt.');
  }
  return room.treasureDeck.pop();
}

// ---------------------------------------------------------------------------
// Ausrüstung / Stufen / Kampfstärke
// ---------------------------------------------------------------------------

// SPECIAL_SLOT_ITEMS, SPECIAL_SLOTS: siehe src/cards/passives.js (Tabelle
// wird weiter unten, nach hasRace/hasClass, per passivesFactory geladen -
// SPECIAL_SLOT_KEYS steht dort direkt daneben).

function newEquipped() {
  const eq = { head: null, armor: null, feet: null, hands: [null, null] };
  SPECIAL_SLOT_KEYS.forEach((k) => { eq[k] = []; });
  return eq;
}

function specialSlotCards(player, key) {
  const v = player.equipped[key];
  return Array.isArray(v) ? v.filter(Boolean) : (v ? [v] : []);
}

function specialSlotRule(c) {
  return (c && SPECIAL_SLOT_ITEMS[c.name]) || null;
}

// Jede getragene Karte GENAU EINMAL. Ein zweihaendiger Gegenstand steht in
// beiden Handslots (siehe handleEquipItem: hands = [id, id]) - ohne das
// Entdoppeln zaehlt er doppelt, und zwar ueberall auf einmal: Kampfbonus
// (BOGEN MIT BUNTEN BAENDERN gab +8 statt +4), Goldwert beim Verkaufen,
// Gegenstandszahl, und beim Ablegen landete dieselbe Karte zweimal im
// Ablagestapel. Die Slots selbst bleiben doppelt belegt - die "wie viele
// Haende sind frei"-Rechnung liest player.equipped.hands direkt.
function equippedItemIds(player) {
  return [...new Set([player.equipped.head, player.equipped.armor, player.equipped.feet,
    ...player.equipped.hands,
    ...SPECIAL_SLOT_KEYS.flatMap((k) => specialSlotCards(player, k))].filter(Boolean))];
}

// Kartenanhaenge (siehe room.itemAttachments). Ohne Raum - z.B. in den
// aelteren Test-Helfern - gibt es schlicht keine Anhaenge.
function attachmentIds(room, itemId) {
  return (room && room.itemAttachments && room.itemAttachments[itemId]) || [];
}

function attachmentBonusSum(room, itemId) {
  return attachmentIds(room, itemId).reduce((sum, id) => {
    const c = card(id);
    return sum + (c && c.bonus ? c.bonus : 0);
  }, 0);
}

// NÜTZLICHE GRIFFE: "Permanent an einen beliebigen grossen Gegenstand
// anzubringen. Der Gegenstand zaehlt nicht laenger als gross." Deshalb gibt
// es neben dem statischen isBigItem(card) diese raumbezogene Frage - ueberall
// dort benutzt, wo der Raum bekannt ist.
function istGrosserGegenstand(room, cardId) {
  if (!isBigItem(card(cardId))) return false;
  return !attachmentIds(room, cardId).some((id) => (card(id) || {}).name === 'NÜTZLICHE GRIFFE');
}

// ZWERG: "Du kannst eine beliebige Anzahl Grosser Gegenstaende tragen und
// ausruesten." Alle anderen duerfen genau einen tragen.
function bigItemCount(player, room) {
  return equippedItemIds(player).filter((id) => istGrosserGegenstand(room, id)).length;
}

function canCarryAnotherBigItem(player, room) {
  return hasRace(player, 'ZWERG') || bigItemCount(player, room) < 1;
}

// Ermittelt gierig (teuerste zuerst) genug Gegenstaende/Handkarten, um
// mindestens `gold` Goldstuecke Wert zu erreichen (oder alles, falls nicht
// genug vorhanden) - gemeinsame Rechenregel fuer VERSICHERUNGSVERTRETER und
// FLUCH! EINKOMMENSSTEUER.
function pickItemsWorthGold(player, gold) {
  const ids = equippedItemIds(player).concat(player.hand)
    .filter((id) => (card(id) || {}).gold > 0)
    .sort((a, b) => (card(b).gold || 0) - (card(a).gold || 0));
  let summe = 0;
  const weg = [];
  for (const id of ids) {
    if (summe >= gold) break;
    summe += card(id).gold || 0;
    weg.push(id);
  }
  return { summe, weg };
}

// Alle Ids, die eine Hand belegen: gedruckte Handgegenstaende plus
// Spezialslot-Karten mit slotKind 'hand' (z.B. ZWEIHAENDIGES SCHWERT).
// Grundlage fuer waffenIds (src/cards/passives.js, ohne Schilde) und den
// LUSTMONSTER-Fluch.
function handItemIds(player) {
  const ids = new Set((player.equipped.hands || []).filter(Boolean));
  (player.equipped.special || []).forEach((id) => { if ((card(id) || {}).slotKind === 'hand') ids.add(id); });
  return ids;
}

// room ist optional: ohne ihn zaehlen nur die gedruckten Boni, mit ihm auch
// die Kartenanhaenge (VERGIFTET/GESEGNET, je +2). excludeIds (optional):
// Gegenstands-Ids, die komplett aussen vor bleiben - samt ihrer Anhaenge,
// siehe MONDJUNGFERN in combatTotals.
function equippedBonusSum(player, room, excludeIds) {
  return equippedItemIds(player).reduce((sum, id) => {
    if (excludeIds && excludeIds.has(id)) return sum;
    const c = card(id);
    // Rueckfall auf den Bonus der Spezialplatz-Regel: das EISKALTE HÄNDCHEN
    // ist eine Monsterkarte und nennt in den Rohdaten selbst keinen Bonus.
    const regelBonus = (specialSlotRule(c) || {}).bonus || 0;
    return sum + (c && c.bonus ? c.bonus : regelBonus) + attachmentBonusSum(room, id);
  }, 0);
}

// Die Karte, die einen gedruckten Platz (Kopf/Ruestung/Schuhe) belegt - egal,
// wo sie wirklich liegt: ein geschummelter Gegenstand liegt auf dem
// Spezialplatz (siehe handleEquipItem), traegt seinen slotKind aber weiter.
// EINE Stelle fuer alle, die sonst direkt in player.equipped[slot] schauen.
// Liegen zwei Karten desselben slotKind an (nur geschummelt moeglich), gewinnt
// die auf dem gedruckten Platz: equippedItemIds liefert Kopf/Ruestung/Schuhe
// vor dem Spezialplatz. "Ruestung verlieren" nimmt also die echte zuerst.
function getrageneSlotKarte(player, slot) {
  return equippedItemIds(player).find((id) => (card(id) || {}).slotKind === slot) || null;
}

// MIESER SPIEGEL/GEMEINE GHOULE lassen nur Ruestungsboni stehen. Summiert
// statt eines einzelnen Slots: geschummelt kann eine zweite Ruestung anliegen
// (siehe getrageneSlotKarte), und beide sind Ruestungsboni.
function ruestungsBonusSumme(player) {
  return equippedItemIds(player)
    .filter((id) => (card(id) || {}).slotKind === 'armor')
    .reduce((sum, id) => sum + ((card(id) || {}).bonus || 0), 0);
}

// Machtgruppe Höllenritter, "Höllenritterrüstung": eine im Kampf +5 werte
// Rüstung, die zugleich als Rüstung UND Kopfbedeckung zählt - laut Karte darf
// daneben keine andere Rüstung/Kopfbedeckung getragen werden. Statt das
// Anlegen zu blockieren, zählt der Bonus nur, solange beide Slots frei sind:
// gleiches Ergebnis, egal in welcher Reihenfolge Karte und Ausrüstung kommen,
// und die Spielerin sieht die Zahl sofort statt einer Fehlermeldung.
// ponytail: bewusst keine Blockier-Logik im Anlegen-Pfad.
function hellknightArmorBonus(player) {
  if (!hasPowerGroup(player, 'HÖLLENRITTER')) return 0;
  return (player.equipped.armor || player.equipped.head) ? 0 : 5;
}

// Rassenbonus, der sich aus der getragenen Ausruestung ergibt (siehe
// RACE_ITEM_BONUS in src/cards/passives.js - heute nur der Gnom). Zaehlt wie
// ein Gegenstandsbonus: MIESER SPIEGEL und GEMEINE GHOULE unterdruecken ihn
// entsprechend, siehe combatTotals.
// excludeIds (optional): siehe equippedBonusSum - dieselbe Ausschlussmenge,
// damit RACE_ITEM_BONUS (z.B. GNOM) nicht ueber die Rasse zurueckholt, was
// MONDJUNGFERN gerade an Waffenbonus gestrichen hat.
function raceItemBonusSum(player, excludeIds) {
  if (hatFluchArt(player, 'traitsVergessen')) return 0; // siehe hasRace
  return player.races.reduce((sum, id) => {
    const c = card(id);
    const fn = c && RACE_ITEM_BONUS[c.name.toUpperCase()];
    return sum + (fn ? fn(player, excludeIds) : 0);
  }, 0);
}

// Mit leerer Monsterliste liefert conditionalItemBonusSum genau die Boni, die
// nur an der Person haengen (Geschlecht, Rasse: GENITALSCHONER, GEILER HELM) -
// die gehoeren auch in die dauerhaft angezeigte Staerke.
function baseStrength(player, room) {
  // VERFLUCHTER GEGENSTAND: "Er verliert seine Kraefte" gilt dauerhaft, nicht
  // nur waehrend combatTotals rechnet - sonst zeigt die staendig sichtbare
  // Kampfstaerke (Spielerliste, "Meine Figur") den verfluchten Bonus weiter
  // an, obwohl er im eigentlichen Kampf schon korrekt rausfliegt (siehe
  // combatTotals/excludeIds).
  const excludeIds = cursedItemIds(player);
  return player.level + equippedBonusSum(player, room, excludeIds) + raceItemBonusSum(player, excludeIds) + hellknightArmorBonus(player)
    + conditionalItemBonusSum(player, [], false, excludeIds);
}

// ITEM_CONDITIONAL_BONUS: siehe src/cards/passives.js (dort zusammen mit den
// übrigen Dauerwirkungstabellen geladen, obwohl die Nutzung hier ist).
// excludeIds (optional): siehe equippedBonusSum.
function conditionalItemBonusSum(player, monsters, untot, excludeIds) {
  if (!player || !monsters) return 0;
  // EISRIESE: "Jeder Feuer- oder Flammengegenstand verursacht doppelten
  // Schaden." Verdoppeln heisst: den gedruckten Bonus ein zweites Mal
  // dazuzaehlen. Generisch ueber FIRE_ITEMS, damit neue Feuergegenstaende
  // automatisch mitzaehlen.
  const eisriese = monsters.some((m) => m && m.name === 'EISRIESE');
  return equippedItemIds(player).reduce((sum, id) => {
    if (excludeIds && excludeIds.has(id)) return sum;
    const c = card(id);
    const fn = c && ITEM_CONDITIONAL_BONUS[c.name];
    const feuer = (eisriese && c && FIRE_ITEMS.has(c.name)) ? (c.bonus || 0) : 0;
    return sum + (fn ? fn(player, monsters, !!untot) : 0) + feuer;
  }, 0);
}

function setLevel(player, newLevel) {
  player.level = Math.max(1, Math.min(MAX_LEVEL, newLevel));
}

function removeFromHand(player, cardId) {
  const idx = player.hand.indexOf(cardId);
  if (idx >= 0) player.hand.splice(idx, 1);
}

function unequipSlotCard(player, cardId) {
  SPECIAL_SLOT_KEYS.forEach((k) => {
    player.equipped[k] = specialSlotCards(player, k).filter((id) => id !== cardId);
  });
  if (player.equipped.head === cardId) player.equipped.head = null;
  if (player.equipped.armor === cardId) player.equipped.armor = null;
  if (player.equipped.feet === cardId) player.equipped.feet = null;
  player.equipped.hands = player.equipped.hands.map((h) => (h === cardId ? null : h));
  ensureHandsLength(player);
}

// ---------------------------------------------------------------------------
// Öffentlicher Zustand
// ---------------------------------------------------------------------------

function publicPlayer(room, p) {
  // RIESENSTINKTIER: die Strafe endet beim LESEN, sobald keine Kleidung mehr
  // anliegt (siehe stinktierStrafeAktiv). Ausruestung kann auf vielen Wegen
  // verschwinden, nicht nur ueber handleUnequipItem - Verkauf, Diebstahl,
  // Fluch, Schlimme Dinge, Tod. Dieser eine Aufruf in der Serialisierung
  // normalisiert activeCurses fuer ALLE Leser: die Anzeige im Client zeigt
  // keine abgelaufene Strafe mehr an, und der WUNSCHRING, der die Rohliste
  // liest, kann nicht mehr an sie verschwendet werden.
  stinktierStrafeAktiv(p);
  return {
    id: p.id,
    name: p.name,
    connected: p.connected,
    isHost: p.id === room.hostId,
    isBot: p.isBot === true,
    level: p.level,
    races: p.races,
    classes: p.classes,
    powerGroups: p.powerGroups,
    raceCapCard: p.raceCapCard,
    classCapCard: p.classCapCard,
    powerGroupCapCard: p.powerGroupCapCard,
    handCount: p.hand.length,
    equipped: p.equipped,
    attachments: p.attachments, // SCHUMMELN!: markiert den geschummelten Gegenstand fuer den Client
    activeCurses: p.activeCurses, // anhaltende Flueche, siehe LINGERING_CURSES
    gender: p.gender,
    zaubercouch: p.zaubercouch || null,
    strength: baseStrength(p, room),
    handLimit: handLimit(p), // ZWERG darf 6 Karten halten, alle anderen 5
  };
}

function publicState(room) {
  return {
    code: room.code,
    phase: room.phase,
    players: room.players.map((p) => publicPlayer(room, p)),
    spectators: (room.spectators || []).map((s) => ({ id: s.id, name: s.name, connected: s.connected })),
    hostId: room.hostId,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    settings: room.settings,
    setLabels: SET_LABELS,
    setKeys: SET_KEYS,
    // Statische Konfiguration der Spezialplaetze - so braucht der Client
    // keine zweite Kartenliste (er zeigt nur Knopf und Platz an).
    specialSlots: SPECIAL_SLOTS,
    specialSlotItems: SPECIAL_SLOT_ITEMS,
    // Statische Liste fuer den Hinweistext am "Anlegen"-Knopf (siehe
    // BIG_ITEMS in src/cards/bigitems.js) - die eigentliche Durchsetzung
    // bleibt serverseitig in handleEquipItem.
    bigItems: [...BIG_ITEMS],
    doorCombatCards: Object.keys(DOOR_COMBAT_CARDS),
    combatReactionCards: Object.keys(COMBAT_REACTION_CARDS),
    // Davon duerfen manche nur von Kaempfenden gespielt werden (HILF MIR) -
    // damit der Client den Knopf gar nicht erst anbietet.
    combatReactionOnlyInFight: Object.keys(COMBAT_REACTION_CARDS).filter((n) => COMBAT_REACTION_CARDS[n].nurImKampf),
    // Und manche brauchen ein Monster auf der Hand (Wanderndes Monster, Illusion).
    combatReactionNeedsMonster: Object.keys(COMBAT_REACTION_CARDS).filter((n) => COMBAT_REACTION_CARDS[n].brauchtHandmonster),
    // Welche Tuerkarten als Fluch gelten (die Rohdaten fuehren die meisten als
    // normale Tuerkarte) - damit der Client den "Fluch spielen"-Knopf zeigen
    // kann, ohne eine eigene Namensliste zu pflegen.
    curseCards: [...DOOR_OTHER_AS_CURSE],
    // Sofortkraft-Schatz-/Tuerkarten und Kampf-Traenke: siehe
    // TREASURE_POWER_CARD_NAMES/COMBAT_POTION_CARD_NAMES oben - ersetzt die
    // frueheren Namensspiegel in public/client.js.
    treasurePowerCards: [...TREASURE_POWER_CARD_NAMES],
    combatPotionCards: [...COMBAT_POTION_CARD_NAMES],
    // Wuerfel-Reaktionskarten (GEZINKTER WÜRFEL, KATZENINTERVENTION) - welche
    // davon neu wuerfeln statt den Wert zu setzen, steht in rollRerollCards.
    rollReactionCards: [...ROLL_REACTION_CARDS],
    rollRerollCards: [...ROLL_REROLL_CARDS],
    // Und welche nur auf den EIGENEN Wurf gespielt werden duerfen.
    rollReactionOwnRollOnly: [...ROLL_REACTION_OWN_ROLL_ONLY],
    // ORK/GNOM/BARDE: Rassen- und Klassenkarten, die in den Rohdaten als
    // "door_other" gefuehrt werden - damit der Client den "Spielen"-Knopf
    // zeigt, ohne eine eigene Namensliste zu pflegen.
    traitDoorCards: TRAIT_DOOR_CARDS,
    // Kartenanhaenge: welche Karten angeheftet werden koennen (fuer den Knopf
    // im Client) und was aktuell woran haengt (fuer die Anzeige am Gegenstand).
    attachmentCards: ATTACHMENT_CARDS,
    itemAttachments: room.itemAttachments,
    turnIndex: room.turnIndex,
    turnPlayerId: room.players[room.turnIndex] ? room.players[room.turnIndex].id : null,
    turnPhase: room.turnPhase,
    // Vorbereitungsrunde: wer ist schon bereit? (siehe handlePrepReady)
    prepReady: room.prepReady || {},
    doorDeckCount: room.doorDeck.length,
    // Ablagestapel komplett: sie liegen am echten Tisch offen, jede:r darf sie
    // durchsehen (der Client zeigt sie auf Klick). Reihenfolge alt -> neu, die
    // letzte Karte ist also die oberste.
    doorDiscard: room.doorDiscard,
    treasureDeckCount: room.treasureDeck.length,
    treasureDiscard: room.treasureDiscard,
    revealedDoorCard: room.revealedDoorCard,
    doorReveal: room.doorReveal,
    dieRoll: room.dieRoll,
    // Gespielte Kampfkarte (Anzeige-Ereignis, siehe announceCardPlay).
    cardPlay: room.cardPlay || null,
    // Aktivierte Sonderkraft (Anzeige-Ereignis, siehe announceCardPower) - der
    // Client zeigt die Karte kurz gross mit einem "glaenzenden" Spezialeffekt.
    cardPower: room.cardPower || null,
    // Statische Namensliste, damit der Client selbst erkennen kann, ob ein
    // Kampfmonster "untot" ist (fuer UNTOT/Priester-Vertreiben/GHOULPEITSCHE) -
    // siehe UNDEAD_MONSTERS in src/cards/passives.js und combatHasUndead.
    undeadMonsters: [...UNDEAD_MONSTERS],
    combat: room.combat ? Object.assign({}, room.combat, combatConditionalBonusFields(room)) : null,
    pendingConsequence: room.pendingConsequence,
    // onResolve ist eine Funktion und darf nicht serialisiert werden -
    // deshalb hier nur die drei Felder, die der Client fuer den
    // "Wurf aendern"/"Passen"-Knopf braucht.
    pendingRoll: room.pendingRoll
      ? { playerId: room.pendingRoll.playerId, roll: room.pendingRoll.roll, holders: room.pendingRoll.holders }
      : null,
    pendingCardAction: room.pendingCardAction,
    winner: room.winner,
    logs: room.logs.slice(-80),
  };
}

function sendInfoTo(room, player) {
  if (!player.socketId) return;
  const trades = room.trades || [];
  // Handelsangebote sind privat, bis sie angenommen wurden (sie verraten
  // Handkarten) - jede:r sieht nur die eigenen offenen Angebote (inklusive
  // der Gegenleistung, die nur die beiden Beteiligten betrifft), nicht die
  // aller anderen. Nach Annahme landet das Ergebnis öffentlich im Verlauf.
  const mapTrade = (t) => ({
    id: t.id,
    status: t.status,
    fromId: t.fromId, fromName: (findPlayer(room, t.fromId) || {}).name || '?',
    toId: t.toId, toName: (findPlayer(room, t.toId) || {}).name || '?',
    offerCardIds: t.offerCardIds,
    counterCardIds: t.counterCardIds || [],
  });
  const incomingTrades = trades.filter((t) => t.toId === player.id).map(mapTrade);
  const outgoingTrades = trades.filter((t) => t.fromId === player.id).map(mapTrade);
  io.to(player.socketId).emit('yourInfo', {
    playerId: player.id,
    hand: player.hand,
    incomingTrades,
    outgoingTrades,
    // Welche Klassenkraft diese Person im laufenden Kampf gerade einsetzen
    // darf (Berserken/Vertreiben/Flugzauber) - privat, weil sie von der
    // eigenen Hand und Klasse abhängt.
    classCombatPower: classCombatPowerInfo(room, player),
    // BARDE "Verzaubern": haengt an eigener Klasse, eigenem Zug und eigener
    // Hand - deshalb privat wie classCombatPower.
    bardeVerzaubern: room.combat ? bardenVerzauberInfo(room, player) : null,
    // ZAUBERER "Verzauberung" und die Rettungskarten nach einem verpatzten
    // Weglaufwurf haengen an der eigenen Hand - deshalb privat und nicht im
    // oeffentlichen Kampfzustand.
    classEnchant: room.combat ? enchantInfo(room, player) : null,
    // DIEB (Rueckenfall/Diebstahl) und PRIESTER (Auferstehung): haengen an
    // eigener Klasse und eigener Hand, also privat.
    thiefPower: thiefPowerInfo(room, player),
    resurrectPiles: priestResurrectPiles(room, player),
    fleeEscapeCardIds: (room.combat && room.combat.fleeRerollOffer && room.combat.fleeingId === player.id)
      ? postFleeEscapeCardIds(player) : [],
    // MAGISCHE LAMPE: in der eigenen Runde während des Kampfes spielbar (im Kampf,
    // bei der Flucht oder nach verpatztem Wurf).
    lampCardIds: (room.combat && currentPlayer(room) && currentPlayer(room).id === player.id && room.combat.actorId === player.id)
      ? lampCardIds(player) : [],
    // Beute-Animation nach einem Kampfsieg. Bewusst hier im privaten
    // yourInfo statt im oeffentlichen publicState: welche Schatzkarten
    // jemand gezogen hat, gehoert zur Hand und ist damit geheim - im
    // Verlauf steht fuer alle nur die ANZAHL.
    lastReward: player.lastReward || null,
    // HALBLING: ob die einmalige Verdopplung in diesem Zug noch offen ist -
    // der Client braucht das, um den Verkaufen-Knopf am ECHTEN Erlös zu
    // messen statt am reinen Goldwert (siehe updateSellBar).
    halblingSaleOpen: halblingSaleOpen(player),
  });
}

function broadcastState(room) {
  // Muss VOR publicState laufen: veränderte Kampfwerte setzen den
  // Bereit-Status zurück, und der Client soll den neuen Stand sehen.
  refreshCombatReady(room);
  const cardCache = {};
  // Alle Karten mitschicken, die irgendwo referenziert sind, plus die Hände
  // der Spieler:innen einzeln - Kartendetails selbst sind kein Geheimnis
  // (Kartentexte sind öffentlich bekannt), nur WER welche Karte auf der Hand
  // hat ist privat.
  io.to(room.code).emit('gameState', publicState(room));
  io.to(room.code).emit('cardIndex', ALL_CARDS_MIN);
  room.players.forEach((p) => sendInfoTo(room, p));
  (room.spectators || []).forEach((s) => sendSpectatorInfo(room, s));
  touchRoom(room);
  scheduleBotActionsIfNeeded(room);
}

// Zuschauer:innen bekommen (laut Bugreport) ALLE Haende per Dropdown zu sehen,
// nicht nur die einer Person - deshalb ein eigener Broadcast statt sendInfoTo
// (das ist strikt privat pro Spieler:in).
function sendSpectatorInfo(room, spectator) {
  if (!spectator.socketId) return;
  const hands = {};
  room.players.forEach((p) => { hands[p.id] = p.hand; });
  io.to(spectator.socketId).emit('spectatorInfo', { spectatorId: spectator.id, hands });
}

// Schlanke, öffentliche Kartentabelle (einmalig an Clients gesendet) - so
// muss der Server bei jedem State-Update nicht die vollen Kartentexte erneut
// verschicken.
const ALL_CARDS_MIN = ALL_CARDS.reduce((acc, c) => { acc[c.id] = c; return acc; }, {});

// ---------------------------------------------------------------------------
// Spielstart
// ---------------------------------------------------------------------------

function startGame(room) {
  room.players = shuffle(room.players);
  buildDecks(room);
  room.players.forEach((p) => {
    p.level = 1;
    p.races = [];
    p.classes = [];
    p.hand = [];
    p.equipped = newEquipped();
    p.activeCurses = [];
    for (let i = 0; i < 4; i++) {
      const d = drawDoor(room); if (d) p.hand.push(d);
      const t = drawTreasure(room); if (t) p.hand.push(t);
    }
  });
  room.turnIndex = 0;
  // Vorbereitungsrunde: Ausruestung darf sonst nur im eigenen Zug geaendert
  // werden (darfAusruesten) - ohne diese Phase startete die erste Person mit
  // nacktem Charakter in den ersten Kampf, waehrend alle anderen bis zu ihrem
  // Zug warten muessten. Hier legen alle gleichzeitig an; die erste Runde
  // beginnt, sobald alle bereit sind.
  room.turnPhase = 'vorbereitung';
  room.prepReady = {};
  // Bots legen ohnehin nichts an - sie sind sofort bereit und blockieren die
  // Partie nicht.
  room.players.forEach((p) => { if (p.isBot) room.prepReady[p.id] = true; });
  room.combatHappenedThisTurn = false;
  room.lastCombatWinnerId = null;
  room.lastCombatWinnerTurnIndex = null;
  room.kartenSperren = [];
  room.revealedDoorCard = null;
  room.combat = null;
  zaubercouchZuruecksetzen(room);
  room.pendingConsequence = null;
  room.winner = null;
  room.phase = 'playing';
  room.logs = [];
  room.trades = [];
  log(room, `Das Spiel beginnt mit ${room.players.length} Spieler:innen. Jede:r hat 4 Tür- und 4 Schatzkarten auf der Hand.`);
  log(room, 'Vorbereitung: Ausrüstung anlegen - die erste Runde beginnt, sobald alle bereit sind.');
  pruefeVorbereitungFertig(room);
}

// Die Vorbereitungsrunde endet, sobald alle Verbundenen bereit sind. Getrennte
// zaehlen nicht mit - sonst haengt die Partie an jemandem, der nicht am Geraet
// ist (gleiche Regel wie bei reactionHolders und der Kartenwarteschlange).
function pruefeVorbereitungFertig(room) {
  if (room.turnPhase !== 'vorbereitung') return;
  const offen = room.players.filter((p) => p.connected && !room.prepReady[p.id]);
  if (offen.length) return;
  room.turnPhase = 'tuer';
  log(room, `Alle sind bereit - ${currentPlayer(room).name} ist am Zug (Phase 1: Tür eintreten).`);
}

function handlePrepReady(room, playerId, ready) {
  if (room.turnPhase !== 'vorbereitung') return;
  const player = findPlayer(room, playerId);
  if (!player) return;
  room.prepReady = room.prepReady || {};
  const vorher = !!room.prepReady[playerId];
  const jetzt = ready !== false;
  if (jetzt) room.prepReady[playerId] = true; else delete room.prepReady[playerId];
  // Nur bei echter Aenderung loggen - sonst laesst sich der Spielverlauf mit
  // einem Dauerklick auf "Bereit" zuspammen.
  if (vorher !== jetzt) log(room, `${player.name} ist ${jetzt ? 'bereit' : 'doch noch nicht bereit'}.`);
  pruefeVorbereitungFertig(room);
}

function endTurn(room) {
  if (room.pendingConsequence || room.combat) return;
  if (currentPlayer(room) && currentPlayer(room).hand.length > handLimit(currentPlayer(room))) return; // Milde Gabe erzwingen
  room.turnIndex = (room.turnIndex + 1) % room.players.length;
  // KALI: "setze auch deinen naechsten Zug aus". Die Schleife hat eine harte
  // Obergrenze, damit eine Runde, in der ALLE aussetzen, nicht haengt.
  // Setzen ALLE aus, bleibt die letzte Person am Zug (sonst drehte sich die
  // Runde im Kreis) - ihr Zaehler bleibt dann auch stehen.
  for (let i = 0; i < room.players.length - 1 && (currentPlayer(room).skipTurns || 0) > 0; i++) {
    const aussetzer = currentPlayer(room);
    aussetzer.skipTurns -= 1;
    log(room, `${aussetzer.name} setzt diesen Zug aus.`);
    room.turnIndex = (room.turnIndex + 1) % room.players.length;
  }
  // Der HALBLING-Doppelverkauf gilt "pro Runde" - siehe handleSellItems.
  room.players.forEach((p) => { p.halblingSaleUsed = false; });
  room.rucksackWurfZug = null; // HUNGRIGER RUCKSACK: im neuen Zug wird wieder gewuerfelt
  room.turnPhase = 'tuer';
  
  if (room.bumerangReturns) {
    const cp = currentPlayer(room);
    if (room.bumerangReturns[cp.id] && room.bumerangReturns[cp.id].length > 0) {
      room.bumerangReturns[cp.id].forEach(id => {
        const c = card(id);
        if (!c) return;
        const currentHolder = room.players.find(p => p.hand.includes(id) || equippedItemIds(p).includes(id));
        if (currentHolder) {
          if (currentHolder.id !== cp.id) {
             if (!currentHolder.hand.includes(id)) unequipSlotCard(currentHolder, id);
             removeFromHand(currentHolder, id);
             cp.hand.push(id);
             log(room, `"${c.name}" kehrt magisch zu ${cp.name} zurück!`);
          }
        } else if (room.treasureDiscard.includes(id)) {
          room.treasureDiscard = room.treasureDiscard.filter(x => x !== id);
          cp.hand.push(id);
          log(room, `"${c.name}" kehrt aus dem Ablagestapel zu ${cp.name} zurück!`);
        }
      });
      delete room.bumerangReturns[cp.id];
    }
  }
  
  room.combatHappenedThisTurn = false;
  // lastCombatWinnerId wird bewusst NICHT sofort hier geleert (anders als bis
  // eben): HEIMSE DIE LORBEEREN EIN reagiert auf einen fremden Sieg, der per
  // Definition im fremden Zug liegt - beim eigenen Zug war das Feld dann
  // schon wieder null. Stattdessen laeuft das Fenster genau eine Runde: es
  // wird geleert, sobald turnIndex wieder beim Sieger ankommt (alle anderen
  // hatten dann je einen Zug zum Reagieren), oder vorher schon durch den
  // naechsten Sieg ueberschrieben (siehe resolveCombatWin).
  if (room.lastCombatWinnerId && room.turnIndex === room.lastCombatWinnerTurnIndex) {
    room.lastCombatWinnerId = null;
    room.lastCombatWinnerTurnIndex = null;
  }
  room.kartenSperren = [];
  room.revealedDoorCard = null;
  log(room, `${currentPlayer(room).name} ist am Zug (Phase 1: Tür eintreten).`);
}

function checkWin(room, player) {
  if (player.level >= MAX_LEVEL) {
    room.phase = 'gameend';
    room.winner = player.id;
    log(room, `🏆 ${player.name} erreicht Stufe 10 und gewinnt das Spiel!`);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Phase 1: Tür eintreten
// ---------------------------------------------------------------------------

function handleDrawDoor(room, playerId) {
  const player = currentPlayer(room);
  if (!player || player.id !== playerId) return;
  // pendingRoll: der Amulett-Wurf laeuft, das Fluch-Ergebnis steht noch aus -
  // die Fluchkarte hat revealedDoorCard schon geleert, pendingConsequence aber
  // noch nicht gesetzt. Ohne diese Sperre liesse sich hier eine zweite Tuer
  // ziehen, die der Wurf-Callback danach ueberschreibt.
  if (room.turnPhase !== 'tuer' || room.revealedDoorCard || room.combat
    || room.pendingConsequence || room.pendingRoll) return;
  const id = drawDoor(room);
  if (!id) { log(room, 'Türstapel ist leer.'); return; }
  room.revealedDoorCard = id;
  // Zaehler statt nur Karten-ID: dieselbe Karte kann (nach dem Neumischen des
  // Ablagestapels) zweimal hintereinander aufgedeckt werden - der Client
  // erkennt am seq trotzdem, dass es ein NEUES Aufdecken ist, und spielt die
  // Animation genau einmal ab.
  room.doorReveal = { cardId: id, seq: (room.doorReveal ? room.doorReveal.seq : 0) + 1 };
  const c = card(id);
  log(room, `${player.name} deckt "${c.name}" auf (${c.setLabel}).`, [id]);

  if (c.category === 'monster') {
    room.revealedDoorCard = null;
    // "Greift niemanden mit Stufe X oder niedriger an" / "Greift keinen Dieb
    // an": das Monster zieht weiter, der Zug läuft mit Phase 2 weiter.
    if (monsterRefusesTarget(id, player)) {
      room.doorDiscard.push(id);
      room.turnPhase = 'aerger';
      // AMAZONE: "Sie erhalten stattdessen 1 Schatz."
      const geschenkSoll = MONSTER_REFUSES_TREASURE[c.name] || 0;
      const gezogen = zieheSchaetzeFuer(room, player, geschenkSoll);
      gezogen.forEach((tid) => player.hand.push(tid));
      if (gezogen.length) {
        player.lastReward = {
          seq: (player.lastReward ? player.lastReward.seq : 0) + 1,
          cardIds: gezogen, levelsGained: 0, monsterNames: [c.name],
        };
      }
      const geschenkHinweis = (geschenkSoll && !gezogen.length && hatSchatzSperre(player))
        ? `, aber ${player.name} steht auf der Störerliste und bekommt nichts`
        : (gezogen.length ? `, laesst aber ${gezogen.length} Schatzkarte(n) da` : '');
      log(room, `"${c.name}" greift ${player.name} nicht an und zieht weiter${geschenkHinweis}. Phase 2: Auf Ärger aus sein.`, [id]);
    } else if (monsterPassOption(id, player)) {
      // "Kaempfen oder vorbeigehen und winken" - Halblinge bekommen die Wahl
      // gar nicht angeboten (monsterPassOption), die muessen kaempfen.
      const fightAction = { type: 'startRevealedCombat', cardId: id };
      const passAction = { type: 'passMonster', cardId: id };
      if (player.isBot) {
        // Ein Wahldialog wuerde auf einen Bot ewig warten: er kaempft, wenn
        // seine Staerke reicht, und geht sonst vorbei.
        const desc = applyPrimitiveAction(room, player, baseStrength(player, room) > (c.level || 0) ? fightAction : passAction);
        log(room, `${player.name} (Bot) trifft die Wahl bei "${c.name}": ${desc}.`, [id]);
      } else {
        openCardChoice(room, player, c.name, [
          { id: 'fight', label: 'Kaempfen', action: fightAction },
          { id: 'pass', label: 'Vorbeigehen und winken (kein Kampf, kein Schatz)', action: passAction },
        ]);
        log(room, `"${c.name}": ${player.name} darf kaempfen oder einfach vorbeigehen.`, [id]);
      }
    } else if (combatStartOptionRule(id, player)) {
      // MÖCHTEGERN-VAMPIR/LAUFENDE NASE/PIT BULL: "Statt zu kaempfen ..." -
      // dieselbe choice-Warteschlange wie beim Vorbeigeh-Zweig oben, nur mit
      // einer kartenspezifischen Alternative statt "vorbeigehen". Kein
      // eigener Bot-Zweig nötig: scheduleBotActionsIfNeeded/
      // resolveBotCardAction (Task 3) beantworten JEDE pendingCardAction
      // generisch (erste Option), auch diese hier.
      const rule = combatStartOptionRule(id, player);
      openCardChoice(room, player, c.name, [
        { id: 'fight', label: 'Kaempfen', action: { type: 'startRevealedCombat', cardId: id } },
        { id: 'alt', label: rule.label, action: Object.assign({ cardId: id }, rule.action) },
      ]);
      log(room, `"${c.name}": ${player.name} darf kaempfen oder die Alternative nutzen (${rule.label}).`, [id]);
    } else if (COMBAT_START_COST[c.name]) {
      // ZUNGENDÄMON: "Lege einen Gegenstand deiner Wahl VOR dem Kampf ab." -
      // erzwungen (keine Wahl OB), aber WELCHER Gegenstand bleibt eine echte
      // Wahl - dieselbe discardOwn-chooseCard-Mechanik wie bei SCHNECKEN AUF
      // SPEED, nur ohne Wuerfelwurf und mit Kampfstart als Folgeaktion (siehe
      // room._preCombatCost in handleResolveCardCardChoice). Kein Gegenstand
      // vorhanden: Kampf startet direkt, es gibt nichts abzulegen.
      const itemIds = equippedItemIds(player).concat(player.hand).filter((iid) => (card(iid) || {}).category === 'item');
      if (!itemIds.length) {
        startCombat(room, player.id, [id], { fromHand: false });
      } else {
        room.pendingCardAction = {
          playerId: player.id, cardName: c.name, kind: 'chooseCard',
          prompt: 'Vor dem Kampf einen Gegenstand ablegen', candidateIds: itemIds, discardOwn: true,
        };
        room._pendingCardActionResolvers = null;
        room._preCombatCost = { monsterCardId: id };
        log(room, `"${c.name}": ${player.name} muss vor dem Kampf einen Gegenstand ablegen.`, [id]);
      }
    } else {
      startCombat(room, player.id, [id], { fromHand: false });
    }
  } else if (c.category === 'curse' || DOOR_OTHER_AS_CURSE.has(c.name)) {
    room.doorDiscard.push(id);
    room.revealedDoorCard = null;
    const shield = curseProtectionItem(player);
    if (shield) {
      // SCHUTZSANDALEN: gezogene Flüche haben keine Wirkung.
      room.turnPhase = 'aerger';
      log(room, `Fluch "${c.name}" - aber ${player.name} trägt "${card(shield).name}": keine Wirkung. Phase 2: Auf Ärger aus sein.`, [id, shield]);
    } else {
      fluchZiel(room, player, player.id, c, (opfer) => {
        if (!opfer) {
          room.turnPhase = 'aerger';
          log(room, `Fluch "${c.name}" verpufft. Phase 2: Auf Ärger aus sein.`, [id]);
          touchRoom(room);
          return;
        }
        room.pendingConsequence = { playerId: opfer.id, kind: 'curse', cardId: id, text: c.text || c.name, autoApplied: null, choice: null,
          // Anzeige im Spielfeld ("Fluch - X"): wer die Tuerkarte gezogen hat
          // (bei den meisten Fluechen == das Opfer selbst - der Client zeigt
          // das nur an, wenn beide auseinanderfallen, z.B. per Umlenkung).
          casterId: player.id,
          keepPhase: opfer.id !== player.id };
        if (opfer.id !== player.id) room.turnPhase = 'aerger';
        log(room, `Fluch! ${opfer.name} muss die Auswirkung anwenden: "${c.name}".`, [id]);
        autoApplyLossConsequence(room, opfer, [{ name: c.name, text: c.text, cardId: id }]);
        touchRoom(room);
      });
    }
  } else {
    // Karte bleibt offen auf dem Tisch liegen (wie ein Monster), bis sie per
    // handleTakeRevealedDoor aktiv auf die Hand genommen wird - die Phase
    // bleibt solange 'tuer' und blockiert damit alle Folgephasen.
    log(room, `"${c.name}" liegt offen aus - ${player.name} kann sie auf die Hand nehmen.`, [id]);
  }
}

// Wen trifft ein Fluch am Ende wirklich? Zwei Gegenstaende reden hier mit,
// beide "wenn dich ein Fluch trifft" - also gezogen UND von anderen gespielt:
//
//   PRÄCHTIGER HUT: "Er ist nicht nur praechtig, er glaenzt auch so sehr, dass
//     er Flueche reflektiert. Jeder Fluch, den du ziehst oder den jemand
//     anderes auf dich spielt, wird zufaellig zurueckgeworfen. Alle anderen
//     Spieler wuerfeln; der Spieler mit dem niedrigsten Wurf ist verflucht."
//   DAS MANCHMAL VERLÄSSLICHE AMULETT: "Wenn dich ein Fluch trifft, wirf einen
//     Wuerfel. Bei einer 1-3 trifft dich der Fluch und das Amulett wird
//     abgeworfen. Bei einer 4-6 wird der Fluch geblockt; wirf den Fluch ab.
//     Bei einer 6 steigst du zudem eine Stufe auf."
//
// Rueckgabe: die Person, die der Fluch trifft, oder null, wenn er verpufft.
// ponytail: der Hut wirft hoechstens einmal zurueck - traegt das neue Ziel
// auch einen, bleibt der Fluch dort. Sonst koennte er im Kreis laufen.
// `weiter` bekommt die Person, die der Fluch trifft, oder null (verpufft).
// Nur so herum, weil der Amulett-Wurf ein Reaktionsfenster oeffnen kann
// (GEZINKTER WÜRFEL: "nachdem DU ... wuerfeln musstest") und dann erst spaeter
// feststeht, wen es trifft.
// ponytail: die Wuerfe des PRÄCHTIGEN HUTS bleiben ohne Fenster - das sind
// mehrere Wuerfe mehrerer Personen gleichzeitig, und room.pendingRoll traegt
// genau einen. Aufruestweg: eine Kette aus Einzelfenstern.
function fluchZiel(room, ziel, casterId, c, weiter) {
  const traegt = (p, name) => equippedItemIds(p).find((id) => (card(id) || {}).name === name);

  const alu = traegt(ziel, 'ALUFOLIEN-HUT');
  if (alu && ziel.id !== casterId) {
    // Alufolien-Hut wehrt Flüche ANDERER Spieler komplett ab.
    log(room, `"${c.name}" prallt am Alufolien-Hut von ${ziel.name} ab und verpufft.`, [alu]);
    weiter(null);
    return;
  }

  const hut = traegt(ziel, 'PRÄCHTIGER HUT');
  if (hut) {
    const andere = room.players.filter((p) => p.id !== ziel.id);
    if (andere.length) {
      const wuerfe = andere.map((p) => ({ p, wurf: rollDie() }));
      const tiefster = wuerfe.reduce((a, b) => (b.wurf < a.wurf ? b : a));
      log(room, `"${c.name}" prallt am Prächtigen Hut von ${ziel.name} ab (${wuerfe.map((w) => `${w.p.name} ${w.wurf}`).join(', ')}) - es trifft ${tiefster.p.name}.`, [hut]);
      ziel = tiefster.p;
    }
  }

  const opfer = ziel;
  const amulett = traegt(opfer, 'DAS MANCHMAL VERLÄSSLICHE AMULETT');
  if (!amulett) { weiter(opfer); return; }
  rollWithWindow(room, opfer, 'amulett', (wurf) => {
    if (wurf <= 3) {
      unequipSlotCard(opfer, amulett);
      discardCard(room, amulett);
      log(room, `${opfer.name} würfelt ${wurf}: das Amulett hält nicht und wird abgeworfen.`, [amulett]);
      weiter(opfer);
      return;
    }
    let extra = '';
    if (wurf === 6) { setLevel(opfer, opfer.level + 1); extra = ' und steigt dafür 1 Stufe auf'; }
    log(room, `${opfer.name} würfelt ${wurf}: das Amulett blockt "${c.name}"${extra}.`, [amulett]);
    weiter(null);
  });
}

// Die offen liegende (Nicht-Monster-, Nicht-Fluch-)Tuerkarte auf die Hand
// nehmen und damit Phase 1 abschliessen.
function handleTakeRevealedDoor(room, playerId) {
  const player = currentPlayer(room);
  if (!player || player.id !== playerId) return;
  if (room.turnPhase !== 'tuer' || !room.revealedDoorCard || room.combat || room.pendingConsequence) return;
  const id = room.revealedDoorCard;
  player.hand.push(id);
  room.revealedDoorCard = null;
  room.turnPhase = 'aerger';
  log(room, `${player.name} nimmt "${card(id).name}" auf die Hand. Phase 2: Auf Ärger aus sein.`, [id]);
}

// Fluchkarten aus der HAND: "Du darfst eine Fluchkarte jederzeit gegen eine
// beliebige Person am Tisch ausspielen." Bis hierher war ein Fluch auf der
// Hand eine tote Karte - er wirkte nur, wenn man ihn selbst aus dem Tuerstapel
// zog (handleDrawDoor). Beute aus dem Raum und offen liegende Tuerkarten
// bringen aber laufend welche auf die Hand.
//
// Unterschiede zum gezogenen Fluch, beide stehen so auf den Karten:
//  * SCHUTZSANDALEN schuetzen NICHT ("Flueche von anderen Spielern wirken
//    weiterhin auf dich") - deshalb hier keine curseProtectionItem-Pruefung.
//  * Die Zugphase bleibt, wo sie ist (keepPhase): der Fluch gehoert zu keiner
//    Phase und kann sogar waehrend eines fremden Zuges kommen.
function handlePlayCurseFromHand(room, playerId, cardId, targetId) {
  const player = findPlayer(room, playerId);
  const target = findPlayer(room, targetId);
  if (!player || !target || player.id === target.id) return;
  if (!player.hand.includes(cardId)) return;
  const c = card(cardId);
  if (!c || !(c.category === 'curse' || DOOR_OTHER_AS_CURSE.has(c.name))) return;
  // Nicht in eine laufende Entscheidung hineinplatzen - die wuerde sonst
  // ueberschrieben (gleiche Regel wie bei den anderen Sofort-Karten).
  if (room.pendingConsequence || room.pendingCardAction || room.pendingRoll) return;
  if (room.winner) return;
  if (kartenSperreAktiv(room, playerId, targetId)) {
    log(room, `${player.name} steht unter einer Einstweiligen Verfügung von ${target.name} - kein Fluch.`);
    touchRoom(room);
    return;
  }
  if (stinktierSperre(room, playerId) && combatParticipants(room).some((p) => p.id === targetId)) {
    log(room, `${player.name} kommt am Riesenstinktier nicht vorbei - kein Fluch gegen ${target.name}.`);
    touchRoom(room);
    return;
  }
  removeFromHand(player, cardId);
  discardCard(room, cardId);
  // PRÄCHTIGER HUT / AMULETT koennen den Fluch umlenken oder ganz abwehren.
  fluchZiel(room, target, player.id, c, (opfer) => {
    if (!opfer) {
      log(room, `${player.name} spielt den Fluch "${c.name}" gegen ${target.name} - er verpufft.`, [cardId]);
      refreshCombatReady(room);
      touchRoom(room);
      return;
    }
    room.pendingConsequence = {
      playerId: opfer.id, kind: 'curse', cardId, text: c.text || c.name,
      autoApplied: null, choice: null, keepPhase: true,
      // Anzeige im Spielfeld ("Fluch - X"): wer den Fluch gespielt hat.
      casterId: player.id,
    };
    log(room, `${player.name} spielt den Fluch "${c.name}" gegen ${opfer.name}!`, [cardId]);
    autoApplyLossConsequence(room, opfer, [{ name: c.name, text: c.text, cardId }]);
    refreshCombatReady(room); // ein Fluch kann Stufe/Ausruestung aendern
    touchRoom(room);
  });
}

function handleAckConsequence(room, playerId) {
  if (!room.pendingConsequence || room.pendingConsequence.playerId !== playerId) return;
  const pc = room.pendingConsequence;
  const wasCurse = pc.kind === 'curse';
  room.pendingConsequence = null;
  const player = findPlayer(room, playerId);
  // Zweite Person eines verlorenen Kampfes: erst jetzt ist der Platz frei.
  if (room._pendingConsequenceBacklog && room._pendingConsequenceBacklog.length) {
    const naechste = room._pendingConsequenceBacklog.shift();
    const opfer = findPlayer(room, naechste.playerId);
    if (opfer) {
      room.pendingConsequence = naechste.eintrag;
      autoApplyLossConsequence(room, opfer, naechste.sources);
    }
  }
  if (pc.keepPhase && !wasCurse) {
    // Miese-Zeug-Bestaetigung einer Helfer:in: sie ist nicht am Zug, die
    // Zugphase geht sie nichts an (siehe beendeFluchtphase).
    log(room, `${player.name} hakt das Miese Zeug ab.`);
  } else if (wasCurse && pc.keepPhase) {
    // Aus der Hand gespielter Fluch (handlePlayCurseFromHand): er gehoert zu
    // keiner Zugphase, der laufende Zug bleibt unangetastet.
    log(room, `${player.name} hakt den Fluch ab.`);
  } else if (wasCurse) {
    room.turnPhase = 'aerger';
    log(room, `${player.name} macht weiter mit Phase 2: Auf Ärger aus sein.`);
  } else {
    // Folge einer verlorenen Kampfrunde: direkt weiter zu Phase 4 (wurde beim
    // Kampfstart bereits als combatHappenedThisTurn markiert) - ausser
    // ÜBERFALLTRANK war im Spiel (pc.originalActorId, siehe
    // oeffneVerlustKonsequenz und combatEndPhase), dann bekommt die
    // urspruengliche Person trotz
    // verlorenem Kampf ihre Pluenderphase.
    setzeZugphase(room, combatEndPhase({ originalActorId: pc.originalActorId }, false));
    log(room, room.turnPhase === 'pluendern'
      ? `${player.name} macht weiter mit Phase 3: Raum plündern.`
      : `${player.name} macht weiter mit Phase 4: Milde Gabe.`);
  }
  touchRoom(room);
}

// Generisches Werkzeug, um eine Konsequenz (Fluch oder "Schlimme Dinge")
// anzuwenden - siehe Kommentar am Dateianfang zum "Trust"-Prinzip.
function handleApplyConsequenceAction(room, playerId, action) {
  if (!room.pendingConsequence || room.pendingConsequence.playerId !== playerId) return;
  const player = findPlayer(room, playerId);
  if (!player) return;
  if (action.type === 'levelDelta') {
    setLevel(player, player.level + action.delta);
    log(room, `${player.name}: Stufe ${action.delta >= 0 ? '+' : ''}${action.delta} -> jetzt Stufe ${player.level}.`);
  } else if (action.type === 'discardCard') {
    const cardId = action.cardId;
    // HUHN AUF DEINEM KOPF: dieses Werkzeug laeuft nur waehrend einer
    // offenen room.pendingConsequence (siehe Guard oben), also immer als
    // Folge eines Fluchs oder Schlimmer Dinge - nie freiwillig. Die
    // Kopfbedeckung faellt hier also unter huhnMitKopfbedeckung.
    const hatteKopf = !!getrageneSlotKarte(player, 'head');
    if (player.hand.includes(cardId)) {
      removeFromHand(player, cardId);
      discardCard(room, cardId);
    } else if (equippedItemIds(player).includes(cardId)) {
      unequipSlotCard(player, cardId);
      discardCard(room, cardId);
    } else return;
    huhnMitKopfbedeckung(room, player, hatteKopf);
    const c = card(cardId);
    log(room, `${player.name} legt "${c ? c.name : cardId}" ab.`, [cardId]);
  } else if (action.type === 'death') {
    applyDeathConsequence(room, player);
    log(room, `💀 ${player.name} ist gestorben und beginnt bei Stufe 1 mit leeren Händen neu.`);
  }
  touchRoom(room);
}

function discardCard(room, cardId) {
  const c = card(cardId);
  if (!c) return;
  if (c.name === 'BUMERANGDOLCH' && room.pendingConsequence && room.pendingConsequence.kind === 'curse') {
    room.bumerangReturns = room.bumerangReturns || {};
    room.bumerangReturns[room.pendingConsequence.playerId] = (room.bumerangReturns[room.pendingConsequence.playerId] || []).concat(cardId);
  }
  if (c.type === 'door') room.doorDiscard.push(cardId);
  else room.treasureDiscard.push(cardId);
  // SCHUMMELN!: "Lege diese Karte ab, wenn du den geschummelten Gegenstand
  // verlierst." Das trifft praktisch jeden Ablege-Weg (Verkauf, Konsequenzen,
  // Weglaufkarten) - deshalb hier zentral geloest statt an jeder Aufrufstelle
  // einzeln. Steal/Handel gehen NICHT über discardCard (Gegenstand landet in
  // einer anderen Hand statt im Ablagestapel) - dafuer siehe clearCheatIfLost.
  room.players.forEach((p) => {
    if (p.attachments && p.attachments.cheatedItemId === cardId) p.attachments.cheatedItemId = null;
  });
}

// KUMPEL legt dieselbe Monster-Karten-ID ein zweites Mal in c.monsterIds
// (siehe COMBAT_REACTION_CARDS/applyCombatReaction), damit Stufe und Schatz
// automatisch doppelt zaehlen. Beim gemeinsamen Ablegen aller verbliebenen
// Kampfmonster (Sieg, Flucht, garantierte Flucht, ...) darf die ID trotzdem
// nur EINMAL auf den Zielstapel wandern - sonst verdoppelt sich die Karte im
// Deck. Zentral hier statt an jeder Ablege-Stelle einzeln dedupliziert.
function discardMonsterIds(target, monsterIds) {
  [...new Set(monsterIds)].forEach((id) => target.push(id));
}

// SCHUMMELN!: fuer die zwei Faelle, in denen ein Gegenstand die Besitzerin
// wechselt, ohne den Ablagestapel zu sehen (Diebstahl, Handel) - siehe
// discardCard() fuer den haeufigeren Ablage-Fall.
function clearCheatIfLost(player, cardId) {
  if (player.attachments && player.attachments.cheatedItemId === cardId) player.attachments.cheatedItemId = null;
}

// Tod: "Du verlierst alle deine Karten - die anderen pluendern die Leiche.
// Stufe, Rasse und Klasse behaeltst du." Die Stufe blieb hier frueher NICHT
// erhalten (setLevel 1) und alles wanderte direkt auf die Ablagestapel -
// beides gegen die gedruckte Regel.
// Reihenfolge beim Pluendern: hoechste Stufe zuerst, dann der Reihe nach.
// Wer nicht verbunden ist, wird von advanceCardActionQueue uebersprungen; was
// danach uebrig bleibt, geht ueber restModus 'alles' auf die Ablagestapel.
function applyDeathConsequence(room, player) {
  const leiche = () => [...player.hand, ...equippedItemIds(player)];
  const anzahl = leiche().length;
  const alleAblegen = () => {
    // Über discardCard(), weil das nach Kartentyp auf den richtigen Stapel
    // legt: angelegte Gegenstände sind ausnahmslos Schatzkarten, auf dem
    // Tür-Ablagestapel würden sie beim Neumischen zu Türkarten.
    leiche().forEach((id) => discardCard(room, id));
    player.hand = [];
    player.equipped = newEquipped();
  };
  log(room, `${player.name} stirbt - Stufe ${player.level} bleibt, alle Karten sind weg (${anzahl}).`);
  if (!anzahl) return;
  const andere = room.players.filter((p) => p.id !== player.id).sort((a, b) => b.level - a.level);
  if (!andere.length) { alleAblegen(); return; }
  const queue = [];
  while (queue.length < anzahl) andere.forEach((p) => queue.push(p.id));
  // Stoererliste: advanceCardActionQueue filtert die Kandidaten.
  openQueuedCardAction(room, 'Leiche plündern', queue.slice(0, anzahl), () => {
    const ids = leiche();
    if (!ids.length) return null;
    return { kind: 'chooseCard', prompt: `Eine Karte von ${player.name} nehmen`, candidateIds: ids, takeFrom: player.id };
  }, player.id, 'alles');
  log(room, `Die anderen plündern die Leiche von ${player.name} (${anzahl} Karte(n), höchste Stufe zuerst).`);
}

// ---------------------------------------------------------------------------
// Automatische Berechnung von "Schlimme Dinge"/Fluch-Konsequenzen
// ---------------------------------------------------------------------------
// Wie bei den Monster-Verstärkerkarten oben gilt grundsätzlich das "Trust"-
// Prinzip (siehe Kommentar am Dateianfang): der Server zeigt den Original-
// text, Spieler:innen wenden ihn selbst an. Für "Schlimme Dinge" (verlorener
// Kampf) und Flüche gehen wir hier aber bewusst einen Schritt weiter, da
// diese Texte sich - anders als die hunderten sehr individuellen Sonder-
// kräfte - überwiegend auf eine begrenzte Menge klar erkennbarer Muster
// reduzieren lassen (Stufenverlust, Tod, fester Ausrüstungsverlust, würfel-
// basierte Effekte, Rassen-/Klassen-Bedingungen, echte Entweder-Oder-Wahl).
//
// Zwei Ebenen der Erkennung:
//  1) CONSEQUENCE_OVERRIDES: eine kuratierte, pro Kartenname geprüfte Tabelle
//     für alle Karten mit individueller, aber trotzdem eindeutig berechen-
//     barer Logik (Rassen-/Klassen-Bedingungen, Ausrüstungszustand, Werte-
//     Vergleiche, Wahlmöglichkeiten). Jede Regel ist unten mit dem exakten
//     Original-Kartentext kommentiert.
//  2) parseAutoConsequence: ein generischer Regex-Fallback für die übrigen,
//     immer wiederkehrenden einfachen Formulierungen ("Verliere N Stufen.").
//
// Bewusst AUSSERHALB des Umfangs (bleibt manuell, siehe Aufgabenstellung):
// alles, was ANDERE Spieler am Tisch betrifft (z. B. "jeder andere Spieler
// muss ..."), sowie die Handvoll Karten, die von Daten abhängen, die dieser
// Server nicht erfasst (Geschlecht, "Großer Gegenstand"-Flag, exakter
// Goldwert-Kombinationen) oder eine echte freie Auswahl unter mehreren
// eigenen Karten verlangen ("2 Gegenstände deiner Wahl" - dafür gibt es
// weiterhin das Ablege-Dropdown unten, das keine Rechnerei erfordert).
// Verifiziert gegen den kompletten Kartensatz, siehe tests/auto-consequence.test.js.

// Adjektiv-Formen, wie sie in Gegenstands-Texten für Rassen-/Klassen-Boni
// vorkommen (z.B. "+2 Bonus für Elfen"), gemappt auf den jeweiligen Karten-
// namen der Rassen-/Klassenkarte selbst ("ELF").
// ORK gehoert dazu, seit ORK spielbar ist: SCHÄDELHELM ist der Gegenstand,
// den ROTZ-ELEMENTAR einem Ork abnehmen muss. GNOM/BARDE fehlen bewusst - zu
// denen gibt es heute keinen Gegenstand mit "für Gnome/Barden" im Text.
const RACE_ADJECTIVE_DE = { ELF: 'Elfen', ZWERG: 'Zwerge', HALBLING: 'Halblinge', ORK: 'Orks' };
const CLASS_ADJECTIVE_DE = { ZAUBERER: 'Zauberer', PRIESTER: 'Priester', DIEB: 'Diebe', KRIEGER: 'Krieger' };

// TEMPORAERE ANMNESIE: solange der Fluch wirkt, zaehlen die ausliegenden
// Klassen- und Rassenkarten nicht - "ueberall als klassenloser Mensch". Wer
// die Karten als BESITZ braucht (Ablegen, Obergrenzen, Anzeige), liest
// weiter player.classes/player.races direkt. Derselbe Fluch wie in hasRace/
// hasClass (kind 'traitsVergessen', siehe hatFluchArt) - eine Stelle statt
// zwei getrennter Mechanismen fuer dieselbe Karte.

function hasRace(player, substr) {
  // TEMPORÄRE ANMNESIE: "ueberall als klassenloser Mensch gezaehlt" - die
  // Karten bleiben ausliegen, zaehlen aber nirgends (auch nicht als Vorteil).
  if (hatFluchArt(player, 'traitsVergessen')) return false;
  return player.races.some((id) => { const c = card(id); return c && c.name && c.name.toUpperCase().includes(substr.toUpperCase()); });
}

// Geschlecht: alle starten maennlich (player.gender), geaendert wird es nur
// durch Karten. Wer die FREUD'SCHEN SLIPPER traegt, "zaehlt gleichzeitig als
// beide Geschlechter, erleidet aber keine der Strafen" - fuer jede Regel, die
// ein Geschlecht NENNT, gilt er damit als keins von beiden. Geschlechtslos
// (STRICHMÄNNCHEN) wirkt genauso.
function istGeschlecht(player, g) {
  if (!player || !player.gender) return false;
  if (equippedItemIds(player).some((id) => { const c = card(id); return c && GENDER_IMMUNE_ITEMS.has(c.name); })) return false;
  return player.gender === g;
}

// Verleiht ein getragener Gegenstand diese Rasse/Klasse? (ITEM_GRANTS_TRAIT).
// `nurMonster` heisst: gilt nur dort, wo Monster reagieren - nicht fuer die
// Faehigkeiten der Rasse selbst.
function itemGrantsTrait(player, art, name, auchNurMonster) {
  // TEMPORÄRE ANMNESIE: geliehene Rassen/Klassen sind genauso vergessen.
  if (hatFluchArt(player, 'traitsVergessen')) return false;
  return equippedItemIds(player).some((id) => {
    const c = card(id);
    const regel = c && ITEM_GRANTS_TRAIT[c.name];
    if (!regel || !regel[art]) return false;
    if (regel.nurMonster && !auchNurMonster) return false;
    if (regel.nurWennBenutzt && player.zaubercouch !== 'ja') return false;
    return regel[art].toUpperCase().includes(name.toUpperCase());
  });
}

function hasPowerGroup(player, name) {
  return player.powerGroups.some((id) => { const c = card(id); return c && c.name && c.name.toUpperCase() === name.toUpperCase(); });
}

function slotLabelDe(slot) {
  return { head: 'Kopfbedeckung', armor: 'Rüstung', feet: 'Schuhwerk' }[slot] || slot;
}

// Führt eine einzelne, bereits eindeutig aufgelöste Aktion aus und mutiert
// dabei room/player. Gibt eine kurze, menschenlesbare Beschreibung für Log/UI
// zurück.
function applyPrimitiveAction(room, player, action) {
  switch (action.type) {
    case 'flohmarktSelectTarget1': {
      if (player.hand.includes(action.discardedId)) {
        removeFromHand(player, action.discardedId);
      } else {
        unequipSlotCard(player, action.discardedId);
      }
      discardCard(room, action.discardedId);
      
      const v = card(action.discardedId).gold || 0;
      const discards = room.treasureDiscard.filter(id => card(id) && typeof card(id).gold === 'number' && card(id).gold <= v);
      const options = discards.map(id => ({
        id,
        label: `"${card(id).name}" (${card(id).gold} G) ziehen`,
        action: { type: 'flohmarktSelectTarget2', v, firstId: id }
      }));
      options.push({ id: 'none', label: 'Keinen Schatz ziehen', action: { type: 'flohmarktFinish' } });
      
      openCardChoice(room, player, 'FLOHMARKT (1. Schatz)', options);
      return `wirft "${card(action.discardedId).name}" ab und wählt Schätze aus dem Ablagestapel`;
    }
    case 'flohmarktSelectTarget2': {
      room.treasureDiscard = room.treasureDiscard.filter(x => x !== action.firstId);
      player.hand.push(action.firstId);
      const remV = action.v;
      const discards = room.treasureDiscard.filter(id => card(id) && typeof card(id).gold === 'number' && card(id).gold <= remV);
      const options = discards.map(id => ({
        id,
        label: `"${card(id).name}" (${card(id).gold} G) ziehen`,
        action: { type: 'flohmarktFinish', secondId: id }
      }));
      options.push({ id: 'none', label: 'Keinen weiteren Schatz ziehen', action: { type: 'flohmarktFinish' } });
      
      openCardChoice(room, player, 'FLOHMARKT (2. Schatz)', options);
      return `zieht "${card(action.firstId).name}" und wählt einen weiteren Schatz`;
    }
    case 'flohmarktFinish': {
      if (action.secondId) {
        room.treasureDiscard = room.treasureDiscard.filter(x => x !== action.secondId);
        player.hand.push(action.secondId);
        return `zieht "${card(action.secondId).name}"`;
      }
      return 'beendet die Schatzsuche';
    }
    case 'findeEineKarteSort1': {
      const pa = room.pendingCardAction;
      const oldContext = action.context;
      oldContext.sortedCards.push(action.cardId);
      oldContext.cardsToSort = oldContext.cardsToSort.filter(id => id !== action.cardId);
      const remaining = oldContext.cardsToSort;
      const options = remaining.map(id => ({ id, label: card(id).name + ' (' + card(id).category + ')', action: { type: 'findeEineKarteSort2', cardId: id, context: oldContext } }));
      openCardChoice(room, player, 'Finde eine Karte - 2. Karte wählen', options);
      // Prevent finishCardAction from clearing pendingCardAction
      pa.keepPending = true;
      return 'wählt 1. Karte für ganz oben';
    }
    case 'findeEineKarteSort2': {
      const oldContext = action.context;
      oldContext.sortedCards.push(action.cardId);
      oldContext.cardsToSort = oldContext.cardsToSort.filter(id => id !== action.cardId);
      const lastId = oldContext.cardsToSort[0];
      oldContext.sortedCards.push(lastId);
      // Zurueck aufs Deck: drawDoor() zieht per pop() vom ENDE des Arrays
      // (Ende = oben). sortedCards ist [1. Wahl, 2. Wahl, Rest] - umgekehrt
      // gepusht landet die 1. Wahl ganz am Ende = ganz oben, wird also zuerst
      // gezogen. (Bugreport 2026-09-19: unshift setzte sie zuvor ans Ende des
      // Arrays, das per pop() aber das UNTERE Ende des Stapels ist.)
      oldContext.sortedCards.reverse().forEach(id => room.doorDeck.push(id));
      return 'wählt 2. Karte, 3. ergibt sich automatisch. Stapel sortiert!';
    }
    // Entscheidung bei Monstern mit Vorbeigeh-Option (BEKIFFTER GOLEM).
    case 'startRevealedCombat':
      startCombat(room, player.id, [action.cardId], { fromHand: false });
      return 'stellt sich dem Monster';
    case 'passMonster':
      room.doorDiscard.push(action.cardId);
      room.turnPhase = 'aerger';
      return `geht vorbei und winkt - "${card(action.cardId).name}" behaelt seinen Schatz`;
    // MÖCHTEGERN-VAMPIR: "wegjagen ... und seinen Schatz nimmt. Steige keine
    // Stufe auf dafuer!" Bewusst OHNE room.combat/applyCombatPotionAction -
    // es findet nie ein Kampf statt, den man beenden könnte.
    case 'wegjagenMitSchatz': {
      const m = card(action.cardId);
      room.doorDiscard.push(action.cardId);
      const drawn = zieheSchaetzeFuer(room, player, m.treasureCount || 0);
      drawn.forEach((cid) => player.hand.push(cid));
      player.lastReward = {
        seq: (player.lastReward ? player.lastReward.seq : 0) + 1,
        cardIds: drawn, levelsGained: 0, monsterNames: [m.name],
      };
      room.turnPhase = 'aerger';
      return (!drawn.length && (m.treasureCount || 0) && hatSchatzSperre(player))
        ? `jagt "${m.name}" weg, keine Stufe - ${player.name} steht auf der Störerliste und bekommt keinen Schatz`
        : `jagt "${m.name}" weg, ${drawn.length} Schatzkarte(n), keine Stufe`;
    }
    // PACKRATTE: "Wenn du keine Gegenstaende im Spiel hast, erhaeltst du einen
    // von der Packratte. Ziehe zwei offene Schaetze und waehle einen aus. Du
    // kannst stattdessen auch kaempfen, wenn du moechtest."
    case 'packratteGeschenk': {
      const m = card(action.cardId);
      room.doorDiscard.push(action.cardId);
      room.turnPhase = 'aerger';
      if (hatSchatzSperre(player)) {
        return `"${m.name}" will schenken, aber ${player.name} steht auf der Störerliste und bekommt nichts`;
      }
      const gezogen = zieheSchaetzeFuer(room, player, 2);
      if (!gezogen.length) return `"${m.name}" zieht weiter - der Schatzstapel ist leer`;
      if (gezogen.length === 1) {
        player.hand.push(gezogen[0]);
        return `"${m.name}" schenkt "${card(gezogen[0]).name}"`;
      }
      openQueuedCardAction(room, 'PACKRATTE', [player.id], () => ({
        kind: 'choice',
        prompt: 'Welchen der beiden offenen Schaetze nimmst du?',
        options: gezogen.map((id) => ({
          id: `schatz-${id}`,
          label: `"${card(id).name}" nehmen`,
          action: { type: 'nimmEinenVonZweien', nehmen: id, ablegen: gezogen.filter((x) => x !== id) },
        })),
      }));
      return `"${m.name}" legt zwei offene Schaetze vor: ${gezogen.map((id) => `"${card(id).name}"`).join(' / ')}`;
    }
    case 'nimmEinenVonZweien': {
      player.hand.push(action.nehmen);
      (action.ablegen || []).forEach((id) => discardCard(room, id));
      player.lastReward = {
        seq: (player.lastReward ? player.lastReward.seq : 0) + 1,
        cardIds: [action.nehmen], levelsGained: 0, monsterNames: ['PACKRATTE'],
      };
      return `nimmt "${card(action.nehmen).name}"`;
    }
    case 'useLampOnMonster': {
      handleUseLamp(room, player.id, action.lampCardId, action.monsterId);
      return '';
    }
    // DAS DUNGEON-CASINO: "Jederzeit spielbar, ausser im Kampf. Wirf
    // Gegenstaende im Wert von mindestens 500 Goldstuecken ab und wirf einen
    // Wuerfel: 1 - Verliere 1 Stufe. 2 - Wirf eine Karte aus deiner Hand oder
    // vom Tisch ab. 3 oder 4 - Zieh 1 Schatz, aufgedeckt. 5 - Zieh 2 Schaetze.
    // 6 - Zieh 3 Schaetze."
    case 'dungeonCasino': {
      const einsatz = applyPrimitiveAction(room, player, { type: 'discardItemsWorthGold', gold: 500 });
      const ausgang = wurfMitFenster(room, player, 'casino', (wurf) => {
        let folge;
        if (wurf === 1) folge = applyPrimitiveAction(room, player, { type: 'levelDelta', amount: 1 });
        else if (wurf === 2) folge = applyPrimitiveAction(room, player, { type: 'queuedDiscardOwn', count: 1, quelle: 'alles', cardName: 'DAS DUNGEON-CASINO', prompt: 'Eine Karte oder einen Gegenstand abwerfen' });
        else folge = applyPrimitiveAction(room, player, { type: 'drawTreasureN', n: wurf <= 4 ? 1 : (wurf === 5 ? 2 : 3) });
        return `Wuerfelwurf ${wurf} -> ${folge}`;
      });
      return `Einsatz: ${einsatz}. ${ausgang}`;
    }
    // LAUFENDE NASE: "bestich sie mit einem Gegenstand im Wert von
    // wenigstens 200 Goldstuecken und sie laesst dich gehen." Kein Schatz,
    // keine Stufe. Der Kartentext verlangt keinen GETRAGENEN Gegenstand -
    // also equipped + Hand, wie ueberall sonst bei Goldwert-Bedingungen
    // (pickItemsWorthGold, ZUNGENDÄMON oben).
    // ponytail: es wird automatisch der GUENSTIGSTE noch ausreichende
    // Gegenstand verwendet statt einer eigenen Auswahl-Runde - Aufruestweg
    // wie bei 'curseIncomeTax' oben: eine chooseCard-Runde (discardOwn) ueber
    // die qualifizierenden Gegenstaende.
    case 'bribeMonster': {
      const ids = equippedItemIds(player).concat(player.hand)
        .filter((iid) => ((card(iid) || {}).gold || 0) >= action.minGold);
      if (!ids.length) return 'kein Gegenstand mehr wertvoll genug';
      let chosen = ids[0];
      ids.forEach((iid) => { if (((card(iid) || {}).gold || 0) < ((card(chosen) || {}).gold || 0)) chosen = iid; });
      if (player.hand.includes(chosen)) removeFromHand(player, chosen); else unequipSlotCard(player, chosen);
      clearCheatIfLost(player, chosen);
      discardCard(room, chosen);
      room.doorDiscard.push(action.cardId);
      room.turnPhase = 'aerger';
      return `bestochen mit "${card(chosen).name}" - "${card(action.cardId).name}" laesst ${player.name} gehen`;
    }
    // PIT BULL: "darfst du ihn ablenken (automatische Flucht), indem du
    // einen Stab oder Aehnliches fallen laesst." Kein Kampf, kein Schatz,
    // keine Stufe.
    // ponytail: es wird automatisch der erste passende Stab genommen statt
    // einer eigenen Auswahl-Runde, falls mehrere getragen werden - gleicher
    // Aufruestweg wie bei 'bribeMonster' oben.
    case 'dropStaffEscape': {
      const ids = equippedItemIds(player).filter((iid) => STAFF_ITEMS.has((card(iid) || {}).name));
      if (!ids.length) return 'kein Stab mehr getragen';
      const chosen = ids[0];
      unequipSlotCard(player, chosen);
      clearCheatIfLost(player, chosen);
      discardCard(room, chosen);
      room.doorDiscard.push(action.cardId);
      room.turnPhase = 'aerger';
      return `laesst "${card(chosen).name}" fallen - "${card(action.cardId).name}" lenkt ab (automatische Flucht)`;
    }
    // EISKALTES HÄNDCHEN: kein Kampf, der Ring geht weg, die Monsterkarte
    // wird zur Ausruestung. Der Ring wird aus der Hand ODER der Ausruestung
    // genommen - "geben" heisst hergeben.
    case 'haendchenBesaenftigen': {
      const m = card(action.cardId);
      const ringId = player.hand.find((id) => (card(id) || {}).name === 'WUNSCHRING')
        || equippedItemIds(player).find((id) => (card(id) || {}).name === 'WUNSCHRING');
      if (!ringId) return 'kein Wunschring da';
      if (player.hand.includes(ringId)) removeFromHand(player, ringId); else unequipSlotCard(player, ringId);
      discardCard(room, ringId);
      player.equipped.special = [...specialSlotCards(player, 'special'), action.cardId];
      room.turnPhase = 'aerger';
      return `gibt den Wunschring - "${m.name}" wird die kleine Freundin (+3 im Kampf)`;
    }
    case 'death':
      applyDeathConsequence(room, player);
      return 'Tod';
    case 'levelDelta':
      setLevel(player, player.level - action.amount);
      return `-${action.amount} Stufe(n) (jetzt Stufe ${player.level})`;
    case 'levelUp':
      setLevel(player, player.level + action.amount);
      return `+${action.amount} Stufe(n) (jetzt Stufe ${player.level})`;
    // Monster-Schlimme-Dinge, die ueber diese eine Konsequenz hinaus
    // weiterwirken. Landen im selben Tracker wie die anhaltenden Flueche
    // (activeCurses) - deshalb beendet der WUNSCHRING sie mit, was gewollt
    // ist: im Spielgefuehl sind es Flueche, und der Ring sagt "beendet jeden
    // Fluch". Der Name kommt aus der Action, weil die Konsequenz-Funktionen
    // nur (player, room) sehen und die Monsterkarte selbst nicht kennen.
    case 'lingeringCurse':
      applyLingeringRule(room, player, action.name, action.cardId || null, action);
      return action.hinweis || 'anhaltende Wirkung';
    // VERFLUCHTER GEGENSTAND: die Id steht am Tracker-Eintrag, nicht in einem
    // zweiten Feld am Spieler - so verschwindet sie mit dem Eintrag, und der
    // WUNSCHRING braucht keine Sonderbehandlung.
    case 'curseItem': {
      const ziel = card(action.itemId);
      if (!ziel || !equippedItemIds(player).includes(action.itemId)) return 'der Gegenstand ist nicht mehr angelegt';
      player.activeCurses = player.activeCurses || [];
      player.activeCurses.push({
        cardId: action.cardId || null, name: 'VERFLUCHTER GEGENSTAND', kind: 'cursedItem',
        itemId: action.itemId, amount: 0, dauer: 'dauerhaft',
        hinweis: `"${ziel.name}" ist verflucht: keine Kräfte, und du wirst ihn nicht los.`,
      });
      return `"${ziel.name}" ist verflucht`;
    }
    case 'levelUpAllPriests': {
      const priester = room.players.filter((p) => hasClass(p, 'PRIESTER'));
      if (!priester.length) return 'niemand ist Priester - keine Wirkung';
      priester.forEach((p) => setLevel(p, p.level + 1));
      // Ausdruecklich erlaubt: "Dies darf die Siegesstufe sein."
      priester.forEach((p) => { if (!room.winner) checkWin(room, p); });
      return `Priester steigen 1 Stufe auf: ${priester.map((p) => p.name).join(', ')}`;
    }
    case 'drawTreasureN': {
      const drawn = zieheSchaetzeFuer(room, player, action.n);
      drawn.forEach((id) => player.hand.push(id));
      return (!drawn.length && action.n && hatSchatzSperre(player))
        ? `keine Schatzkarte - ${player.name} steht auf der Störerliste`
        : `${drawn.length} Schatzkarte(n) gezogen`;
    }
    // EINHEITSGRÖSSE: "Durchsuche den Schatzabwurfstapel, fange dabei oben an,
    // und tausche diese Karte gegen den ersten tragbaren Gegenstand, den du
    // findest. Wenn du ihn jetzt anlegst, kannst du ihn behalten und seinen
    // maximal moeglichen Bonus ausschoepfen, unabhaengig der normalen
    // Beschraenkungen zu Rasse, Klasse, Geschlecht, Anzahl deiner Koepfe und
    // so weiter." Es gibt also gar keine Wahl - der oberste tragbare
    // Gegenstand ist gemeint (treasureDiscard ist alt -> neu sortiert, "oben"
    // ist das Ende). Die Beschraenkungs-Ausnahme laeuft ueber denselben
    // Marker wie SCHUMMELN! (attachments.cheatedItemId).
    case 'skipNextTurn': {
      player.skipTurns = (player.skipTurns || 0) + 1;
      return 'naechster Zug faellt aus';
    }
    case 'takeFirstWearableFromTreasureDiscard': {
      const idx = [...room.treasureDiscard].reverse().findIndex((id) => (card(id) || {}).category === 'item');
      if (idx < 0) return 'kein tragbarer Gegenstand im Schatz-Ablagestapel';
      const echterIdx = room.treasureDiscard.length - 1 - idx;
      const [itemId] = room.treasureDiscard.splice(echterIdx, 1);
      player.hand.push(itemId);
      // ponytail: die Ausnahme laeuft ueber denselben Marker wie SCHUMMELN!,
      // und den gibt es nur einmal pro Person - wer schon einen geschummelten
      // Gegenstand hat, bekommt sie nicht (und sieht das im Log). Der Marker
      // hebt ausserdem nur die Gross- und Rassensperre auf, nicht Klasse/
      // Geschlecht/"maximal moeglicher Bonus" wie auf der Karte. Aufruestweg:
      // eine Liste geschummelter Gegenstaende statt eines einzelnen Feldes.
      let zusatz = '';
      if (player.attachments && !player.attachments.cheatedItemId) {
        player.attachments.cheatedItemId = itemId;
        zusatz = ' - die Anlege-Beschraenkungen gelten dafuer nicht';
      } else {
        zusatz = ' - die Beschraenkungs-Ausnahme entfaellt (es ist schon ein anderer Gegenstand geschummelt)';
      }
      return `"${card(itemId).name}" aus dem Schatz-Ablagestapel genommen${zusatz}`;
    }
    case 'discardDoorCardsFromHand': {
      const ids = player.hand.filter((id) => { const c = card(id); return c && c.type === 'door'; });
      if (!ids.length) return 'keine Türkarten auf der Hand';
      ids.forEach((id) => removeFromHand(player, id));
      ids.forEach((id) => discardCard(room, id));
      return `Türkarte(n) abgelegt (${ids.map((id) => card(id).name).join(', ')})`;
    }
    case 'discardHandSlotItemElseLevel': {
      const ids = player.equipped.hands.filter(Boolean);
      if (!ids.length) return applyPrimitiveAction(room, player, { type: 'levelDelta', amount: 1 });
      const id = ids[0];
      unequipSlotCard(player, id);
      discardCard(room, id);
      return `Hand-Gegenstand "${card(id).name}" abgelegt`;
    }
    case 'setLevel1':
      setLevel(player, 1);
      return 'auf Stufe 1 gesetzt';
    case 'setLevelToTableMin': {
      const minLevel = Math.min(...room.players.map((p) => p.level));
      setLevel(player, minLevel);
      return `auf Stufe ${player.level} gesetzt (niedrigste Stufe am Tisch)`;
    }
    // Konsequenz-Wuerfe laufen ueber wurfMitFenster: ohne Halter:in einer
    // Reaktionskarte synchron wie bisher, sonst mit Wurf-Fenster.
    case 'diceLevelLoss':
      return wurfMitFenster(room, player, 'stufenverlust', (roll) => {
        setLevel(player, player.level - roll);
        return `Würfelwurf ${roll} -> -${roll} Stufe(n)`;
      });
    // KATZENMÄDCHEN: "Wirf den Wuerfel und lege so viele Karten aus deiner
    // Hand ab." Gleiche Bauform wie diceLevelLoss, nur dass die Augenzahl die
    // Anzahl der Karten ist statt der Stufen.
    case 'diceDiscardHand':
      return wurfMitFenster(room, player, 'handkartenverlust', (roll) => {
        const anzahl = Math.min(roll, player.hand.length);
        if (!anzahl) return `Würfelwurf ${roll} -> keine Handkarten zum Ablegen`;
        applyPrimitiveAction(room, player, { type: 'queuedDiscardOwn', count: anzahl, quelle: 'hand',
          cardName: action.cardName || 'Schlimme Dinge', prompt: 'Eine Handkarte ablegen' });
        return `Würfelwurf ${roll} -> ${anzahl} Handkarte(n) ablegen`;
      });
    case 'diceThresholdDeath':
      return wurfMitFenster(room, player, 'schlimmeDinge', (roll) => {
        if (action.deathValues.includes(roll)) {
          applyDeathConsequence(room, player);
          return `Würfelwurf ${roll} -> Tod`;
        }
        setLevel(player, player.level - roll);
        return `Würfelwurf ${roll} -> -${roll} Stufe(n)`;
      });
    case 'discardSlot': {
      const id = getrageneSlotKarte(player, action.slot);
      // Gekoppelte Spezialausruestung faellt mit (GNOMEX-ANZUG mit der
      // Ruestung, SCHRECKLICHE SOCKEN mit dem Schuhwerk) - auch dann, wenn der
      // eigentliche Platz gerade leer ist.
      const gekoppelt = SPECIAL_SLOT_KEYS
        .flatMap((k) => specialSlotCards(player, k))
        .filter((sid) => (SPECIAL_SLOT_ITEMS[(card(sid) || {}).name] || {}).mitSlot === action.slot);
      gekoppelt.forEach((sid) => { unequipSlotCard(player, sid); discardCard(room, sid); });
      const mit = gekoppelt.length ? ` (mit ${gekoppelt.map((sid) => `"${card(sid).name}"`).join(', ')})` : '';
      if (!id) return gekoppelt.length ? `${slotLabelDe(action.slot)} war leer${mit} abgelegt` : `${slotLabelDe(action.slot)}: nichts getragen`;
      // unequipSlotCard statt player.equipped[slot] = null: die Karte kann
      // auch geschummelt auf dem Spezialplatz liegen.
      unequipSlotCard(player, id);
      discardCard(room, id);
      return `${slotLabelDe(action.slot)} "${card(id).name}"${mit} abgelegt`;
    }
    case 'discardBigItem': {
      // GALLERT-OKTAEDER: "Lass ALLE deine Grossen Gegenstaende fallen." -
      // deshalb alle betroffenen, nicht nur einer.
      const ids = equippedItemIds(player).filter((id) => istGrosserGegenstand(room, id));
      if (!ids.length) return 'kein Grosser Gegenstand getragen';
      ids.forEach((id) => { unequipSlotCard(player, id); discardCard(room, id); });
      return `Grosse Gegenstaende abgelegt: ${ids.map((id) => card(id).name).join(', ')}`;
    }
    // VERLIERE 1 GROSSEN GEGENSTAND bei einem Zwerg mit mehreren: der eine
    // ausgewaehlte Gegenstand aus CONSEQUENCE_OVERRIDES' 'choice'-Optionen.
    case 'discardSpecificItem': {
      if (!equippedItemIds(player).includes(action.itemId)) return 'Gegenstand nicht (mehr) getragen';
      unequipSlotCard(player, action.itemId);
      discardCard(room, action.itemId);
      return `Gegenstand "${card(action.itemId).name}" abgelegt`;
    }
    case 'discardAllEquipped': {
      const ids = equippedItemIds(player);
      if (!ids.length) return 'keine Ausrüstung getragen';
      ids.forEach((id) => discardCard(room, id));
      player.equipped = { head: null, armor: null, feet: null, hands: [null, null] };
      return `Ausrüstung abgelegt (${ids.map((id) => card(id).name).join(', ')})`;
    }
    case 'curseKleinerFehler': {
      let monsterIdx = -1;
      for (let i = room.doorDiscard.length - 1; i >= 0; i--) {
        if ((card(room.doorDiscard[i]) || {}).category === 'monster') {
          monsterIdx = i;
          break;
        }
      }
      if (monsterIdx === -1) {
        return 'verpufft mangels Monster im Ablagestapel';
      }
      const monsterId = room.doorDiscard.splice(monsterIdx, 1)[0];
      const mc = card(monsterId);
      
      if (room.combat) {
        room.combat.monsterIds.push(monsterId);
        room.combat.hasUndeadCurse = true;
        refreshCombatReady(room);
        return `belebt "${mc.name}" als Untoten wieder und wirft es in den Kampf`;
      } else {
        startCombat(room, player.id, [monsterId], { fromHand: false });
        room.combat.hasUndeadCurse = true;
        return `belebt "${mc.name}" aus dem Ablagestapel als Untoten wieder - ein Kampf beginnt`;
      }
    }
    case 'curseEdelmut': {
      const victim = (action.victim ? findPlayer(room, action.victim) : player) || player;
      const others = playerQueueFrom(room, victim, 'after').filter((id) => id !== victim.id);
      if (others.length === 0) return 'hat niemanden zum Beschenken';
      const queueIds = others.map(() => victim.id);
      openQueuedCardAction(room, (card(action.cardId) || {}).name || 'EDELMUT', queueIds, () => {
        const nextReceiverId = others.shift();
        if (!nextReceiverId) return null;
        const currentVictim = findPlayer(room, victim.id);
        const receiver = findPlayer(room, nextReceiverId);
        if (!currentVictim || !receiver) return null;
        
        const equip = equippedItemIds(currentVictim);
        if (equip.length > 0) {
          return {
            playerId: currentVictim.id,
            kind: 'chooseCard',
            prompt: `Gegenstand für ${receiver.name} wählen`,
            candidateIds: equip,
            giveTo: receiver.id
          };
        } else if (currentVictim.hand.length > 0) {
          // Stoererliste: gezogen wird nur, was der Empfaenger bekommen darf.
          const ziehbar = () => currentVictim.hand.filter((id) => darfSchatzBekommen(receiver, id));
          const count = Math.min(2, ziehbar().length);
          const drawn = [];
          for (let i = 0; i < count; i++) {
             const erlaubt = ziehbar();
             const id = erlaubt[Math.floor(Math.random() * erlaubt.length)];
             removeFromHand(currentVictim, id);
             clearCheatIfLost(currentVictim, id);
             drawn.push(id);
          }
          drawn.forEach((id) => receiver.hand.push(id));
          log(room, `${receiver.name} zieht ${drawn.length} Handkarte(n) von ${currentVictim.name}.`);
          return null;
        }
        return null;
      });
      return 'muss all sein Hab und Gut verteilen';
    }
    case 'discardWholeHand': {
      const ids = [...player.hand];
      if (!ids.length) return 'Hand war leer';
      player.hand = [];
      ids.forEach((id) => discardCard(room, id));
      return `ganze Hand abgelegt (${ids.length} Karte(n))`;
    }
    case 'discardWholeHandWithBonusDraw': {
      const ids = [...player.hand];
      player.hand = [];
      ids.forEach((id) => discardCard(room, id));
      let extra = '';
      if (ids.length > 1) {
        if (hatSchatzSperre(player)) {
          extra = ` - ${player.name} steht auf der Störerliste und bekommt keinen Extraschatz`;
        } else {
          const [t] = zieheSchaetzeFuer(room, player, 1);
          if (t) { player.hand.push(t); extra = `, +1 Schatz gezogen ("${card(t).name}")`; }
        }
      }
      return `ganze Hand abgelegt (${ids.length} Karte(n))${extra}`;
    }
    case 'discardRaceCards': {
      const ids = [...player.races];
      if (!ids.length) return 'keine Rassenkarte(n)';
      player.races = [];
      ids.forEach((id) => discardCard(room, id));
      if (player.raceCapCard) { discardCard(room, player.raceCapCard); player.raceCapCard = null; }
      return `Rassenkarte(n) abgelegt (${ids.map((id) => card(id).name).join(', ')})`;
    }
    case 'discardClassCards': {
      const ids = [...player.classes];
      if (!ids.length) return 'keine Klassenkarte(n)';
      player.classes = [];
      ids.forEach((id) => discardCard(room, id));
      if (player.classCapCard) { discardCard(room, player.classCapCard); player.classCapCard = null; }
      return `Klassenkarte(n) abgelegt (${ids.map((id) => card(id).name).join(', ')})`;
    }
    case 'discardSpecificClassCard': {
      const idx = player.classes.indexOf(action.cardId);
      if (idx < 0) return 'Klassenkarte nicht (mehr) vorhanden';
      const id = player.classes.splice(idx, 1)[0];
      discardCard(room, id);
      if (!player.classes.length && player.classCapCard) { discardCard(room, player.classCapCard); player.classCapCard = null; }
      return `Klassenkarte "${card(id).name}" abgelegt`;
    }
    // "Verliere zwei Karten": der/die Nächste bzw. Vorherige in der
    // Zugreihenfolge zieht je eine ZUFÄLLIGE Karte aus der Hand des Opfers
    // (welche genau, legt die Originalkarte nicht fest).
    case 'giveHandCardsToNeighbors': {
      if (!player.hand.length) return 'Hand war leer';
      const idx = room.players.findIndex((p) => p.id === player.id);
      const n = room.players.length;
      const results = [];
      const giveOne = (targetIdx) => {
        if (!player.hand.length) return;
        const target = room.players[targetIdx];
        if (!target || target.id === player.id) return;
        // Stoererliste: nur Karten, die das Ziel bekommen darf.
        const erlaubt = player.hand.filter((id) => darfSchatzBekommen(target, id));
        if (!erlaubt.length) { results.push(`${target.name} bekommt nichts (Störerliste)`); return; }
        const cid = erlaubt[Math.floor(Math.random() * erlaubt.length)];
        removeFromHand(player, cid);
        // SCHUMMELN!: dritter Transferweg neben Diebstahl/Handel, der nicht
        // ueber discardCard laeuft - Anhang muss auch hier mit der Karte weg.
        clearCheatIfLost(player, cid);
        target.hand.push(cid);
        results.push(`${target.name} erhält 1 Karte`);
      };
      if (n >= 2) giveOne((idx + 1) % n);
      if (n >= 3) giveOne((idx - 1 + n) % n);
      return results.length ? results.join('; ') : 'keine Mitspieler:innen vorhanden';
    }
    // "Regeln der Neuauflage": betrifft ALLE am Tisch, nicht nur die
    // ziehende Person (der Wunschring-Aufhebungs-Sonderfall bleibt manuell).
    case 'levelDeltaAllPlayers':
      room.players.forEach((p) => setLevel(p, p.level - action.amount));
      return `alle Spieler:innen -${action.amount} Stufe`;
    case 'discardPowerGroupCards': {
      const ids = [...player.powerGroups];
      if (!ids.length) return 'keine Machtgruppenkarte(n)';
      player.powerGroups = [];
      ids.forEach((id) => discardCard(room, id));
      if (player.powerGroupCapCard) { discardCard(room, player.powerGroupCapCard); player.powerGroupCapCard = null; }
      return `Machtgruppenkarte(n) abgelegt (${ids.map((id) => card(id).name).join(', ')})`;
    }
    // Sucht - beginnend mit der obersten Karte - im Türablagestapel nach der
    // ersten Karte der passenden Kategorie ("Rasse"/"Klasse"/Machtgruppe) und
    // ersetzt damit die eigene(n) verlorene(n) Karte(n); wird keine gefunden,
    // bleibt es beim reinen Verlust. Für WECHSLE DEINE KLASSE / WECHSLE DEINE
    // MACHTGRUPPE (die Rassen-Variante existiert im Kartensatz nicht).
    case 'replaceTraitFromDiscard': {
      const arrField = action.arrField; // 'classes' | 'powerGroups'
      const capField = action.capField; // 'classCapCard' | 'powerGroupCapCard'
      const currentIds = [...player[arrField]];
      if (!currentIds.length) return `${action.label} war bereits leer - Fluch wirkungslos`;
      const matches = (action.category === 'class' || action.category === 'race')
        // TRAIT_DOOR_CARDS: ORK/GNOM/BARDE stehen als "door_other" in den
        // Rohdaten, zaehlen hier aber als Rassen- bzw. Klassenkarte.
        ? (cc) => cc.category === action.category
          || TRAIT_DOOR_CARDS[(cc.name || '').toUpperCase()] === action.category
        : (cc) => cc.category === 'door_other' && POWER_GROUP_NAMES.has((cc.name || '').toUpperCase());
      // ERST suchen, DANN die eigene Karte ablegen: "Durchsuche den
      // Ablegestapel, beginnend mit der obersten Karte." Am Tisch liegt die
      // eigene Klasse zu diesem Zeitpunkt noch vor einem - wer zuerst ablegt,
      // findet sie als oberste Karte sofort wieder und wechselt zu sich
      // selbst.
      let ersatz = null;
      for (let i = room.doorDiscard.length - 1; i >= 0; i--) {
        const cc = card(room.doorDiscard[i]);
        if (cc && matches(cc)) { room.doorDiscard.splice(i, 1); ersatz = cc; break; }
      }
      currentIds.forEach((id) => discardCard(room, id));
      player[arrField] = [];
      if (player[capField]) { discardCard(room, player[capField]); player[capField] = null; }
      if (ersatz) {
        player[arrField].push(ersatz.id);
        return `${action.label} ersetzt durch "${ersatz.name}" (aus dem Ablagestapel)`;
      }
      return `${action.label} verloren - keine passende Ersatzkarte im Ablagestapel gefunden`;
    }
    case 'discardOneRaceCardIfAny': {
      if (!player.races.length) return 'war bereits ohne (nicht-menschliche) Rasse';
      const id = player.races.shift();
      discardCard(room, id);
      return `Rassenkarte "${card(id).name}" abgelegt`;
    }
    case 'discardClassCardMatchingElseDeath': {
      const idx = player.classes.findIndex((id) => { const c = card(id); return c && c.name && c.name.toUpperCase().includes(action.substr.toUpperCase()); });
      if (idx >= 0) {
        const id = player.classes.splice(idx, 1)[0];
        discardCard(room, id);
        return `Klassenkarte "${card(id).name}" abgelegt (statt Tod)`;
      }
      applyDeathConsequence(room, player);
      return 'Tod (keine passende Klasse)';
    }
    case 'discardMaxBonusItem': {
      const ids = equippedItemIds(player);
      let best = null;
      ids.forEach((id) => { const c = card(id); if (c && c.bonus && (!best || c.bonus > card(best).bonus)) best = id; });
      if (!best) return 'kein Gegenstand mit Bonus getragen';
      unequipSlotCard(player, best);
      discardCard(room, best);
      return `Gegenstand mit größtem Bonus abgelegt ("${card(best).name}")`;
    }
    case 'discardMaxGoldItem': {
      const ids = equippedItemIds(player);
      let best = null;
      ids.forEach((id) => { const c = card(id); const g = (c && c.gold) || 0; if (!best || g > ((card(best) && card(best).gold) || 0)) best = id; });
      if (!best) return 'keinen Gegenstand getragen';
      unequipSlotCard(player, best);
      discardCard(room, best);
      return `Gegenstand mit höchstem Goldwert abgelegt ("${card(best).name}")`;
    }
    case 'discardTraitBonusItems': {
      const traitIds = action.which === 'race' ? player.races : player.classes;
      const adjMap = action.which === 'race' ? RACE_ADJECTIVE_DE : CLASS_ADJECTIVE_DE;
      const adjectives = traitIds.map((id) => { const c = card(id); return c && adjMap[(c.name || '').toUpperCase()]; }).filter(Boolean);
      if (!adjectives.length) return `keine aktuelle ${action.which === 'race' ? 'Rasse' : 'Klasse'} mit bekanntem Bonus-Muster`;
      const ids = equippedItemIds(player).filter((id) => {
        const c = card(id);
        return c && adjectives.some((adj) => new RegExp(`für\\s+${adj}`, 'i').test(c.text || ''));
      });
      if (!ids.length) return 'keine passenden Bonus-Gegenstände getragen';
      ids.forEach((id) => { unequipSlotCard(player, id); discardCard(room, id); });
      return `Gegenstände abgelegt (${ids.map((id) => card(id).name).join(', ')})`;
    }
    case 'discardItemsAboveBonus': {
      const ids = equippedItemIds(player).filter((id) => { const c = card(id); return c && typeof c.bonus === 'number' && c.bonus > action.threshold; });
      if (!ids.length) return `keine Gegenstände über +${action.threshold} Bonus`;
      ids.forEach((id) => { unequipSlotCard(player, id); discardCard(room, id); });
      return `Gegenstände über +${action.threshold} Bonus abgelegt (${ids.map((id) => card(id).name).join(', ')})`;
    }
    case 'discardItemsByTextMatch': {
      const re = action.pattern;
      const ids = equippedItemIds(player).filter((id) => { const c = card(id); return c && (re.test(c.name || '') || re.test(c.text || '')); });
      if (!ids.length) return 'keine passenden Gegenstände getragen';
      ids.forEach((id) => { unequipSlotCard(player, id); discardCard(room, id); });
      return `Gegenstände abgelegt (${ids.map((id) => card(id).name).join(', ')})`;
    }
    case 'discardHandCardsMatching': {
      const ids = player.hand.filter((id) => action.predicate(card(id)));
      if (!ids.length) return 'keine passenden Karten auf der Hand';
      ids.forEach((id) => removeFromHand(player, id));
      ids.forEach((id) => discardCard(room, id));
      return `Karte(n) abgelegt (${ids.map((id) => card(id).name).join(', ')})`;
    }
    // --- Schlimme Dinge mit Fremdbeteiligung: andere Spieler:innen nehmen
    // sich Karten/Gegenstaende ueber die Aktions-Warteschlange (Task 3). Die
    // Reihenfolge (mode) steht bereits im Kartentext, siehe playerQueueFrom. ---
    case 'queuedTakeFromHand': {
      // Jede betroffene Person zieht EINE Karte aus der Hand des Opfers.
      // "ohne hinzusehen" (HIPPOGREIF) laesst sich hier nicht abbilden - die
      // waehlende Person sieht die Karten. ponytail: bewusst offen gelassen,
      // ein verdecktes Ziehen braeuchte eine eigene Anzeigeart im Client.
      const opfer = player;
      let queue = playerQueueFrom(room, opfer, action.mode);
      // BOBBELKOPF: "Lass jeden ORK im Spiel eine Karte aus deiner Hand
      // ziehen" - dieselbe Warteschlange, nur auf eine Rasse eingeschraenkt.
      if (action.nurRasse) queue = queue.filter((pid) => { const p2 = findPlayer(room, pid); return p2 && hasRace(p2, action.nurRasse); });
      if (!queue.length) return action.nurRasse ? `niemand am Tisch ist ${action.nurRasse}` : 'niemand sonst am Tisch';
      openQueuedCardAction(room, 'Schlimme Dinge', queue, (pid) => {
        if (!opfer.hand.length) return null; // nichts mehr zu holen: ueberspringen
        return { kind: 'chooseCard', prompt: `Eine Karte von ${opfer.name} nehmen`,
          candidateIds: opfer.hand.slice(), takeFrom: opfer.id };
      }, action.discardRest ? opfer.id : null);
      return `${queue.length} Mitspieler nehmen je 1 Handkarte`;
    }
    case 'queuedTakeItem': {
      const opfer = player;
      const queue = playerQueueFrom(room, opfer, action.mode);
      if (!queue.length) return 'niemand sonst am Tisch';
      openQueuedCardAction(room, 'Schlimme Dinge', queue, (pid) => {
        const ids = equippedItemIds(opfer);
        if (!ids.length) return null;
        return { kind: 'chooseCard', prompt: `Einen Gegenstand von ${opfer.name} nehmen`,
          candidateIds: ids, takeFrom: opfer.id };
      });
      return `${queue.length} Mitspieler nehmen je 1 Gegenstand`;
    }
    // PIÑATA: "Der Spieler, der nach dem Opfer an der Reihe ist, waehlt einen
    // der Gegenstaende des Opfers, die im Spiel sind. Leg es ab."
    // Spiegelbild zu queuedTakeItem: dieselbe Fremdauswahl, aber die Karte
    // geht auf den Ablagestapel statt in die Hand der waehlenden Person.
    case 'queuedDiscardItemOfVictim': {
      const opfer = player;
      const naechste = playerQueueFrom(room, opfer, 'after')[0];
      if (!naechste) return 'niemand sonst am Tisch';
      if (!equippedItemIds(opfer).length) return 'kein Gegenstand im Spiel';
      openQueuedCardAction(room, action.cardName || 'Schlimme Dinge', [naechste], () => {
        const ids = equippedItemIds(opfer);
        if (!ids.length) return null;
        return { kind: 'chooseCard', prompt: `Einen Gegenstand von ${opfer.name} ablegen`,
          candidateIds: ids, discardVictim: opfer.id };
      });
      return `${findPlayer(room, naechste).name} waehlt einen Gegenstand zum Ablegen`;
    }
    case 'discardItemsWorthGold': {
      // VERSICHERUNGSVERTRETER: "Verliere Gegenstaende im Wert von 1.000
      // Goldstuecken. Hast du nicht genug, verlierst du alles, was du hast."
      // ponytail: pickItemsWorthGold waehlt gierig (teuerste zuerst) ohne
      // Spielerwahl, welche Gegenstaende genau gehen - bei einem exakten
      // Grenzfall (z.B. zwei Gegenstaende reichen, aber ein anderes Paar
      // waere guenstiger) trifft der Server die Wahl statt der Person.
      // Aufruestweg: eine chooseCard-Runde wie bei 'curseIncomeTax', sobald
      // dafuer eine Anzeige existiert.
      const { summe, weg } = pickItemsWorthGold(player, action.gold);
      weg.forEach((id) => {
        if (player.hand.includes(id)) removeFromHand(player, id); else unequipSlotCard(player, id);
        discardCard(room, id);
      });
      return weg.length
        ? `Gegenstaende im Wert von ${summe} GS abgelegt: ${weg.map((id) => card(id).name).join(', ')}`
        : 'nichts Verkaufbares vorhanden';
    }
    case 'diceItemOrHandLoss': {
      // SCHNECKEN AUF SPEED: "Wuerfle und verliere entsprechend viele
      // Gegenstaende oder Karten von deiner Hand - deine Wahl." Die Wahl
      // laeuft ueber die Warteschlange an die eigene Person (roll-mal
      // hintereinander), damit sie die Karten selbst aussucht.
      return wurfMitFenster(room, player, 'schlimmeDinge', (roll) => {
        openQueuedCardAction(room, 'SCHNECKEN AUF SPEED', Array(roll).fill(player.id), () => {
          const ids = equippedItemIds(player).concat(player.hand);
          if (!ids.length) return null;
          return { kind: 'chooseCard', prompt: 'Eine Karte oder einen Gegenstand ablegen',
            candidateIds: ids, discardOwn: true };
        });
        return `Wuerfelwurf ${roll} -> ${roll} Karte(n)/Gegenstand/Gegenstaende ablegen`;
      });
    }
    // Mehrere eigene Karten/Gegenstaende nacheinander SELBST aussuchen und
    // ablegen ("Lege zwei Karten deiner Wahl ab", "Verliere 2 kleine
    // Gegenstaende deiner Wahl"). Gleiche Bauform wie diceItemOrHandLoss, nur
    // mit fester Anzahl und waehlbarer Quelle.
    case 'queuedDiscardOwn': {
      const quelle = () => {
        if (action.quelle === 'hand') return player.hand.slice();
        const ids = equippedItemIds(player);
        if (action.quelle === 'alles') return ids.concat(player.hand);
        return action.quelle === 'kleineGegenstaende' ? ids.filter((id) => !istGrosserGegenstand(room, id)) : ids;
      };
      if (!quelle().length) return 'nichts Passendes vorhanden';
      openQueuedCardAction(room, action.cardName || 'Schlimme Dinge', Array(action.count).fill(player.id), () => {
        const ids = quelle();
        if (!ids.length) return null;
        return { kind: 'chooseCard', prompt: action.prompt || 'Eine Karte ablegen', candidateIds: ids, discardOwn: true };
      });
      return `${action.count} Karte(n)/Gegenstand/Gegenstaende selbst aussuchen und ablegen`;
    }
    // KAMIKAZE-KOBOLDE: "Alle anderen verlieren 1 Gegenstand ihrer Wahl."
    // Anders als queuedTakeItem bekommt niemand etwas - jede Person legt
    // selbst ab.
    case 'queuedDiscardEachOther': {
      const queue = playerQueueFrom(room, player, 'allOthers');
      if (!queue.length) return 'niemand sonst am Tisch';
      openQueuedCardAction(room, action.cardName || 'Schlimme Dinge', queue, (pid) => {
        const p2 = findPlayer(room, pid);
        const ids = p2 ? equippedItemIds(p2) : [];
        if (!ids.length) return null;
        return { kind: 'chooseCard', prompt: 'Einen Gegenstand ablegen', candidateIds: ids, discardOwn: true };
      });
      return `${queue.length} Mitspieler legen je 1 Gegenstand ab`;
    }
    // GOTHYANKI: "Jeder Spieler, dessen Stufe niedriger ist als deine, steigt
    // eine Stufe auf. Du verlierst dann diese Anzahl an Stufen."
    case 'levelUpLowerPlayersAndLose': {
      const niedriger = room.players.filter((p) => p.id !== player.id && p.level < player.level);
      if (!niedriger.length) return 'niemand steht niedriger - keine Wirkung';
      // setLevel deckelt auf die Siegstufe; aufsteigen darf man dadurch laut
      // Karte trotzdem nicht gewinnen - das prueft checkWin ohnehin separat.
      niedriger.forEach((p) => setLevel(p, p.level + 1));
      setLevel(player, player.level - niedriger.length);
      return `${niedriger.map((p) => p.name).join(', ')} steigen je 1 Stufe auf, ${player.name} verliert ${niedriger.length}`;
    }
    // GESCHLECHTSUMWANDLUNG ("Die Umwandlung ist jedoch permanent") und
    // STRICHMÄNNCHEN ("Du bist weder maennlich noch weiblich, bis ein anderer
    // Spieler das Geschlecht wechselt ... dann nimmst du dessen Geschlecht
    // an"). value: 'm' | 'w' | null | 'wechseln'.
    case 'setGender': {
      const alt = player.gender;
      player.gender = action.value === 'wechseln'
        ? (alt === 'w' ? 'm' : (alt === 'm' ? 'w' : alt))
        : action.value;
      const wort = (g) => (g === 'w' ? 'weiblich' : (g === 'm' ? 'maennlich' : 'geschlechtslos'));
      // Zweiter Satz von STRICHMÄNNCHEN: wer geschlechtslos ist, uebernimmt
      // das Geschlecht der naechsten Person, die ihres wechselt.
      if (player.gender) {
        room.players.forEach((p2) => {
          if (p2.id !== player.id && p2.gender === null) {
            p2.gender = player.gender;
            log(room, `${p2.name} war geschlechtslos und ist jetzt ${wort(p2.gender)}.`);
          }
        });
      }
      return `Geschlecht: ${wort(alt)} -> ${wort(player.gender)}`;
    }
    case 'curseIncomeTax': {
      const ownIds = equippedItemIds(player).concat(player.hand).filter((id) => (card(id) || {}).gold > 0);
      if (!ownIds.length) return 'kein Gegenstand zum Ablegen - Fluch wirkungslos';
      
      const options = ownIds.map(id => ({
        id,
        label: `"${card(id).name}" (${card(id).gold} GS) ablegen`,
        action: { type: 'curseIncomeTaxStep2', cardId: id, mode: action.mode }
      }));
      
      openCardChoice(room, player, 'FLUCH! EINKOMMENSSTEUER', options);
      return 'wählt einen Gegenstand aus, um die Steuer festzulegen';
    }
    
    case 'curseIncomeTaxStep2': {
      const chosen = action.cardId;
      const gold = card(chosen).gold || 0;
      if (player.hand.includes(chosen)) removeFromHand(player, chosen); else unequipSlotCard(player, chosen);
      discardCard(room, chosen);
      
      const betroffene = playerQueueFrom(room, player, action.mode).map((pid) => findPlayer(room, pid)).filter(Boolean);
      const teile = betroffene.map((target) => {
        const { summe, weg } = pickItemsWorthGold(target, gold);
        weg.forEach((id) => {
          if (target.hand.includes(id)) removeFromHand(target, id); else unequipSlotCard(target, id);
          discardCard(room, id);
        });
        if (summe < gold) { setLevel(target, target.level - 1); return `${target.name}: alles abgelegt + 1 Stufe verloren`; }
        return `${target.name}: ${summe} GS abgelegt`;
      });
      return `"${card(chosen).name}" (${gold} GS) abgelegt - ${teile.join('; ')}`;
    }
    // DIEB "Diebstahl": der Wurf ist zu diesem Zeitpunkt schon geglueckt -
    // hier wechselt nur noch der gewaehlte kleine Gegenstand den Besitzer.
    case 'stealItemFrom': {
      const opfer = findPlayer(room, action.targetId);
      if (!opfer || !equippedItemIds(opfer).includes(action.cardId)) return 'Gegenstand nicht (mehr) getragen';
      if (card(action.cardId).name === 'BUMERANGDOLCH') {
        room.bumerangReturns = room.bumerangReturns || {};
        room.bumerangReturns[opfer.id] = (room.bumerangReturns[opfer.id] || []).concat(action.cardId);
      }
      unequipSlotCard(opfer, action.cardId);
      clearCheatIfLost(opfer, action.cardId);
      player.hand.push(action.cardId);
      refreshCombatReady(room);
      return `"${card(action.cardId).name}" von ${opfer.name} gestohlen`;
    }
    // PRIESTER "Auferstehung": der Preis fuer jede vom Ablagestapel geholte
    // Karte - eine selbst gewaehlte Handkarte.
    case 'discardSpecificHandCard': {
      if (!player.hand.includes(action.cardId)) return 'Karte nicht mehr auf der Hand';
      removeFromHand(player, action.cardId);
      discardCard(room, action.cardId);
      return `"${card(action.cardId).name}" abgelegt`;
    }
    case 'combo':
      return action.actions.map((a) => applyPrimitiveAction(room, player, a)).join('; ');
    // UNFASSBAR REICH: eine einzelne erbeutete Schatzkarte gegen eine neue tauschen.
    case 'schatzTauschen': {
      const idx = player.hand.indexOf(action.cardId);
      if (idx < 0) return '';
      player.hand.splice(idx, 1);
      discardCard(room, action.cardId);
      const neu = drawTreasure(room);
      if (neu) player.hand.push(neu);
      return `"${card(action.cardId).name}" abgelegt${neu ? `, dafür "${card(neu).name}" gezogen` : ' - der Schatzstapel ist leer'}`;
    }
    // ENTE DER VIELEN SACHEN: sieben Schritte "in dieser Reihenfolge". Die
    // Warteschlange laeuft auf dieselbe Person; Schritte ohne Entscheidung
    // erledigen sich im Callback und liefern null, worauf advanceCardActionQueue
    // sofort zum naechsten Schritt weiterrueckt. Schritt 7 ("Lege diese Karte
    // ab") ist schon passiert - handleUseCardPower legt vor dem Anwenden ab.
    case 'enteDerVielenSachen': {
      const naechsterId = playerQueueFrom(room, player, 'after')[0] || null;
      const naechster = naechsterId ? findPlayer(room, naechsterId) : null;
      // Die Ente liegt beim Ausspielen selbst schon obenauf - sie darf sich in
      // Schritt 3 nicht zurueckholen (gleiche Sorge wie `ausser` in
      // openCardCardChoice).
      const selbst = room.treasureDiscard[room.treasureDiscard.length - 1] || null;
      const oberste = (pile) => {
        for (let i = pile.length - 1; i >= 0; i--) if (pile[i] !== selbst) return pile[i];
        return null;
      };
      // Der shift() im Callback haelt nur deshalb Schritt mit der Queue, weil
      // ALLE Eintraege dieselbe Person sind: advanceCardActionQueue ruft
      // specFor genau einmal pro Eintrag auf und ueberspringt Getrennte, ohne
      // zu fragen - bei gemischten Queues wuerden sich Schritt und Eintrag
      // gegeneinander verschieben.
      const schritte = ['klauen', 'geben', 'ablagestapel', 'staendchen', 'stufe', 'ablegen', 'ablegen'];
      openQueuedCardAction(room, 'ENTE DER VIELEN SACHEN', schritte.map(() => player.id), () => {
        switch (schritte.shift()) {
          case 'klauen': {
            if (!naechster || !naechster.hand.length) return null;
            const id = naechster.hand[Math.floor(Math.random() * naechster.hand.length)];
            if (!darfSchatzBekommen(player, id)) {
              log(room, `${player.name} zieht eine Schatzkarte von ${naechster.name} - Störerliste, sie bleibt dort.`);
              return null;
            }
            removeFromHand(naechster, id);
            clearCheatIfLost(naechster, id);
            player.hand.push(id);
            // Ohne Kartenanhang: eine zufaellig gezogene Handkarte ist geheim.
            log(room, `${player.name} zieht 1 zufällige Karte aus der Hand von ${naechster.name}.`);
            return null;
          }
          // Stoererliste bei geben/ablagestapel: advanceCardActionQueue filtert.
          case 'geben':
            if (!naechster || !player.hand.length) return null;
            return { kind: 'chooseCard', prompt: `Eine Karte an ${naechster.name} geben`,
              candidateIds: player.hand.slice(), giveTo: naechster.id };
          case 'ablagestapel': {
            const kandidaten = [oberste(room.doorDiscard), oberste(room.treasureDiscard)].filter(Boolean);
            if (!kandidaten.length) return null;
            return { kind: 'chooseCard', prompt: 'Die oberste Karte welches Ablagestapels nimmst du?',
              candidateIds: kandidaten };
          }
          case 'staendchen':
            log(room, `${player.name} singt ein Ständchen.`);
            return null;
          case 'stufe':
            log(room, `${player.name}: ${applyPrimitiveAction(room, player, { type: 'levelUp', amount: 1 })}.`);
            return null;
          case 'ablegen':
            if (!player.hand.length) return null;
            return { kind: 'chooseCard', prompt: 'Eine Karte ablegen',
              candidateIds: player.hand.slice(), discardOwn: true };
          default:
            return null;
        }
      });
      return 'die Kette läuft';
    }
    case 'noEffect':
      return 'kein spielmechanischer Effekt';
    // GRASGNOLL: "Du verlierst drei Stufen. Du erhaeltst eine Stufe zurueck
    // fuer jeden Trank, den du sofort ablegst." Zurueck gibt es hoechstens,
    // was wirklich verloren ging - setLevel stoppt bei Stufe 1.
    case 'grasgnoll': {
      const vorher = player.level;
      const desc = applyPrimitiveAction(room, player, { type: 'levelDelta', amount: 3 });
      grasgnollTrankWahl(room, player, vorher - player.level);
      return desc;
    }
    case 'grasgnollTrank': {
      // Karte inzwischen weg (von Hand abgelegt, zweite Quelle): Wahl mit den
      // uebrigen Traenken neu anbieten statt sie still zu verlieren.
      if (!player.hand.includes(action.cardId)) {
        grasgnollTrankWahl(room, player, action.rest);
        return 'der Trank ist nicht mehr auf der Hand';
      }
      removeFromHand(player, action.cardId);
      discardCard(room, action.cardId);
      setLevel(player, player.level + 1);
      grasgnollTrankWahl(room, player, action.rest - 1);
      return `"${card(action.cardId).name}" abgelegt, +1 Stufe (jetzt Stufe ${player.level})`;
    }
    case 'grasgnollFertig':
      return 'keinen weiteren Trank abgelegt';
    // WUNSCHRING: "Beendet jeden Fluch." - siehe TREASURE_POWER_OVERRIDES.
    // Ist der gewaehlte Fluch inzwischen von selbst ausgelaufen, sagt die
    // Meldung das ehrlich: die Karte ist trotzdem verbraucht.
    case 'clearCurse': {
      // Genau der gewaehlte Eintrag (Id aus fluchBeendenSpec) - nicht alle
      // derselben Wirkungsart.
      const vorher = (player.activeCurses || []).length;
      player.activeCurses = (player.activeCurses || []).filter((f) => f.id !== action.id);
      if (player.activeCurses.length === vorher) return `Fluch "${action.name}" war schon vorbei - die Karte ist umsonst weg`;
      const ziel = action.itemId && card(action.itemId);
      return ziel ? `Fluch "${action.name}" auf "${ziel.name}" beendet` : `Fluch "${action.name}" beendet`;
    }
    default:
      return '';
  }
}

// CONSEQUENCE_OVERRIDES, DOOR_OTHER_AS_CURSE: siehe src/cards/consequences.js.
// resolveConsequenceSpec wird als Funktionsreferenz durchgereicht (STERBENDER
// FLUCH ruft sie zur Laufzeit auf - sie liest ihrerseits CONSEQUENCE_OVERRIDES,
// ein Zyklus, der sich dadurch auflöst, dass der Aufruf erst beim Anwenden der
// Konsequenz passiert, nicht beim Laden dieses Moduls).
const consequencesFactory = require('./src/cards/consequences.js');
const { CONSEQUENCE_OVERRIDES, DOOR_OTHER_AS_CURSE } = consequencesFactory({
  card, hasRace, hatRasseMitNachteil, hasPowerGroup, isMonsterEnhancerCard,
  resolveConsequenceSpec, bigItemCount, equippedItemIds, isBigItem, istGeschlecht,
  istGrosserGegenstand, getrageneSlotKarte,
  specialSlotRule,
  // Beide Tabellen/Funktionen stehen in server.js erst weiter unten - als
  // Funktion durchgereicht, damit sie zur Aufrufzeit gelesen werden.
  gegenstandHatSonderkraft: (name) => gegenstandHatSonderkraft(name),
  cursedItemIds: (player) => cursedItemIds(player),
});

const CONSEQUENCE_CONDITIONAL_RE = /\b(wenn|falls|sofern|es sei denn|außer|ansonsten|andernfalls|entweder)\b/i;
const CONSEQUENCE_CHOICE_OR_RE = /\bStufen?\b.{0,20}\boder\b|\boder\b.{0,20}\bStufen?\b/i;
// Wortgrenzen sind hier wichtig: ohne \b würde z.B. "Elfen" auch in "helfen"
// anschlagen und fälschlich einen eigentlich eindeutigen Text ausschließen.
const CONSEQUENCE_ITEM_OR_TRAIT_RE = /\bGegenst[aä]nde?\w*\b|\bRüstung\w*\b|\bKopfbedeckung\w*\b|\bSchuhwerk\w*\b|\bKlasse\w*\b|\bRasse\w*\b|\bHand\s+ab\b|\bMänner\b|\bFrauen\b|\bHalbling\w*\b|\bElfen\b|\bZwerg\w*\b/i;

// Generischer Fallback für die übrigen, immer wiederkehrenden einfachen
// Formulierungen (siehe Erklärung oben). Wird nur benutzt, wenn kein Eintrag
// in CONSEQUENCE_OVERRIDES existiert.
const GERMAN_NUMBER_WORDS = { eine: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6 };

function parseAutoConsequence(rawText) {
  if (!rawText) return null;
  const t = String(rawText).replace(/\\n/g, ' ').replace(/<br\s*\/?>/gi, ' ').replace(/<\/?[bi]>/gi, '');
  if (/\bdu\s+bist\s+tot\b/i.test(t) || /\bstirbst?\b/i.test(t) || /zu\s+Tode\s+\w+/i.test(t)) return { type: 'death' };
  if (/w[üu]rfle/i.test(t) && /stufen/i.test(t) && /gew[üu]rfelt/i.test(t)) return { type: 'diceLevelLoss' };
  const excluded = () => t.includes('(') || CONSEQUENCE_CONDITIONAL_RE.test(t) || CONSEQUENCE_CHOICE_OR_RE.test(t) || CONSEQUENCE_ITEM_OR_TRAIT_RE.test(t);
  const NUM = '(\\d+|eine|zwei|drei|vier|fünf|sechs)';
  const toAmount = (s) => (/^\d+$/.test(s) ? parseInt(s, 10) : GERMAN_NUMBER_WORDS[s.toLowerCase()]);
  // Verb zuerst: "Verliere(st) 2/zwei Stufen." / "... kostet dich 2 Stufen."
  let m = t.match(new RegExp(`(?:verlier\\w*|kostet)\\s+(?:du\\s+|dich\\s+)?${NUM}\\s+Stufen?\\b`, 'i'));
  // Zahl zuerst: "Zwei/2 Stufen verlieren."
  if (!m) m = t.match(new RegExp(`\\b${NUM}\\s+Stufen?\\s+verlier\\w*`, 'i'));
  if (m) {
    if (excluded()) return null;
    return { type: 'levelDelta', amount: toAmount(m[1]) };
  }
  if (/auf\s+Stufe\s+1\s+(reduziert|zur[üu]ckgesetzt|gesetzt)/i.test(t)) return { type: 'setLevel1' };
  return null;
}

// Löst EINE Quelle (ein Monster oder ein Fluch) auf: erst die kuratierte
// Override-Tabelle (per exaktem Kartennamen), sonst der generische Fallback.
// quelle (optional): die ganze Quelle {name, text, verstaerker} - FUNGUS
// braucht die Verstaerker des schon beendeten Kampfs.
function resolveConsequenceSpec(name, text, player, room, quelle) {
  const override = CONSEQUENCE_OVERRIDES[name];
  if (override) {
    const result = override(player, room, quelle || {});
    if (result !== undefined) return result; // null = bewusst manuell, sonst eine Aktion
  }
  return parseAutoConsequence(text);
}

// Wendet - wo eindeutig erkennbar - die Konsequenz(en) für eine verlorene
// Kampfrunde (ein oder mehrere Monster) oder einen Fluch automatisch an und
// trägt das Ergebnis direkt in room.pendingConsequence ein (muss von der
// aufrufenden Stelle bereits gesetzt sein). `sources` ist eine Liste von
// {name, text}. Bietet eine Karte eine echte Wahl an UND ist sie die
// einzige Quelle, wird stattdessen `pendingConsequence.choice` gesetzt und
// auf die Antwort der Spielerin gewartet (siehe handleResolveConsequenceChoice).
// HUHN AUF DEINEM KOPF: "Jeder Fluch oder alle Schlimmen Dinge, die deine
// Kopfbedeckung entfernen, nehmen das Huhn mit." Geprueft an den drei
// Stellen, ueber die ein automatisch oder manuell aufgeloester Fluch/Miese
// Dinge den Kopf-Slot leeren kann: autoApplyLossConsequence (automatische
// Anwendung), handleResolveConsequenceChoice (Wahlmoeglichkeit) und der
// discardCard-Zweig von handleApplyConsequenceAction (manuelles "Trust"-
// Werkzeug) - alle drei laufen nur waehrend einer offenen
// room.pendingConsequence. NICHT geprueft: Gegenstand-Waehler, die ueber
// handleResolveCardChoice aufgeloest werden (z.B. FLUCH! EINKOMMENSSTEUER) -
// diese generische Weiche bedient auch beliebige freiwillige Kartenkraefte,
// eine "gehoert zu einem Fluch"-Erkennung waere dort nicht zuverlaessig.
// Freiwilliges Ablegen laeuft durch keine dieser Stellen und nimmt das Huhn
// deshalb nicht mit.
function huhnMitKopfbedeckung(room, player, hatteKopf) {
  if (!hatteKopf || getrageneSlotKarte(player, 'head')) return;
  const vorher = (player.activeCurses || []).length;
  player.activeCurses = (player.activeCurses || []).filter((f) => f.name !== 'HUHN AUF DEINEM KOPF');
  if (player.activeCurses.length < vorher) log(room, `Mit der Kopfbedeckung ist auch das Huhn von ${player.name} weg.`);
}

function autoApplyLossConsequence(room, player, sources) {
  const pc = room.pendingConsequence;
  if (!pc) return;
  const hatteKopf = !!getrageneSlotKarte(player, 'head');
  if (sources.length === 1) {
    const spec = resolveConsequenceSpec(sources[0].name, sources[0].text, player, room, sources[0]);
    if (spec && spec.type === 'choice') {
      pc.choice = { sourceName: sources[0].name, options: spec.options.map((o) => ({ id: o.id, label: o.label })) };
      room._pendingChoiceActions = {};
      spec.options.forEach((o) => { room._pendingChoiceActions[o.id] = o.action; });
      return;
    }
  }
  const parts = [];
  sources.forEach((s) => {
    const spec = resolveConsequenceSpec(s.name, s.text, player, room, s);
    // Anhaltende Flüche: zusätzlich zum (fehlenden) Sofort-Effekt den Tracker
    // eintragen - unabhängig davon, ob spec null/choice/eine Aktion ist.
    if (LINGERING_CURSES[s.name]) addActiveCurse(room, player, s.name, s.cardId);
    if (!spec || spec.type === 'choice') return; // Mehrere Quellen mit echter Wahl gleichzeitig: bewusst manuell
    const desc = applyPrimitiveAction(room, player, spec);
    if (desc) parts.push(`${s.name}: ${desc}`);
  });
  if (parts.length) {
    pc.autoApplied = parts.join('; ');
    log(room, `${player.name}: Automatisch berechnet - ${pc.autoApplied}.`);
  }
  huhnMitKopfbedeckung(room, player, hatteKopf);
}

// GRASGNOLL: Wahl "Trank ablegen (+1 Stufe)" oder "fertig", solange noch
// Stufen zurueckzuholen sind. Als Trank zaehlt jede Kampf-Einmalkarte
// (isCombatPotionCard) - vom Nutzer so festgelegt 2026-09-22. Laeuft ueber
// pendingConsequence.choice, damit kein zweiter Wartezustand neben der
// offenen Konsequenz entsteht. Bots bestaetigen die Konsequenz direkt und
// legen damit keinen Trank ab.
function grasgnollTrankWahl(room, player, rest) {
  const pc = room.pendingConsequence;
  const traenke = player.hand.filter((id) => isCombatPotionCard(card(id)));
  if (!pc || pc.playerId !== player.id || rest <= 0 || !traenke.length) return;
  const options = traenke.map((id) => ({
    id: `trank-${id}`, label: `"${card(id).name}" ablegen: +1 Stufe zurück`,
    action: { type: 'grasgnollTrank', cardId: id, rest },
  })).concat({ id: 'fertig', label: 'Keinen (weiteren) Trank ablegen', action: { type: 'grasgnollFertig' } });
  pc.choice = { sourceName: 'GRASGNOLL', options: options.map((o) => ({ id: o.id, label: o.label })) };
  room._pendingChoiceActions = {};
  options.forEach((o) => { room._pendingChoiceActions[o.id] = o.action; });
}

function handleResolveConsequenceChoice(room, playerId, optionId) {
  const pc = room.pendingConsequence;
  if (!pc || pc.playerId !== playerId || !pc.choice) return;
  const stored = room._pendingChoiceActions;
  if (!stored || !stored[optionId]) return;
  const player = findPlayer(room, playerId);
  if (!player) return;
  const hatteKopf = !!getrageneSlotKarte(player, 'head');
  const option = pc.choice.options.find((o) => o.id === optionId);
  const sourceName = pc.choice.sourceName;
  // Erst schliessen, dann anwenden: eine Aktion darf eine Folgewahl oeffnen
  // (GRASGNOLL, siehe grasgnollTrankWahl).
  pc.choice = null;
  room._pendingChoiceActions = null;
  const desc = applyPrimitiveAction(room, player, stored[optionId]);
  huhnMitKopfbedeckung(room, player, hatteKopf);
  const zeile = `${sourceName}: ${option ? option.label : optionId} -> ${desc}`;
  // Anhaengen statt ersetzen: GRASGNOLL hat davor schon "-3 Stufen"
  // eingetragen (bei mehreren Monstern auch die der anderen).
  pc.autoApplied = pc.autoApplied ? `${pc.autoApplied}; ${zeile}` : zeile;
  log(room, `${player.name}: ${zeile}`);
  touchRoom(room);
}

// ---------------------------------------------------------------------------
// Schatzkarten-Sonderkräfte ("Sonstige"-Schatzkarten ohne Ausrüsten/Verkaufen)
// ---------------------------------------------------------------------------
// Analog zum "Trust"-Prinzip oben gilt: die riesige Mehrheit der 177
// "Sonstige"-Schatzkarten hat gar keinen anderen Spielmechanismus als
// Ausrüsten/Verkaufen/Ablegen, obwohl ihr Text eine eigene Sonderkraft
// beschreibt. Zwei Muster decken den Großteil automatisch ab:
//  1) isInstantLevelUpCard: einfache "Steige eine Stufe auf"-Karten.
//  2) TREASURE_POWER_OVERRIDES: kuratierte Einzelfälle (Wahlmöglichkeiten,
//     Ziel-Auswahl, Sonderregeln), nach demselben Muster wie
//     CONSEQUENCE_OVERRIDES oben - jeder Eintrag mit Original-Kartentext
//     kommentiert. `null` = bewusst manuell (Bedingung nicht prüfbar oder
//     außerhalb des Umfangs), eine Aktion = automatisch anwendbar.
// Bewusst AUSSERHALB des Umfangs: Karten, die einen "Großer Gegenstand"-Flag,
// eine "Untot"-Kennzeichnung auf Monstern, einen dauerhaften Fluch-/Status-
// Tracker (den es in diesem Server nicht gibt, siehe WUNSCHRING) oder eine
// echte freie Auswahl aus dem gesamten Ablagestapel mit Wertgrenze brauchen
// (FLOHMARKT, EINHEITSGRÖSSE) - siehe README für die vollständige Liste.

function normalizeCardText(raw) {
  return String(raw || '').replace(/\\n/g, ' ').replace(/<br\s*\/?>/gi, ' ').replace(/<\/?[bi]>/gi, '').replace(/\s+/g, ' ').trim();
}

const INSTANT_LEVEL_UP_RE = /^\s*Steige\s+(?:eine|\d+)\s+Stufen?\s+auf\b/i;

function isInstantLevelUpCard(c) {
  if (!c || c.category !== 'treasure_other') return false;
  if (TREASURE_POWER_OVERRIDES[c.name] !== undefined) return true; // kuratiert, siehe unten
  return INSTANT_LEVEL_UP_RE.test(normalizeCardText(c.text));
}

function isTopLevel(room, player) {
  const maxLevel = Math.max(...room.players.map((p) => p.level));
  return player.level >= maxLevel;
}

// TREASURE_POWER_OVERRIDES, COMBAT_POTION_OVERRIDES, DOOR_COMBAT_CARDS,
// POST_FLEE_ESCAPE_CARDS, GUARANTEED_FLEE_CARDS, GUARANTEED_FLEE_MAX_MONSTER_LEVEL:
// siehe src/cards/treasures.js.
const treasuresFactory = require('./src/cards/treasures.js');
const {
  TREASURE_POWER_OVERRIDES, COMBAT_POTION_OVERRIDES, DOOR_COMBAT_CARDS,
  POST_FLEE_ESCAPE_CARDS, GUARANTEED_FLEE_CARDS, GUARANTEED_FLEE_MAX_MONSTER_LEVEL,
} = treasuresFactory({ card, hasRace, findPlayer, currentPlayer, isTopLevel, combatParticipants, equippedItemIds, hatSchatzSperre });

// ROLL_REACTION_CARDS, ESCAPE_REACTION_CARDS, DOOR_POWER_CARDS, LINGERING_CURSES:
// siehe src/cards/reactions.js.
const reactionsFactory = require('./src/cards/reactions.js');
const {
  ROLL_REACTION_CARDS, ROLL_REROLL_CARDS, ROLL_REACTION_OWN_ROLL_ONLY,
  ESCAPE_REACTION_CARDS, DOOR_POWER_CARDS,
  LINGERING_CURSES, COMBAT_REACTION_CARDS,
  TREASURE_REACTION_CARDS,
} = reactionsFactory();

// Eine Aktion, die mehrere Personen NACHEINANDER betrifft. specFor(playerId)
// liefert je Person den Inhalt (kind/options/prompt/candidateIds) - so kann
// jede Person aus ihrer eigenen Hand waehlen. `discardRestPlayerId` (ANWALT)
// haengt am jeweiligen Eintrag selbst, nicht an einem losen Raum-Feld - sonst
// koennte er beim naechsten Eintrag im Backlog faelschlich mitlaufen.
//
// Ist bereits eine Warteschlange aktiv, wird die neue HINTEN angehaengt statt
// die laufende zu ueberschreiben: eine verlorene Kampfrunde mit zwei oder
// mehr "Schlimme Dinge"-Monstern (z.B. durch WANDERNDES MONSTER, Task 8, oder
// schlicht zwei aufgedeckte Monster) ruft applyPrimitiveAction synchron fuer
// JEDE Quelle auf (siehe autoApplyLossConsequence) - ohne Backlog wuerde die
// zweite Karte die erste Warteschlange kommentarlos verschlucken, noch bevor
// irgendwer sie zu Gesicht bekommt.
function openQueuedCardAction(room, cardName, queue, specFor, discardRestPlayerId, restModus) {
  const entry = { cardName, queue: queue.slice(), specFor, discardRestPlayerId: discardRestPlayerId || null, restModus: restModus || 'hand' };
  if (room._queuedCardAction) {
    room._queuedCardActionBacklog = room._queuedCardActionBacklog || [];
    room._queuedCardActionBacklog.push(entry);
    return;
  }
  room._queuedCardAction = entry;
  advanceCardActionQueue(room);
}

function advanceCardActionQueue(room) {
  const q = room._queuedCardAction;
  if (!q) {
    room.pendingCardAction = null;
    room._pendingCardActionResolvers = null;
    return;
  }
  const nextId = q.queue.shift();
  if (!nextId) {
    room._queuedCardAction = null;
    room.pendingCardAction = null;
    room._pendingCardActionResolvers = null;
    // ANWALT: "Lege alle uebrigen Karten ab." - erst wenn DIESE Warteschlange
    // durch ist, geht der Rest der Opfer-Hand weg (siehe
    // queuedTakeFromHand/action.discardRest). Gebunden an q, nicht an room.
    if (q.discardRestPlayerId) {
      const opfer = findPlayer(room, q.discardRestPlayerId);
      // 'alles': Rest einer nicht komplett gepluenderten Leiche (Hand UND
      // angelegte Gegenstaende), 'hand' (Standard): ANWALT.
      if (opfer && q.restModus === 'alles') {
        const rest = [...opfer.hand, ...equippedItemIds(opfer)];
        if (rest.length) {
          rest.forEach((id) => discardCard(room, id));
          opfer.hand = [];
          opfer.equipped = newEquipped();
          log(room, `${opfer.name}: ${rest.length} nicht gepluenderte Karte(n) abgelegt.`);
        }
      } else if (opfer && opfer.hand.length) {
        const desc = applyPrimitiveAction(room, opfer, { type: 'discardWholeHand' });
        log(room, `${opfer.name}: uebrige Handkarten abgelegt (${desc}).`);
      }
    }
    // Naechste wartende Warteschlange (Backlog) jetzt erst starten.
    if (room._queuedCardActionBacklog && room._queuedCardActionBacklog.length) {
      room._queuedCardAction = room._queuedCardActionBacklog.shift();
      return advanceCardActionQueue(room);
    }
    return;
  }
  const p = findPlayer(room, nextId);
  // Getrennte werden uebersprungen - sonst haengt die Partie an jemandem, der
  // gerade nicht am Geraet ist (gleiche Regel wie bei combatReadyRequired).
  if (!p || !p.connected) {
    // Frueher lautlos: bei einer Warteschlange, die nur aus EINER Person
    // besteht (ENTE DER VIELEN SACHEN), verpufft dadurch die ganze Karte -
    // das gehoert in den Verlauf, sonst sieht niemand, warum nichts passiert.
    log(room, `${p ? p.name : 'Jemand'} ist nicht da - der Schritt von "${q.cardName}" entfällt.`);
    return advanceCardActionQueue(room);
  }
  const spec = q.specFor(nextId);
  if (!spec) return advanceCardActionQueue(room);
  room.pendingCardAction = Object.assign({ playerId: nextId, cardName: q.cardName }, spec);
  // Der Resolver hat je "kind" eine andere Form - genau wie bei
  // openCardChoice/openCardTarget/openCardCardChoice. Eine Warteschlange darf
  // jede der drei Arten liefern (die Schnittstelle schraenkt "kind" nicht
  // ein), also muss hier dieselbe Fallunterscheidung stehen wie dort.
  if (spec.kind === 'targetPlayer') {
    room._pendingCardActionResolvers = spec.action;
  } else if (spec.kind === 'chooseCard') {
    room._pendingCardActionResolvers = null;
    // Stoererliste an EINER Stelle fuer alle Warteschlangen-Kartenwahlen
    // (HIPPOGREIF, ANWALT, LEPRACHAUN, EDELMUT, ENTE, Leiche, ...): nur
    // Karten anbieten, die die empfangende Person bekommen darf.
    const pa = room.pendingCardAction;
    const empfaenger = findPlayer(room, kartenwahlEmpfaengerId(pa));
    pa.candidateIds = pa.candidateIds.filter((id) => darfSchatzBekommen(empfaenger, id));
    if (!pa.candidateIds.length) {
      log(room, `${empfaenger ? empfaenger.name : 'Jemand'} steht auf der Störerliste - bei "${q.cardName}" gibt es nichts, was ankommen darf.`);
      return advanceCardActionQueue(room);
    }
  } else {
    room._pendingCardActionResolvers = {};
    (spec.options || []).forEach((o) => { room._pendingCardActionResolvers[o.id] = o.action; });
  }
}

function openCardChoice(room, player, cardName, options) {
  room.pendingCardAction = { playerId: player.id, cardName, kind: 'choice', options: options.map((o) => ({ id: o.id, label: o.label })) };
  room._pendingCardActionResolvers = {};
  options.forEach((o) => { room._pendingCardActionResolvers[o.id] = o.action; });
}

function openCardTarget(room, player, cardName, prompt, action) {
  room.pendingCardAction = {
    playerId: player.id,
    cardName,
    kind: 'targetPlayer',
    prompt: prompt || 'Ziel wählen',
    candidateIds: room.players.filter((p) => p.id !== player.id).map((p) => p.id),
  };
  room._pendingCardActionResolvers = action;
}

// `ausser` ist die Karte, die den Wähler ausgelöst hat: sie liegt zu diesem
// Zeitpunkt selbst schon auf dem Ablagestapel (handleUseCardPower legt zuerst
// ab) und waere sonst waehlbar - WÜNSCHELSTAB/GEDENKTAFEL/EINHEITSGRÖSSE
// koennten sich dadurch beliebig oft selbst zurueckholen.
function openCardCardChoice(room, player, cardName, prompt, ausser) {
  const candidates = [...room.doorDiscard, ...room.treasureDiscard]
    .filter((id) => id !== ausser && darfSchatzBekommen(player, id))
    .map((id) => card(id)).filter(Boolean);
  room.pendingCardAction = {
    playerId: player.id,
    cardName,
    kind: 'chooseCard',
    prompt: prompt || 'Karte aus den Ablagestapeln wählen',
    candidateIds: candidates.map((c) => c.id),
  };
  room._pendingCardActionResolvers = null;
}

// Wendet eine bereits aufgelöste Aktion an, die (anders als
// applyPrimitiveAction) eine ZWEITE Person betrifft (Ziel einer
// Spieler-Auswahl, z.B. "Klaue eine Stufe").
// EINSTWEILIGE VERFÜGUNG: Darf `wer` gerade Karten gegen `gegen` spielen?
function kartenSperreAktiv(room, wer, gegen) {
  return (room.kartenSperren || []).some((k) => k.gesperrt === wer && k.geschuetzt === gegen);
}

// RIESENSTINKTIER: gesperrt ist, wer NICHT selbst kaempft. Der Kartentext
// richtet sich an "deine Freunde" ("SIE können dir nicht helfen, dich
// hintergehen, oder ..."), nicht an die kaempfende Person - die spielt ihre
// eigenen Waffen und Traenke weiter. Eine Helfer:in kann es nicht geben, weil
// schon die Anfrage gesperrt ist.
function stinktierSperre(room, playerId) {
  if (!room.combat || !combatHasMonster(room, MONSTER_LOCKS_OTHERS)) return false;
  return !combatParticipants(room).some((p) => p.id === playerId);
}

// Kleidung und Ruestung im Sinne des Stinktiers: Kopf, Ruestung, Schuhe.
// Hand-Gegenstaende (Waffen, Schilde) sind keine Kleidung.
const KLEIDUNG_SLOTS = ['head', 'armor', 'feet'];

// "... bevor du nicht alle getragene Kleidung und Rüstung ablegst."
// ponytail: geprueft beim LESEN, nicht aufgeraeumt an jeder Stelle, an der
// Ausruestung verschwinden kann (Ablegen, Verkaufen, Fluch, Schlimme Dinge) -
// eine Pruefstelle statt fuenf, und sie kann nicht vergessen werden, wenn
// spaeter ein sechster Weg dazukommt.
function stinktierStrafeAktiv(player) {
  if (!player || !(player.activeCurses || []).some((f) => f.kind === 'noHelpHalfGold')) return false;
  if (KLEIDUNG_SLOTS.some((s) => getrageneSlotKarte(player, s))) return true;
  clearActiveCurseByKind(player, 'noHelpHalfGold');
  return false;
}

function applyTargetAction(room, actor, target, action) {
  switch (action.type) {
    case 'findeEineKarteSort1': {
      const pa = room.pendingCardAction;
      const oldContext = action.context;
      oldContext.sortedCards.push(action.cardId);
      oldContext.cardsToSort = oldContext.cardsToSort.filter(id => id !== action.cardId);
      const remaining = oldContext.cardsToSort;
      const options = remaining.map(id => ({ id, label: card(id).name + ' (' + card(id).category + ')', action: { type: 'findeEineKarteSort2', cardId: id, context: oldContext } }));
      openCardChoice(room, player, 'Finde eine Karte - 2. Karte wählen', options);
      // Prevent finishCardAction from clearing pendingCardAction
      pa.keepPending = true;
      return 'wählt 1. Karte für ganz oben';
    }
    case 'findeEineKarteSort2': {
      const oldContext = action.context;
      oldContext.sortedCards.push(action.cardId);
      oldContext.cardsToSort = oldContext.cardsToSort.filter(id => id !== action.cardId);
      const lastId = oldContext.cardsToSort[0];
      oldContext.sortedCards.push(lastId);
      // Zurueck aufs Deck: drawDoor() zieht per pop() vom ENDE des Arrays
      // (Ende = oben). sortedCards ist [1. Wahl, 2. Wahl, Rest] - umgekehrt
      // gepusht landet die 1. Wahl ganz am Ende = ganz oben, wird also zuerst
      // gezogen. (Bugreport 2026-09-19: unshift setzte sie zuvor ans Ende des
      // Arrays, das per pop() aber das UNTERE Ende des Stapels ist.)
      oldContext.sortedCards.reverse().forEach(id => room.doorDeck.push(id));
      return 'wählt 2. Karte, 3. ergibt sich automatisch. Stapel sortiert!';
    }
    case 'kartenSperre': {
      room.kartenSperren = (room.kartenSperren || []).concat({ geschuetzt: actor.id, gesperrt: target.id });
      return `${target.name} darf für den Rest des Zugs keine Karten mehr gegen ${actor.name} spielen`;
    }
    case 'stealLevel':
      setLevel(actor, actor.level + 1);
      setLevel(target, target.level - 1);
      return `${actor.name} +1 Stufe, ${target.name} -1 Stufe`;
    case 'stealBestItemGiveLevel': {
      const ids = equippedItemIds(target);
      let best = null;
      ids.forEach((id) => { const c = card(id); if (c && c.bonus && (!best || c.bonus > card(best).bonus)) best = id; });
      setLevel(target, target.level + 1);
      if (!best) return `${target.name} hatte keinen Gegenstand mit Bonus, bekommt trotzdem +1 Stufe`;
      unequipSlotCard(target, best);
      clearCheatIfLost(target, best);
      actor.hand.push(best);
      return `${actor.name} erhält "${card(best).name}" von ${target.name}, ${target.name} +1 Stufe`;
    }
    // HILF MIR: "Nimm einen Gegenstand von einem beliebigen Spieler. In diesem
    // Augenblick muss der Gegenstand den Unterschied zwischen Gewinnen und
    // Verlieren ausmachen." ponytail: die zweite Haelfte pruefen wir nicht -
    // sie ist eine Tischabsprache, keine berechenbare Bedingung.
    case 'takeAnyItem': {
      const ids = equippedItemIds(target);
      if (!ids.length) return `${target.name} trägt keinen Gegenstand`;
      let best = ids[0];
      ids.forEach((id) => { if ((card(id).bonus || 0) > (card(best).bonus || 0)) best = id; });
      unequipSlotCard(target, best);
      clearCheatIfLost(target, best);
      actor.hand.push(best);
      refreshCombatReady(room);
      return `${actor.name} nimmt "${card(best).name}" von ${target.name}`;
    }
    // ÜBERFALLTRANK: "Ein anderer Spieler (deiner Wahl) kaempft gegen das/die
    // Monster ... Der urspruengliche Spieler ist dann wieder am Zug und darf
    // den Raum pluendern, unabhaengig davon, ob der Kampf gewonnen oder
    // verloren wurde." originalActorId ueberlebt bis zum Kampfende (siehe
    // resolveCombatWin/finishFleeSuccess/handleAckConsequence) und sorgt dort
    // fuer die Pluenderphase statt "gabe" - room.turnIndex bleibt unveraendert,
    // der Zug ist nie gewechselt.
    case 'handOverCombat': {
      const c = room.combat;
      if (!c) return 'kein Kampf im Gange';
      // Die Karte darf auch von Aussenstehenden gespielt werden (kein
      // nurImKampf) - `actor` ist dann die Kartenspielerin, NICHT die
      // bisher kaempfende Person. Fuer Log und Zaubercouch zaehlt aber die
      // bisher kaempfende Person, deshalb hier ueber c.actorId lesen, bevor
      // er ueberschrieben wird.
      const vorherigerKaempfer = findPlayer(room, c.actorId);
      c.originalActorId = c.originalActorId || c.actorId;
      c.actorId = target.id;
      c.helperId = null;
      c.helperPending = null;
      c.bardenZwang = false; // die Zusage war an die alte Helfer:in gebunden
      // Die Zusage gehoerte zur alten Kampfpaarung - sie geht nicht auf die
      // neue kaempfende Person ueber.
      c.helperReward = 0;
      c.ready = {};
      zaubercouchFragen(target);
      // ZAUBERCOUCH: eine Uebergabe zaehlt als neue kaempfende Person - die
      // alte Antwort (kaempfende Person UND abgeloeste Hilfe) verfaellt, weil
      // beide jetzt keine combatParticipants mehr sind (refreshCombatReady
      // raeumt das auf), die neue kaempfende Person bekommt oben die Frage.
      refreshCombatReady(room);
      return `${target.name} kämpft jetzt anstelle von ${vorherigerKaempfer ? vorherigerKaempfer.name : 'der vorherigen Person'}`;
    }
    default:
      return '';
  }
}

function handleUseCardPower(room, playerId, cardId) {
  const player = findPlayer(room, playerId);
  if (!player || !player.hand.includes(cardId)) return;
  if (room.pendingCardAction || room.pendingConsequence) return;
  const c = card(cardId);
  if (!c) return;
  let spec;
  if (DOOR_POWER_CARDS[c.name] !== undefined) {
    spec = DOOR_POWER_CARDS[c.name](player, room);
  } else if (TREASURE_POWER_OVERRIDES[c.name] !== undefined) {
    spec = TREASURE_POWER_OVERRIDES[c.name](player, room);
  } else if (isInstantLevelUpCard(c)) {
    spec = { type: 'levelUp', amount: 1 };
  } else {
    return; // keine automatisierte Sonderkraft für diese Karte
  }
  if (spec == null) {
    log(room, `${player.name} kann die Sonderkraft von "${c.name}" gerade nicht automatisch nutzen (Bedingung nicht erfüllt oder Karte bleibt manuell).`);
    touchRoom(room);
    return;
  }
  removeFromHand(player, cardId);
  discardCard(room, cardId);
  announceCardPower(room, player, cardId);
  if (spec.type === 'choice') {
    openCardChoice(room, player, c.name, spec.options);
    log(room, `${player.name} spielt "${c.name}" - Wahl nötig.`, [cardId]);
    touchRoom(room);
    return;
  }
  if (spec.type === 'multiCardSelection') {
    // playerId ist Pflicht: renderCardAction() im Client zeigt ohne
    // uebereinstimmende playerId fuer NIEMANDEN (auch nicht fuer die
    // handelnde Person) die eigentliche Auswahl-UI, sondern nur "Warte auf
    // ?...", weil pa.playerId dann nie mit myInfo.playerId matcht.
    room.pendingCardAction = { kind: 'multiCardSelection', playerId: player.id, cardName: c.name, sourceCardId: cardId, actionType: spec.actionType };
    log(room, `${player.name} spielt "${c.name}" und wählt Karten zum Abwerfen aus.`, [cardId]);
    touchRoom(room);
    return;
  }
  if (spec.type === 'findeEineKarte') {
    if (room.doorDeck.length < 3) {
      // Der Nachschub wird VORN angehaengt: drawDoor() zieht per pop() vom
      // ENDE des Arrays (das Ende ist "oben"/als naechstes dran) - die paar
      // verbliebenen alten Karten sollen also oben bleiben, der frisch
      // gemischte Ablagestapel wird darunter (=vorn im Array) angehaengt.
      room.doorDeck = shuffle(room.doorDiscard).concat(room.doorDeck);
      room.doorDiscard = [];
    }
    // "Die drei NAECHSTEN Tuerkarten des Decks" = die als naechstes gezogen
    // werden, also die letzten drei Eintraege des Arrays (siehe drawDoor:
    // pop() vom Ende). Bugreport 2026-09-19: splice(0, 3) griff bisher die
    // UNTERSTEN drei Karten ab, nicht die obersten.
    const top3 = room.doorDeck.splice(-3, 3);
    const initialContext = { cardsToSort: top3, sortedCards: [] };
    const options = top3.map(id => ({ id, label: `${card(id).name} (${card(id).category})`, action: { type: 'findeEineKarteSort1', cardId: id, context: initialContext } }));
    openCardChoice(room, player, 'Finde eine Karte - oberste Karte wählen', options);
    log(room, `${player.name} spielt "${c.name}" und sortiert die obersten Türkarten.`, [cardId]);
    touchRoom(room);
    return;
  }
  if (spec.type === 'targetPlayer') {
    openCardTarget(room, player, c.name, spec.prompt, spec.action);
    log(room, `${player.name} spielt "${c.name}" - Ziel nötig.`, [cardId]);
    touchRoom(room);
    return;
  }
  if (spec.type === 'chooseDiscardedCard') {
    openCardCardChoice(room, player, c.name, undefined, cardId);
    log(room, `${player.name} spielt "${c.name}" - Kartenwahl aus dem Ablagestapel nötig.`, [cardId]);
    touchRoom(room);
    return;
  }
  const desc = applyPrimitiveAction(room, player, spec);
  log(room, `${player.name} spielt "${c.name}": ${desc}.`, [cardId]);
  touchRoom(room);
}

// Wickelt einen aufgeloesten Kartendialog ab. Hat die Aktion dabei SELBST
// einen neuen Dialog geoeffnet (PACKRATTE: "Ziehe zwei offene Schaetze und
// waehle einen aus" oeffnet aus der Kampf/Geschenk-Wahl heraus eine zweite
// Wahl), bleibt der stehen - sonst raeumte die Abwicklung ihn sofort wieder
// weg und das Spiel lief ohne die Auswahl weiter.
function finishCardAction(room, pa) {
  if (room.pendingCardAction !== pa) return;
  if (pa.keepPending) return;
  if (room._queuedCardAction) advanceCardActionQueue(room);
  else { room.pendingCardAction = null; room._pendingCardActionResolvers = null; }
}

function handleResolveCardChoice(room, playerId, optionId) {
  const pa = room.pendingCardAction;
  if (!pa || pa.playerId !== playerId || pa.kind !== 'choice') return;
  const stored = room._pendingCardActionResolvers;
  if (!stored || !stored[optionId]) return;
  const player = findPlayer(room, playerId);
  if (!player) return;
  const option = pa.options.find((o) => o.id === optionId);
  const action = stored[optionId];
  // Eine Wahl kann selbst wieder eine Ziel-Auswahl auslösen (z.B. "Sinnloser
  // Akt der Freundlichkeit" -> "Auf Mitspieler anwenden"). Eine laufende
  // Warteschlange rueckt dabei NICHT sofort vor - das passiert erst, wenn die
  // Ziel-Wahl in handleResolveCardTarget aufgeloest wird (return unten).
  if (action.type === 'targetPlayer') {
    room.pendingCardAction = null;
    room._pendingCardActionResolvers = null;
    openCardTarget(room, player, pa.cardName, action.prompt, action.action);
    log(room, `${player.name}: "${pa.cardName}" -> ${option ? option.label : optionId} - Ziel nötig.`);
    touchRoom(room);
    return;
  }
  const COMBAT_ACTION_TYPES = new Set(['modifier', 'endCombatNoLevel', 'removeHelper', 'killMonsterInCombat', 'removeOneMonster', 'doubleStrength', 'combatAddMonster', 'combatReplaceMonster', 'treatMonsterAsLevel1', 'tripleItemBonus', 'forceSelfAsHelper', 'schatzUmtauschAnmelden', 'zeroMonsterTreasure', 'duplicateMonsterMommy', 'freundlichFightOn', 'juckpulverDiscard', 'verstaerkerAufMonster', 'trojanerOhneMonster', 'trojanerMitMonster']);
  const sourceCard = pa.sourceCardId ? card(pa.sourceCardId) : null;
  const desc = COMBAT_ACTION_TYPES.has(action.type)
    ? applyCombatPotionAction(room, player, action, sourceCard)
    : applyPrimitiveAction(room, player, action);
  log(room, `${player.name}: "${pa.cardName}" -> ${option ? option.label : optionId} (${desc}).`);
  finishCardAction(room, pa);
  touchRoom(room);
}

function handleResolveCardTarget(room, playerId, targetId) {
  const pa = room.pendingCardAction;
  if (!pa || pa.playerId !== playerId || pa.kind !== 'targetPlayer') return;
  if (!pa.candidateIds.includes(targetId)) return;
  const stored = room._pendingCardActionResolvers;
  const player = findPlayer(room, playerId);
  const target = findPlayer(room, targetId);
  if (!stored || !player || !target) return;
  const desc = applyTargetAction(room, player, target, stored);
  log(room, `${player.name}: "${pa.cardName}" -> ${target.name} (${desc}).`);
  finishCardAction(room, pa);
  touchRoom(room);
}

function handleResolveCardCardChoice(room, playerId, chosenCardId) {
  const pa = room.pendingCardAction;
  if (!pa || pa.playerId !== playerId || pa.kind !== 'chooseCard') return;
  if (!pa.candidateIds.includes(chosenCardId)) return;
  const player = findPlayer(room, playerId);
  if (!player) return;
  // Stoererliste: die Kandidaten sind beim Oeffnen schon gefiltert, die
  // Sperre kann aber seither entstanden sein.
  const chosen = card(chosenCardId);
  if (!darfSchatzBekommen(findPlayer(room, kartenwahlEmpfaengerId(pa)), chosenCardId)) {
    log(room, `"${chosen ? chosen.name : chosenCardId}" ist eine Schatzkarte - Störerliste, nichts übergeben.`);
    finishCardAction(room, pa);
    touchRoom(room);
    return;
  }
  // Schlimme Dinge mit Fremdbeteiligung (HIPPOGREIF/ANWALT/LEPRACHAUN/
  // NETZ-TROLL): die gewaehlte Karte kommt vom OPFER, nicht aus einem
  // Ablagestapel - siehe queuedTakeFromHand/queuedTakeItem.
  // candidateIds ist eine Momentaufnahme: zwischen dem Oeffnen des Waehlers
  // und der Antwort kann die Karte den Besitzer gewechselt haben (verkauft,
  // gestohlen, gehandelt, von einer vorherigen Person aus derselben
  // Warteschlange genommen). Ohne diese Pruefung liefe unequipSlotCard ins
  // Leere und die Karte laege danach doppelt im Spiel.
  const gehoert = (p, id) => p.hand.includes(id) || equippedItemIds(p).includes(id);
  if (pa.takeFrom) {
    const opfer = findPlayer(room, pa.takeFrom);
    if (!opfer) return;
    if (!gehoert(opfer, chosenCardId)) {
      log(room, `"${chosen ? chosen.name : chosenCardId}" gehoert ${opfer.name} nicht mehr - nichts genommen.`);
      finishCardAction(room, pa);
      touchRoom(room);
      return;
    }
    // VERFLUCHTER GEGENSTAND: "wenn du stirbst, wird der Fluch auf den
    // uebertragen, der ihn von deinem Koerper entfernt." Der Eintrag wird
    // gelesen, BEVOR die Karte das Opfer verlaesst - danach raeumt
    // cursedItemIds ihn als verwaist weg.
    const verfluchtEintrag = (opfer.activeCurses || [])
      .find((f) => f.kind === 'cursedItem' && f.itemId === chosenCardId);
    if (opfer.hand.includes(chosenCardId)) removeFromHand(opfer, chosenCardId);
    else unequipSlotCard(opfer, chosenCardId);
    clearCheatIfLost(opfer, chosenCardId);
    player.hand.push(chosenCardId);
    if (verfluchtEintrag) {
      opfer.activeCurses = (opfer.activeCurses || []).filter((f) => f !== verfluchtEintrag);
      player.activeCurses = player.activeCurses || [];
      player.activeCurses.push(Object.assign({}, verfluchtEintrag));
      log(room, `Der Fluch auf "${chosen ? chosen.name : chosenCardId}" geht auf ${player.name} über - eine große Hilfe.`);
    }
    log(room, `${player.name}: "${pa.cardName}" -> "${chosen ? chosen.name : chosenCardId}" von ${opfer.name} genommen.`, [chosenCardId]);
  } else if (pa.giveTo) {
    // ENTE DER VIELEN SACHEN: Gegenstueck zu takeFrom - die eigene Wahl geht
    // an jemand anderen statt auf den Ablagestapel.
    const empfaenger = findPlayer(room, pa.giveTo);
    if (!empfaenger || !gehoert(player, chosenCardId)) {
      log(room, `"${chosen ? chosen.name : chosenCardId}" ist nicht mehr da - nichts verschenkt.`);
      finishCardAction(room, pa);
      touchRoom(room);
      return;
    }
    if (player.hand.includes(chosenCardId)) removeFromHand(player, chosenCardId);
    else unequipSlotCard(player, chosenCardId);
    clearCheatIfLost(player, chosenCardId);
    empfaenger.hand.push(chosenCardId);
    log(room, `${player.name}: "${pa.cardName}" -> 1 Karte an ${empfaenger.name} gegeben.`);
  } else if (pa.discardVictim) {
    // PIÑATA: die waehlende Person nimmt nichts - der Gegenstand geht weg.
    const opfer = findPlayer(room, pa.discardVictim);
    if (!opfer || !gehoert(opfer, chosenCardId)) {
      log(room, `"${chosen ? chosen.name : chosenCardId}" gehoert ${opfer ? opfer.name : '?'} nicht mehr - nichts abgelegt.`);
      finishCardAction(room, pa);
      touchRoom(room);
      return;
    }
    if (opfer.hand.includes(chosenCardId)) removeFromHand(opfer, chosenCardId);
    else unequipSlotCard(opfer, chosenCardId);
    clearCheatIfLost(opfer, chosenCardId);
    discardCard(room, chosenCardId);
    log(room, `${player.name}: "${pa.cardName}" -> "${chosen ? chosen.name : chosenCardId}" von ${opfer.name} abgelegt.`, [chosenCardId]);
  } else if (pa.discardOwn) {
    // SCHNECKEN AUF SPEED: die eigene Wahl geht direkt auf den Ablagestapel.
    if (!gehoert(player, chosenCardId)) {
      log(room, `"${chosen ? chosen.name : chosenCardId}" ist nicht mehr da - nichts abgelegt.`);
      finishCardAction(room, pa);
      touchRoom(room);
      return;
    }
    if (player.hand.includes(chosenCardId)) removeFromHand(player, chosenCardId);
    else unequipSlotCard(player, chosenCardId);
    discardCard(room, chosenCardId);
    log(room, `${player.name}: "${pa.cardName}" -> "${chosen ? chosen.name : chosenCardId}" abgelegt.`, [chosenCardId]);
  } else {
    const idx = room.doorDiscard.indexOf(chosenCardId);
    if (idx >= 0) room.doorDiscard.splice(idx, 1);
    else {
      const tIdx = room.treasureDiscard.indexOf(chosenCardId);
      if (tIdx >= 0) room.treasureDiscard.splice(tIdx, 1);
      else return;
    }
    player.hand.push(chosenCardId);
    log(room, `${player.name}: "${pa.cardName}" -> "${chosen ? chosen.name : chosenCardId}" aus dem Ablagestapel geholt.`, [chosenCardId]);
  }
  finishCardAction(room, pa);
  // ZUNGENDÄMON: "Gegenstand deiner Wahl VOR dem Kampf ablegen" - siehe
  // room._preCombatCost in handleDrawDoor. Der Kampf beginnt erst JETZT,
  // nachdem der Preis bezahlt ist.
  if (room._preCombatCost) {
    const cost = room._preCombatCost;
    room._preCombatCost = null;
    startCombat(room, player.id, [cost.monsterCardId], { fromHand: false });
    log(room, `${player.name} stellt sich danach "${card(cost.monsterCardId).name}".`, [cost.monsterCardId]);
  }
  touchRoom(room);
}

// ---------------------------------------------------------------------------
// Phase 2: Auf Ärger aus sein (freiwilliges Monster aus der Hand)
// ---------------------------------------------------------------------------

// Eine offene Entscheidung (Kartenwahl, Wurf, Konsequenz) blockiert die
// Zugphasen: sonst laesst sich ein Preis, der noch nicht bezahlt ist, durch
// eine Folgeaktion aus dem Weg raeumen - advanceCardActionQueue ueberschreibt
// room.pendingCardAction kommentarlos. Der Client blendet die Knoepfe in
// dieser Lage ohnehin aus (client.js), hier steht der Riegel serverseitig.
function zugAktionOffen(room) {
  return !!(room.pendingCardAction || room.pendingConsequence || room.pendingRoll);
}

function handlePlayMonsterFromHand(room, playerId, cardId) {
  const player = currentPlayer(room);
  if (!player || player.id !== playerId) return;
  if (room.turnPhase !== 'aerger' || room.combat || zugAktionOffen(room)) return;
  if (!player.hand.includes(cardId)) return;
  const c = card(cardId);
  if (!c || c.category !== 'monster') return;
  // TOURISTENFALLE: "Du darfst nicht 'Auf Aerger aus sein'."
  if (hatFluchArt(player, 'keinAergerSuchen')) {
    log(room, `${player.name} sitzt in der Touristenfalle und darf nicht auf Ärger aus sein.`);
    touchRoom(room);
    return;
  }
  // Auch ein aus der Hand gespieltes Monster greift nicht an, wenn sein Text
  // das ausschließt - die Karte ist dann trotzdem verbraucht.
  if (monsterRefusesTarget(cardId, player)) {
    removeFromHand(player, cardId);
    room.doorDiscard.push(cardId);
    log(room, `"${c.name}" greift ${player.name} nicht an und zieht weiter.`, [cardId]);
    touchRoom(room);
    return;
  }
  removeFromHand(player, cardId);
  startCombat(room, player.id, [cardId], { fromHand: true });
}

function handleSkipToLoot(room, playerId) {
  const player = currentPlayer(room);
  if (!player || player.id !== playerId) return;
  if (room.turnPhase !== 'aerger' || room.combat || zugAktionOffen(room)) return;
  room.turnPhase = 'pluendern';
  log(room, `${player.name} geht dem Ärger aus dem Weg. Phase 3: Raum plündern.`);
  touchRoom(room);
}

// ---------------------------------------------------------------------------
// Phase 3: Raum plündern
// ---------------------------------------------------------------------------

function handleLootRoom(room, playerId) {
  const player = currentPlayer(room);
  if (!player || player.id !== playerId) return;
  if (room.turnPhase !== 'pluendern' || zugAktionOffen(room)) return;
  const id = drawDoor(room);
  if (id) {
    player.hand.push(id);
    // Gleiche Beute-Animation wie nach einem Kampfsieg - privat im yourInfo,
    // denn die gezogene Karte ist eine Handkarte und damit geheim (kind
    // unterscheidet nur die Ueberschrift im Client).
    player.lastReward = {
      seq: (player.lastReward ? player.lastReward.seq : 0) + 1,
      cardIds: [id], levelsGained: 0, monsterNames: [], kind: 'loot',
    };
    log(room, `${player.name} plündert den Raum: 1 verdeckte Türkarte auf die Hand.`);
  }
  setzeZugphase(room, 'gabe');
  touchRoom(room);
}

// ---------------------------------------------------------------------------
// Dauerwirkungen von Karten (Basis-Set)
//
// Bis hierher wertete der Server nur Kartentexte aus, die jemand aktiv
// ausspielt oder die als Konsequenz auflaufen. Daneben hat das Basis-Set eine
// ganze Reihe DAUERWIRKUNGEN, die ohne Zutun gelten und schlicht ignoriert
// wurden: "+6 gegen Zwerge", "Greift niemanden mit Stufe 3 oder niedriger
// an", "Flüche haben keine Wirkung". Wer Schutzsandalen trug, bekam den
// Fluch trotzdem ab - genau daran ist das hier aufgefallen.
//
// Bewusst kuratierte Tabellen statt Regex über den Kartentext: die
// Formulierungen sind zu uneinheitlich ("Elfen haben -4!" gegenüber "+6
// gegen Elfen"), und ein Regex spränge auf Karten an, die dieselbe Formel
// in einer AKTIV auszuspielenden Kraft verwenden - der Zauberer hat "+1 Bonus
// auf Weglaufen", aber nur, wenn er dafür Karten ablegt. Jede Regel steht
// mit dem Original-Kartentext im Kommentar. Ein Test prüft, dass jeder
// Tabellenname zu einer echten Karte gehört.
//
// ponytail: nur Basis-Set, wie beauftragt. Die Erweiterungs-Sets haben
// dieselben Muster (z.B. "+5 gegen Elfen" bei RIESENKAKERLAKE) - dort
// jeweils dieselben Tabellen ergänzen, die Mechanik darunter passt schon.
// ---------------------------------------------------------------------------

function hasClass(player, substr) {
  if (hatFluchArt(player, 'traitsVergessen')) return false; // siehe hasRace
  // ZAUBERCOUCH: "... wirst du in allen Belangen ... als Zauberer angesehen."
  // ponytail: die ZAUBERCOUCH wirkt auch unter TEMPORAERER ANMNESIE - sie ist
  // ein Gegenstand, keine Erinnerung.
  if (itemGrantsTrait(player, 'class', substr, true)) return true;
  return player.classes.some((id) => { const c = card(id); return c && c.name && c.name.toUpperCase().includes(substr.toUpperCase()); });
}

function combatParticipants(room) {
  const c = room.combat;
  return [findPlayer(room, c.actorId), c.helperId ? findPlayer(room, c.helperId) : null].filter(Boolean);
}

function combatHasMonster(room, nameSet) {
  return !!room.combat && room.combat.monsterIds.some((id) => { const c = card(id); return c && nameSet.has(c.name); });
}

// LUSTMONSTER: "ein Charakter des anderen Geschlechts". istGeschlecht liefert
// fuer das geschlechtslose STRICHMÄNNCHEN ueberall false - fuer eine Regel,
// die ein Geschlecht NENNT, ist es keins von beiden, und zwar auf beiden
// Seiten der Bedingung.
function passendeHilfe(room) {
  const c = room.combat;
  if (!c || !c.helperId) return false;
  const actor = findPlayer(room, c.actorId);
  const helfer = findPlayer(room, c.helperId);
  return istAnderesGeschlecht(actor, helfer);
}

function istAnderesGeschlecht(a, b) {
  if (!a || !b || !a.gender || !b.gender) return false;
  return (istGeschlecht(a, 'm') && istGeschlecht(b, 'w'))
    || (istGeschlecht(a, 'w') && istGeschlecht(b, 'm'));
}

// Dauerwirkungstabellen (CURSE_PROOF_ITEMS, MONSTER_REFUSES, ...): siehe
// src/cards/passives.js. Aufruf hier - erst nach hasRace/hasClass, aber vor
// der ersten Benutzung der Tabellen (curseProtectionItem gleich darunter).
const passivesFactory = require('./src/cards/passives.js');
const {
  CURSE_PROOF_ITEMS, MONSTER_REFUSES, MONSTER_REFUSES_TREASURE, MONSTER_AUTO_KILL_BY_RACE,
  MONSTER_PASS_OPTION, MONSTER_TRAIT_BONUS, MONSTER_IGNORES_LEVEL,
  MONSTER_IGNORES_WEAPONS, MONSTER_IGNORES_BONUSES, MONSTER_FORBIDS_HELP, MONSTER_LOCKS_OTHERS,
  FLEE_ITEM_BONUS,
  FLEE_MONSTER_MOD, FLEE_IMPOSSIBLE, FLEE_AUTOMATIC, FLEE_PENALTY,
  FLEE_TREASURE_ITEMS, MONSTER_EXTRA_LEVEL, FIRE_ITEMS,
  CLASS_COMBAT_DISCARD, UNDEAD_MONSTERS, CLASS_FLEE_DISCARD,
  ITEM_CONDITIONAL_BONUS, SPECIAL_SLOT_ITEMS, SPECIAL_SLOTS,
  COMBAT_START_OPTIONS, COMBAT_START_COST, STAFF_ITEMS,
  TRAIT_DOOR_CARDS, MONSTER_SEES_AS_RACE, RACE_ITEM_BONUS, FLEE_AUTOMATIC_BY_RACE,
  GENDER_IMMUNE_ITEMS, ATTACHMENT_CARDS, FREE_HAND_ITEMS, DEADLY_ITEMS_BY_RACE,
  BACKSTAB_ITEMS, ITEM_GRANTS_TRAIT, MONSTER_REQUIRES_OTHER_GENDER,
  waffenIds,
} = passivesFactory({
  card, hasRace, hasClass, equippedItemIds, istGeschlecht, monsterSeesRace, handItemIds, hatFluchArt, hatRasseMitNachteil,
});
const SPECIAL_SLOT_KEYS = Object.keys(SPECIAL_SLOTS);
// Fuer die Logzeilen: das (einzige) Monster, gegen das keine Boni zaehlen.
// Fuer die Logzeilen: das Monster im laufenden Kampf, gegen das keine Boni
// zaehlen (GEMEINE GHOULE, GUMMI-GOLEM).
function monsterIgnoringBonusesName(room) {
  const id = room.combat && room.combat.monsterIds.find((i) => { const c = card(i); return c && MONSTER_IGNORES_BONUSES.has(c.name); });
  return id ? card(id).name : [...MONSTER_IGNORES_BONUSES][0];
}

// --- Fluchschutz -----------------------------------------------------------
// SCHUTZSANDALEN: siehe CURSE_PROOF_ITEMS in src/cards/passives.js.
function curseProtectionItem(player) {
  return equippedItemIds(player).find((id) => { const c = card(id); return c && CURSE_PROOF_ITEMS.has(c.name); }) || null;
}

// --- Anhaltende Flüche (M1) -------------------------------------------------
// LINGERING_CURSES (src/cards/reactions.js): Flüche, die nach dem Ziehen
// weiterwirken statt nur einmalig. Ergänzt CONSEQUENCE_OVERRIDES (die dort
// bleiben `() => null`/`noEffect`, weil sie keinen SOFORT-Effekt haben) um
// einen laufenden Zustand je Spieler:in.
function addActiveCurse(room, player, cardName, cardId) {
  const regel = LINGERING_CURSES[cardName];
  if (!regel) return;
  applyLingeringRule(room, player, cardName, cardId, regel);
}

// Das Eintragen selbst - getrennt vom Nachschlag in LINGERING_CURSES, damit
// auch Monster-Schlimme-Dinge (Primitiv 'lingeringCurse') denselben Tracker
// benutzen koennen, ohne eine zweite Tabelle danebenzustellen.
function applyLingeringRule(room, player, cardName, cardId, regel) {
  // ponytail: defensiv statt eine Invariante vorauszusetzen - ältere
  // Test-Helper/Spielstände ohne activeCurses sollen nicht abstürzen.
  if (!player.activeCurses) player.activeCurses = [];
  // ZWERGENBIER: "-4 ... ausser du bist ein Zwerg ... dann stattdessen +4".
  // Einmal beim Eintragen aufgeloest, damit der Eintrag reine Daten bleibt.
  let amount = regel.amount || 0;
  if (regel.amountFuerRasse) {
    const treffer = Object.keys(regel.amountFuerRasse).find((r) => hasRace(player, r));
    if (treffer) amount = regel.amountFuerRasse[treffer];
  }
  player.activeCurses.push({
    cardId, name: cardName, kind: regel.kind, amount, dauer: regel.dauer,
    // Klartext fuer die Anzeige - steht bei der Regel selbst (src/cards/
    // reactions.js), damit der Client die Wirkung nicht nachbauen muss.
    hinweis: regel.hinweis || '',
  });
  log(room, `${player.name} steht unter dem Fluch "${cardName}".`);
  // WINZIGE HÄNDE: "Du kannst keine Gegenstaende tragen, die mehr als eine
  // Hand benoetigen." Der haeufige Fall ist, dass der Zweihaender schon
  // getragen wird - sonst wirkte der Fluch nur auf kuenftige Gegenstaende.
  // Die Karte wandert zurueck auf die Hand (nicht auf den Ablagestapel): der
  // Text nimmt sie einem nicht weg, man kann sie nur nicht mehr benutzen.
  if (regel.kind === 'noTwoHandedItems') {
    equippedItemIds(player).forEach((id) => {
      const g = card(id);
      if (!g || (g.handsCost || 0) < 2) return;
      unequipSlotCard(player, id);
      player.hand.push(id);
      log(room, `"${g.name}" braucht zwei Haende - ${player.name} legt ihn zurueck auf die Hand.`, [id]);
    });
  }
  // STINKER: "Wenn dir in dem Moment, in dem diese Karte ausgespielt wird,
  // jemand in einem Kampf hilft, zieht er sich straffrei zurueck ... (Aber
  // wenn Laufende Nase oder sein Schatten im Kampf sind, fluechten sie sofort
  // und hinterlassen ihren Schatz.)" Beides nur fuer den Kampf, in dem die
  // verfluchte Person gerade steckt - sonst waere es ein Angriff auf einen
  // fremden Kampf.
  if (regel.kind === 'noHelp' && room.combat
    && combatParticipants(room).some((p) => p.id === player.id)) {
    if (room.combat.helperId) {
      const weg = findPlayer(room, room.combat.helperId);
      room.combat.helperId = null;
      room.combat.helperReward = 0;
      room.combat.bardenZwang = false;
      log(room, `${weg ? weg.name : 'Die Helfer:in'} zieht sich straffrei zurück - niemand bleibt neben dem Gestank.`);
      refreshCombatReady(room);
    }
    const NASEN = new Set(['LAUFENDE NASE', 'DIE SCHATTENNASE']);
    [...room.combat.monsterIds].forEach((mid) => {
      const m = card(mid);
      if (!m || !NASEN.has(m.name)) return;
      log(room, `"${m.name}" hält den Gestank nicht aus, flüchtet und lässt den Schatz da.`, [mid]);
      applyCombatPotionAction(room, player, { type: 'removeOneMonster', leavesTreasure: true, monsterId: mid, name: m.name }, null);
    });
  }
}

// Gezieltes Loeschen nach Wirkungsart - der EINZIGE Weg, einen Eintrag aus
// activeCurses zu nehmen. Gebraucht von den Eintraegen, die nicht nach fester
// Dauer enden, sondern wenn eine Bedingung eintritt (Stinktier: alle Kleidung
// abgelegt; Weihnachtsmann: ein Monster ohne Hilfe getoetet) - und vom
// WUNSCHRING. Rueckgabewert sagt, ob wirklich etwas weg ist - die aufrufende
// Stelle loggt nur dann. Eine index-basierte Variante gab es hier bis
// 2026-09-17; sie ist weg, weil ein gespeicherter Index veraltet, sobald die
// Liste sich unter einem offenen Wahldialog verschiebt.
function clearActiveCurseByKind(player, kind) {
  const vorher = (player.activeCurses || []).length;
  if (!vorher) return false;
  player.activeCurses = player.activeCurses.filter((f) => f.kind !== kind);
  return player.activeCurses.length < vorher;
}

// "Nächster Kampf"-Flüche gelten für GENAU den einen folgenden Kampf - egal
// ob er mit Sieg oder Flucht endet. Wird an beiden Stellen aufgerufen, an
// denen ein Kampf wirklich vorbei ist (resolveCombatWin, finishFleeSuccess).
function clearNextCombatCurses(players) {
  (players || []).forEach((p) => {
    if (!p || !p.activeCurses || !p.activeCurses.length) return;
    p.activeCurses = p.activeCurses.filter((f) => f.dauer !== 'naechsterKampf');
  });
}

function curseCombatModifier(player) {
  return (player.activeCurses || [])
    .filter((f) => f.kind === 'combatMalus')
    .reduce((sum, f) => sum + f.amount, 0);
}

function curseSuppressesItemBonuses(player) {
  return (player.activeCurses || []).some((f) => f.kind === 'noItemBonusExceptArmor');
}

// LUSTMONSTER: "in deinem naechsten Kampf werden deine Hand-Gegenstaende
// nutzlos" - dieselbe Ausblendung, die MONDJUNGFERN im Kampf macht, nur an
// der Person statt am Monster.
function curseHidesHandItems(player) {
  return (player.activeCurses || []).some((f) => f.kind === 'noHandItemBonus');
}

// Die verfluchten Gegenstaende, die noch angelegt sind. Geprueft wird beim
// LESEN, ob der Gegenstand ueberhaupt noch getragen wird: "Der Gegenstand kann
// durch einen anderen Fluch zerstoert werden", und dann endet der Fluch mit
// ihm (gleiche Bauform wie stinktierStrafeAktiv). Aufgeraeumt wird je Eintrag,
// nicht nach Wirkungsart - sonst nimmt ein zerstoerter Gegenstand den Fluch
// eines zweiten mit.
// Menge statt Einzelwert: die Karte steckt mehrfach im Stapel, und die drei
// Leser (combatTotals, die Ablege-/Verkaufs-/Handelssperren, die Uebertragung
// beim Tod) brauchen ohnehin eine Mengenpruefung.
function cursedItemIds(player) {
  const flueche = (player && player.activeCurses) || [];
  if (!flueche.some((f) => f.kind === 'cursedItem')) return new Set();
  // Massstab ist der BESITZ, nicht das Tragen: beim Pluendern einer Leiche
  // wandert der Fluch mit der Karte auf die HAND der erbenden Person
  // ("wenn du stirbst, wird der Fluch auf den uebertragen, der ihn von deinem
  // Koerper entfernt") - am Tragen gemessen waere er sofort wieder weg.
  // Ist die Karte ganz fort (abgelegt, zerstoert), endet der Fluch mit ihr.
  const besitz = [...player.hand, ...equippedItemIds(player)];
  player.activeCurses = flueche.filter((f) => f.kind !== 'cursedItem' || besitz.includes(f.itemId));
  return new Set(player.activeCurses.filter((f) => f.kind === 'cursedItem').map((f) => f.itemId));
}

// STINKER: "Niemand hilft dir in deinem naechsten Kampf."
function hatHilfeSperre(player) {
  return (player.activeCurses || []).some((f) => f.kind === 'noHelp');
}

// TODESANGST: "Du hilfst niemandem, die Untoten zu bekaempfen ... Wenn du
// gegen Untote kaempfst, wird dir niemand helfen!"
function hatUntotenAngst(player) {
  return !!player && (player.activeCurses || []).some((f) => f.kind === 'fearUndead');
}

// WEIHNACHTSMANN: "Du erhaeltst keine Schatzkarten ... auch nicht von anderen
// Spielern." Betroffene Karten werden gar nicht erst GEZOGEN statt gezogen
// und weggeworfen - der Text sagt "du erhaeltst keine", der Stapel soll
// dadurch nicht schrumpfen.
function hatSchatzSperre(player) {
  return !!player
    && (player.activeCurses || []).some((f) => f.kind === 'noTreasure' || f.kind === 'zuckerschock');
}

// Fuer jeden Weg, auf dem eine Karte OHNE drawTreasure() in eine Hand
// wandert (Diebstahl, ENTE, Auferstehung, Ablagestapel-Wahl, Leiche):
// Tuerkarten gehen immer, Schatzkarten nicht an Gesperrte.
function darfSchatzBekommen(player, cardId) {
  return !hatSchatzSperre(player) || (card(cardId) || {}).type !== 'treasure';
}

// Wer bei einer Kartenwahl (kind 'chooseCard') die Karte bekommt: takeFrom
// und Ablagestapel -> die waehlende Person, giveTo -> die beschenkte,
// discardVictim/discardOwn -> niemand (die Karte geht auf den Ablagestapel).
function kartenwahlEmpfaengerId(pa) {
  if (pa.giveTo) return pa.giveTo;
  if (pa.discardVictim || pa.discardOwn) return null;
  return pa.playerId;
}

// NARRENGOLD: "Du erhaeltst keinen Schatz im naechsten Kampf." Nur die
// Kampfbeute - anders als die Stoererliste (hatSchatzSperre), die JEDE
// Schatzkarte sperrt und deshalb in zieheSchaetzeFuer sitzt.
function hatKampfschatzSperre(player) {
  return !!player && (player.activeCurses || []).some((f) => f.kind === 'noCombatTreasure');
}

// WEIHNACHTSMANN: "Du erhaeltst keine Schatzkarten ... auch nicht von
// anderen Spielern." Gesperrte Personen ziehen gar nicht erst - der
// Stapel darf durch die Sperre nicht schrumpfen. EINZIGER Ort, der fuer
// eine belohnende Ziehung (Kampfsieg, Geschenk, Bonuszug, ...) direkt
// drawTreasure() aufrufen darf - jede neue Belohnungsstelle geht ab jetzt
// hier durch, statt eine eigene hatSchatzSperre-Abfrage zu bauen.
// ponytail: deckt jede Ziehung ab, bei der EINE Person das Ergebnis
// bekommt (die ueblichen "ziehe N Schaetze"-Faelle). Deckt NICHT ab: den
// Erstausteilungs-Zug bei Spielstart (noch keine Flueche moeglich) und
// UNFASSBAR REICH/schatzTauschen (schon oberhalb ueber fuerActor.length
// gesperrt - ein Aufruf hier waere die zweite Pruefung fuer dieselbe
// Person). Fuer eine Ziehung, die auf zwei Personen verteilt wird (Kampf-
// Hauptausschuettung), gilt die Sperre der Person, fuer die tatsaechlich
// gezogen wird - siehe resolveCombatWin.
// Karten, die OHNE drawTreasure() die Hand wechseln, pruefen
// darfSchatzBekommen/hatSchatzSperre selbst:
//   - jede Kartenwahl aus einer Warteschlange (HIPPOGREIF, ANWALT, EDELMUT,
//     ENTE, Leiche, ...) zentral in advanceCardActionQueue und
//     handleResolveCardCardChoice, die Ablagestapel-Wahl in openCardCardChoice
//   - einzeln: DIEB, ENTE-klauen, EDELMUT-Handkarten, VERLIERE ZWEI KARTEN,
//     PRIESTER-Auferstehung, EINHEITSGRÖSSE, WÜNSCHELSTAB, FLOHMARKT,
//     SINNLOSER AKT, HILF MIR, SCHICKSALHAFTE KARTEN
// Bewusst ohne Sperre: Anfangsverteilung, SCHATZ TAUSCHEN (eigener Schatz
// gegen einen neuen) und der BUMERANGDOLCH, der zu seinem Besitzer
// zurueckkehrt (endTurn).
function zieheSchaetzeFuer(room, player, n) {
  if (hatSchatzSperre(player)) return [];
  const drawn = [];
  for (let i = 0; i < n; i++) { const t = drawTreasure(room); if (t) drawn.push(t); }
  return drawn;
}

// VERFLUCHTER GEGENSTAND: "ein Gegenstand, der dir einen Kampfbonus oder eine
// besondere Kraft verleiht". Was eine besondere Kraft ist, steht schon in den
// Dauerwirkungstabellen - eine eigene Liste daneben waere eine zweite Quelle
// der Wahrheit, die beim naechsten Set auseinanderlaeuft.
// ponytail: dadurch faellt der Begriff etwas weiter aus als der Kartentext ihn
// vermutlich meint (ein blosser Weglauf-Bonus zaehlt mit). Enger ginge nur
// kuratiert, und dann von Hand gepflegt.
const SONDERKRAFT_TABELLEN = [
  CURSE_PROOF_ITEMS, GENDER_IMMUNE_ITEMS, BACKSTAB_ITEMS, FLEE_ITEM_BONUS,
  FLEE_TREASURE_ITEMS, ITEM_CONDITIONAL_BONUS, ITEM_GRANTS_TRAIT, STAFF_ITEMS,
  FREE_HAND_ITEMS,
];

function gegenstandHatSonderkraft(name) {
  return SONDERKRAFT_TABELLEN.some((t) => (t instanceof Set
    ? t.has(name)
    : Object.prototype.hasOwnProperty.call(t, name)));
}

// HUHN AUF DEINEM KOPF: "-1 auf alle Wuerfe." Gilt fuer jeden Wurf, den die
// Person selbst macht - deshalb zentral in rollWithWindow, durch das
// inzwischen alle Wuerfe laufen. Der Wert bleibt bei mindestens 1: ein
// Wuerfel zeigt keine 0, und mehrere Karten lesen den Wurf als 1..6
// (3.872 ORKS: "bei einer 1 oder 2").
// Gibt es einen Tracker-Eintrag dieser Wirkungsart? (TOURISTENFALLE,
// TEMPORÄRE ANMNESIE, HUNGRIGER RUCKSACK - siehe LINGERING_CURSES.)
function hatFluchArt(player, kind) {
  return !!player && (player.activeCurses || []).some((f) => f.kind === kind);
}

function curseRollModifier(player) {
  return (player && player.activeCurses || [])
    .filter((f) => f.kind === 'rollMalus')
    .reduce((sum, f) => sum + (f.amount || 0), 0);
}

// WINZIGE HÄNDE: "Du kannst keine zweihaendigen Gegenstaende benutzen."
function curseBlocksTwoHanded(player) {
  return (player.activeCurses || []).some((f) => f.kind === 'noTwoHandedItems');
}

// --- Monster, die bestimmte Munchkins gar nicht angreifen ------------------
// siehe MONSTER_REFUSES in src/cards/passives.js. Das Monster zieht weiter:
// kein Kampf, kein Schatz, keine Stufe. Die Karte wandert auf den Ablage-
// stapel und der Zug läuft normal mit Phase 2 weiter - damit bleiben beide
// regulären Optionen offen (Monster aus der Hand spielen oder plündern).
function monsterRefusesTarget(cardId, player) {
  const c = card(cardId);
  const rule = c && MONSTER_REFUSES[c.name];
  return !!rule && rule(player);
}

// --- Monster, die eine Rasse automatisch totstampft ----------------------
// siehe MONSTER_AUTO_KILL_BY_RACE in src/cards/passives.js. Umgesetzt als
// Staerke 0 in der Kampfrechnung: besiegt wird das Monster dann ueber die
// normale Auswertung, Stufe und Schatz gibt es also trotzdem.
function monsterAutoKilled(m, sides) {
  const race = m && MONSTER_AUTO_KILL_BY_RACE[m.name];
  return !!race && sides.some((p) => hasRace(p, race));
}

// --- Monster, an denen man auch einfach vorbeigehen darf -----------------
// siehe MONSTER_PASS_OPTION in src/cards/passives.js. Gilt nur fuer
// aufgedeckte Monster - ein aus der Hand gespieltes Monster hat sich die
// kaempfende Person selbst eingeladen.
function monsterPassOption(cardId, player) {
  const c = card(cardId);
  const rule = c && MONSTER_PASS_OPTION[c.name];
  if (!rule) return null;
  if ((rule.forcedFightRaces || []).some((r) => hatRasseMitNachteil(player, r))) return null;
  // nurRassen: BOBBELKOPF duerfen nur Elfen einfach abwerfen.
  if (rule.nurRassen && !rule.nurRassen.some((r) => hasRace(player, r))) return null;
  return rule;
}

// --- Monster, die statt des Kampfes eine bedingte Alternative anbieten -----
// siehe COMBAT_START_OPTIONS in src/cards/passives.js. Anders als
// monsterPassOption oben gilt die Bedingung nicht pro Rasse, sondern prüft,
// ob die Person die Alternative überhaupt nutzen kann (Klasse/Gegenstand).
function combatStartOptionRule(cardId, player) {
  const c = card(cardId);
  const rule = c && COMBAT_START_OPTIONS[c.name];
  if (!rule || !rule.wennErfuellt(player)) return null;
  return rule;
}

// --- Monsterboni gegen Rassen/Klassen --------------------------------------
// siehe MONSTER_TRAIT_BONUS in src/cards/passives.js. Der Bonus gilt einmal
// pro Monster, sobald IRGENDWER auf der Munchkin-Seite die Rasse/Klasse hat
// (Angreifer:in oder Helfer:in) - nicht einmal pro Person.
// SUPER MUNCHKIN / HALB-BLUT, zweite Kartenhaelfte: "Oder du darfst 1
// Klassenkarte haben und hast alle Vorteile aber keine Nachteile der Klasse
// (z.B. Monster, die Priester hassen, werden diesen Bonus nicht gegen einen
// Super Priester haben)." Es braucht keinen Moduswahl-Dialog: der Kartentext
// leitet den Modus selbst ab - Cap-Karte plus genau EIN Merkmal heisst "ohne
// Nachteile", Cap-Karte plus zwei Merkmale heisst "normal, mit allem".
// Rassen und Klassen sind getrennt: SUPER MUNCHKIN schuetzt nicht vor einem
// Rassen-Malus.
// Rassenabhaengige Nachteile ausserhalb von MONSTER_TRAIT_BONUS (Schlimme
// Dinge wie ZUNGENDAEMON/FUNGUS, BEKIFFTER GOLEMs forcedFightRaces,
// KRAKZILLAs Ausnahme, SPASSBREMSE) fragen hatRasseMitNachteil statt hasRace
// - siehe dort.
function traitImmun(player, welches) {
  if (welches === 'classes') return !!player.classCapCard && player.classes.length === 1;
  if (welches === 'races') return !!player.raceCapCard && player.races.length === 1;
  return false;
}

// HALB-BLUT, zweite Kartenhaelfte: "eine Rassenkarte ... alle Vorteile aber
// keine Nachteile". Fuer jede Stelle, an der eine Rasse ein NACHTEIL ist
// (Schlimme Dinge, Kampfzwang, toedliche Gegenstaende) statt hasRace.
// Vorteile (Elf +1 auf Weglaufen, ...) fragen weiter hasRace.
function hatRasseMitNachteil(player, rasse) {
  return hasRace(player, rasse) && !traitImmun(player, 'races');
}

// Welche Rasse ein Monster in dieser Person SIEHT - siehe MONSTER_SEES_AS_RACE
// (GNOM: "Monster behandeln dich wie einen Halbling"). Nur fuer Monsterboni,
// nicht fuer die Faehigkeiten der Rasse selbst.
function monsterSeesRace(player, race) {
  if (hasRace(player, race)) return true;
  // FALSCHE OHREN: "Monster reagieren auch, als waere der Traeger ein Elf."
  if (itemGrantsTrait(player, 'race', race, true)) return true;
  return player.races.some((id) => {
    const c = card(id);
    return !!c && MONSTER_SEES_AS_RACE[c.name.toUpperCase()] === race.toUpperCase();
  });
}

// "Untot" im laufenden Kampf: entweder steht ein untotes Monster da
// (UNDEAD_MONSTERS) oder jemand hat die Verstärkerkarte UNTOT gespielt
// ("Das Monster zählt jetzt als Untoter für alle Zwecke"). Eine Stelle für
// beide Nutzer: Priester-"Vertreiben" und die GHOULPEITSCHE.
function combatHasUndead(room) {
  if (!room.combat) return false;
  if (combatHasMonster(room, UNDEAD_MONSTERS)) return true;
  if (room.combat.hasUndeadCurse) return true;
  return enhancerKartenIds(room).some((id) => { const c = card(id); return c && c.name === 'UNTOT'; });
}

// Verstaerker-Eintraege, deren Monster noch im Kampf steht.
function aktiveEnhancers(room) {
  const c = room.combat;
  if (!c) return [];
  return (c.enhancers || []).filter((e) => c.monsterIds.includes(e.monsterId));
}
// Kartenbonus eines Verstaerkers - GIGANTISCH auf dem FUNGUS ("+25 statt +10")
// und der RAPIER-TROTTEL ("doppelter Effekt") haengen am Zielmonster.
function enhancerBonusEintrag(room, eintrag) {
  const karte = card(eintrag.cardId);
  const ziel = card(eintrag.monsterId);
  if (!karte || !ziel) return 0;
  if (karte.name === 'GIGANTISCH' && ziel.name === 'FUNGUS') return 25;
  if (ziel.name === 'RAPIER-TROTTEL') return (karte.bonus || 0) * 2;
  return karte.bonus || 0;
}
// Summe der Verstaerker eines Monsters. monsterIds kann dieselbe Id zweimal
// enthalten (KUMPEL: "ein weiteres Monster mit den gleichen Verstaerkern") -
// die Summe wird deshalb je Vorkommen gezaehlt, nicht je Eintrag.
function enhancerBonusSumme(room) {
  const c = room.combat;
  if (!c) return 0;
  return (c.monsterIds || []).reduce((sum, mid) => sum
    + (c.enhancers || []).filter((e) => e.monsterId === mid)
      .reduce((teil, e) => teil + enhancerBonusEintrag(room, e), 0), 0);
}
// Schatzzuschlag der Verstaerker (GIGANTISCH/URALT +2, BABY -1), ebenfalls je
// Vorkommen des Monsters.
function enhancerTreasureSumme(room) {
  const c = room.combat;
  if (!c) return 0;
  return (c.monsterIds || []).reduce((sum, mid) => sum
    + (c.enhancers || []).filter((e) => e.monsterId === mid)
      .reduce((teil, e) => teil + (typeof card(e.cardId).treasureCount === 'number' ? card(e.cardId).treasureCount : 0), 0), 0);
}
// Karten-Ids der noch wirksamen Verstaerker (UNTOT-Pruefung, BABY/MAMI).
function enhancerKartenIds(room) {
  return aktiveEnhancers(room).map((e) => e.cardId);
}

function monsterTraitBonusSum(room) {
  const parts = combatParticipants(room);
  return room.combat.monsterIds.concat(enhancerKartenIds(room)).reduce((sum, id) => {
    const c = card(id);
    const regeln = c && MONSTER_TRAIT_BONUS[c.name];
    if (!regeln) return sum;
    // Eine Karte darf mehrere Boni nennen ("+5 gegen Orks, +5 gegen Krieger") -
    // die addieren sich, siehe MONSTER_TRAIT_BONUS in src/cards/passives.js.
    return sum + [].concat(regeln).reduce((teil, rule) => {
      // traitImmun (SUPER MUNCHKIN/HALB-BLUT: "alle Vorteile, aber keine
      // Nachteile") darf nur Nachteile abschalten. Clerical Errors hat
      // Monster mit NEGATIVEM Bonus (DRECKIGE GÄNSE -3 gegen Barden,
      // GIFTEFEU KUDZU-FLIEGENFALLE -4 gegen Elfen) - die zu unterdruecken
      // macht die Kappen-Karte schlechter als gar keine.
      const immun = rule.bonus > 0;
      // nurKaempfer: Regeln, die laut Kartentext "dich" meinen (KALI: "es sei
      // denn, DU verteidigst dich mit 2 Waffen"), duerfen nicht ueber die
      // Helfer:in erfuellt werden - sonst macht Hilfe das Monster staerker.
      const kandidaten = rule.nurKaempfer ? parts.filter((p) => p.id === room.combat.actorId) : parts;
      const hit = kandidaten.some((p) => (!(immun && traitImmun(p, 'races')) && (rule.races || []).some((r) => monsterSeesRace(p, r)))
        || (!(immun && traitImmun(p, 'classes')) && (rule.classes || []).some((k) => hasClass(p, k)))
        // Der Raum kommt als zweites Argument dazu, damit eine Regel den
        // Kampfzustand sehen kann (FEUERLÖSCHER: "+5, wenn dir niemand
        // hilft"). Alle aelteren Regeln ignorieren ihn.
        // nachteilFuer: eine wennErfuellt-Regel, die (auch) an einer Rasse
        // oder Klasse haengt, bekommt denselben Halb-Blut-/Super-Munchkin-
        // Schutz wie rule.races/rule.classes (RIESENKAKERLAKE).
        || (rule.wennErfuellt && !(immun && rule.nachteilFuer && traitImmun(p, rule.nachteilFuer))
          ? rule.wennErfuellt(p, room) : false));
      return teil + (hit ? rule.bonus : 0);
    }, 0);
  }, 0);
}

// --- Monster, die die Kampfrechnung selbst verändern ---------------------
// siehe MONSTER_IGNORES_LEVEL, MONSTER_IGNORES_BONUSES, MONSTER_FORBIDS_HELP
// in src/cards/passives.js. Die ersten beiden Regeln gelten für die ganze
// Munchkin-Seite: sobald jemand mithilft, kämpfen beide gegen dasselbe
// Monster, also trifft die Einschränkung auch die Helfer:in.

// --- Weglaufen -------------------------------------------------------------
// siehe FLEE_ITEM_BONUS, FLEE_MONSTER_MOD, FLEE_IMPOSSIBLE, FLEE_AUTOMATIC,
// FLEE_PENALTY, FLEE_TREASURE_ITEMS in src/cards/passives.js. Der Zauberer-
// Flugzauber ("+1 pro abgelegter Karte") steht bewusst NICHT dort - er
// kostet Karten und bleibt darum eine manuelle Eingabe im Weglaufen-Feld.

// Automatische Flucht: entweder sagt das Monster selbst sie zu
// (FLEE_AUTOMATIC) oder die Rasse der fliehenden Person (FLEE_AUTOMATIC_BY_RACE,
// heute nur der Gnom vor Monstern mit "Nase" im Namen).
function fleeIsAutomatic(room, player) {
  if (combatHasMonster(room, FLEE_AUTOMATIC)) return true;
  if (!room.combat || !player) return false;
  if (hatFluchArt(player, 'traitsVergessen')) return false; // siehe hasRace
  const regeln = player.races.map((id) => {
    const c = card(id);
    return c && FLEE_AUTOMATIC_BY_RACE[c.name.toUpperCase()];
  }).filter(Boolean);
  if (!regeln.length) return false;
  // Alle Monster des Kampfes muessen betroffen sein - eines, das trotzdem
  // angreift, macht die Flucht wieder zur Wuerfelsache.
  return room.combat.monsterIds.every((id) => { const m = card(id); return !!m && regeln.some((fn) => fn(m)); });
}

// Summiert alle festen Weglaufen-Modifikatoren und liefert die Einzelposten
// mit, damit Log und Würfelanimation sie benennen können.
function fleeModifierParts(room, player) {
  const parts = [];
  if (hasRace(player, 'ELF')) parts.push({ label: 'Elf', amount: 1 }); // "Du hast +1 auf Weglaufen."
  // Machtgruppe Assassine der Roten Mantis, "Heimlichkeit".
  if (hasPowerGroup(player, 'ASSASSINE DER ROTEN MANTIS')) parts.push({ label: 'Heimlichkeit', amount: 1 });
  equippedItemIds(player).forEach((id) => {
    const c = card(id);
    if (c && FLEE_ITEM_BONUS[c.name] && !(c.name === 'ZAUBERCOUCH' && player.zaubercouch !== 'ja')) {
      parts.push({ label: c.name, amount: FLEE_ITEM_BONUS[c.name] });
    }
  });
  if (room.combat) {
    room.combat.monsterIds.forEach((id) => {
      const c = card(id);
      if (c && FLEE_MONSTER_MOD[c.name]) parts.push({ label: c.name, amount: FLEE_MONSTER_MOD[c.name] });
    });
    // Bereits abgeworfene Flugzauber-Karten (siehe CLASS_FLEE_DISCARD).
    if (room.combat.fleeBonus) parts.push({ label: 'Flugzauber', amount: room.combat.fleeBonus });
    // In diesem Kampf gespielte Karten mit Weglauf-Klausel (STEAM-CODE).
    if (room.combat.playedFleeBonus) parts.push({ label: 'Steam-Code', amount: room.combat.playedFleeBonus });
  }
  return parts;
}

// --- Bedingtes Reaktionsfenster --------------------------------------------
// Manche Karten reagieren auf ein Ereignis, statt aktiv ausgespielt zu
// werden (GEZINKTER WÜRFEL auf einen Wurf, KLEBERFLÄSCHCHEN auf eine
// gelungene Flucht). Dafür braucht es ein kurzes Zeitfenster, das der Server
// sonst nirgends hat.

// Wer koennte auf dieses Ereignis reagieren? Bots spielen keine
// Reaktionskarten, Getrennte koennen nicht - beide oeffnen deshalb kein
// Fenster, sonst haengt die Partie an niemandem.
function reactionHolders(room, cardSet, darf) {
  return room.players
    .filter((p) => p.connected && !p.isBot
      && p.hand.some((id) => {
        const name = (card(id) || {}).name;
        return cardSet.has(name) && (!darf || darf(p.id, name));
      }))
    .map((p) => p.id);
}

// ponytail: kein generischer Reaktions-Stack. Haelt niemand eine passende
// Karte, laeuft alles synchron weiter - bitgleich zum Verhalten vorher. Ein
// Fenster entsteht nur, wenn es wirklich jemanden gibt, der es nutzen
// koennte. Obergrenze: genau zwei Ausloeser (Wurf, gelungene Flucht). Kommen
// mehr dazu, lohnt sich ein echter Stack.
// `purpose` ist ein reines Diagnosefeld (steht in room.pendingRoll und damit
// im Zustand, den der Client bekommt) - keine Logik haengt daran.
function rollWithWindow(room, player, purpose, onResolve) {
  const malus = curseRollModifier(player);
  const roll = Math.max(1, rollDie() + malus);
  // Der GEZINKTE WÜRFEL gilt nur fuer den eigenen Wurf - wer nur ihn haelt,
  // bekommt bei fremden Wuerfen gar kein Fenster (siehe
  // ROLL_REACTION_OWN_ROLL_ONLY).
  const holders = reactionHolders(room, ROLL_REACTION_CARDS,
    (pid, name) => !ROLL_REACTION_OWN_ROLL_ONLY.has(name) || pid === player.id);
  // Ein zweites Fenster waehrend eines offenen wuerde das erste (samt seinem
  // onResolve) ueberschreiben - dessen Wirkung fiele ersatzlos aus. Zwei
  // Wuerfe koennen tatsaechlich zusammenfallen: autoApplyLossConsequence
  // arbeitet mehrere Monster eines verlorenen Kampfes nacheinander ab. Der
  // zweite Wurf laeuft dann synchron wie frueher.
  if (!holders.length || room.pendingRoll) { onResolve(roll); return; }
  room.pendingRoll = { playerId: player.id, purpose, roll, holders, onResolve };
  log(room, `${player.name} würfelt ${roll}${malus ? ` (${malus} durch einen Fluch)` : ''} - es darf noch auf den Wurf reagiert werden.`);
}

// Eine Stelle fuer den Phasenwechsel, damit Effekte, die an einer Phase
// haengen, nicht an jedem der Uebergaenge einzeln stehen muessen.
function setzeZugphase(room, phase) {
  room.turnPhase = phase;
  if (phase === 'gabe') rucksackWurf(room);
}

// HUNGRIGER RUCKSACK: der Wurf faellt beim Uebergang in die Milde Gabe -
// "bevor Milde Gabe verteilt oder abgelegt wird". Pro Zug nur einmal
// (room.rucksackWurfZug, in endTurn zurueckgesetzt), und nur fuer die Person,
// die gerade am Zug ist - der Fluch nennt "jedes deiner Zuege".
function rucksackWurf(room) {
  const p = currentPlayer(room);
  if (!p || !hatFluchArt(p, 'hungrigerRucksack')) return;
  if (room.rucksackWurfZug === room.turnIndex) return;
  room.rucksackWurfZug = room.turnIndex;
  wurfMitFenster(room, p, 'hungrigerRucksack', (roll) => {
    if (roll === 6) {
      clearActiveCurseByKind(p, 'hungrigerRucksack');
      return `Würfelwurf ${roll} -> der Hungrige Rucksack verschluckt sich selbst und verschwindet`;
    }
    const anzahl = Math.min(roll, p.hand.length);
    for (let i = 0; i < anzahl; i++) {
      const id = p.hand[Math.floor(Math.random() * p.hand.length)];
      removeFromHand(p, id);
      clearCheatIfLost(p, id);
      discardCard(room, id);
    }
    return `Würfelwurf ${roll} -> der Hungrige Rucksack frisst ${anzahl} Handkarte(n)`;
  });
}

// Wuerfelwurf fuer Stellen, die ihr Ergebnis als Text zurueckgeben muessen
// (applyPrimitiveAction/applyCombatPotionAction). Haelt niemand eine
// Reaktionskarte, laeuft alles wie vorher synchron und der Text geht an die
// aufrufende Stelle zurueck; sonst wird der Effekt erst nach dem Fenster
// angewendet und bekommt eine eigene Logzeile.
// GEZINKTER WÜRFEL/KATZENINTERVENTION gelten laut Karte fuer JEDEN Wurf
// ("aus einem beliebigen Grund"), nicht nur fuer den Weglaufwurf.
function wurfMitFenster(room, player, purpose, anwenden) {
  let sofort = null;
  let synchron = true;
  rollWithWindow(room, player, purpose, (roll) => {
    const desc = anwenden(roll);
    if (synchron) sofort = desc == null ? '' : desc;
    else if (desc) log(room, `${player.name}: ${desc}.`);
  });
  synchron = false;
  return sofort !== null ? sofort : 'Wurf läuft - es darf noch auf den Wurf reagiert werden';
}

function resolvePendingRoll(room, finalRoll) {
  const pr = room.pendingRoll;
  if (!pr) return;
  room.pendingRoll = null;
  pr.onResolve(typeof finalRoll === 'number' ? finalRoll : pr.roll);
}

// Gemeinsamer Einstiegspunkt fuer beide Reaktionskarten: welches Fenster
// gerade offen ist (Wurf oder gelungene Flucht), entscheidet, welcher Ast
// greift. Aussenrum bewusst kein drittes generisches Feld - siehe
// ponytail-Kommentar oben.
function handlePlayReactionCard(room, playerId, cardId, value) {
  const pr = room.pendingRoll;
  if (pr && pr.holders.includes(playerId)) {
    const p = findPlayer(room, playerId);
    const c = card(cardId);
    if (!p || !c || !p.hand.includes(cardId) || !ROLL_REACTION_CARDS.has(c.name)) return;
    if (ROLL_REACTION_OWN_ROLL_ONLY.has(c.name) && playerId !== pr.playerId) return;
    // KATZENINTERVENTION wuerfelt neu, der GEZINKTE WÜRFEL setzt den Wert.
    // Der Neuwurf ist ein Wurf DERSELBEN Person - ein "-1 auf alle Wuerfe"
    // (HUHN AUF DEINEM KOPF) gilt also auch hier, sonst hebt die Katze den
    // Fluch fuer diesen Wurf auf.
    const werfer = findPlayer(room, pr.playerId);
    const neu = ROLL_REROLL_CARDS.has(c.name)
      ? Math.max(1, rollDie() + curseRollModifier(werfer))
      : Math.max(1, Math.min(6, Math.round(Number(value) || pr.roll)));
    removeFromHand(p, cardId);
    discardCard(room, cardId);
    log(room, `${p.name} spielt "${c.name}": Wurf ${pr.roll} wird zu ${neu}.`, [cardId]);
    resolvePendingRoll(room, neu);
    touchRoom(room);
    return;
  }
  const combat = room.combat;
  const offer = combat && combat.escapeReactionOffer;
  if (offer && offer.includes(playerId)) {
    const p = findPlayer(room, playerId);
    const c = card(cardId);
    if (!p || !c || !p.hand.includes(cardId) || !ESCAPE_REACTION_CARDS.has(c.name)) return;
    const actor = findPlayer(room, combat.actorId);
    removeFromHand(p, cardId);
    discardCard(room, cardId);
    combat.escapeReactionOffer = null;
    combat.escapeReactionDone = true; // verhindert eine Endlosschleife bei erneut gelungener Flucht
    log(room, `${p.name} spielt "${c.name}": ${actor.name} muss die Flucht noch einmal würfeln.`, [cardId]);
    touchRoom(room);
    handleAttemptFlee(room, actor.id, combat.fleeManualModifier || 0);
  }
}

// TROJANISCHER PFERD: "Spiele diese Karte zusammen mit einem Monster aus
// deiner Hand aus, wenn jemand gerade nach dem Kampf einen Schatz ziehen
// will ... (Oder spiele diese Karte ohne Monster, um einfach den Schatz
// wegzunehmen.)" Die Monsterwahl laeuft ueber den vorhandenen
// openCardChoice-Dialog (Vorbild: WANDERNDES MONSTER/ILLUSION,
// regel.kind === 'addMonsterFromHand' weiter unten in dieser Datei) - der
// Client zeigt die Wahl bereits generisch ueber renderCardAction(), keine
// neue Client-UI noetig.
function handlePlayTrojaner(room, playerId, cardId) {
  const combat = room.combat;
  if (!combat || !combat.trojanerOffer || !combat.trojanerOffer.includes(playerId)) return;
  const p = findPlayer(room, playerId);
  const c = card(cardId);
  if (!p || !c || !p.hand.includes(cardId) || !TREASURE_REACTION_CARDS.has(c.name)) return;
  removeFromHand(p, cardId);
  discardCard(room, cardId);
  combat.trojanerOffer = null;
  combat.trojanerDone = true;
  const eigeneMonster = p.hand.filter((id) => (card(id) || {}).category === 'monster');
  const options = [
    { id: 'ohne', label: 'Ohne Monster: nur den Schatz wegnehmen', action: { type: 'trojanerOhneMonster' } },
  ].concat(eigeneMonster.map((id) => ({
    id: `mon-${id}`,
    label: `Mit "${card(id).name}": neuer Kampf gegen dieses Monster`,
    action: { type: 'trojanerMitMonster', cardId: id },
  })));
  openCardChoice(room, p, 'TROJANISCHER PFERD', options);
  log(room, `${p.name} spielt "${c.name}" - der Kampf um den Schatz geht weiter.`);
  touchRoom(room);
}

// Eine Person faellt weg (Verbindung verloren): sie kann auf nichts mehr
// reagieren. Bleibt danach niemand mehr uebrig, loest sich das Fenster auf.
function loeseReaktionsfensterOhne(room, playerId) {
  const pr = room.pendingRoll;
  if (pr && pr.holders.includes(playerId)) {
    pr.holders = pr.holders.filter((id) => id !== playerId);
    if (!pr.holders.length) resolvePendingRoll(room, pr.roll);
  }
  const c = room.combat;
  if (c && c.escapeReactionOffer && c.escapeReactionOffer.includes(playerId)) {
    c.escapeReactionOffer = c.escapeReactionOffer.filter((id) => id !== playerId);
    if (!c.escapeReactionOffer.length) {
      const actor = findPlayer(room, c.actorId);
      c.escapeReactionOffer = null;
      finishFleeSuccess(room, actor, c);
    }
  }
  if (c && c.trojanerOffer && c.trojanerOffer.includes(playerId)) {
    c.trojanerOffer = c.trojanerOffer.filter((id) => id !== playerId);
    if (!c.trojanerOffer.length) {
      c.trojanerOffer = null;
      c.trojanerDone = true;
      finishCombatWin(room);
    }
  }
}

function handlePassReaction(room, playerId) {
  const pr = room.pendingRoll;
  if (pr && pr.holders.includes(playerId)) {
    pr.holders = pr.holders.filter((id) => id !== playerId);
    if (!pr.holders.length) resolvePendingRoll(room, pr.roll);
    touchRoom(room);
    return;
  }
  const combat = room.combat;
  const offer = combat && combat.escapeReactionOffer;
  if (offer && offer.includes(playerId)) {
    combat.escapeReactionOffer = offer.filter((id) => id !== playerId);
    if (!combat.escapeReactionOffer.length) {
      const actor = findPlayer(room, combat.actorId);
      combat.escapeReactionOffer = null;
      finishFleeSuccess(room, actor, combat);
    }
    touchRoom(room);
  }
  const trojaner = combat && combat.trojanerOffer;
  if (trojaner && trojaner.includes(playerId)) {
    combat.trojanerOffer = trojaner.filter((id) => id !== playerId);
    if (!combat.trojanerOffer.length) {
      combat.trojanerOffer = null;
      combat.trojanerDone = true;
      finishCombatWin(room);
    }
    touchRoom(room);
  }
}

// --- Bonusstufen und Bonusschätze beim Sieg ------------------------------
// siehe MONSTER_EXTRA_LEVEL, FIRE_ITEMS in src/cards/passives.js. (In diesem
// Server findet ein Kampf immer im eigenen Zug statt, die Bedingung "während
// deines Zugs" ist also immer erfüllt.)
function monsterVictoryExtras(room, actor, helper, monsters) {
  const c = room.combat;
  let levels = 0;
  let treasures = 0;
  monsters.forEach((m) => {
    if (MONSTER_EXTRA_LEVEL.has(m.name)) levels += 1;
    // "Du erhältst eine Extrastufe, wenn du es ohne Hilfe und Boni besiegst."
    if (m.name === 'PIKOTZU' && !helper && c.actorModifier === 0 && equippedBonusSum(actor) === 0) levels += 1;
    if (m.name === 'GROSSES WUTENDES HUHN' && equippedItemIds(actor).some((id) => FIRE_ITEMS.has((card(id) || {}).name))) levels += 1;
    // "Elfen ziehen 1 zusätzlichen Schatz, nachdem sie besiegt wurde."
    if (m.name === 'TOPFPFLANZE' && hasRace(actor, 'ELF')) treasures += 1;
  });
  
  if (c && c.mommyMonsterId) {
    levels += 1;
    treasures += 1;
    // Nur wenn BABY auf GENAU dem Baby-Monster dieser Mami liegt - BABY auf
    // einem anderen Monster im selben Kampf betrifft diese Mami nicht.
    if ((c.enhancers || []).some((e) => e.monsterId === c.mommyMonsterId && (card(e.cardId) || {}).name === 'BABY')) {
      treasures += 1; // BABY gab -1 Basis-Schatz, MAMI gleicht aus
    }
  }

  // ORK: "Wenn ein Ork, der alleine kaempft, ein Monster um mehr als 10
  // Punkte besiegt, steigt er eine zusaetzliche Stufe auf."
  if (!helper && hasRace(actor, 'ORK')) {
    const t = combatTotals(room);
    if (t.playerStrength - t.monsterStrength > 10) levels += 1;
  }
  // BARDE, "Bardenglueck": "Wenn du in deinem Zug einen Kampf gewinnst, ziehe
  // einen zusaetzlichen Schatz. Sieh sie dir alle an und wirf sofort einen ab
  // (beliebig)." Das Abwerfen selbst passiert in finishCombatWin (ueber die
  // ganze Hand, nachdem die Beute drauf liegt) - hier zaehlt nur der Extraschatz.
  if (hasClass(actor, 'BARDE')) treasures += 1;
  return { levels, treasures };
}

// --- Klassenkräfte: Karten im Kampf abwerfen ------------------------------
// siehe CLASS_COMBAT_DISCARD, UNDEAD_MONSTERS, CLASS_FLEE_DISCARD in
// src/cards/passives.js. Drei der vier Basis-Klassen haben dieselbe Form:
// bis zu 3 Handkarten abwerfen, jede gibt einen festen Bonus. Dafür gab es
// bisher überhaupt keinen Weg im Spiel - nur das manuelle Bonus-Zahlenfeld,
// das aber keine Karte abwirft.

// DIEB "In den Rücken fallen" (-2 für eine ANDERE Person) hat eine andere
// Form als diese drei und steht deshalb weiter unten bei den Kräften, die
// sich gegen Mitspieler:innen richten (handleThiefBackstab).

function classDiscardPower(room, player) {
  const c = room.combat;
  if (!c) return null;
  const flee = !!c.mustFlee;
  const table = flee ? CLASS_FLEE_DISCARD : CLASS_COMBAT_DISCARD;
  const isPriestViaHammer = !flee && equippedItemIds(player).some(id => (card(id)||{}).name === 'GESEGNETER HAMMER VON ST. UUUAAAAH');
  const name = Object.keys(table).find((n) => hasClass(player, n) || (n === 'PRIESTER' && isPriestViaHammer));
  if (!name) return null;
  const rule = table[name];
  if (rule.requiresUndead && !combatHasUndead(room)) return null;
  const used = (c.classDiscards || {})[`${player.id}:${flee ? 'flee' : 'combat'}`] || 0;
  return Object.assign({ className: name, kind: flee ? 'flee' : 'combat', used, remaining: Math.max(0, rule.max - used) }, rule);
}

// Was die/der Einzelne gerade nutzen darf - wandert ins private yourInfo,
// damit der Client keine eigene Kopie der Tabellen braucht.
function classCombatPowerInfo(room, player) {
  const c = room.combat;
  if (!c) return null;
  if (player.id !== c.actorId && player.id !== c.helperId) return null;
  const power = classDiscardPower(room, player);
  if (!power) return null;
  return { label: power.label, className: power.className, bonus: power.bonus, kind: power.kind, remaining: power.remaining };
}

// BARDE "Verzaubern": "Im Kampf kannst du in deinem Zug eine Karte abwerfen
// und einen Rivalen waehlen. Ihr wuerfelt beide, wenn dein Wurf besser ist als
// seiner, muss er dir helfen und kann keine Belohnung verlangen." Ein Versuch
// pro Aufruf - "bis du Erfolg hast, aufgibst oder dir die Karten oder Gegner
// ausgehen" ergibt sich daraus, dass man erneut klicken darf.
function bardenVerzauberInfo(room, player) {
  const c = room.combat;
  if (!c || !player || c.actorId !== player.id) return null;
  const dran = currentPlayer(room);
  if (!dran || dran.id !== player.id) return null;       // "in deinem Zug"
  if (!hasClass(player, 'BARDE') || c.helperId || c.helperPending) return null;
  if (c.mustFlee || room.pendingRoll || room.pendingCardAction) return null;
  if (!player.hand.length) return null;
  // Dieselben Sperren wie beim normalen "Um Hilfe bitten" (Stinktier,
  // MONSTER_FORBIDS_HELP, Stinktier-Strafe, Todesangst vor Untoten) - siehe
  // hilfeVerbotenGrund. Ohne diesen Filter wuerde die Kraft Hilfe erzwingen,
  // die selbst freiwillig nicht zustande kaeme.
  const rivalen = room.players.filter((p) => p.id !== player.id && p.connected
    && !hilfeVerbotenGrund(room, player, p.id))
    .map((p) => ({ id: p.id, name: p.name }));
  return rivalen.length ? { rivalen } : null;
}

function handleBardeVerzaubern(room, playerId, cardId, targetId) {
  const player = findPlayer(room, playerId);
  const ziel = findPlayer(room, targetId);
  if (!player || !ziel || !bardenVerzauberInfo(room, player)) return;
  if (!player.hand.includes(cardId) || ziel.id === player.id) return;
  if (room.pendingRoll || room.pendingCardAction) return; // keine offene Wahl ueberschreiben
  // Fremdeingabe: targetId kommt vom Client und koennte trotz gefilterter
  // Rivalen-Liste ein gesperrtes Ziel nennen (veralteter Stand, manipulierter
  // Payload) - deshalb hier nochmal geprueft, VOR dem Abwerfen der Karte.
  if (hilfeVerbotenGrund(room, player, targetId)) return;
  removeFromHand(player, cardId);
  discardCard(room, cardId);
  log(room, `${player.name} (Barde) wirft "${card(cardId).name}" ab und versucht, ${ziel.name} zu verzaubern.`, [cardId]);
  rollWithWindow(room, player, 'verzaubern', (wurfBarde) => {
    rollWithWindow(room, ziel, 'verzaubern', (wurfZiel) => {
      const c = room.combat;
      if (!c) return;
      if (c.helperId || c.helperPending) {
        // Waehrend das Wurf-Fenster offen war, ist schon jemand anderes
        // helfende Person geworden (freiwillig oder durch einen zweiten
        // Verzauber-Versuch) - die nicht ersetzen.
        log(room, `Der Verzauber-Versuch von ${player.name} kommt zu spaet - ${ziel.name} kann nicht mehr helfende Person werden.`);
        touchRoom(room);
        return;
      }
      if (wurfBarde > wurfZiel) {
        log(room, `Verzaubert: ${wurfBarde} gegen ${wurfZiel} - ${ziel.name} muss ${player.name} helfen (ohne Belohnung).`);
        // Gleiche Bauform wie KNIESCHUETZER DER VERLOCKUNG: die Hilfe ist
        // erzwungen ("compelled"), handleRespondHelp uebernimmt Stinker-Sperre,
        // Untotenangst, Logging und den Ready-Status wie bei jeder Hilfe.
        c.helperPending = { targetId: ziel.id, compelled: true, reward: 0 };
        handleRespondHelp(room, ziel.id, true);
        // "Du kannst das Spiel mit dieser Faehigkeit nicht gewinnen." - nur
        // setzen, wenn die Hilfe wirklich zustande kam (Stinker/Untotenangst/
        // Lustmonster koennen sie trotz compelled=true noch verhindern).
        if (room.combat && room.combat.helperId === ziel.id) room.combat.bardenZwang = true;
      } else {
        log(room, `Der Zauber misslingt: ${wurfBarde} gegen ${wurfZiel}. ${player.name} darf es erneut versuchen.`);
      }
      touchRoom(room);
    });
  });
  touchRoom(room);
}

// ZAUBERER "Verzauberung": "Du darfst deine ganze Hand ablegen (Minimum 3
// Karten), um ein einzelnes Monster zu verzaubern, anstatt zu bekaempfen.
// Lege das Monster ab und nimm seinen Schatz, erhalte aber keine Stufe.
// Sollten mehrere Monster am Kampf beteiligt sein, musst du die anderen
// normal bekaempfen." -> mechanisch dasselbe wie das VERZAUBERARMBAND, nur
// mit der ganzen Hand als Preis; deshalb keine eigene Schatzauszahlung.
const ENCHANT_MIN_HAND = 3;

function enchantInfo(room, player) {
  const c = room.combat;
  if (!c || c.mustFlee || c.actorId !== player.id) return null;
  if (!hasClass(player, 'ZAUBERER')) return null;
  if (c.monsterIds.length !== 1) return null; // mehrere Monster: normal kaempfen
  if (player.hand.length < ENCHANT_MIN_HAND) return null;
  const m = card(c.monsterIds[0]);
  return { handCount: player.hand.length, monsterName: m ? m.name : '?' };
}

function handleEnchantMonster(room, playerId) {
  const player = findPlayer(room, playerId);
  if (!player) return;
  const info = enchantInfo(room, player);
  if (!info) return;
  const hand = player.hand.slice();
  hand.forEach((id) => { removeFromHand(player, id); discardCard(room, id); });
  const desc = applyCombatPotionAction(room, player, { type: 'endCombatNoLevel', leavesTreasure: true }, null);
  log(room, `${player.name} (Zauberer) legt die ganze Hand ab (${hand.length} Karten) und verzaubert "${info.monsterName}": ${desc}.`, hand);
  touchRoom(room);
}

function handleUseClassCombatDiscard(room, playerId, cardId) {
  if (!room.combat) return;
  const c = room.combat;
  // TROJANISCHER PFERD: der Kampf ist bereits entschieden, solange das
  // Reaktionsfenster offen ist oder gerade aufgeloest wird - keine weiteren
  // Eingriffe in einen Kampf, der schon vorbei ist.
  if (c.trojanerOffer || c.trojanerDone) return;
  const player = findPlayer(room, playerId);
  if (!player || !player.hand.includes(cardId)) return;
  // Nur wer wirklich im Kampf steht - Zuschauer:innen dürfen nicht abwerfen.
  if (playerId !== c.actorId && playerId !== c.helperId) return;
  const power = classDiscardPower(room, player);
  if (!power || power.remaining <= 0) return;
  if (power.kind === 'combat' && combatHasMonster(room, MONSTER_IGNORES_BONUSES)) {
    log(room, `"${power.label}" wuerde gegen "${monsterIgnoringBonusesName(room)}" nichts bewirken (nur Charakterstufen zaehlen) - die Karte bleibt auf der Hand.`);
    touchRoom(room);
    return;
  }
  c.classDiscards = c.classDiscards || {};
  c.classDiscards[`${playerId}:${power.kind}`] = power.used + 1;
  removeFromHand(player, cardId);
  discardCard(room, cardId);
  if (power.kind === 'flee') {
    c.fleeBonus = (c.fleeBonus || 0) + power.bonus;
    log(room, `${player.name} (${power.className}) legt "${card(cardId).name}" ab - ${power.label}: +${power.bonus} auf Weglaufen.`, [cardId]);
  } else {
    c.actorModifier += power.bonus;
    log(room, `${player.name} (${power.className}) legt "${card(cardId).name}" ab - ${power.label}: +${power.bonus} im Kampf.`, [cardId]);
    announceCardPlay(room, player, cardId, `${power.label}: +${power.bonus} im Kampf`);
  }
  touchRoom(room);
}

// --- Klassenkraefte, die sich gegen Mitspieler:innen richten --------------
// DIEB "In den Ruecken fallen": "Lege eine Karte ab, um einem Spieler in den
// Ruecken zu fallen (-2 im Kampf). Das darfst du nur einmal pro Opfer pro
// Kampf tun, aber falls zwei Spieler zusammen gegen ein Monster kaempfen,
// darfst du beiden in den Ruecken fallen."
function handleThiefBackstab(room, playerId, discardCardId, targetId) {
  const c = room.combat;
  if (!c) return;
  const dieb = findPlayer(room, playerId);
  const opfer = findPlayer(room, targetId);
  // STICH-O-MAT laesst auch Nicht-Diebe in den Ruecken fallen (-2), und gibt
  // einem Dieb +1 auf seinen eigenen Rueckenfall (-3 statt -2).
  const stichOMat = dieb && equippedItemIds(dieb).some((id) => BACKSTAB_ITEMS.has((card(id) || {}).name));
  if (!dieb || !opfer || (!hasClass(dieb, 'DIEB') && !stichOMat)) return;
  if (dieb.id === opfer.id) return;                                     // nicht sich selbst
  if (equippedItemIds(opfer).some((id) => (card(id) || {}).name === 'HELM FÜR PERIPHERES SEHEN')) {
    log(room, `${dieb.name} kann ${opfer.name} nicht in den Rücken fallen - der Helm für peripheres Sehen schützt.`);
    touchRoom(room);
    return;
  }
  if (stinktierSperre(room, playerId)) {
    log(room, `${dieb.name} kommt am Riesenstinktier nicht vorbei - kein Rückenfall.`);
    touchRoom(room);
    return;
  }
  if (!combatParticipants(room).some((p) => p.id === opfer.id)) return; // nur Kaempfende
  if (!dieb.hand.includes(discardCardId)) return;
  c.backstabs = c.backstabs || {};
  const schluessel = `${dieb.id}:${opfer.id}`;
  if (c.backstabs[schluessel]) {
    log(room, `${dieb.name} ist ${opfer.name} in diesem Kampf schon in den Ruecken gefallen.`);
    touchRoom(room);
    return;
  }
  const malus = (hasClass(dieb, 'DIEB') && stichOMat) ? 3 : 2;
  c.backstabs[schluessel] = malus;
  removeFromHand(dieb, discardCardId);
  discardCard(room, discardCardId);
  log(room, `${dieb.name} faellt ${opfer.name} in den Ruecken: -${malus} im Kampf.`, [discardCardId]);
  refreshCombatReady(room); // der Bereit-Status muss verfallen
  touchRoom(room);
}

// Summe der Rueckenfall-Mali. Gezaehlt werden nur Opfer, die JETZT noch im
// Kampf stehen: zieht die Helferin zurueck (oder uebernimmt jemand anderes
// den Kampf), nimmt sie ihren Malus mit - er haengt an der Person, nicht am
// Kampf.
function backstabMalus(room) {
  const c = room.combat;
  if (!c || !c.backstabs) return 0;
  const drin = new Set(combatParticipants(room).map((p) => p.id));
  // Der Wert ist der Malus dieses Rueckenfalls (2, mit STICH-O-MAT beim Dieb
  // 3) - aeltere Eintraege stehen noch auf `true` und zaehlen als 2.
  return Object.keys(c.backstabs)
    .filter((k) => drin.has(k.split(':')[1]))
    .reduce((sum, k) => sum - (typeof c.backstabs[k] === 'number' ? c.backstabs[k] : 2), 0);
}

// DIEB "Diebstahl": "Lege eine Karte ab, um einem anderen Spieler einen
// kleinen Gegenstand zu stehlen. Wuerfle. Bei einer 4 oder mehr gelingt es.
// Ansonsten wirst du verhauen und verlierst eine Stufe."
const DIEBSTAHL_MIN_WURF = 4;

// "kleiner Gegenstand" = alles Getragene, was kein Grosser Gegenstand ist.
function stealableItemIds(player, room) {
  return equippedItemIds(player).filter((id) => !istGrosserGegenstand(room, id));
}

function handleThiefSteal(room, playerId, discardCardId, targetId) {
  const dieb = findPlayer(room, playerId);
  const opfer = findPlayer(room, targetId);
  if (!dieb || !opfer || dieb.id === opfer.id) return;
  if (!hasClass(dieb, 'DIEB') || !dieb.hand.includes(discardCardId)) return;
  if (room.pendingCardAction || room.pendingRoll) return; // keine fremde Auswahl ueberschreiben
  if (equippedItemIds(opfer).some((id) => (card(id) || {}).name === 'HELM FÜR PERIPHERES SEHEN')) {
    log(room, `${dieb.name} kann ${opfer.name} nicht bestehlen - der Helm für peripheres Sehen schützt.`);
    touchRoom(room);
    return;
  }
  // Stoererliste: gestohlen wird immer ein Schatz-Gegenstand.
  if (hatSchatzSperre(dieb)) {
    log(room, `${dieb.name} steht auf der Störerliste und bekommt keine Schatzkarten - kein Diebstahl.`);
    touchRoom(room);
    return;
  }
  removeFromHand(dieb, discardCardId);
  discardCard(room, discardCardId);
  log(room, `${dieb.name} (Dieb) legt "${card(discardCardId).name}" ab und versucht, ${opfer.name} zu bestehlen.`, [discardCardId]);
  rollWithWindow(room, dieb, 'diebstahl', (roll) => {
    if (roll >= DIEBSTAHL_MIN_WURF) {
      const klein = stealableItemIds(opfer, room);
      if (!klein.length) {
        log(room, `${dieb.name} wuerfelt ${roll} - aber ${opfer.name} traegt keinen kleinen Gegenstand.`);
      } else {
        openCardChoice(room, dieb, 'DIEBSTAHL', klein.map((id) => ({
          id: `steal-${id}`,
          label: card(id).name,
          action: { type: 'stealItemFrom', targetId: opfer.id, cardId: id },
        })));
        log(room, `${dieb.name} wuerfelt ${roll}: der Diebstahl gelingt.`);
      }
    } else {
      setLevel(dieb, dieb.level - 1);
      log(room, `${dieb.name} wuerfelt ${roll}: erwischt! -1 Stufe (jetzt Stufe ${dieb.level}).`);
    }
    touchRoom(room);
  });
  touchRoom(room);
}

// Was der Client anbieten darf - privat im yourInfo, damit dort keine zweite
// Kopie der Regeln liegt.
// STICH-O-MAT laesst auch Nicht-Diebe in den Ruecken fallen (handleThiefBackstab
// pruefte das schon) - hier durfte bisher nur eine DIEB-Klasse ueberhaupt ein
// Ergebnis bekommen, also blieb der Knopf fuer Nicht-Diebe unsichtbar. Der
// Diebstahl (stealTargets) bleibt exklusiv fuer die DIEB-Klasse.
function thiefPowerInfo(room, player) {
  const dieb = hasClass(player, 'DIEB');
  const stichOMat = equippedItemIds(player).some((id) => BACKSTAB_ITEMS.has((card(id) || {}).name));
  if (!dieb && !stichOMat) return null;
  if (!player.hand.length) return { backstabTargets: [], stealTargets: [] }; // die Karte ist der Preis
  const c = room.combat;
  const schon = (c && c.backstabs) || {};
  const backstabTargets = (c ? combatParticipants(room) : [])
    .filter((p) => p.id !== player.id && !schon[`${player.id}:${p.id}`])
    .map((p) => ({ id: p.id, name: p.name }));
  const stealTargets = dieb && !hatSchatzSperre(player) ? room.players
    .filter((p) => p.id !== player.id && stealableItemIds(p, room).length)
    .map((p) => ({ id: p.id, name: p.name })) : [];
  return { backstabTargets, stealTargets };
}

// PRIESTER "Auferstehung": "Wenn du eine oder mehrere Karten offen ziehen
// sollst, darfst du stattdessen eine, mehrere oder alle Karten vom
// entsprechenden Ablegestapel ziehen. Du musst danach fuer jede so gezogene
// Karte eine Karte von deiner Hand ablegen."
// ponytail: genau eine Karte, kein Mehrfachwaehler - die Kraft ersetzt das
// Tuereintreten (siehe priestResurrectPiles) und ist danach fuer den Rest des
// Zugs vorbei, also gibt es keinen zweiten Knopfdruck mehr. Der Preis wird
// sofort eingefordert.
// Nutzbar ist sie nur als Alternative zum Tuereintreten: wer dran ist und in
// Phase 1 steht, tritt entweder die Tuer ein ODER holt eine Karte vom
// Ablagestapel - deshalb hier dieselbe Sperre wie in handleDrawDoor.
function priestResurrectPiles(room, player) {
  if (!hasClass(player, 'PRIESTER') || !player.hand.length) return [];
  const dran = currentPlayer(room);
  if (!dran || !player || dran.id !== player.id) return [];
  if (room.turnPhase !== 'tuer' || room.revealedDoorCard || room.combat
    || room.pendingConsequence || room.pendingRoll || room.pendingCardAction) return [];
  const piles = [];
  if (room.doorDiscard.length) piles.push('door');
  if (room.treasureDiscard.length && !hatSchatzSperre(player)) piles.push('treasure');
  return piles;
}

function handlePriestResurrect(room, playerId, stapel) {
  const p = findPlayer(room, playerId);
  if (!p || !hasClass(p, 'PRIESTER')) return;
  if (room.pendingCardAction || room.pendingRoll) return; // keine fremde Auswahl ueberschreiben
  if (!priestResurrectPiles(room, p).includes(stapel)) {
    log(room, `${p.name}: Auferstehung nicht moeglich (leerer Ablagestapel oder keine Karte als Preis).`);
    touchRoom(room);
    return;
  }
  const discard = stapel === 'door' ? room.doorDiscard : room.treasureDiscard;
  const geholt = discard.pop();
  p.hand.push(geholt);
  // Die Kraft ersetzt das Tuereintreten - der Zug laeuft direkt mit Phase 2
  // weiter, auch waehrend der Preis noch bezahlt wird.
  room.turnPhase = 'aerger';
  log(room, `${p.name} nutzt "Auferstehung" statt die Tür einzutreten und nimmt "${card(geholt).name}" vom Ablagestapel. Phase 2: Auf Ärger aus sein.`, [geholt]);
  // Preis: genau eine Karte ablegen, selbst gewaehlt - die geholte zaehlt nicht.
  openCardChoice(room, p, 'AUFERSTEHUNG', p.hand
    .filter((id) => id !== geholt)
    .map((id) => ({ id: `ab-${id}`, label: `"${card(id).name}" ablegen`,
      action: { type: 'discardSpecificHandCard', cardId: id } })));
  touchRoom(room);
}

// --- Handkartenlimit -------------------------------------------------------
// ZWERG: "Du darfst sechs Karten auf deiner Hand haben."
function handLimit(player) {
  return player && hasRace(player, 'ZWERG') ? HAND_LIMIT + 1 : HAND_LIMIT;
}

// ---------------------------------------------------------------------------
// Kampf
// ---------------------------------------------------------------------------

// DRYADE: "Sie schwaecht die Kraefte des Zauberers. Jeder Zauberer, der ihr
// gegenuebersteht, verliert SOFORT seine Zauberer-Klasse." Wird beim
// Kampfbeginn und beim Dazukommen einer Helfer:in geprueft - das sind die
// beiden Zeitpunkte, zu denen jemand "ihr gegenuebersteht".
function dryadeWirkung(room, player) {
  if (!room.combat || !player) return;
  if (!room.combat.monsterIds.some((id) => (card(id) || {}).name === 'DRYADE')) return;
  if (!hasClass(player, 'ZAUBERER')) return; // respektiert TEMPORÄRE ANMNESIE
  const desc = applyPrimitiveAction(room, player, { type: 'discardClassCardMatchingElseDeath', substr: 'ZAUBERER' });
  log(room, `Die Dryade schwaecht ${player.name}: ${desc}.`);
}

// ZAUBERCOUCH: "Du kannst zu Beginn eines jeden Kampfes entscheiden, ob du
// die Zaubercouch verwenden willst." Wer mit angelegter Couch in einen Kampf
// kommt (kaempfend bei Kampfbeginn, helfend beim Einstieg), bekommt die
// Frage. Solange sie offen ist, wird nicht ausgewertet. Bots sagen Nein.
// Der Zustand haengt am Spieler, weil hasClass keinen Raum kennt; er wird bei
// jedem Kampfbeginn und jedem Kampfende zurueckgesetzt.
function zaubercouchFragen(player) {
  if (!player || !equippedItemIds(player).some((id) => (card(id) || {}).name === 'ZAUBERCOUCH')) return;
  player.zaubercouch = player.isBot ? 'nein' : 'offen';
}
function zaubercouchZuruecksetzen(room) {
  room.players.forEach((p) => { delete p.zaubercouch; });
}
function zaubercouchOffen(room) {
  // combatReadyRequired ignoriert Getrennte aus demselben Grund: eine
  // unbeantwortete Frage einer Person, die nicht mehr am Geraet ist, darf
  // den Kampf nicht auf ewig blockieren - sie zaehlt (wie ueberall sonst
  // bei Zaubercouch) automatisch als "Nein".
  return combatParticipants(room).filter((p) => p.zaubercouch === 'offen' && p.connected);
}
function handleAnswerZaubercouch(room, playerId, benutzen) {
  const p = findPlayer(room, playerId);
  if (!room.combat || !p || p.zaubercouch !== 'offen') return;
  p.zaubercouch = benutzen ? 'ja' : 'nein';
  log(room, `${p.name} ${benutzen ? 'ruht sich auf der Zaubercouch aus (Zauberer, -1 auf Weglaufen)' : 'verzichtet in diesem Kampf auf die Zaubercouch'}.`);
  refreshCombatReady(room); // Klasse und Staerke koennen sich geaendert haben
  touchRoom(room);
}

function startCombat(room, actorId, monsterIds, opts) {
  zaubercouchZuruecksetzen(room);
  room.players.forEach((p) => pruefeSlipperVerlust(room, p));
  room.combatHappenedThisTurn = true;
  room.turnPhase = 'kampf';
  room.combat = {
    actorId,
    helperId: null,
    helperPending: null, // { targetId, compelled, reward }
    helperReward: 0,     // zugesagte Schatzkarten fuer die Helfer:in
    monsterIds,
    actorModifier: 0,
    monsterModifier: 0,
    mustFlee: false,
    // Weglaufen betrifft JEDE beteiligte Person einzeln (Angreifer:in und
    // Helfer:in): fleeQueue sind die, die noch dran sind, fleeingId ist die
    // aktuelle, fleeFailed sammelt die, die es nicht geschafft haben. Das
    // Miese Zeug wird erst verteilt, wenn alle gewuerfelt haben - siehe
    // beendeFluchtphase.
    fleeQueue: null,
    fleeingId: null,
    fleeFailed: [],
    fromHand: !!opts.fromHand,
    classDiscards: {}, // "<playerId>:combat"/"<playerId>:flee" -> Anzahl bereits abgeworfener Karten
    fleeBonus: 0,        // Summe der Flugzauber-Karten
    playedFleeBonus: 0,  // STEAM-CODE: Weglauf-Zuschlag aus gespielten Kampfkarten
    treasureDelta: 0,  // Schatzbonus/-malus, der nicht an ein Monster haengt
    // Gespielte Monster-Verstaerker mit ihrem Zielmonster: { cardId, monsterId }.
    // Verschwindet ein Monster, verschwinden seine Verstaerker mit ihm - die
    // ILLUSION sagt das ausdruecklich ("zusammen mit allen Karten, die
    // gespielt wurden, um es zu veraendern").
    enhancers: [],
    ready: {},         // playerId -> true, sobald jemand die Auswertung freigibt
    readySignature: null,
  };
  zaubercouchFragen(findPlayer(room, actorId));
  dryadeWirkung(room, findPlayer(room, actorId));
  // GUMMI-GOLEM: "Du musst in jedem Kampf deine Hilfe anbieten." Trust-Prinzip
  // (2026-09-23 vom Nutzer bestaetigt): der Server kann niemanden zwingen,
  // eine angebotene Hilfe anzunehmen, deshalb nur eine Logzeile und keine
  // erzwungene Anfrage.
  const kaempfer = findPlayer(room, actorId);
  room.players.forEach((p) => {
    if (p.id !== actorId && (p.activeCurses || []).some((f) => f.kind === 'zuckerschock')) {
      log(room, `${p.name} steht unter Zuckerschock und bietet ${kaempfer ? kaempfer.name : 'der kämpfenden Person'} seine Hilfe an.`);
    }
  });
  touchRoom(room);
}

// ---------------------------------------------------------------------------
// Bereit-Check vor der Kampfauswertung
//
// Jede:r am Tisch darf in einen laufenden Kampf eingreifen (Monster-
// Verstärker, Kampf-Tränke, das manuelle Bonusfeld). Vorher konnte die
// kämpfende Person aber sofort auf "Kampf auswerten" drücken - wer das
// Monster noch verstärken wollte, hatte nur seine Reaktionsgeschwindigkeit.
// Deshalb muss jetzt jede:r andere bestätigen, dass nichts mehr kommt.
// ---------------------------------------------------------------------------

// Wer bestätigen muss: alle außer der kämpfenden Person. Bots greifen nie
// ein und gelten sofort als bereit, Getrennte werden übersprungen - sonst
// hängt das Spiel an jemandem, der gerade nicht am Gerät ist.
function combatReadyRequired(room) {
  const c = room.combat;
  if (!c) return [];
  return room.players.filter((p) => p.id !== c.actorId && p.connected && !p.isBot).map((p) => p.id);
}

function combatAllReady(room) {
  const c = room.combat;
  if (!c) return false;
  return combatReadyRequired(room).every((id) => (c.ready || {})[id]);
}

// Der Bereit-Status verfällt, sobald sich am Kampf irgendetwas ändert -
// sonst bestätigen alle, jemand spielt danach noch "Uralt +10", und der
// Kampf löst mit veralteter Zustimmung aus.
//
// Bewusst über eine Signatur statt über einen Reset-Aufruf in jedem
// einzelnen Handler: so kann keine künftig ergänzte Karte den Reset
// vergessen. Die Signatur enthält die fertigen Summen, also wirkt auch
// Ausrüsten mitten im Kampf.
function combatSignature(room) {
  const c = room.combat;
  if (!c) return null;
  const t = combatTotals(room);
  return JSON.stringify([c.monsterIds, c.helperId, c.actorModifier, c.monsterModifier,
    enhancerBonusSumme(room), t.playerStrength, t.monsterStrength, c.mustFlee]);
}

function refreshCombatReady(room) {
  const c = room.combat;
  if (!c) return;
  // TODESANGST: "Wenn Untote in einen Kampf treten, in dem du geholfen hast,
  // musst du diesen Kampf verlassen (keine Strafe)." Hier statt an jeder
  // einzelnen Stelle, an der ein Monster oder die Karte UNTOT dazukommt -
  // refreshCombatReady laeuft nach jeder dieser Aenderungen. Direktes Setzen
  // von c.helperId statt eines erneuten Aufrufs dieser Funktion, damit keine
  // Rekursion entsteht.
  if (c.helperId && combatHasUndead(room)) {
    const helfer = findPlayer(room, c.helperId);
    if (hatUntotenAngst(helfer)) {
      c.helperId = null;
      c.helperReward = 0;
      c.bardenZwang = false;
      log(room, `${helfer.name} hat Todesangst vor Untoten und verlässt den Kampf - ohne Strafe.`);
    }
  }
  const sig = combatSignature(room);
  if (c.readySignature !== sig) {
    c.ready = {};
    c.readySignature = sig;
  }
  // ZAUBERCOUCH: wer den Kampf verlassen hat (Uebergabe, entfernte Hilfe,
  // Todesangst, Stinker-Rueckzug, ...), ist keine kaempfende Person mehr und
  // verliert Zauberer-Klasse und Weglauf-Malus sofort - nicht erst beim
  // naechsten Kampf. Zentral hier statt an jeder einzelnen Austrittsstelle,
  // aus demselben Grund wie oben bei Todesangst: refreshCombatReady laeuft
  // nach jeder davon.
  const teilnehmendeIds = new Set(combatParticipants(room).map((p) => p.id));
  room.players.forEach((p) => {
    if (p.zaubercouch && !teilnehmendeIds.has(p.id)) delete p.zaubercouch;
  });
}

function handleSetCombatReady(room, playerId, ready) {
  const c = room.combat;
  if (!c) return;
  if (!combatReadyRequired(room).includes(playerId)) return;
  if (ready && findPlayer(room, playerId) && findPlayer(room, playerId).zaubercouch === 'offen') return;
  c.ready = c.ready || {};
  if (ready) c.ready[playerId] = true; else delete c.ready[playerId];
  const p = findPlayer(room, playerId);
  log(room, `${p.name} ist ${ready ? 'bereit' : 'doch noch nicht bereit'} für die Auswertung.`);
  touchRoom(room);
}

function combatTotals(room) {
  const c = room.combat;
  const actor = findPlayer(room, c.actorId);
  const helper = c.helperId ? findPlayer(room, c.helperId) : null;
  const monsters = c.monsterIds.map(card);
  const sides = [actor, helper].filter(Boolean);
  // Eingestampfte Monster (siehe MONSTER_AUTO_KILL_BY_RACE) bringen keine
  // Stufe in die Rechnung ein.
  // TYPOGRAFISCHER FEHLER setzt einzelne Monster auf Stufe 1 (levelOverrides).
  const monsterLevel = c.monsterIds.reduce((sum, id) => {
    const m = card(id);
    if (!m || monsterAutoKilled(m, sides)) return sum;
    const stufe = (c.levelOverrides && c.levelOverrides[id] != null) ? c.levelOverrides[id] : (m.level || 0);
    return sum + stufe;
  }, 0);
  const ignoreLevel = combatHasMonster(room, MONSTER_IGNORES_LEVEL);
  const ignoreWeapons = combatHasMonster(room, MONSTER_IGNORES_WEAPONS);
  const ignoreBonuses = combatHasMonster(room, MONSTER_IGNORES_BONUSES);
  let playerStrength;
  if (ignoreBonuses) {
    // GEMEINE GHOULE: nur die Charakterstufe(n) - keine Ausrüstung, keine
    // ausgespielten Karten. Monster-Verstärker bleiben davon unberührt.
    playerStrength = sides.reduce((sum, p) => sum + p.level, 0) + backstabMalus(room);
  } else {
    playerStrength = sides.reduce((sum, p) => {
      // MIESER SPIEGEL: "keine Boni durch Gegenstände, die einzige Ausnahme
      // sind Rüstungsboni" - sonst zaehlen Ausruestung + situative Item-Boni
      // wie gewohnt. hellknightArmorBonus bleibt in beiden Faellen stehen
      // (kein regulaerer Gegenstands-Slot, siehe Kommentar dort).
      // MONDJUNGFERN: "keine Vorteile durch Waffen" - die Waffen-Ids fliegen
      // hier komplett aus allen drei Item-Summanden, statt hinterher eine
      // zweite Summe abzuziehen. Sonst ueberleben Kartenanhaenge an der Waffe,
      // konditionale Item-Boni (VORPALE KLINGE, EISRIESE-Verdopplung, ...)
      // und rassenabhaengige Item-Boni (GNOM) den Abzug.
      // ignoreWeapons haengt am Monster und gilt fuer beide Seiten gleich,
      // curseHidesHandItems an der Person - deshalb steht der Ausdruck hier
      // in der sides-Schleife, wo p bekannt ist.
      // Eine Ausschlussmenge fuer drei Gruende: Monster (MONDJUNGFERN),
      // Person (LUSTMONSTER) und einzelner Gegenstand (VERFLUCHTER
      // GEGENSTAND, "Er verliert seine Kraefte"). Sie fliegt aus allen drei
      // Item-Summanden, also samt Kartenanhaengen und Rassenbonus.
      const excludeIds = new Set();
      // MONDJUNGFERN nimmt nur Waffen (ohne Schilde), der LUSTMONSTER-Fluch
      // alle Hand-Gegenstaende.
      if (ignoreWeapons) waffenIds(p).forEach((id) => excludeIds.add(id));
      if (curseHidesHandItems(p)) handItemIds(p).forEach((id) => excludeIds.add(id));
      cursedItemIds(p).forEach((id) => excludeIds.add(id));
      const items = curseSuppressesItemBonuses(p)
        ? ruestungsBonusSumme(p)
        : equippedBonusSum(p, room, excludeIds) + raceItemBonusSum(p, excludeIds)
          + conditionalItemBonusSum(p, monsters, combatHasUndead(room), excludeIds);
      return sum + p.level + items + hellknightArmorBonus(p)
        + curseCombatModifier(p) - (ignoreLevel ? p.level : 0);
    }, 0) + c.actorModifier + backstabMalus(room);
  }
  // DOPPELGAENGER: "Verdopple deine Kampfstaerke" - auf die fertige Summe der
  // Munchkin-Seite, gespielte Karten eingeschlossen.
  if (c.doubleActor) playerStrength *= 2;
  const monsterStrength = monsterLevel + c.monsterModifier + monsterTraitBonusSum(room) + enhancerBonusSumme(room);
  return { playerStrength, monsterStrength, monsterLevel };
}

// Liefert die zustandsabhängigen Item-Zusatzboni (siehe ITEM_CONDITIONAL_BONUS)
// getrennt für Angreifer:in und Helfer:in, damit der Client dieselbe Zahl wie
// der Server anzeigen kann, ohne die Kartendaten selbst neu auszuwerten.
function combatConditionalBonusFields(room) {
  const c = room.combat;
  // FEIGHEITSTRANK/mustFlee: fleeQueue/fleeingId werden von fluechtenderId()
  // nur LAZY beim ersten Aufruf gesetzt. Bisher passierte dieser erste
  // Aufruf oft erst in scheduleBotActionsIfNeeded - und das laeuft in
  // broadcastState() ERST NACH dem gameState-Emit. Der allererste State nach
  // "muss weglaufen" hatte also fleeingId: undefined, und wenn die
  // fluechtende Person ein Mensch war (kein Bot), gab es danach nie wieder
  // einen Broadcast, der es nachtraegt -> Softlock (Bugreport 2026-09-19).
  // Fix: hier eager aufrufen, bevor der Kampf serialisiert wird, damit
  // fleeingId schon im ALLERERSTEN "mustFlee"-State stimmt.
  fluechtenderId(room);
  const actor = findPlayer(room, c.actorId);
  const helper = c.helperId ? findPlayer(room, c.helperId) : null;
  const monsters = c.monsterIds.map(card);
  const totals = combatTotals(room);
  // KRIEGER: "Bei Gleichstand im Kampf gewinnst du." Dieselbe Bedingung wie
  // in resolveCombat (dort tatsaechlich entscheidend), hier nur zur ANZEIGE:
  // der Client zeigt die eigene Kampfstaerke bei Gleichstand normalerweise
  // rot ("verloren") an - fuer eine Kriegerin/einen Krieger ist ein
  // Gleichstand aber ein Sieg, also nicht rot. Die anderen Verlust-Zwaenge
  // (LUSTMONSTER ohne Hilfe, TODESANGST, KRAKZILLA-Schwert) gehen vor, genau
  // wie bei der echten Auswertung.
  const lustOhneHilfe = combatHasMonster(room, MONSTER_REQUIRES_OTHER_GENDER) && !passendeHilfe(room);
  const angstVorUntoten = combatHasUndead(room) && hatUntotenAngst(actor);
  const krakzillaSchwertZwang = monsters.some((m) => m && m.name === 'KRAKZILLA')
    && equippedItemIds(actor).some((id) => (card(id) || {}).name === 'ALLES AUSSER KRAKZILLA ABSCHLACHTENDES SCHWERT');
  const kampfVerloren = lustOhneHilfe || angstVorUntoten || krakzillaSchwertZwang;
  const warriorTieWins = !kampfVerloren && totals.playerStrength === totals.monsterStrength
    && combatParticipants(room).some((p) => hasClass(p, 'KRIEGER'));
  return {
    actorConditionalBonus: conditionalItemBonusSum(actor, monsters, combatHasUndead(room)),
    helperConditionalBonus: helper ? conditionalItemBonusSum(helper, monsters, combatHasUndead(room)) : 0,
    // Fertig gerechnete Summen: der Client hat sie früher selbst
    // nachgerechnet und würde die Monsterboni gegen Rassen/Klassen und die
    // Sonderregeln sonst nicht kennen - zwei Rechenwege, die auseinander-
    // laufen können. Jetzt zeigt er genau das an, was der Server wertet.
    playerStrength: totals.playerStrength,
    monsterStrength: totals.monsterStrength,
    readyRequired: combatReadyRequired(room),
    allReady: combatAllReady(room),
    monsterTraitBonus: monsterTraitBonusSum(room),
    ignoresLevel: combatHasMonster(room, MONSTER_IGNORES_LEVEL),
    ignoresBonuses: combatHasMonster(room, MONSTER_IGNORES_BONUSES),
    forbidsHelp: combatHasMonster(room, MONSTER_FORBIDS_HELP),
    autoKilledMonsters: monsters.filter((m) => monsterAutoKilled(m, [actor, helper].filter(Boolean))).map((m) => m.name),
    warriorTieWins,
    // Fertig gerechnete Schatzzahl fuer die Hilfe-Zusage-Obergrenze (siehe
    // kampfSchatzZahl weiter unten) - der Client duplizierte diese Formel
    // frueher selbst und kannte dabei den Verstaerker-Anteil (enhancers)
    // nicht mehr, seit der am Monster statt kampfweit haengt.
    kampfSchatzZahl: kampfSchatzZahl(room),
  };
}

// Monster-Verstärker: Türkarten (Kategorie "door_other"), die laut Text
// jederzeit während eines beliebigen Kampfes ausgespielt werden dürfen und
// einen festen Bonus/Malus "für das Monster" geben (z.B. Uralt +10, Baby -5).
// Diese lassen sich automatisch erkennen (nicht-null/nicht-0 bonus-Feld +
// passender Kartentext) und daher automatisch verrechnen, statt dass die
// Zahl manuell eingetragen werden muss.
function isMonsterEnhancerCard(c) {
  return !!c && c.category === 'door_other' && typeof c.bonus === 'number' && c.bonus !== 0 &&
    /für\s+(das\s+)?Monster/i.test(c.text || '');
}

// "Kampf-Trank"-Erkenner: treasure_other-Karten, die laut Text während eines
// beliebigen Kampfes gespielt werden dürfen und einen festen +N-Bonus für
// eine Seite geben (anders als Monster-Verstärker steht die Zahl hier nur im
// Fließtext, nicht in einem eigenen bonus-Feld). Deckt die weitaus häufigste
// Formulierung ab; seltenere Sonderfälle stehen in COMBAT_POTION_OVERRIDES.
// Das bloße "im Kampf" reicht als Spielbarkeits-Hinweis, weil
// isCombatPotionCard zusätzlich einen geparsten +N-Bonus verlangt
// ("Sorgen im Kampf für Ablenkung. +5, egal für welche Seite.").
const COMBAT_PLAYABLE_RE = /im\s+Kampf\b|Während\s+(eines\s+)?beliebige[nm]\s+Kampf(es)?\s+spielen/i;

function parseCombatPotion(rawText) {
  const t = normalizeCardText(rawText);
  // "+X für eine der beiden Seiten" (Erweiterungen; englisch "to either side" -
  // die alte Übersetzung "für beide Seiten" war falsch).
  let m = t.match(/\+(\d+)\s+für\s+eine\s+der\s+beiden\s+Seiten/i);
  if (m) return { side: 'either', amount: parseInt(m[1], 10) };
  // Alle Schreibweisen des Grundspiels: "+2 egal für welche Seite", "+5 für
  // egal welche Seite", "+5, egal für welche Seite", "+3 für eine der
  // Parteien, egal für welche Seite".
  m = t.match(/\+(\d+)[,\s]+(?:für\s+)?(?:eine\s+der\s+Parteien,\s*)?egal[,\s]+(?:für\s+)?welche\s+Seite/i);
  if (m) return { side: 'either', amount: parseInt(m[1], 10) };
  m = t.match(/\+(\d+)\s+nur\s+für\s+Monster/i);
  if (m) return { side: 'monster', amount: parseInt(m[1], 10) };
  m = t.match(/\+(\d+)\s+für\s+die\s+Munchkin-Seite/i);
  if (m) return { side: 'actor', amount: parseInt(m[1], 10) };
  return null;
}

// Kuratierte Einzelfälle für Kampf-Tränke, die sich nicht auf das einfache
// "+N für Seite X"-Muster reduzieren lassen. Rückgabe wie bei
// TREASURE_POWER_OVERRIDES: eine Aktion, `null` = bewusst manuell/Bedingung
// nicht erfüllt. Siehe COMBAT_POTION_OVERRIDES, DOOR_COMBAT_CARDS in
// src/cards/treasures.js.

function isCombatPotionCard(c) {
  if (!c || c.category !== 'treasure_other') return false;
  if (COMBAT_POTION_OVERRIDES[c.name] !== undefined) return true;
  const t = normalizeCardText(c.text);
  return COMBAT_PLAYABLE_RE.test(t) && parseCombatPotion(c.text) != null;
}

// Vorab berechnete Kartenlisten fuer publicState (Clerical-Errors-Audit,
// Task 1): public/client.js pflegte bisher eigene, handkopierte Kopien
// dieser Namen - die sind auseinandergedriftet, 13 Karten lagen serverseitig
// fertig implementiert, aber ohne Knopf tot auf der Hand. Jetzt gibt es nur
// noch diese eine Quelle, siehe tests/card-clerical-ui.test.js.
const TREASURE_POWER_CARD_NAMES = [...new Set([
  ...Object.keys(TREASURE_POWER_OVERRIDES),
  ...Object.keys(DOOR_POWER_CARDS),
  ...ALL_CARDS.filter(isInstantLevelUpCard).map((c) => c.name),
])];
const COMBAT_POTION_CARD_NAMES = [...new Set(ALL_CARDS.filter(isCombatPotionCard).map((c) => c.name))];

// Welche Phase nach EINEM DER SECHS Kampfende-Pfade folgt (Sieg, gelungene/
// garantierte Flucht, verlorener Kampf, sowie die beiden Kartenkraefte, die
// einen Kampf ohne Sieg/Niederlage beenden: endCombatNoLevel/
// killMonsterInCombat). thenLoot ist die kartentexteigene Regel ("... und
// pluendere danach den Raum", z.B. MAHLZEIT!); c.originalActorId ist
// ÜBERFALLTRANK ("... der urspruengliche Spieler darf danach pluendern,
// unabhaengig davon, ob der Kampf gewonnen oder verloren wurde" - das deckt
// ausdruecklich JEDEN Kampfausgang ab, nicht nur Sieg/Niederlage). EINE
// Stelle statt an jeder Kampfende-Stelle einzeln dieselbe Bedingung zu
// wiederholen, damit ein siebter Beendigungspfad sie nicht vergisst.
// Ein Kampf endet nicht nur durch Sieg oder Flucht, sondern auch durch Karten,
// die alle Monster entfernen (MAHLZEIT!, FREUNDSCHAFTSTRANK, DEUS EX
// MASCHINENGEWEHR, MONSTER SIND BESCHÄFTIGT, Verzauberung, ...). Diese Wege
// liefen frueher an clearNextCombatCurses vorbei - "(Nur) in deinem naechsten
// Kampf"-Flueche (MIESER SPIEGEL, GESCHLECHTSUMWANDLUNG, ZWERGENBIER) hielten
// dann einen Kampf zu lange. Deshalb enden ALLE diese Wege hier.
function beendeKampfOhneSieg(room, c, thenLoot) {
  clearNextCombatCurses(combatParticipants(room));
  room.combat = null;
  zaubercouchZuruecksetzen(room);
  setzeZugphase(room, combatEndPhase(c, thenLoot));
}

function combatEndPhase(c, thenLoot) {
  return (thenLoot || (c && c.originalActorId)) ? 'pluendern' : 'gabe';
}

// Wendet eine bereits aufgelöste Kampf-Trank-Aktion an (mutiert
// room.combat). Machtgruppe Alchemist ("Tränkemeister") verdoppelt den
// Bonus von "Nur einmal einsetzbar"-Gegenständen.
function applyCombatPotionAction(room, player, action, sourceCard) {
  const c = room.combat;
  if (!c) return '';
  const isAlchemistDoubled = hasPowerGroup(player, 'ALCHEMIST') && /nur\s+einmal\s+einsetzbar/i.test((sourceCard && sourceCard.text) || '');
  switch (action.type) {
    case 'findeEineKarteSort1': {
      const pa = room.pendingCardAction;
      const oldContext = action.context;
      oldContext.sortedCards.push(action.cardId);
      oldContext.cardsToSort = oldContext.cardsToSort.filter(id => id !== action.cardId);
      const remaining = oldContext.cardsToSort;
      const options = remaining.map(id => ({ id, label: card(id).name + ' (' + card(id).category + ')', action: { type: 'findeEineKarteSort2', cardId: id, context: oldContext } }));
      openCardChoice(room, player, 'Finde eine Karte - 2. Karte wählen', options);
      // Prevent finishCardAction from clearing pendingCardAction
      pa.keepPending = true;
      return 'wählt 1. Karte für ganz oben';
    }
    case 'findeEineKarteSort2': {
      const oldContext = action.context;
      oldContext.sortedCards.push(action.cardId);
      oldContext.cardsToSort = oldContext.cardsToSort.filter(id => id !== action.cardId);
      const lastId = oldContext.cardsToSort[0];
      oldContext.sortedCards.push(lastId);
      // Zurueck aufs Deck: drawDoor() zieht per pop() vom ENDE des Arrays
      // (Ende = oben). sortedCards ist [1. Wahl, 2. Wahl, Rest] - umgekehrt
      // gepusht landet die 1. Wahl ganz am Ende = ganz oben, wird also zuerst
      // gezogen. (Bugreport 2026-09-19: unshift setzte sie zuvor ans Ende des
      // Arrays, das per pop() aber das UNTERE Ende des Stapels ist.)
      oldContext.sortedCards.reverse().forEach(id => room.doorDeck.push(id));
      return 'wählt 2. Karte, 3. ergibt sich automatisch. Stapel sortiert!';
    }
    case 'forceFlee': {
      c.mustFlee = true;
      return 'die Munchkins müssen weglaufen';
    }
    case 'juckpulverDiscard': {
      const p = findPlayer(room, action.playerId);
      unequipSlotCard(p, action.itemId);
      removeFromHand(p, action.itemId);
      discardCard(room, action.itemId);
      return `${p.name} muss "${card(action.itemId).name}" ablegen`;
    }
    case 'modifier': {
      const amount = isAlchemistDoubled ? action.amount * 2 : action.amount;
      if (action.side === 'both') { c.actorModifier += amount; c.monsterModifier += amount; return `+${amount} für beide Seiten`; }
      if (action.side === 'monster') { c.monsterModifier += amount; return `+${amount} für das Monster`; }
      c.actorModifier += amount;
      return `+${amount} für die Munchkins`;
    }
    // Kampf endet, ohne dass ein Monster besiegt wurde: nie Stufen. Ob es
    // Schatz gibt, sagt der Kartentext - "lässt seinen Schatz zurück"
    // (leavesTreasure) gegen "du erhältst keinen Schatz".
    case 'endCombatNoLevel': {
      const monsters = c.monsterIds.map(card);
      const names = monsters.map((m) => m.name).join(' + ');
      if (action.returnToDoorDeckBottom) [...new Set(c.monsterIds)].forEach((id) => room.doorDeck.unshift(id));
      else discardMonsterIds(room.doorDiscard, c.monsterIds);
      const drawn = [];
      let actor = null;
      if (action.leavesTreasure) {
        // Schatz wie beim Sieg: an die kämpfende Person, nicht an die, die
        // den Trank gespielt hat (jede:r am Tisch darf ihn einwerfen).
        actor = findPlayer(room, c.actorId) || player;
        // MAHLZEIT! nennt eine feste Zahl, sonst gilt der treasureCount der
        // zurueckgelassenen Monster.
        const treasureCount = typeof action.fixedTreasures === 'number'
          ? action.fixedTreasures
          : monsters.reduce((sum, m) => sum + (m.treasureCount || 0), 0);
        drawn.push(...zieheSchaetzeFuer(room, actor, treasureCount));
        drawn.forEach((id) => actor.hand.push(id));
        actor.lastReward = {
          seq: (actor.lastReward ? actor.lastReward.seq : 0) + 1,
          cardIds: drawn,
          levelsGained: 0,
          monsterNames: monsters.map((m) => m.name),
        };
      }
      beendeKampfOhneSieg(room, c, action.thenLoot);
      return action.leavesTreasure
        ? (!drawn.length && actor && hatSchatzSperre(actor)
            ? `Kampf gegen ${names} beendet, keine Stufe - ${actor.name} steht auf der Störerliste und bekommt keinen Schatz`
            : `Kampf gegen ${names} beendet, keine Stufe, ${drawn.length} zurückgelassene Schatzkarte(n)`)
        : `Kampf gegen ${names} beendet, kein Schatz`;
    }
    case 'doubleStrength': {
      c.doubleActor = true;
      return 'Kampfstaerke der Munchkin-Seite verdoppelt';
    }
    // TYPOGRAFISCHER FEHLER: "Ein Monster hat einen Tippfehler in seiner
    // Beschreibung; daher wird es fuer alle Zwecke als Stufe 1 behandelt.
    // Seine Kraefte und sein Schatz bleiben unveraendert."
    // ponytail: WELCHES Monster waehlt die Karte nicht aus - hier trifft es
    // das staerkste noch nicht heruntergesetzte (das ist immer die sinnvolle
    // Wahl). Ein Monster-Waehler waere der Aufruestweg. "Fuer alle Zwecke"
    // gilt hier fuer die Kampfrechnung; Regeln, die VOR dem Kampf an der
    // gedruckten Stufe haengen (MONSTER_REFUSES), sind da laengst durch.
    case 'treatMonsterAsLevel1': {
      c.levelOverrides = c.levelOverrides || {};
      const offen = c.monsterIds.filter((id) => c.levelOverrides[id] == null);
      if (!offen.length) return '';
      const ziel = offen.reduce((a, b) => (((card(a) || {}).level || 0) >= ((card(b) || {}).level || 0) ? a : b));
      c.levelOverrides[ziel] = 1;
      return `"${(card(ziel) || {}).name}" zählt jetzt als Stufe 1`;
    }
    // HALBFINAL-SCHLAG: "Waehle einen Gegenstand, den du verwendest, der NICHT
    // 'nur einmal einsetzbar' ist. Erhalte fuer einen einzigen Kampf 3-Mal den
    // normalen Bonus dieses Gegenstands. Wirf dann einen Wuerfel. Bei einer 6
    // kannst du den Gegenstand behalten; andernfalls wird er abgeworfen."
    // ponytail: der Wuerfelwurf laeuft direkt ueber rollDie() statt ueber
    // rollWithWindow - der GEZINKTE WÜRFEL kann ihn also nicht drehen. Das
    // Reaktionsfenster hier aufzumachen hiesse, den Kartenbonus erst nach der
    // Antwort zu verrechnen.
    case 'tripleItemBonus': {
      const ziel = card(action.itemId);
      if (!ziel) return '';
      const bonus = ziel.bonus || 0;
      // Der Gegenstand selbst zaehlt schon einmal ueber equippedBonusSum mit.
      c.actorModifier += bonus * 2;
      // Der Bonus gilt sofort; nur ueber Behalten/Abwerfen entscheidet der
      // Wurf - deshalb darf hier ein Reaktionsfenster aufgehen.
      return wurfMitFenster(room, player, 'halbfinalschlag', (wurf) => {
        if (wurf === 6) return `"${ziel.name}" zaehlt dreifach (+${bonus * 3}); Wuerfelwurf 6 - Gegenstand bleibt`;
        // Verloren, aber der dreifache Bonus gilt "fuer einen einzigen Kampf":
        // der wegfallende Grundbonus wird ausgeglichen.
        unequipSlotCard(player, action.itemId);
        discardCard(room, action.itemId);
        c.actorModifier += bonus;
        return `"${ziel.name}" zaehlt dreifach (+${bonus * 3}); Wuerfelwurf ${wurf} - Gegenstand wird abgeworfen`;
      });
    }
    // NIMM MICH! NIMM MICH!: "Wenn ein Spieler befugt ist, im Kampf um Hilfe
    // zu bitten, spiele diese Karte, um ihn dazu zu zwingen, DEINE Hilfe zu
    // akzeptieren. Du kannst keine Belohnung einfordern."
    case 'forceSelfAsHelper': {
      c.helperId = player.id;
      c.helperPending = null;
      c.helperReward = 0; // "Du kannst keine Belohnung einfordern."
      zaubercouchFragen(player);
      c.bardenZwang = false; // draengt sich freiwillig rein, keine Verzauber-Zusage

      refreshCombatReady(room);
      return `${player.name} draengt sich als Helfer in den Kampf (ohne Belohnung)`;
    }
    // UNFASSBAR REICH: "Fuer ein Monster im Kampf spielen. Wird der Schatz
    // erbeutet, koennen die Spieler, die ihn erhalten, jede Schatzkarte
    // ablegen, nachdem sie sich diese angesehen haben, und einmalig eine
    // Ersatzkarte ziehen." Gemerkt wird es am Kampf, eingeloest in
    // resolveCombatWin.
    case 'schatzUmtauschAnmelden': {
      c.schatzUmtausch = true;
      return 'erbeutete Schätze dürfen einmalig getauscht werden';
    }
    case 'removeHelper': {
      const helper = findPlayer(room, c.helperId);
      c.helperId = null;
      c.helperReward = 0; // mit der Helfer:in faellt auch ihre Zusage weg
      refreshCombatReady(room); // ZAUBERCOUCH: die Hilfe ist keine combatParticipant mehr
      c.bardenZwang = false;
      return `${helper ? helper.name : 'Helfer'} verlässt den Kampf`;
    }
    // POLLYVERWANDLUNGSTRANK/TRANK DER IRRELEVANZ/ENTLASSUNGSGLOCKE nennen
    // ausdruecklich EIN Monster ("Verwandelt ein Monster ...", "Wenn es das
    // einzige Monster im Kampf war, ist der Kampf vorbei"). endCombatNoLevel
    // legt dagegen ALLE ab und schuettet bei leavesTreasure auch deren Schatz
    // aus - bei zwei Monstern war das viel zu stark.
    case 'removeOneMonster': {
      const mId = action.monsterId || c.monsterIds[0];
      const idx = c.monsterIds.indexOf(mId);
      if (idx < 0) return 'Monster nicht im Kampf gefunden';
      const m = card(mId);
      c.monsterIds.splice(idx, 1);
      // KUMPEL kann dieselbe Karten-ID zweimal im Kampf haben: solange die
      // zweite Kopie noch kaempft, darf die Karte weder auf den Ablagestapel
      // noch zurueck in den Tuerstapel - sonst laege sie gleichzeitig im
      // Stapel UND im Kampf (siehe discardMonsterIds).
      if (!c.monsterIds.includes(mId)) {
        if (action.returnToDoorDeckBottom) room.doorDeck.unshift(mId);
        else room.doorDiscard.push(mId);
      }
      if (action.keepTreasureForWin) {
        c.treasureDelta = (c.treasureDelta || 0) + (m.treasureCount || 0);
      }
      const drawn = [];
      let actorFuerSchatz = null;
      if (action.leavesTreasure) {
        actorFuerSchatz = findPlayer(room, c.actorId) || player;
        drawn.push(...zieheSchaetzeFuer(room, actorFuerSchatz, m.treasureCount || 0));
        actorFuerSchatz.lastReward = {
          seq: (actorFuerSchatz.lastReward ? actorFuerSchatz.lastReward.seq : 0) + 1,
          cardIds: drawn, levelsGained: 0, monsterNames: [m.name],
        };
        drawn.forEach((id) => actorFuerSchatz.hand.push(id));
      }
      const schatzHinweis = (!drawn.length && actorFuerSchatz && (m.treasureCount || 0) && hatSchatzSperre(actorFuerSchatz))
        ? `, aber ${actorFuerSchatz.name} steht auf der Störerliste und bekommt nichts`
        : (drawn.length ? `, ${drawn.length} zurueckgelassene Schatzkarte(n)` : '');
      // Die Verstaerker des entfernten Monsters fallen mit ihm weg: sie
      // rechnen ueber enhancerBonusSumme()/enhancerTreasureSumme() nur noch
      // fuer Monster-Ids, die noch in c.monsterIds stehen.
      if (!c.monsterIds.length) {
        beendeKampfOhneSieg(room, c, action.thenLoot);
        return `"${m.name}" verschwindet - Kampf vorbei, keine Stufe${schatzHinweis}`;
      }
      refreshCombatReady(room);
      return `"${m.name}" verschwindet${schatzHinweis} - der Kampf geht weiter`;
    }
    case 'killMonsterInCombat': {
      const idx = c.monsterIds.findIndex((id) => { const m = card(id); return m && m.name === action.name; });
      if (idx < 0) return 'Monster nicht im Kampf gefunden';
      const [dead] = c.monsterIds.splice(idx, 1);
      room.doorDiscard.push(dead);
      if (c.monsterIds.length === 0) beendeKampfOhneSieg(room, c, false);
      return `${action.name} sofort besiegt (kein Schatz)`;
    }
    // WANDERNDES MONSTER: "Dein Monster schliesst sich dem schon kaempfenden
    // an - addiere ihre Kampfstaerken."
    case 'zeroMonsterTreasure': {
      const mid = action.monsterId || c.monsterIds[0];
      c.zeroTreasureMonsterIds = c.zeroTreasureMonsterIds || [];
      c.zeroTreasureMonsterIds.push(mid);
      return `reduziert die Schätze von "${card(mid).name}" auf 0`;
    }
    case 'freundlichChoice': {
      openCardChoice(room, player, sourceCard ? sourceCard.name : 'FREUNDLICH', [
        { id: 'freundlich-take', label: 'Schatz nehmen und Kampf beenden', action: { type: 'endCombatNoLevel', leavesTreasure: true } },
        { id: 'freundlich-fight', label: 'Weiterkämpfen (Monster gibt 2 extra Schätze)', action: { type: 'freundlichFightOn' } },
      ]);
      return null;
    }
    case 'freundlichFightOn': {
      const r1 = Math.floor(Math.random() * 6) + 1;
      const r2 = Math.floor(Math.random() * 6) + 1;
      const roll = r1 + r2;
      c.monsterModifier = (c.monsterModifier || 0) + roll;
      return `würfelt ${roll} und lässt den Kampf weitergehen (+${roll} auf Monster)`;
    }
    case 'duplicateMonsterMommy': {
      const mid = action.monsterId || action.validMonsterIds[0];
      // Nur BABY auf GENAU diesem Monster zaehlt - BABY auf einem anderen
      // Monster im selben Kampf hat mit dieser Mami nichts zu tun.
      const hasBaby = (c.enhancers || []).some((e) => e.monsterId === mid && (card(e.cardId) || {}).name === 'BABY');
      c.monsterIds.push(mid);
      c.mommyMonsterId = mid;
      // "Mami ist von allen Verbesserungen ihres Babys betroffen, ausser der
      // BABY-Karte selbst": mit dem zweiten Vorkommen von mid zaehlen alle an
      // mid haengenden Verstaerker (enhancerBonusSumme, siehe combatTotals)
      // automatisch ein zweites Mal - das ist fuer URALT & Co. genau richtig.
      // Nur BABYs -5 soll NICHT doppelt gelten, deshalb hier ausgeglichen.
      let mamiBonus = 10;
      if (hasBaby) mamiBonus += 5; // gleicht BABYs verdoppeltes -5 aus
      c.monsterModifier += mamiBonus;
      refreshCombatReady(room);
      return `ruft die MAMI von "${card(mid).name}" (+${mamiBonus} auf Mami)`;
    }
    case 'combatAddMonster': {
      removeFromHand(player, action.cardId);
      c.monsterIds.push(action.cardId);
      refreshCombatReady(room);
      return `"${card(action.cardId).name}" schliesst sich dem Kampf an`;
    }
    // ILLUSION: "Lege ein beliebiges Monster in diesem Kampf ab, zusammen mit
    // allen Karten, die gespielt wurden, um es zu veraendern, und ersetze es."
    case 'combatReplaceMonster': {
      removeFromHand(player, action.cardId);
      const alt = c.monsterIds.shift();
      if (alt) room.doorDiscard.push(alt);
      c.monsterIds.unshift(action.cardId);
      // Die Verstaerker des ersetzten Monsters fallen von selbst weg: sie
      // rechnen ueber enhancerBonusSumme()/enhancerTreasureSumme() nur noch
      // fuer Monster-Ids in c.monsterIds, und "alt" steht dort nicht mehr.
      // Kampfweite Boni (Traenke, Wuerfelergebnisse) haengen an keinem
      // Monster und bleiben deshalb unangetastet.
      refreshCombatReady(room);
      return `"${card(alt).name}" wird durch "${card(action.cardId).name}" ersetzt`;
    }
    // TROJANISCHER PFERD ohne Monster: nur der Schatz entfaellt, der Kampf
    // bleibt beim urspruenglichen Sieg.
    case 'trojanerOhneMonster': {
      c.trojanerNoTreasure = true;
      finishCombatWin(room);
      return 'kein Schatz';
    }
    // TROJANISCHER PFERD mit Monster: kein Schatz, stattdessen ein neuer
    // Kampf gegen genau dieses Monster. aktorId wird VOR finishCombatWin
    // gelesen, weil die Funktion room.combat auf null setzt - c selbst
    // bleibt als Referenz auf das alte (jetzt losgeloeste) Objekt gueltig.
    case 'trojanerMitMonster': {
      removeFromHand(player, action.cardId);
      const monsterName = card(action.cardId).name;
      const aktorId = c.actorId;
      c.trojanerNoTreasure = true;
      finishCombatWin(room);
      if (!room.winner) startCombat(room, aktorId, [action.cardId], { fromHand: true });
      return `kein Schatz - neuer Kampf gegen "${monsterName}"`;
    }
    // Monster-Verstaerker: erst hier weiss der Server, welches Monster
    // gemeint war (bei nur einem Monster im Kampf sofort, sonst nach der
    // Zielwahl in handlePlayCombatCard).
    case 'verstaerkerAufMonster': {
      if (!c.monsterIds.includes(action.monsterId)) return 'das Monster ist nicht mehr im Kampf';
      c.enhancers = (c.enhancers || []).concat({ cardId: action.cardId, monsterId: action.monsterId });
      const karte = card(action.cardId);
      const eintrag = { cardId: action.cardId, monsterId: action.monsterId };
      const bonus = enhancerBonusEintrag(room, eintrag);
      const ziel = card(action.monsterId);
      const zusatz = (karte.name === 'GIGANTISCH' && ziel.name === 'FUNGUS') ? ' - der Fungus erhält 25 statt 10'
        : (ziel.name === 'RAPIER-TROTTEL' ? ' - der Rapier-Trottel verdoppelt' : '');
      const delta = typeof karte.treasureCount === 'number' ? karte.treasureCount : 0;
      log(room, `${player.name} spielt "${karte.name}" auf "${ziel.name}" (${bonus >= 0 ? '+' : ''}${bonus}${zusatz}${delta ? `, ${delta >= 0 ? '+' : ''}${delta} Schatz` : ''}).`, [action.cardId]);
      announceCardPlay(room, player, action.cardId, `${bonus >= 0 ? '+' : ''}${bonus} für "${ziel.name}"`);
      // Ein Verstaerker kann Kampfstaerke UND (durch UNTOT) den Untot-Status
      // aendern - beides muss den Bereit-Status zuruecksetzen.
      refreshCombatReady(room);
      // '' statt einer Beschreibung: die Zeile oben ist schon geloggt (mit
      // Zielmonster und Sonderfaellen) - bei mehreren Monstern haengt sonst
      // noch eine zweite, redundante Zusammenfassung von
      // handleResolveCardChoice dahinter (gleiche Bauform wie
      // 'useLampOnMonster').
      return '';
    }
    default:
      return '';
  }
}

function handleSetCombatModifier(room, playerId, who, value) {
  if (!room.combat) return;
  const c = room.combat;
  if (c.mustFlee) return;
  // TROJANISCHER PFERD: siehe handlePlayCombatCard - der Kampf ist bereits
  // entschieden, solange das Reaktionsfenster offen ist oder gerade
  // aufgeloest wird.
  if (c.trojanerOffer || c.trojanerDone) return;
  const player = findPlayer(room, playerId);
  if (!player) return;
  // Jede:r am Tisch darf hier eingreifen (Karteneffekte, die das Monster
  // stärken/schwächen oder den Kämpfenden helfen/schaden, manuell eintragen) -
  // nicht nur die kämpfende Person selbst.
  const v = Math.max(-99, Math.min(99, Math.round(Number(value) || 0)));
  if (who === 'monster') {
    if (c.monsterModifier === v) return;
    c.monsterModifier = v;
    log(room, `${player.name} setzt den Monster-Bonus/Malus auf ${v >= 0 ? '+' : ''}${v}.`);
  } else {
    if (c.actorModifier === v) return;
    c.actorModifier = v;
    log(room, `${player.name} setzt den Bonus/Malus der Kämpfenden auf ${v >= 0 ? '+' : ''}${v}.`);
  }
  touchRoom(room);
}

// Jede:r Spieler:in (nicht nur Angreifer:in/Helfer:in) darf einen
// Monster-Verstärker aus der eigenen Hand in den laufenden Kampf spielen -
// z.B. um das Monster zu stärken (mehr Risiko, mehr Schatz) oder zu
// schwächen und so der kämpfenden Person zu helfen.
// GEMEINE GHOULE: "Gegen sie duerfen keine Gegenstaende oder andere Boni
// eingesetzt werden - kaempfe nur mit deiner Charakterstufe." combatTotals
// laesst deshalb jeden Munchkin-Bonus fallen (actorModifier eingeschlossen).
// Eine Karte, die genau das bringen soll, waere also verbraucht, ohne zu
// wirken und wird hier abgewiesen statt still geschluckt. Die Monster-Seite
// zaehlt auch gegen die Ghoule: Karten mit Seitenwahl ("egal welche Seite",
// eigene Wahl) bleiben spielbar, nur ihre Munchkin-Option faellt weg (siehe
// ohneMunchkinBonus).
// tripleItemBonus (HALBFINAL-SCHLAG) landet ebenfalls in actorModifier.
const istNurMunchkinBonus = (action) => !!action
  && ((action.type === 'modifier' && action.side === 'actor') || action.type === 'tripleItemBonus');
function munchkinBonusWirkungslos(room, spec) {
  if (!spec || !combatHasMonster(room, MONSTER_IGNORES_BONUSES)) return false;
  if (spec.type === 'modifier') return spec.side === 'actor';
  // Trifft heute HALBFINAL-SCHLAG (nur Gegenstandsoptionen) und schuetzt
  // zugleich davor, dass ohneMunchkinBonus einen leeren Wahl-Dialog oeffnet.
  if (spec.type === 'choice') return spec.options.every((o) => istNurMunchkinBonus(o.action));
  return false;
}
function ohneMunchkinBonus(room, options) {
  if (!combatHasMonster(room, MONSTER_IGNORES_BONUSES)) return options;
  return options.filter((o) => !istNurMunchkinBonus(o.action));
}

// Gespielte Kampfkarte als Anzeige-Ereignis: alle am Tisch sollen kurz sehen,
// WER WAS spielt ("URALT" auf das Monster, ein Trank auf die Munchkins, eine
// Klassenkraft). Gleiche Bauform wie doorReveal/dieRoll - ein Zaehler, damit
// der Client die Animation genau einmal abspielt und beim Wiederverbinden
// nichts nachholt.
// Kampfkarten, die ueber ihre Sofortwirkung hinaus den Weglaufwurf dieses
// Kampfes veraendern. Der Zuschlag haengt am Kampf, nicht an der Karte oder
// der Person - er gilt fuer alle Munchkins im Kampf (siehe
// fleeModifierParts).
const FLEE_BONUS_WHEN_PLAYED = {
  'STEAM-CODE': 1, // "Wenn der Kampf verloren wird, erhalten die Munchkins +1 auf Weglaufen."
};

function announceCardPlay(room, player, cardId, hinweis) {
  room.cardPlay = {
    seq: (room.cardPlay ? room.cardPlay.seq : 0) + 1,
    cardId, playerName: player.name, hinweis: hinweis || '',
  };
}

// Gleiches Muster wie announceCardPlay: der Client zeigt kurz die Karte,
// deren Sonderkraft gerade aktiviert wurde, mit einem "glaenzenden"
// Spezialeffekt (siehe playCardPower im Client) statt der schlichten
// Kampfkarten-Anzeige.
function announceCardPower(room, player, cardId) {
  room.cardPower = {
    seq: (room.cardPower ? room.cardPower.seq : 0) + 1,
    cardId, playerName: player.name,
  };
}

function handlePlayCombatCard(room, playerId, cardId) {
  if (!room.combat || room.combat.mustFlee) return;
  // TROJANISCHER PFERD: der Kampf ist bereits entschieden, solange das
  // Reaktionsfenster offen ist oder gerade aufgeloest wird - sonst liesse
  // sich z.B. ueber WANDERNDES MONSTER noch ein zusaetzliches Monster (und
  // damit Stufen/Schaetze) in einen schon gewonnenen Kampf nachschieben.
  if (room.combat.trojanerOffer || room.combat.trojanerDone) return;
  const player = findPlayer(room, playerId);
  if (!player || !player.hand.includes(cardId)) return;
  // EINSTWEILIGE VERFÜGUNG: wer gesperrt ist, darf in diesen Kampf nicht
  // eingreifen, solange die geschuetzte Person daran teilnimmt.
  // ponytail: gesperrt ist JEDE Kampfkarte, nicht nur die schaedlichen - ob
  // eine Karte "gegen dich" geht, haengt in einem Kampf von der Seite ab, die
  // sie staerkt, und die kann sich noch aendern.
  const gesperrtGegen = combatParticipants(room).find((p) => kartenSperreAktiv(room, playerId, p.id));
  if (gesperrtGegen) {
    log(room, `${player.name} steht unter einer Einstweiligen Verfügung von ${gesperrtGegen.name} und kann in diesem Kampf keine Karten spielen.`);
    touchRoom(room);
    return;
  }
  // RIESENSTINKTIER, weisse Liste: erlaubt sind genau die zwei Ausnahmen, die
  // der Kartentext nennt. Alles andere ist gesperrt - ausdruecklich auch
  // KUMPEL, ILLUSION, HILF MIR und ÜBERFALLTRANK: es sind Karten, die "fuer
  // oder gegen dich" wirken, und die Karte nimmt sie nicht aus.
  const c = card(cardId);
  if (!c) return;
  // REGENMANTEL: "Andere Spieler können deine Kämpfe nicht mit Tränken stören."
  // Gilt nicht, wenn jemand hilft.
  if (isCombatPotionCard(c) && !room.combat.helperId && playerId !== room.combat.actorId) {
    const actor = findPlayer(room, room.combat.actorId);
    if (equippedItemIds(actor).some((id) => (card(id) || {}).name === 'REGENMANTEL')) {
      log(room, `${player.name} kann keinen Trank spielen: ${actor.name} trägt einen Regenmantel und kämpft alleine.`);
      touchRoom(room);
      return;
    }
  }
  if (stinktierSperre(room, playerId)
    && !(c.name === 'WANDERNDES MONSTER' || isMonsterEnhancerCard(c))) {
    log(room, `${player.name} kommt am Riesenstinktier nicht vorbei - nur Wandernde Monster und Monsterverstärker gehen durch.`);
    touchRoom(room);
    return;
  }
  // COMBAT_REACTION_CARDS (Kumpel, Wanderndes Monster, Illusion, Hilf mir,
  // Ueberfalltrank): sie greifen selbst in monsterIds/actorId ein statt nur
  // einen Zahlenwert zu addieren - deshalb vor der Verstaerker-/Trank-Logik.
  const reaktion = COMBAT_REACTION_CARDS[c.name];
  if (reaktion) {
    if (room.pendingCardAction || room.pendingConsequence) return;
    // HILF MIR: "waehrend du dich im Kampf befindest" (siehe nurImKampf).
    if (reaktion.nurImKampf && !combatParticipants(room).some((p) => p.id === player.id)) {
      log(room, `"${c.name}" darf nur spielen, wer selbst im Kampf steht - die Karte bleibt bei ${player.name} auf der Hand.`);
      touchRoom(room);
      return;
    }
    applyCombatReaction(room, player, cardId, reaktion);
    return;
  }
  if (LAMP_CARDS.has(c.name)) {
    const actor = currentPlayer(room);
    if (!actor || actor.id !== playerId || room.combat.actorId !== playerId) {
      log(room, `"${c.name}" ist nur in der eigenen Runde spielbar - die Karte bleibt auf der Hand.`);
      touchRoom(room);
      return;
    }
    if (room.combat.monsterIds.length === 1) {
      handleUseLamp(room, playerId, cardId, room.combat.monsterIds[0]);
      return;
    }
    openCardChoice(room, actor, c.name, room.combat.monsterIds.map((mId) => ({
      id: `lamp-mon-${mId}`,
      label: `"${card(mId).name}" verschwinden lassen`,
      action: { type: 'useLampOnMonster', monsterId: mId, lampCardId: cardId },
    })));
    room.pendingCardAction.sourceCardId = cardId;
    log(room, `${player.name} spielt "${c.name}" im Kampf - Monster-Wahl nötig.`, [cardId]);
    touchRoom(room);
    return;
  }
  if (isMonsterEnhancerCard(c)) {
    // Nur wirklich unterschiedliche Monster brauchen eine Zielwahl - KUMPEL
    // legt dasselbe Monster zweimal in monsterIds, das waere sonst ein
    // Wahldialog mit einer einzigen Option.
    const zielMonster = [...new Set(room.combat.monsterIds)];
    if (zielMonster.length > 1 && (room.pendingCardAction || room.pendingConsequence)) {
      // Es laeuft schon eine andere Kartenwahl (z.B. ein zweiter Verstaerker) -
      // diese hier wuerde room.pendingCardAction ueberschreiben und die erste
      // Wahl verwaisen lassen. Karte bleibt auf der Hand, nochmal versuchen.
      log(room, `"${c.name}" wartet: eine andere Kartenwahl läuft noch - die Karte bleibt bei ${player.name} auf der Hand.`);
      touchRoom(room);
      return;
    }
    removeFromHand(player, cardId);
    // Bei mehreren Monstern muss gesagt werden, welches verstaerkt wird
    // (gleiche Bauform wie die Monster-Wahl der MAGISCHEN LAMPE).
    if (zielMonster.length > 1) {
      room.doorDiscard.push(cardId);
      openCardChoice(room, player, c.name, zielMonster.map((mId) => ({
        id: `verstaerker-${mId}`,
        label: `Auf "${card(mId).name}" spielen`,
        action: { type: 'verstaerkerAufMonster', cardId, monsterId: mId },
      })));
      room.pendingCardAction.sourceCardId = cardId;
      log(room, `${player.name} spielt "${c.name}" im Kampf - Zielmonster nötig.`, [cardId]);
      announceCardPlay(room, player, cardId, 'Zielmonster wird noch gewählt');
      touchRoom(room);
      return;
    }
    room.doorDiscard.push(cardId);
    applyCombatPotionAction(room, player, { type: 'verstaerkerAufMonster', cardId, monsterId: zielMonster[0] }, c);
    touchRoom(room);
    return;
  }
  if (DOOR_COMBAT_CARDS[c.name]) {
    const doorSpec = DOOR_COMBAT_CARDS[c.name](player, room);
    if (doorSpec == null) {
      log(room, `${player.name} kann "${c.name}" gerade nicht einsetzen (Bedingung nicht erfuellt).`);
      touchRoom(room);
      return;
    }
    if (munchkinBonusWirkungslos(room, doorSpec)) {
      log(room, `"${c.name}" wuerde gegen "${monsterIgnoringBonusesName(room)}" nichts bewirken (nur Charakterstufen zaehlen) - die Karte bleibt auf der Hand.`);
      touchRoom(room);
      return;
    }

    const needsTarget = ['removeOneMonster', 'zeroMonsterTreasure', 'duplicateMonsterMommy'];
    const candidates = doorSpec.validMonsterIds || room.combat.monsterIds;
    if (needsTarget.includes(doorSpec.type) && candidates.length > 1) {
      openCardChoice(room, player, c.name, candidates.map((mId, i) => ({
        id: `mon-${i}-${mId}`,
        label: `Auf "${card(mId).name}" spielen`,
        action: Object.assign({}, doorSpec, { monsterId: mId }),
      })));
      room.pendingCardAction.sourceCardId = cardId;
      log(room, `${player.name} spielt "${c.name}" im Kampf - Monster-Wahl nötig.`, [cardId]);
      announceCardPlay(room, player, cardId, 'Ziel wird gewählt');
      touchRoom(room);
      return;
    }

    removeFromHand(player, cardId);
    discardCard(room, cardId);
    const desc = applyCombatPotionAction(room, player, doorSpec, c);
    log(room, `${player.name} spielt "${c.name}" im Kampf: ${desc}.`, [cardId]);
    announceCardPlay(room, player, cardId, desc);
    touchRoom(room);
    return;
  }
  if (!isCombatPotionCard(c)) return;
  if (room.pendingCardAction || room.pendingConsequence) return;
  const spec = COMBAT_POTION_OVERRIDES[c.name] !== undefined
    ? COMBAT_POTION_OVERRIDES[c.name](player, room)
    : (() => { const p = parseCombatPotion(c.text); return p && { type: 'modifier', side: p.side, amount: p.amount }; })();
  if (spec == null) {
    log(room, `${player.name} kann "${c.name}" gerade nicht einsetzen (Bedingung nicht erfüllt).`);
    touchRoom(room);
    return;
  }
  if (munchkinBonusWirkungslos(room, spec)) {
    log(room, `"${c.name}" wuerde gegen "${monsterIgnoringBonusesName(room)}" nichts bewirken (nur Charakterstufen zaehlen) - die Karte bleibt auf der Hand.`);
    touchRoom(room);
    return;
  }
  removeFromHand(player, cardId);
  // Über discardCard(), weil Kampf-Tränke type 'treasure' sind: auf dem
  // Tür-Ablagestapel würden sie beim Neumischen (drawDoor) zu Türkarten.
  discardCard(room, cardId);
  // STEAM-CODE: "Wenn der Kampf verloren wird, erhalten die Munchkins +1 auf
  // Weglaufen." Weggelaufen wird ohnehin nur nach einem verlorenen Kampf, also
  // braucht es keine zusaetzliche Bedingung - und der Zuschlag gilt laut Karte
  // unabhaengig davon, fuer welche Seite die +3 gespielt wurden. Deshalb HIER,
  // vor der Seitenwahl.
  if (FLEE_BONUS_WHEN_PLAYED[c.name]) {
    room.combat.playedFleeBonus = (room.combat.playedFleeBonus || 0) + FLEE_BONUS_WHEN_PLAYED[c.name];
  }
  if (spec.type === 'modifier' && spec.side === 'either') {
    // Gegen die GEMEINEN GHOULE faellt die Munchkin-Seite weg - sie waere
    // wirkungslos (siehe munchkinBonusWirkungslos).
    // actorAmount: Karten, deren Bonus nur auf der Munchkin-Seite steigt
    // (SCHARFE PFEFFERSOSSE "+6 zur Hilfe von Halblingen").
    const fuerMunchkins = spec.actorAmount != null ? spec.actorAmount : spec.amount;
    const seiten = ohneMunchkinBonus(room, [
      { id: 'munchkins', label: `+${fuerMunchkins} für die Munchkins`, action: { type: 'modifier', side: 'actor', amount: fuerMunchkins } },
      { id: 'monster', label: `+${spec.amount} für das Monster`, action: { type: 'modifier', side: 'monster', amount: spec.amount } },
    ]);
    openCardChoice(room, player, c.name, seiten);
    room.pendingCardAction.sourceCardId = cardId;
    log(room, `${player.name} spielt "${c.name}" im Kampf - Seite nötig.`, [cardId]);
    announceCardPlay(room, player, cardId, 'Seite wird noch gewählt');
    touchRoom(room);
    return;
  }
  if (spec.type === 'choice') {
    openCardChoice(room, player, c.name, ohneMunchkinBonus(room, spec.options));
    room.pendingCardAction.sourceCardId = cardId;
    log(room, `${player.name} spielt "${c.name}" im Kampf - Wahl nötig.`, [cardId]);
    announceCardPlay(room, player, cardId, 'Wahl steht noch aus');
    touchRoom(room);
    return;
  }
  // "Ein Monster" - bei mehreren im Kampf muss gesagt werden, welches (gleiche
  // Bauform wie die Monster-Wahl der MAGISCHEN LAMPE weiter oben).
  if (spec.type === 'removeOneMonster' && room.combat.monsterIds.length > 1) {
    // KUMPEL kann dieselbe Karte zweimal im Kampf haben - dann braucht jede
    // Option eine eigene ID, sonst sehen beide gleich aus.
    openCardChoice(room, player, c.name, room.combat.monsterIds.map((mId, i) => ({
      id: `mon-${i}-${mId}`,
      label: `"${card(mId).name}"${room.combat.monsterIds.filter((x) => x === mId).length > 1 ? ` (${i + 1}.)` : ''} verschwinden lassen`,
      action: Object.assign({}, spec, { monsterId: mId }),
    })));
    room.pendingCardAction.sourceCardId = cardId;
    log(room, `${player.name} spielt "${c.name}" im Kampf - Monster-Wahl nötig.`, [cardId]);
    announceCardPlay(room, player, cardId, 'Monster wird noch gewählt');
    touchRoom(room);
    return;
  }
  const desc = applyCombatPotionAction(room, player, spec, c);
  log(room, `${player.name} spielt "${c.name}" im Kampf: ${desc}.`, [cardId]);
  announceCardPlay(room, player, cardId, desc);
  touchRoom(room);
}

// Wendet eine der fuenf COMBAT_REACTION_CARDS an - siehe Kommentar dort im
// Kartennamen-Kommentar (src/cards/reactions.js) fuer den Originaltext.
function applyCombatReaction(room, player, cardId, regel) {
  const c = room.combat;
  const karte = card(cardId);
  // Kampfreaktionen (Kumpel, Wanderndes Monster, Illusion, Hilf mir,
  // Ueberfalltrank) greifen tief in den Kampf ein - erst recht soll der Tisch
  // sehen, wer sie spielt. Erst NACH den Bedingungen unten: eine Karte, die
  // liegen bleibt, darf keine Animation ausloesen.
  const zeigen = () => announceCardPlay(room, player, cardId, 'Kampfreaktion');
  if (regel.kind === 'duplicateMonster') {
    // Dieselbe Karten-ID ein zweites Mal in den Kampf: Stufe, Schatzzahl und
    // alle Dauerwirkungen gelten damit automatisch doppelt (siehe
    // combatTotals/resolveCombatWin). Beim Ablegen darf die ID trotzdem nur
    // einmal auf den Stapel wandern - siehe discardMonsterIds weiter unten.
    const erstes = c.monsterIds[0];
    if (!erstes) return;
    c.monsterIds.push(erstes);
    // "... mit den gleichen Monsterverstaerker-Karten": Stufe, Schatzzahl UND
    // die an "erstes" haengenden Verstaerker verdoppeln sich jetzt von selbst
    // ueber die zweite Vorkommen von "erstes" in monsterIds - siehe
    // enhancerBonusSumme()/enhancerTreasureSumme(). Kein Code mehr noetig.
    removeFromHand(player, cardId);
    discardCard(room, cardId);
    zeigen();
    log(room, `${player.name} spielt "${karte.name}": "${card(erstes).name}" taucht ein zweites Mal auf.`, [cardId]);
    refreshCombatReady(room);
    touchRoom(room);
    return;
  }
  if (regel.kind === 'addMonsterFromHand' || regel.kind === 'replaceMonsterFromHand') {
    const eigene = player.hand.filter((id) => (card(id) || {}).category === 'monster');
    if (!eigene.length) {
      log(room, `${player.name} hat kein Monster auf der Hand - "${karte.name}" bleibt liegen.`);
      touchRoom(room);
      return;
    }
    removeFromHand(player, cardId);
    discardCard(room, cardId);
    zeigen();
    openCardChoice(room, player, karte.name, eigene.map((id) => ({
      id: `mon-${id}`,
      label: card(id).name,
      action: regel.kind === 'addMonsterFromHand'
        ? { type: 'combatAddMonster', cardId: id }
        : { type: 'combatReplaceMonster', cardId: id },
    })));
    log(room, `${player.name} spielt "${karte.name}" - Monster von der Hand nötig.`, [cardId]);
    touchRoom(room);
    return;
  }
  if (regel.kind === 'takeItemFromPlayer') {
    // Der genommene Gegenstand ist eine Schatzkarte - nicht auf der Stoererliste.
    if (hatSchatzSperre(player)) {
      log(room, `${player.name} steht auf der Störerliste und bekommt keine Schatzkarten - "${karte.name}" bleibt auf der Hand.`);
      touchRoom(room);
      return;
    }
    removeFromHand(player, cardId);
    discardCard(room, cardId);
    zeigen();
    openCardTarget(room, player, karte.name, 'Von wem einen Gegenstand nehmen?', { type: 'takeAnyItem' });
    log(room, `${player.name} spielt "${karte.name}" - Ziel nötig.`, [cardId]);
    touchRoom(room);
    return;
  }
  if (regel.kind === 'handOverCombat') {
    removeFromHand(player, cardId);
    discardCard(room, cardId);
    zeigen();
    openCardTarget(room, player, karte.name, 'Wer soll stattdessen kämpfen?', { type: 'handOverCombat' });
    log(room, `${player.name} spielt "${karte.name}" - Ziel nötig.`, [cardId]);
    touchRoom(room);
  }
}

// Wie viele Schaetze bringt dieser Kampf sicher? Grundlage fuer die
// Obergrenze der Helfer-Zusage - kartenspezifische Bonusschaetze
// (monsterVictoryExtras) stehen beim Anfragen noch nicht fest und bleiben
// deshalb aussen vor; sie landen dann bei der kaempfenden Person.
function kampfSchatzZahl(room) {
  const c = room.combat;
  if (!c) return 0;
  const basis = c.monsterIds.reduce((sum, id) => {
    if (c.zeroTreasureMonsterIds && c.zeroTreasureMonsterIds.includes(id)) return sum;
    return sum + ((card(id) || {}).treasureCount || 0);
  }, 0);
  const delta = (c.treasureDelta || 0) + enhancerTreasureSumme(room);
  return Math.max(0, delta ? Math.max(1, basis + delta) : basis);
}

// Gemeinsame Sperrpruefung fuer JEDE Anfrage nach Hilfe - ob ueber den
// normalen "Um Hilfe bitten"-Knopf (handleRequestHelp) oder ueber BARDE
// "Verzaubern" (bardenVerzauberInfo/handleBardeVerzaubern). handleRespondHelp
// prueft das absichtlich NICHT erneut (das waere ein zweiter, leicht
// abweichender Kopiersatz) - wer bis zur Annahme kommt, hat diese Pruefung
// schon hinter sich. Reihenfolge und Texte 1:1 wie zuvor in handleRequestHelp,
// nur an einer Stelle statt an zweien.
function hilfeVerbotenGrund(room, actor, targetId) {
  if (stinktierSperre(room, targetId)) {
    return 'Das Riesenstinktier hält alle anderen auf 20 Meter Abstand - niemand hilft.';
  }
  // "Niemand kann dir helfen. Du musst dich dem Pavillon allein stellen."
  // Steht VOR der Stinktier-Strafe: was das Monster im Kampf verbietet, ist
  // der naeherliegende Grund - sonst bekaeme eine besprühte Person am
  // Pavillon die Meldung, sie solle ihre Kleidung ablegen.
  if (combatHasMonster(room, MONSTER_FORBIDS_HELP)) {
    return 'Gegen dieses Monster darf niemand helfen.';
  }
  if (stinktierStrafeAktiv(actor)) {
    return `${actor.name} stinkt noch aus dem Riesenstinktier-Kampf - niemand hilft, solange Kleidung und Rüstung anliegen.`;
  }
  if (hatHilfeSperre(actor)) {
    return `${actor.name} stinkt - in diesem Kampf hilft niemand.`;
  }
  if (hatUntotenAngst(actor) && combatHasUndead(room)) {
    return `${actor.name} kämpft gegen Untote - die Todesangst schreckt jede Hilfe ab.`;
  }
  return null;
}

function handleRequestHelp(room, playerId, targetId, reward) {
  if (!room.combat) return;
  const c = room.combat;
  // TROJANISCHER PFERD: siehe handlePlayCombatCard.
  if (c.trojanerOffer || c.trojanerDone) return;
  if (c.actorId !== playerId || c.helperId) return;
  const actor = findPlayer(room, playerId);
  const target = findPlayer(room, targetId);
  if (!target || targetId === c.actorId) return;
  const verbotenGrund = hilfeVerbotenGrund(room, actor, targetId);
  if (verbotenGrund) {
    log(room, verbotenGrund);
    touchRoom(room);
    return;
  }
  // KNIESCHÜTZER DER VERLOCKUNG: "Kein Spieler mit einer höheren Stufe als du
  // darf deine Bitte ablehnen ... beizustehen." Die Karte bleibt beim
  // Anfragen auf der Hand (treasure_other, nicht anlegbar) - "das Fragen nach
  // einer Belohnung" bildet der Server nirgends ab und bleibt daher aussen vor.
  const compelled = target.level > actor.level
    && actor.hand.some((id) => { const cc = card(id); return cc && cc.name === 'KNIESCHÜTZER DER VERLOCKUNG'; });
  // Zusage aus dem Client ist Fremdeingabe: ganze Zahl, nicht negativ, nicht
  // mehr als der Kampf ueberhaupt hergibt.
  const zusage = Math.max(0, Math.min(kampfSchatzZahl(room), Math.floor(Number(reward) || 0)));
  // noWinLevel ist die KNIESCHÜTZER-eigene Folge von "compelled" (Sperre der
  // Siegesstufe) - BARDE "Verzaubern" setzt spaeter ebenfalls compelled:true,
  // aber ohne noWinLevel: seine Sperre ist bardenZwang (Sieg zaehlt nicht),
  // nicht eine gekappte Stufe. Deshalb getrennte Felder statt "compelled"
  // wiederzuverwenden.
  c.helperPending = { targetId, compelled, noWinLevel: compelled, reward: zusage };
  log(room, `${actor.name} bittet ${target.name} um Hilfe${zusage ? ` (Zusage: ${zusage} Schatzkarte(n))` : ' (ohne Belohnung)'}${compelled ? ' - Knieschützer der Verlockung: kann nicht ablehnen' : ''}.`);
  touchRoom(room);
}

function handleRespondHelp(room, playerId, accept) {
  if (!room.combat || !room.combat.helperPending) return;
  const c = room.combat;
  if (c.helperPending.targetId !== playerId) return;
  const target = findPlayer(room, playerId);
  const compelled = !!c.helperPending.compelled;
  if (!accept && compelled) {
    log(room, `${target.name} darf nicht ablehnen (Knieschützer der Verlockung).`);
    accept = true;
  }
  if (accept) {
    const bittsteller = findPlayer(room, c.actorId);
    if (bittsteller && hatHilfeSperre(bittsteller)) {
      log(room, `${target.name} kann ${bittsteller.name} nicht helfen - der Stinker hält alle fern.`);
      c.helperPending = null;
      touchRoom(room);
      return;
    }
    if (hatUntotenAngst(target) && combatHasUndead(room)) {
      log(room, `${target.name} hat Todesangst vor Untoten und hilft hier nicht.`);
      c.helperPending = null;
      touchRoom(room);
      return;
    }
    // LUSTMONSTER: die Zusage kommt nicht zustande, wenn das Geschlecht nicht
    // passt. Bewusst hier und nicht in handleRequestHelp: das Fragen bleibt
    // erlaubt, nur das Zustandekommen nicht - so sieht der Tisch im Verlauf,
    // dass es versucht wurde.
    if (combatHasMonster(room, MONSTER_REQUIRES_OTHER_GENDER)
      && !istAnderesGeschlecht(findPlayer(room, c.actorId), target)) {
      log(room, `${target.name} kann hier nicht helfen - das Lustmonster verlangt einen Charakter des anderen Geschlechts.`);
      c.helperPending = null;
      touchRoom(room);
      return;
    }
    c.helperId = playerId;
    zaubercouchFragen(findPlayer(room, playerId));
    c.bardenZwang = false; // neue Zusage - handleBardeVerzaubern setzt es danach ggf. wieder
    // Die Zusage aus der Anfrage wird beim Sieg eingeloest (resolveCombatWin).
    c.helperReward = c.helperPending.reward || 0;
    dryadeWirkung(room, findPlayer(room, playerId));
    // "In einem Kampf, bei dem der Helfer ... genötigt wurde, kannst du
    // nicht die Siegesstufe erreichen." Greift in resolveCombatWin.
    if (c.helperPending.noWinLevel) c.noWinLevel = true;
    log(room, `${target.name} hilft im Kampf.`);
  } else {
    log(room, `${target.name} lehnt ab.`);
  }
  c.helperPending = null;
  touchRoom(room);
}

// "Du gewinnst bei einem Gleichstand im Kampf." ALUFOLIE ist eine
// treasure_other-Karte und damit nicht anlegbar - sie liegt auf der Hand.
// Ohne sie verliert ein Gleichstand immer, sie einzusetzen ist also nie
// schlechter als sie liegen zu lassen. Deshalb ohne Rückfrage automatisch,
// statt dafür eine eigene Kampf-Schaltfläche zu bauen.
// ponytail: als Einwegkarte behandelt (Text nennt keine Dauerwirkung).
// ALUFOLIE kam aus dem Pathfinder-Set und liegt derzeit in keinem Stapel -
// findTieBreaker findet also nie etwas. Wie bei POWER_GROUP_NAMES bleibt die
// Mechanik stehen, falls die Karte zurueckkommt.
const TIE_BREAKER_CARD = 'ALUFOLIE';

function findTieBreaker(room) {
  const c = room.combat;
  const sides = [findPlayer(room, c.actorId), c.helperId ? findPlayer(room, c.helperId) : null];
  for (const p of sides) {
    if (!p) continue;
    const cardId = p.hand.find((id) => { const cd = card(id); return cd && cd.name === TIE_BREAKER_CARD; });
    if (cardId) return { player: p, cardId };
  }
  return null;
}

// DER GANZ NORMALE HASE: "Nachdem du entschieden hast, ob und wer dir im
// Kampf hilft, wirf einen Wuerfel. Bei einer 6 ist es 'Der Hase Aus Dem Film'
// auf Stufe 15 und der Helfer kann nicht mehr entkommen."
// ponytail: der Wurf faellt beim ersten Auswertungsversuch - das ist der
// spaeteste Moment, zu dem die Helferfrage sicher geklaert ist. Der zweite
// Satz (die Helfer:in kann nicht mehr entkommen) bleibt offen: dieser Server
// wuerfelt die Flucht ohnehin nur fuer die kaempfende Person.
// Rueckgabe: true, wenn auf den Wurf noch reagiert werden darf - dann wartet
// die Kampfauswertung und wird ueber `nachWurf` erneut angestossen.
function hasenWurf(room, nachWurf) {
  const c = room.combat;
  if (!c || c.haseGewuerfelt) return false;
  const hase = c.monsterIds.find((id) => (card(id) || {}).name === 'DER GANZ NORMALE HASE');
  if (!hase) return false;
  c.haseGewuerfelt = true;
  let synchron = true;
  rollWithWindow(room, findPlayer(room, c.actorId) || room.players[0], 'hase', (wurf) => {
    haseAnwenden(room, c, hase, wurf);
    if (!synchron && nachWurf) nachWurf();
  });
  synchron = false;
  // Unterschied zum synchronen Weg: bei einer 6 setzt haseAnwenden ueber
  // refreshCombatReady die Bereitschaft zurueck (die Monsterstaerke hat sich
  // geaendert). Der erneute handleEvaluateCombat wartet dann, bis alle wieder
  // bereit sind - gewollt, denn auf Stufe 15 will man neu entscheiden.
  return !!room.pendingRoll;
}

function haseAnwenden(room, c, hase, wurf) {
  if (wurf !== 6) { log(room, `Der ganz normale Hase: Wuerfelwurf ${wurf} - er bleibt ganz normal.`); return; }
  c.levelOverrides = c.levelOverrides || {};
  c.levelOverrides[hase] = 15;
  // "... und der Helfer kann nicht mehr entkommen" - gilt fuer die helfende
  // Person dieses Kampfs, auch wenn sie erst nach dem Wurf dazukommt
  // (siehe handleAttemptFlee).
  c.helferGefangen = true;
  log(room, 'Der ganz normale Hase: Würfelwurf 6 - es ist "Der Hase Aus Dem Film" auf Stufe 15!', [hase]);
  refreshCombatReady(room);
}

function handleEvaluateCombat(room, playerId) {
  if (!room.combat) return;
  // TROJANISCHES PFERD: sobald das Reaktionsfenster gezeigt wurde (oder
  // schon aufgeloest ist), gilt dieser Kampf als abgeschlossen - ein
  // zweites "Kampf auswerten" wuerde den Sieg nochmal auswerten und die
  // Trojaner-Karte/das Monster der spielenden Person umsonst verbrauchen.
  if (room.combat.trojanerOffer || room.combat.trojanerDone) return;
  // Waehrend eines offenen Wurf-Fensters (Hase, Halbfinal-Schlag) nicht
  // auswerten: der Wurf gehoert noch zu diesem Kampf, sein Callback wuerde
  // sonst in einen bereits beendeten Kampf hineinschreiben.
  if (room.pendingRoll) return;
  const c = room.combat;
  if (c.actorId !== playerId) return;
  const couchOffen = zaubercouchOffen(room);
  if (couchOffen.length) {
    log(room, `Erst entscheiden, ob die Zaubercouch benutzt wird: ${couchOffen.map((p) => p.name).join(', ')}.`);
    touchRoom(room);
    return;
  }
  // Erst auswerten, wenn niemand mehr eingreifen will.
  if (!combatAllReady(room)) return;
  // DER GANZ NORMALE HASE wuerfelt "nachdem du entschieden hast, wer hilft" -
  // darf also selbst noch mit einem gezinkten Wuerfel geaendert werden. Dann
  // wartet die Auswertung auf das Fenster.
  if (hasenWurf(room, () => handleEvaluateCombat(room, playerId))) return;
  resolveCombat(room);
}

function resolveCombat(room) {
  const c = room.combat;
  const { playerStrength, monsterStrength } = combatTotals(room);
  // LUSTMONSTER: "sonst kannst du das Lustmonster nicht besiegen". Ohne
  // passende Hilfe ist der Kampf unabhaengig von der Kampfstaerke verloren -
  // deshalb ganz oben, vor Krieger-Gleichstand UND ALUFOLIE-Notloesung. Ein
  // Gleichstand ist auch ein Sieg, und die Notloesung waere sonst umsonst
  // verbraucht (Karte weg, "zaehlt als Sieg" geloggt, direkt danach doch
  // geflohen).
  const lustOhneHilfe = combatHasMonster(room, MONSTER_REQUIRES_OTHER_GENDER) && !passendeHilfe(room);
  // TODESANGST: "Du musst Weglaufen, selbst wenn du das Monster besiegen
  // koenntest." Gleiche Bauform wie lustOhneHilfe - die Kampfstaerke spielt
  // keine Rolle mehr, also vor Krieger-Gleichstand und ALUFOLIE.
  const angstVorUntoten = combatHasUndead(room) && hatUntotenAngst(findPlayer(room, c.actorId));
  // ALLES AUSSER KRAKZILLA ABSCHLACHTENDES SCHWERT: "Hast du dieses Schwert
  // ausgespielt und triffst auf Krakzilla, musst du versuchen, Wegzulaufen!"
  const krakzillaSchwertZwang = room.combat.monsterIds.some(
    (id) => (card(id) || {}).name === 'KRAKZILLA'
  ) && equippedItemIds(findPlayer(room, c.actorId)).some(
    (id) => (card(id) || {}).name === 'ALLES AUSSER KRAKZILLA ABSCHLACHTENDES SCHWERT'
  );
  const kampfVerloren = lustOhneHilfe || angstVorUntoten || krakzillaSchwertZwang;
  // KRIEGER: "Bei Gleichstand im Kampf gewinnst du." Greift vor der
  // ALUFOLIE-Notlösung, damit die Karte nicht unnötig verbraucht wird.
  const warrior = !kampfVerloren && playerStrength === monsterStrength
    ? combatParticipants(room).find((p) => hasClass(p, 'KRIEGER')) : null;
  if (warrior) {
    log(room, `Gleichstand (${playerStrength} vs. ${monsterStrength}) - ${warrior.name} ist Krieger und gewinnt ihn.`);
    resolveCombatWin(room);
    return;
  }
  const tie = !kampfVerloren && playerStrength === monsterStrength ? findTieBreaker(room) : null;
  if (tie) {
    removeFromHand(tie.player, tie.cardId);
    discardCard(room, tie.cardId);
    log(room, `${tie.player.name} setzt "${TIE_BREAKER_CARD}" ein: Gleichstand (${playerStrength} vs. ${monsterStrength}) zählt als Sieg.`, [tie.cardId]);
  }
  if (!kampfVerloren && (playerStrength > monsterStrength || tie)) {
    resolveCombatWin(room);
  } else {
    c.mustFlee = true;
    // Reihenfolge: erst die kaempfende Person, dann die Helfer:in.
    c.fleeQueue = combatParticipants(room).map((p) => p.id);
    c.fleeingId = c.fleeQueue[0];
    c.fleeFailed = [];
    const wer = combatParticipants(room).length > 1
      ? ` Jede:r läuft einzeln weg (${combatParticipants(room).map((p) => p.name).join(', ')}).` : '';
    log(room, angstVorUntoten
      ? `Die Todesangst vor den Untoten ist stärker als jede Waffe. Fliehen nötig!${wer}`
      : (lustOhneHilfe
        ? `Ohne Hilfe eines Charakters des anderen Geschlechts ist das Lustmonster nicht zu besiegen. Fliehen nötig!${wer}`
        : (krakzillaSchwertZwang
          ? `Das Schwert zwingt ${findPlayer(room, c.actorId).name} zur Flucht vor Krakzilla!${wer}`
          : `Kampfstärke reicht nicht (${playerStrength} vs. ${monsterStrength}). Fliehen nötig!${wer}`)));
    touchRoom(room);
  }
}

function resolveCombatWin(room) {
  const c = room.combat;
  // TROJANISCHER PFERD: "wenn jemand gerade nach dem Kampf einen Schatz
  // ziehen will." Das Fenster öffnet sich einmal; wurde es schon gezeigt
  // (trojanerDone), geht es direkt weiter.
  if (!c.trojanerDone) {
    const holders = reactionHolders(room, TREASURE_REACTION_CARDS);
    if (holders.length) {
      c.trojanerOffer = holders;
      log(room, `Kampf gewonnen - es darf noch ein TROJANISCHES PFERD gespielt werden.`);
      touchRoom(room);
      return;
    }
  }
  finishCombatWin(room);
}

function finishCombatWin(room) {
  const c = room.combat;
  // TOURISTENFALLE endet, sobald die verfluchte Person als HILFE einen Kampf
  // gewinnt - der eigene Sieg zaehlt laut Karte nicht. Hier, solange der
  // Kampf noch steht und die Hilfe bekannt ist.
  const helferBeiSieg = c.helperId ? findPlayer(room, c.helperId) : null;
  if (helferBeiSieg && clearActiveCurseByKind(helferBeiSieg, 'keinAergerSuchen')) {
    log(room, `${helferBeiSieg.name} hat jemandem zum Sieg verholfen - die Touristenfalle ist vorbei.`);
  }
  // TEMPORÄRE ANMNESIE endet mit einem gewonnenen Kampf - "wenn du ein Monster
  // getoetet hast oder dabei geholfen hast", also fuer alle Beteiligten.
  combatParticipants(room).forEach((p) => {
    if (clearActiveCurseByKind(p, 'traitsVergessen')) {
      log(room, `${p.name} erinnert sich wieder an Rasse und Klasse.`);
    }
  });
  const actor = findPlayer(room, c.actorId);
  const helper = c.helperId ? findPlayer(room, c.helperId) : null;
  // "... bis du ein Monster ohne Hilfe tötest." Die Loeschung steht VOR der
  // Schatzvergabe: wer die Strafe mit einem hilfsfreien Sieg abschuettelt,
  // bekommt den Schatz dieses Kampfes schon wieder. Das ist die
  // spielerfreundliche Lesart und erspart die Erklaerung, warum ausgerechnet
  // der befreiende Sieg leer ausgeht.
  if (!c.helperId && clearActiveCurseByKind(actor, 'noTreasure')) {
    log(room, `${actor.name} hat ein Monster ohne Hilfe getötet und ist von der Störerliste runter.`);
  }
  // NARRENGOLD ("kein Schatz im naechsten Kampf") traegt dauer:'naechsterKampf'
  // und faellt damit gleich unten bei clearNextCombatCurses weg - DIESER Kampf
  // ist ja "der naechste". Der Sperrstatus muss deshalb VOR der Loeschung
  // festgehalten werden, sonst zieht die Person trotz Fluch ihre Beute.
  // Dieselbe Vorwegnahme gilt fuer die Helfer:in - NARRENGOLDs Text ("Du
  // erhaeltst keinen Schatz im naechsten Kampf") ist rollenunabhaengig und
  // trifft auch eine selbst verfluchte Helfer:in, nicht nur die kaempfende
  // Person (hatSchatzSperre(null)/hatKampfschatzSperre(null) liefern false,
  // helperGesperrt ist also auch ohne Helfer:in sicher).
  const actorGesperrt = hatSchatzSperre(actor) || hatKampfschatzSperre(actor);
  const helperGesperrt = hatSchatzSperre(helper) || hatKampfschatzSperre(helper);
  // MIESER SPIEGEL/GESCHLECHTSUMWANDLUNG gelten nur "im nächsten Kampf" -
  // der ist hiermit vorbei (gewonnen).
  clearNextCombatCurses([actor, helper]);
  const monsters = c.monsterIds.map(card);
  // 1 Stufe pro besiegtem Monster, dazu die kartenspezifischen Bonusstufen
  // und -schätze (Bossmonster, PIKOTZU ohne Hilfe, Feuer gegen das Huhn,
  // Elfen gegen die Topfpflanze) - siehe monsterVictoryExtras.
  const extras = monsterVictoryExtras(room, actor, helper, monsters);
  const levelsGained = monsters.length + extras.levels;
  setLevel(actor, actor.level + levelsGained);
  const baseTreasures = monsters.reduce((sum, m) => {
    if (c.zeroTreasureMonsterIds && c.zeroTreasureMonsterIds.includes(m.id)) return sum;
    return sum + (m.treasureCount || 0);
  }, 0) + extras.treasures;
  // PIÑATA: "Wenn Pinata besiegt wird, zieht jedes Gruppenmitglied einen
  // Schatz aufgedeckt. Es spielt keine Rolle, wer am Kampf teilgenommen hat."
  // Additiv zur normalen Beute (die Piñata nennt selbst 0 Schaetze) - bei
  // einem zweiten Monster im selben Kampf bekommt die kaempfende Person also
  // beides, das ist regeltechnisch richtig.
  // Die Piñata-Karte von actor/helper wird HIER nur gezogen, aber erst unten
  // bei fuerActor/fuerHelfer eingereiht - sonst wuerde die dortige
  // lastReward-Zuweisung sie kommentarlos ueberschreiben (siehe Review I3).
  const pinata = monsters.some((m) => m && m.name === 'PIÑATA');
  let actorPinataCard = null;
  let helperPinataCard = null;
  if (pinata) {
    let gezogen = 0;
    room.players.forEach((p) => {
      const [t] = zieheSchaetzeFuer(room, p, 1);
      if (!t) return;
      gezogen += 1;
      if (p.id === actor.id) { actorPinataCard = t; return; }
      if (helper && p.id === helper.id) { helperPinataCard = t; return; }
      p.hand.push(t);
      p.lastReward = {
        seq: (p.lastReward ? p.lastReward.seq : 0) + 1,
        cardIds: [t], levelsGained: 0,
        monsterNames: monsters.map((m) => m.name),
      };
    });
    // Wer nichts bekommt, bekommt aus einem von zwei Gruenden nichts:
    // Stoererliste (zieheSchaetzeFuer zieht gar nicht) oder leerer
    // Schatzstapel. Die Zeile nennt den Grund, der wirklich zutrifft.
    const gesperrt = room.players.filter(hatSchatzSperre).length;
    const grund = !gesperrt ? 'der Schatzstapel reicht nicht für alle'
      : (gezogen + gesperrt === room.players.length ? 'die Störerliste lässt nicht alle mitziehen'
        : 'Störerliste und Schatzstapel lassen nicht alle mitziehen');
    log(room, gezogen === room.players.length
      ? `Die Piñata platzt - jede:r am Tisch zieht 1 Schatzkarte.`
      : `Die Piñata platzt - ${grund}: nur ${gezogen} von ${room.players.length} Personen ziehen je 1 Schatzkarte.`);
  }
  // Monster-Verstärker aus dem Kampf zählen mit (enhancerTreasureSumme, je
  // Verstärker nur, solange sein Monster noch steht); BABY sagt ausdrücklich
  // "mindestens 1", deshalb die Untergrenze - aber nur, wenn überhaupt ein
  // Zuschlag im Spiel war (ohne ihn bleibt es bei der Kartenangabe).
  const treasureDelta = (c.treasureDelta || 0) + enhancerTreasureSumme(room);
  const treasureCount = treasureDelta ? Math.max(1, baseTreasures + treasureDelta) : baseTreasures;
  // Gezogen wird nur, was auch ankommt, und nur fuer die Person, die es
  // ueberhaupt bekommen kann. Steht die kaempfende Person auf der
  // Stoererliste (oder unter NARRENGOLD), zieht stattdessen die Helfer:in
  // ihren zugesagten Anteil direkt - aber nur, wenn NICHT auch sie selbst
  // gesperrt ist (helferKannZiehen). zieheSchaetzeFuer kennt nur die
  // Stoererliste, nicht NARRENGOLD - die Pruefung gehoert deshalb hierher,
  // an die Aufrufstelle, statt in den Choke-Point (der auch Geschenke und
  // Bonuszuege abdeckt, die NARRENGOLD nicht sperrt). Sind beide gesperrt,
  // wird gar nicht erst gezogen - der Stapel bleibt unberuehrt, wenn
  // niemand etwas bekommen kann.
  const helferKannZiehen = helper && !helperGesperrt;
  const ziehendFuer = actorGesperrt ? (helferKannZiehen ? helper : null) : actor;
  const sollZiehen = actorGesperrt
    ? (helferKannZiehen ? Math.min(treasureCount, c.helperReward || 0) : 0)
    : treasureCount;
  // TROJANISCHER PFERD: "Die Person erhaelt keinen Schatz." Betrifft die
  // GESAMTE Kampfbeute (auch eine zugesagte Helfer:in-Quote, da fuerHelfer
  // ein Ausschnitt von drawn ist) - nicht nur den Anteil der kaempfenden
  // Person. PINATA (eigener, additiver Ziehweg oben in dieser Funktion)
  // bleibt unberuehrt, ponytail: seltener Kombinationsfall.
  const drawn = (ziehendFuer && !c.trojanerNoTreasure) ? zieheSchaetzeFuer(room, ziehendFuer, sollZiehen) : [];
  // einfache Aufteilung: alles an actor, außer helper wurde per Vorabsprache
  // (README) etwas zugesagt - hier immer erst alles an die/den Angreifer:in,
  // Weitergabe von Schätzen kann jederzeit frei "gehandelt" werden.
  // Zusage aus der Hilfe-Anfrage: die ersten N gezogenen Karten gehoeren der
  // Helfer:in (weniger, wenn weniger Schaetze kommen als versprochen). Der
  // Rest geht wie bisher an die kaempfende Person; darueber hinaus bleibt
  // jede Weitergabe freier Handel.
  // Eine gesperrte Helfer:in bekommt kein Versprechen eingeloest - die
  // Zusage wird schlicht auf 0 gesetzt, statt schon gezogene Karten zu
  // vernichten (das waeren Karten, die dann in keinem Stapel und keiner
  // Hand mehr existieren). Die Karten bleiben bei der kaempfenden Person,
  // die sie ohnehin schon gezogen hat.
  const zusage = helferKannZiehen
    ? Math.max(0, Math.min(c.helperReward || 0, drawn.length)) : 0;
  const fuerHelfer = drawn.slice(0, zusage).concat(helperPinataCard ? [helperPinataCard] : []);
  const fuerActor = drawn.slice(zusage).concat(actorPinataCard ? [actorPinataCard] : []);
  fuerActor.forEach((id) => actor.hand.push(id));
  actor.lastReward = {
    seq: (actor.lastReward ? actor.lastReward.seq : 0) + 1,
    cardIds: fuerActor,
    levelsGained,
    monsterNames: monsters.map((m) => m.name),
  };
  if (fuerHelfer.length) {
    fuerHelfer.forEach((id) => helper.hand.push(id));
    helper.lastReward = {
      seq: (helper.lastReward ? helper.lastReward.seq : 0) + 1,
      cardIds: fuerHelfer,
      levelsGained: 0,
      monsterNames: monsters.map((m) => m.name),
    };
    // Ohne Kartenanhang: welche Schaetze die Helfer:in bekommt, ist ihre
    // Hand und damit geheim - oeffentlich ist nur die Anzahl.
    log(room, `${helper.name} bekommt die zugesagten ${fuerHelfer.length} Schatzkarte(n) fuer die Hilfe.`);
  }
  // HEIMSE DIE LORBEEREN EIN: "Spielen, wenn ein RIVALE einen Kampf gewinnt
  // und eine Stufe aufsteigt." - deshalb muss der Server wissen, wer zuletzt
  // gewonnen hat. Das Fenster bleibt eine Runde offen (siehe endTurn) oder
  // bis zum naechsten Sieg, je nachdem was zuerst eintritt.
  room.lastCombatWinnerId = actor.id;
  room.lastCombatWinnerTurnIndex = room.turnIndex;
  // UNFASSBAR REICH: je erbeuteter Schatzkarte einmal "behalten oder tauschen".
  // Nur ueber die Karten, die die kaempfende Person auch behaelt - die
  // zugesagten liegen schon bei der Helfer:in.
  if (c.schatzUmtausch && fuerActor.length) {
    const offen = fuerActor.slice();
    openQueuedCardAction(room, 'UNFASSBAR REICH', fuerActor.map(() => actor.id), () => {
      const id = offen.shift();
      if (!id || !actor.hand.includes(id)) return null;
      return {
        kind: 'choice',
        prompt: `"${card(id).name}" behalten oder gegen eine neue Karte tauschen?`,
        options: [
          { id: `behalten-${id}`, label: 'Behalten', action: { type: 'noEffect' } },
          { id: `tauschen-${id}`, label: 'Ablegen und eine neue Schatzkarte ziehen', action: { type: 'schatzTauschen', cardId: id } },
        ],
      };
    });
  }
  discardMonsterIds(room.doorDiscard, c.monsterIds);
  // Gemeldet wird, was tatsaechlich in einer Hand gelandet ist (inkl.
  // Piñata-Zuschlag) - nicht treasureCount. Unter NARRENGOLD (oder der
  // Stoererliste kombiniert mit Helfer:in) zieht die kaempfende Person
  // real weniger oder nichts; treasureCount waere dann eine falsche Zahl
  // ohne genannten Grund. fuerActor/fuerHelfer bilden immer die Summe der
  // tatsaechlich verteilten Kampfbeute (drawn, aufgeteilt per Zusage, plus
  // je eigener Piñata-Karte).
  const gemeldeteSchaetze = fuerActor.length + fuerHelfer.length;
  log(room, `${actor.name} besiegt ${monsters.map((m) => m.name).join(' + ')}! +${levelsGained} Stufe(n), ${gemeldeteSchaetze} Schatzkarte(n) gezogen.`, c.monsterIds);
  if (extras.levels) log(room, `Kartenbonus: +${extras.levels} zusätzliche Stufe(n).`);
  if (extras.treasures) log(room, `Kartenbonus: +${extras.treasures} zusätzliche(r) Schatz.`);
  if (hasClass(actor, 'BARDE')) log(room, `Bardenglück: ${actor.name} zieht 1 Extraschatz.`);
  // BARDE "Bardenglueck": "Sieh sie dir alle an und wirf sofort einen ab
  // (beliebig)." Die Wahl geht ueber die GANZE Hand (Beute ist schon drin),
  // nicht nur ueber den Extraschatz. Reiht sich hinter eine schon offene
  // Kartenwahl ein (z.B. UNFASSBAR REICH oben) statt sie zu verdraengen -
  // openQueuedCardAction uebernimmt das. Ohne Handkarten (Schatzstapel leer
  // o.ae., theoretisch moeglich) entfaellt die Wahl.
  if (hasClass(actor, 'BARDE') && actor.hand.length) {
    openQueuedCardAction(room, 'BARDENGLÜCK', [actor.id], () => ({
      kind: 'chooseCard', prompt: 'Bardenglück: eine Karte abwerfen',
      candidateIds: actor.hand.slice(), discardOwn: true,
    }));
  }
  if (helper) log(room, `(${helper.name} hat geholfen.)`);
  // ELF: "Für jedes Monster, das du jemandem anderen hilfst zu töten,
  // steigst du 1 Stufe auf."
  if (helper && hasRace(helper, 'ELF')) {
    setLevel(helper, helper.level + monsters.length);
    log(room, `${helper.name} ist Elf und steigt fürs Helfen ${monsters.length} Stufe(n) auf -> jetzt Stufe ${helper.level}.`);
  }
  // KNIESCHÜTZER DER VERLOCKUNG: "In einem Kampf, bei dem der Helfer ...
  // genötigt wurde, kannst du nicht die Siegesstufe erreichen." Nur die
  // Siegesstufe in DIESEM Kampf ist gesperrt, nicht der Kampf selbst und
  // nicht künftige Kämpfe (noWinLevel haengt am Kampf, nicht am Spieler).
  if (c.noWinLevel && actor.level >= MAX_LEVEL) {
    setLevel(actor, MAX_LEVEL - 1);
    log(room, `${actor.name} hat die Hilfe mit den Knieschützern erzwungen und kann in diesem Kampf nicht gewinnen.`);
  }
  room.combat = null;
  zaubercouchZuruecksetzen(room);
  // BARDE "Verzaubern": "Du kannst das Spiel mit dieser Faehigkeit nicht
  // gewinnen." Die Stufe steigt (oben schon geschehen), der Spielsieg faellt
  // aus - checkWin wird fuer diesen Sieg gar nicht erst aufgerufen.
  let won = c.bardenZwang ? false : checkWin(room, actor);
  if (c.bardenZwang && actor.level >= MAX_LEVEL) {
    log(room, `${actor.name} erreicht Stufe 10 - aber mit erzwungener Hilfe des Barden zählt das nicht als Sieg.`);
  }
  // Auch die Helfer:in kann so Stufe 10 erreichen - die Stufe kommt aus einem
  // besiegten Monster, damit zählt sie als Sieg.
  if (!won && helper) won = checkWin(room, helper);
  // ÜBERFALLTRANK: siehe combatEndPhase - der urspruengliche Spieler (nicht
  // die/der Kaempfende) darf danach den Raum pluendern, room.turnIndex zeigt
  // ohnehin noch auf sie/ihn, der Zug ist nie gewechselt.
  if (!won) setzeZugphase(room, combatEndPhase(c, false));
  touchRoom(room);
}

function handleAttemptFlee(room, playerId, modifier) {
  if (!room.combat || !room.combat.mustFlee) return;
  if (room.combat.fleeRerollOffer) return; // erst das Halbling-Angebot beantworten
  if (room.combat.escapeReactionOffer) return; // erst das Kleberflaeschchen-Fenster beantworten
  const c = room.combat;
  // Nicht mehr "nur die kaempfende Person": jede beteiligte Person laeuft
  // einzeln weg, fluechtenderId sagt, wer gerade dran ist.
  if (fluechtenderId(room) !== playerId) return;
  const actor = findPlayer(room, playerId);
  if (!actor) return;
  // `modifier` kommt aus dem Client und ist damit ungeprüfte Fremdeingabe
  // (manuell eingetragene Karteneffekte). Alles, was fest auf Karten steht -
  // Elfenbonus, Weglaufstiefel, Tuba, Monster wie die Schnecken auf Speed -
  // rechnet der Server selbst dazu, statt sich darauf zu verlassen, dass es
  // jemand von Hand einträgt.
  const manual = Math.max(-9, Math.min(9, Math.round(Number(modifier) || 0)));
  const parts = fleeModifierParts(room, actor);
  const mod = manual + parts.reduce((sum, x) => sum + x.amount, 0);
  // GEZINKTER WÜRFEL darf den Weglaufwurf noch aendern, bevor er ausgewertet
  // wird - deshalb ab hier ueber das Reaktionsfenster statt mit einem
  // direkten rollDie(). Haelt niemand die Karte, laeuft der Rest synchron
  // weiter wie zuvor (siehe rollWithWindow).
  rollWithWindow(room, actor, 'flee', function mitWurf(roll) {
    const total = roll + mod;
    const helferGefangen = !!c.helferGefangen && actor.id === c.helperId;
    const impossible = helferGefangen || combatHasMonster(room, FLEE_IMPOSSIBLE);
    const automatic = fleeIsAutomatic(room, actor);
    const success = impossible ? false : (automatic ? true : total >= 5);
    let note = parts.length ? parts.map((x) => `${x.label} ${x.amount >= 0 ? '+' : ''}${x.amount}`).join(', ') : '';
    if (helferGefangen) note = 'Der Hase aus dem Film: der Helfer kann nicht mehr entkommen.';
    else if (impossible) note = 'Vor diesem Monster gibt es kein Entkommen.';
    else if (automatic) note = 'Automatische Flucht.';
    log(room, `${actor.name} würfelt ${roll} (${mod >= 0 ? '+' : ''}${mod} = ${total}) zum Weglaufen: ${success ? 'geschafft!' : 'gescheitert!'}${note ? ` [${note}]` : ''}`);
    // Eigenes seq-Feld fuer die Wuerfel-Animation: room.combat wird gleich auf
    // null gesetzt, die Animation darf davon nicht abhaengen.
    room.dieRoll = {
      seq: (room.dieRoll ? room.dieRoll.seq : 0) + 1,
      roll, mod, total, success, note, playerId: actor.id, playerName: actor.name,
    };
    if (success) {
      applyFleeSuccess(room, actor, c);
    } else if (halblingRerollPossible(room, actor) || postFleeEscapeCardIds(actor).length || lampCardIds(actor).length) {
      // Entscheidung nach dem verpatzten Wurf - der Kampf bleibt stehen, bis
      // sie da ist (handleFleeReroll / handleFleeEscape / handleUseLamp):
      //  * HALBLING: "1 Karte ablegen und es noch mal probieren"
      //  * UNSICHTBARKEITSTRANK: "Ablegen, wenn der Weglaufen-Wurf misslingt.
      //    Du entkommst automatisch."
      //  * MAGISCHE LAMPE: "... selbst wenn dein Weglaufenwurf verpatzt
      //    wurde und es dich fangen wuerde." Kein eigenes Fenster noetig -
      //    genau dieser Moment ist es schon.
      const optionen = [];
      if (halblingRerollPossible(room, actor)) {
        c.halblingRerollUsed = true;
        c.canReroll = true;
        optionen.push('als Halbling 1 Karte ablegen und noch einmal weglaufen');
      }
      if (postFleeEscapeCardIds(actor).length) optionen.push('eine Rettungskarte ablegen und automatisch entkommen');
      if (lampCardIds(actor).length) optionen.push('die Magische Lampe nutzen und ein Monster verschwinden lassen');
      c.fleeRerollOffer = true;
      c.fleeManualModifier = manual;
      log(room, `${actor.name} kann noch reagieren: ${optionen.join(' oder ')} - oder das Miese Zeug hinnehmen.`);
    } else {
      applyFleeFailure(room, actor, c);
    }
    touchRoom(room);
  });
}

// Gelungene Flucht: erst das Reaktionsfenster fuer KLEBERFLÄSCHCHEN, dann
// (finishFleeSuccess) Stufenverlust trotz Flucht (MR. BONES, KOENIG TUT,
// GRUFTIGE GEBRUEDER), Tuba-Schatz auf dem Weg nach draussen, Monster weg.
// Steht separat, weil eine Rettungskarte nach verpatztem Wurf hier
// hereinspringt (handleFleeEscape).
function applyFleeSuccess(room, actor, c) {
  // "Einsetzbar, wenn jemand erfolgreich (egal warum) einem Kampf entkommt.
  // Er muss seine Flucht noch einmal wuerfeln." escapeReactionDone
  // verhindert eine Endlosschleife, wenn der erzwungene Neuwurf wieder
  // gelingt.
  if (!c.escapeReactionDone) {
    const holders = reactionHolders(room, ESCAPE_REACTION_CARDS);
    if (holders.length) {
      c.escapeReactionOffer = holders;
      log(room, `${actor.name} entkommt - es darf noch ein Kleberfläschchen gespielt werden.`);
      return;
    }
  }
  finishFleeSuccess(room, actor, c);
}

function finishFleeSuccess(room, actor, c) {
  // MIESER SPIEGEL/GESCHLECHTSUMWANDLUNG gelten nur "im nächsten Kampf" -
  // der ist hiermit vorbei (geflohen). Gilt je Person, denn jede läuft
  // einzeln weg (siehe fleeQueue).
  clearNextCombatCurses([actor]);
  let penalty = 0;
  c.monsterIds.forEach((id) => {
    const m = card(id);
    const fn = m && FLEE_PENALTY[m.name];
    if (fn) penalty += fn(actor);
  });
  if (penalty) {
    setLevel(actor, actor.level - penalty);
    log(room, `Trotz Flucht: ${actor.name} verliert ${penalty} Stufe(n) -> jetzt Stufe ${actor.level}.`);
  }
  const tuba = equippedItemIds(actor).find((id) => FLEE_TREASURE_ITEMS.has((card(id) || {}).name));
  if (tuba) {
    if (hatSchatzSperre(actor)) {
      log(room, `${actor.name} könnte wegen "${card(tuba).name}" noch eine Schatzkarte mitnehmen, steht aber auf der Störerliste und bekommt keine.`);
    } else {
      const [t] = zieheSchaetzeFuer(room, actor, 1);
      if (t) {
        actor.hand.push(t);
        // Gleiche Beute-Animation wie nach einem Kampfsieg - privat im yourInfo,
        // denn die gezogene Karte ist eine Handkarte (kind/quelle steuern nur
        // die Ueberschrift im Client).
        actor.lastReward = {
          seq: (actor.lastReward ? actor.lastReward.seq : 0) + 1,
          cardIds: [t], levelsGained: 0, monsterNames: [], kind: 'flucht', quelle: card(tuba).name,
        };
        log(room, `${actor.name} nimmt auf dem Weg nach draussen noch 1 verdeckte Schatzkarte mit.`);
      }
    }
  }
  naechsterFluechtling(room, c);
}

// Die naechste Person, die noch weglaufen muss - oder, wenn alle durch sind,
// das Ende der Fluchtphase. Die personenbezogenen Zwischenstaende
// (Halbling-Wiederholung, Kleberflaeschchen-Fenster) werden dabei
// zurueckgesetzt, sonst erbt die naechste Person sie.
// Wer ist gerade mit Weglaufen dran? Legt die Reihe an, falls sie fehlt -
// so gilt die Regel "mustFlee heisst: alle Beteiligten laufen einzeln weg"
// auch dann, wenn mustFlee irgendwo anders gesetzt wurde als in
// handleEvaluateCombat (Testaufbauten, kuenftige Kartenwege).
function fluechtenderId(room) {
  const c = room.combat;
  if (!c || !c.mustFlee) return null;
  if (!c.fleeQueue) {
    c.fleeQueue = combatParticipants(room).map((p) => p.id);
    c.fleeingId = c.fleeQueue[0] || null;
    c.fleeFailed = c.fleeFailed || [];
  }
  return c.fleeingId;
}

function naechsterFluechtling(room, c) {
  c.fleeQueue = (c.fleeQueue || []).filter((id) => id !== c.fleeingId);
  const naechsterId = c.fleeQueue.find((id) => {
    const p = findPlayer(room, id);
    return p && p.connected; // Getrennte werden uebersprungen, wie ueberall sonst
  });
  if (!naechsterId) { beendeFluchtphase(room, c); return; }
  c.fleeingId = naechsterId;
  c.fleeRerollOffer = false;
  c.canReroll = false;
  c.halblingRerollUsed = false;
  c.escapeReactionDone = false;
  c.fleeManualModifier = 0;
  log(room, `${findPlayer(room, naechsterId).name} muss jetzt selbst weglaufen.`);
  touchRoom(room);
}

// Alle haben gewuerfelt: Monster ablegen, Kampf beenden und das Miese Zeug
// verteilen. Erst jetzt - haetten wir es je Person sofort aufgeloest, waere
// der Kampf schon weg, bevor die zweite Person ueberhaupt gewuerfelt hat.
function beendeFluchtphase(room, c) {
  const monsters = c.monsterIds.map(card);
  const gescheitert = (c.fleeFailed || []).map((id) => findPlayer(room, id)).filter(Boolean);
  // GUMMI-GOLEM ("Zuckerschock"): der Fluch endet, sobald die betroffene
  // Person einen Kampf verliert - unabhaengig davon, gegen welches Monster.
  // Muss VOR oeffneVerlustKonsequenz() laufen (weiter unten): sonst wuerde
  // ein frischer Zuckerschock aus GENAU DIESEM verlorenen Kampf (z.B. gegen
  // einen zweiten Gummi-Golem) sich selbst sofort wieder loeschen, statt bis
  // zum NAECHSTEN verlorenen Kampf zu bestehen.
  gescheitert.forEach((p) => {
    if (clearActiveCurseByKind(p, 'zuckerschock')) {
      log(room, `${p.name} verliert den Kampf - der Zuckerschock ist vorbei, Schätze sind wieder erlaubt.`);
    }
  });
  discardMonsterIds(room.doorDiscard, c.monsterIds);
  room.combat = null;
  zaubercouchZuruecksetzen(room);
  // Die Zugphase haengt an der kaempfenden Person: hat SIE das Miese Zeug
  // kassiert, wechselt die Phase erst mit ihrer Bestaetigung (wie bisher,
  // siehe handleAckConsequence). Sonst jetzt.
  const actorGescheitert = gescheitert.some((p) => p.id === c.actorId);
  if (!actorGescheitert) setzeZugphase(room, combatEndPhase(c, false));
  if (!gescheitert.length) return;
  // Helfer:innen zuerst, die kaempfende Person zuletzt - deren Bestaetigung
  // gibt den Zug wieder frei, also soll sie am Ende stehen.
  const reihenfolge = gescheitert.filter((p) => p.id !== c.actorId)
    .concat(gescheitert.filter((p) => p.id === c.actorId));
  reihenfolge.forEach((p) => oeffneVerlustKonsequenz(room, p, monsters, c, p.id !== c.actorId));
}

// Das Miese Zeug fuer EINE Person. Ist schon eine Konsequenz offen (die
// zweite Person eines verlorenen Kampfes), wandert sie in den Nachlauf und
// wird erst geoeffnet, wenn die erste bestaetigt ist - room.pendingConsequence
// ist ein einzelner Platz.
function oeffneVerlustKonsequenz(room, player, monsters, c, keepPhase) {
  const eintrag = {
    playerId: player.id, kind: 'loss', cardId: null,
    text: monsters.map((m) => `${m.name}: ${m.badstuff || '(kein Text hinterlegt)'}`).join(' | '),
    autoApplied: null, choice: null,
    // ÜBERFALLTRANK: originalActorId muss den Kampf ueberleben (room.combat
    // ist gerade geleert) - handleAckConsequence liest ihn von hier.
    originalActorId: c.originalActorId || null,
    keepPhase: !!keepPhase,
  };
  // Die Verstaerker reisen mit (FUNGUS: "Verdoppelt die Strafe, wenn der
  // Fungus Gigantisch ist") - aber nur die des jeweiligen Monsters, GIGANTISCH
  // auf einem anderen Monster verdoppelt den Fungus nicht. room.combat ist
  // hier schon weg, also direkt auf dem mitgegebenen c (nicht
  // aktiveEnhancers/enhancerKartenIds, die room.combat lesen wuerden).
  const sources = monsters.map((m) => ({
    name: m.name, text: m.badstuff,
    verstaerker: (c.enhancers || []).filter((e) => e.monsterId === m.id)
      .map((e) => (card(e.cardId) || {}).name).filter(Boolean),
  }));
  if (room.pendingConsequence) {
    room._pendingConsequenceBacklog = (room._pendingConsequenceBacklog || [])
      .concat({ eintrag, playerId: player.id, sources });
    return;
  }
  room.pendingConsequence = eintrag;
  autoApplyLossConsequence(room, player, sources);
}

// POST_FLEE_ESCAPE_CARDS: siehe src/cards/treasures.js. "Ablegen, wenn der
// Weglaufen-Wurf misslingt. Du entkommst automatisch." (Die
// GUARANTEED_FLEE_CARDS wirken dagegen VOR dem Wurf.)
function postFleeEscapeCardIds(actor) {
  return actor.hand.filter((id) => POST_FLEE_ESCAPE_CARDS.has((card(id) || {}).name));
}

// Rettungskarte nach dem verpatzten Wurf einsetzen.
function handleFleeEscape(room, playerId, cardId) {
  const c = room.combat;
  if (!c || !c.fleeRerollOffer || fluechtenderId(room) !== playerId) return;
  const actor = findPlayer(room, playerId);
  if (!actor || !postFleeEscapeCardIds(actor).includes(cardId)) return;
  c.fleeRerollOffer = false;
  removeFromHand(actor, cardId);
  discardCard(room, cardId);
  log(room, `${actor.name} legt "${card(cardId).name}" ab und entkommt trotz des verpatzten Wurfs.`, [cardId]);
  applyFleeSuccess(room, actor, c);
  touchRoom(room);
}

// "Nur in deiner Runde spielbar. Sie beschwoert einen Geist, der ein Monster
// verschwinden laesst, selbst wenn dein Weglaufenwurf verpatzt wurde und es
// dich fangen wuerde. War es das einzige Monster, erhaeltst du seinen Schatz,
// aber keine Stufe." - Spielbar im eigenen Kampf ueber handlePlayCombatCard und zusaetzlich im Fluchtentscheidungsfenster (c.fleeRerollOffer) nach einem verpatzten Wurf.
const LAMP_CARDS = new Set(['MAGISCHE LAMPE']);

function lampCardIds(actor) {
  return actor.hand.filter((id) => LAMP_CARDS.has((card(id) || {}).name));
}

function handleUseLamp(room, playerId, cardId, monsterId) {
  const c = room.combat;
  if (!c) return;
  const actor = currentPlayer(room);
  if (!actor || actor.id !== playerId) return;
  if (c.actorId !== playerId) return;
  if (c.mustFlee && fluechtenderId(room) !== playerId) return;
  if (!actor.hand.includes(cardId)) return;
  const lampe = card(cardId);
  if (!lampe || !LAMP_CARDS.has(lampe.name)) return;
  const targetMonsterId = monsterId || (c.monsterIds.length === 1 ? c.monsterIds[0] : null);
  const idx = c.monsterIds.indexOf(targetMonsterId);
  if (idx < 0) return;
  announceCardPlay(room, actor, cardId, `"${card(targetMonsterId).name}" verschwindet`);
  removeFromHand(actor, cardId);
  discardCard(room, cardId);
  if (c.monsterIds.length === 1) {
    // War es das einzige Monster, erhaeltst du seinen Schatz, aber keine
    // Stufe - endCombatNoLevel liest den Schatz aus den noch im Kampf
    // stehenden Monstern, das Monster darf also NICHT vorher aus
    // c.monsterIds gesplict werden (siehe VERZAUBERARMBAND-Kommentar in
    // src/cards/treasures.js, derselbe Grund).
    log(room, `${actor.name} spielt "${lampe.name}": "${card(targetMonsterId).name}" verschwindet - es war das einzige Monster.`, [cardId, targetMonsterId]);
    clearNextCombatCurses([actor]);
    applyCombatPotionAction(room, actor, { type: 'endCombatNoLevel', leavesTreasure: true }, lampe);
  } else {
    const weg = c.monsterIds.splice(idx, 1)[0];
    room.doorDiscard.push(weg);
    log(room, `${actor.name} spielt "${lampe.name}": "${card(weg).name}" verschwindet.`, [cardId, weg]);
    c.fleeRerollOffer = false;
    refreshCombatReady(room);
  }
  touchRoom(room);
}

// Das Miese Zeug nach einem endgueltig gescheiterten Weglaufwurf. Steht
// separat, weil beim HALBLING noch eine Entscheidung dazwischen liegt.
function applyFleeFailure(room, actor, c) {
  // Auch eine misslungene Flucht beendet "den nächsten Kampf" - sonst würde
  // der Fluch fälschlich in einen weiteren, künftigen Kampf hineinwirken.
  clearNextCombatCurses([actor]);
  c.fleeFailed = (c.fleeFailed || []).concat(actor.id);
  log(room, `${actor.name} entkommt nicht und wird das Miese Zeug abbekommen.`);
  naechsterFluechtling(room, c);
}

// Nur beim ersten verpatzten Wurf, nur mit Karte auf der Hand - und nicht
// gegen Monster, vor denen es ohnehin kein Entkommen gibt (der zweite Wurf
// wuerde genauso scheitern und die Karte waere umsonst weg). Derselbe Weg
// gilt fuer den vom GANZ NORMALEN HASEN gefangenen Helfer.
function halblingRerollPossible(room, actor) {
  const c = room.combat;
  if (!c || c.halblingRerollUsed) return false;
  if (combatHasMonster(room, FLEE_IMPOSSIBLE)) return false;
  if (c.helferGefangen && actor.id === c.helperId) return false;
  return hasRace(actor, 'HALBLING') && actor.hand.length > 0;
}

// Was ein Bot im Fluchtentscheidungsfenster mitgibt. Das Fenster geht auch
// ohne Halbling auf, sobald jemand eine Rettungskarte oder die Magische Lampe
// haelt - wer dann trotzdem eine Karte mitgibt, wird von handleFleeReroll
// abgelehnt, OHNE dass das Fenster zugeht. Der Bot lief danach im Sekundentakt
// gegen dieselbe Wand und die Partie stand (Abnahme-Durchlauf, Task 13).
function botFleeRerollCard(room, actor) {
  return room.combat && room.combat.canReroll ? (actor.hand[0] || null) : null;
}

// Antwort auf das Halbling-Angebot: mit Karte nochmal wuerfeln, ohne Karte
// (cardId null) das Miese Zeug hinnehmen.
function handleFleeReroll(room, playerId, cardId) {
  const c = room.combat;
  if (!c || !c.fleeRerollOffer || fluechtenderId(room) !== playerId) return;
  const actor = findPlayer(room, playerId);
  if (!actor) return;
  if (cardId !== null && cardId !== undefined) {
    if (!c.canReroll) return; // der Wiederholungswurf steht nur Halblingen zu
    if (!actor.hand.includes(cardId)) return; // Fremdeingabe: Angebot bleibt stehen
    c.fleeRerollOffer = false;
    removeFromHand(actor, cardId);
    discardCard(room, cardId);
    log(room, `${actor.name} (Halbling) legt "${card(cardId).name}" ab und laeuft noch einmal weg.`, [cardId]);
    handleAttemptFlee(room, playerId, c.fleeManualModifier || 0);
    return;
  }
  c.fleeRerollOffer = false;
  log(room, `${actor.name} verzichtet auf den zweiten Weglaufversuch.`);
  applyFleeFailure(room, actor, c);
  touchRoom(room);
}

// GUARANTEED_FLEE_CARDS, GUARANTEED_FLEE_MAX_MONSTER_LEVEL: siehe
// src/cards/treasures.js. Statt eines Weglaufen-Würfelwurfs sofort und
// sicher aus dem Kampf entkommen. Nur nutzbar, während tatsächlich geflohen
// werden muss (mustFlee) und nur für die kämpfende Person selbst (Hilfe für
// eine zweite Person ist in diesem Server ohnehin nicht separat vom
// Kampf-Ausgang der Hauptperson abhängig, siehe handleAttemptFlee).

function handleUseGuaranteedFlee(room, playerId, cardId) {
  if (!room.combat || !room.combat.mustFlee) return;
  const c = room.combat;
  if (fluechtenderId(room) !== playerId) return;
  const player = findPlayer(room, playerId);
  if (!player) return;
  const inHand = player.hand.includes(cardId);
  const equipped = equippedItemIds(player).includes(cardId);
  if (!inHand && !equipped) return;
  const cardData = card(cardId);
  if (!cardData || !GUARANTEED_FLEE_CARDS.has(cardData.name)) return;
  // Karten mit Stufengrenze (RATTE AM SPIESS: "Stufe 8 oder niedriger")
  // wirken nur gegen entsprechend schwache Monster.
  const maxLevel = GUARANTEED_FLEE_MAX_MONSTER_LEVEL[cardData.name];
  if (typeof maxLevel === 'number' && c.monsterIds.some((id) => ((card(id) || {}).level || 0) > maxLevel)) {
    log(room, `"${cardData.name}" wirkt nur gegen Monster bis Stufe ${maxLevel}.`);
    touchRoom(room);
    return;
  }
  if (inHand) removeFromHand(player, cardId); else unequipSlotCard(player, cardId);
  discardCard(room, cardId);
  let extra = '';
  // "Du kannst automatisch aus einem beliebigen Kampf weglaufen ... aber du
  // verlierst eine Stufe."
  if (cardData.name === 'DER ANDERE RING') { setLevel(player, player.level - 1); extra = ', verliert dafür 1 Stufe'; }
  log(room, `${player.name} entkommt garantiert mit "${cardData.name}"${extra}.`, [cardId]);
  // ponytail: bewusst NICHT ueber applyFleeSuccess - die Karte sagt
  // "automatisch weglaufen", ohne Stufenstrafe (MR. BONES) und ohne
  // Kleberflaeschchen-Fenster. Nur diese Person ist raus, eine wartende
  // Helfer:in laeuft danach selbst.
  clearNextCombatCurses([player]);
  naechsterFluechtling(room, c);
  touchRoom(room);
}

// ---------------------------------------------------------------------------
// Ausrüstung, Verkauf, Rasse/Klasse, Ablegen
// ---------------------------------------------------------------------------

// Wann darf die Ausruestung geaendert werden? Die harte Grenze im Regelwerk
// ist der Kampf ("Du darfst deine Ausruestung nicht mitten im Kampf
// wechseln") - genau dort haengt die Kampfrechnung, und genau dort war es
// vorher frei manipulierbar. Ausserhalb eines Kampfes darf jederzeit
// umgeruestet werden, auch im fremden Zug (so liest es der gedruckte
// Ausruestungs-Abschnitt; das VERKAUFEN ist dagegen ausdruecklich an den
// eigenen Zug gebunden, siehe handleSellItems).
// ponytail: wer es strenger will ("nur im eigenen Zug"), haengt hier ein
// `&& currentPlayer(room).id === player.id` an - eine Zeile. Die
// Vorbereitungsrunde braucht das nicht: dort laeuft nie ein Kampf.
function darfAusruesten(room, player) {
  return !!player && !room.combat;
}

function ensureHandsLength(player) {
  const wappenActive = equippedItemIds(player).some((id) => (card(id) || {}).name === 'WAPPEN');
  const targetLength = wappenActive ? 4 : 2;
  while (player.equipped.hands.length < targetLength) {
    player.equipped.hands.push(null);
  }
  while (player.equipped.hands.length > targetLength) {
    if (player.equipped.hands[player.equipped.hands.length - 1] === null) {
      player.equipped.hands.pop();
    } else {
      const itemToDrop = player.equipped.hands.pop();
      player.equipped.hands = player.equipped.hands.map(h => h === itemToDrop ? null : h);
      player.hand.push(itemToDrop);
    }
  }
}

function handleEquipItem(room, playerId, cardId) {
  const player = findPlayer(room, playerId);
  if (!player || !player.hand.includes(cardId)) return;
  const c = card(cardId);
  if (!c) return;
  if (!darfAusruesten(room, player)) {
    log(room, `${player.name} kann "${c.name}" gerade nicht anlegen - Ausruestung aendert man im eigenen Zug und nicht im Kampf.`);
    touchRoom(room);
    return;
  }
  // WINZIGE HÄNDE: "Du kannst keine zweihaendigen Gegenstaende benutzen."
  if (curseBlocksTwoHanded(player) && (c.handsCost || 0) >= 2) {
    log(room, `${player.name} hat winzige Haende - "${c.name}" braucht zwei Haende und bleibt liegen.`);
    touchRoom(room);
    return;
  }
  // SCHUMMELN!: "Diesen Gegenstand kannst du nun legal einsetzen, auch wenn
  // das normalerweise nicht erlaubt wäre" - hebt fuer GENAU DIESEN Gegenstand
  // die Anlege-Regeln auf (siehe handlePlayCheat): Gross-Gegenstand-Sperre,
  // Rassen-Sperre und - Ruling 2026-09-18 - auch der belegte Platz. Der
  // geschummelte Gegenstand landet dafuer auf dem Spezialplatz statt in
  // seinem gedruckten Slot (siehe unten): der Spezialplatz ist ein
  // Sammelbereich, verdraengt also nichts und braucht keine belegten
  // Haende. Zaehlt trotzdem ueberall mit, weil equippedItemIds ihn
  // einschliesst - auch als Waffe (handItemIds liest slotKind, nicht den
  // Platz).
  // ponytail: dadurch sieht eine geschummelte Ruestung nicht mehr in
  // player.equipped.armor - wer dort direkt hineinliest (MIESER SPIEGEL,
  // Stinktier-Kleidung, "Ruestung verlieren"), greift daneben. Bewusst so:
  // die Alternative waere ein Array je Slot, also das ganze
  // Ausruestungsmodell.
  const geschummelt = player.attachments && player.attachments.cheatedItemId === cardId;
  if (!geschummelt && istGrosserGegenstand(room, cardId) && !canCarryAnotherBigItem(player, room)) {
    log(room, `${player.name} kann "${c.name}" nicht anlegen - Grosser Gegenstand, und es wird bereits einer getragen (nur Zwerge duerfen mehrere).`);
    touchRoom(room);
    return;
  }
  // SPASSBREMSE: "In den falschen Haenden - und zwar den Haenden eines Gnoms -
  // ist es toedlich." Wer die Karte trotzdem anlegt, stirbt.
  const toedlichFuer = DEADLY_ITEMS_BY_RACE[c.name];
  if (toedlichFuer && hatRasseMitNachteil(player, toedlichFuer)) {
    removeFromHand(player, cardId);
    discardCard(room, cardId);
    log(room, `${player.name} legt "${c.name}" an - in den Haenden eines ${toedlichFuer}s ist das toedlich.`, [cardId]);
    applyDeathConsequence(room, player);
    touchRoom(room);
    return;
  }
  // Spezialausruestung zuerst: diese Karten sind keine 'item'-Karten und
  // haben keinen slotKind, gehoeren aber trotzdem angelegt.
  const special = specialSlotRule(c);
  if (special) {
    if (specialSlotCards(player, special.slot).includes(cardId)) return; // liegt schon an
    // EISKALTES HÄNDCHEN: die Spezialslot-Regel (+3) gilt nur fuer die
    // BESAENFTIGTE Monsterkarte. Eine Monsterkarte kommt legitim einzig
    // ueber das Primitiv 'haendchenBesaenftigen' in equipped.special - das
    // setzt den Slot direkt und bezahlt dafuer den Wunschring. Aus der Hand
    // (Beute, Erstausteilung, aufgedeckte Tuer, Leichenfund) darf sie
    // niemals angelegt werden, sonst gaebe es den +3 gratis.
    if (c.category === 'monster') {
      log(room, `${player.name} kann "${c.name}" nicht anlegen - eine Monsterkarte rüstet man nicht aus.`);
      touchRoom(room);
      return;
    }
    // FALSCHE OHREN: "Erlaubt dem Traeger, elfen-exklusive Gegenstaende zu
    // nutzen." - deshalb hier itemGrantsTrait statt nur hasRace.
    if (!geschummelt && special.races
      && !special.races.some((r) => hasRace(player, r) || itemGrantsTrait(player, 'race', r, true))) {
      log(room, `${player.name} kann "${c.name}" nicht anlegen - nur für ${special.races.join('/')}.`);
      touchRoom(room);
      return;
    }
    removeFromHand(player, cardId);
    player.equipped[special.slot] = [...specialSlotCards(player, special.slot), cardId];
    log(room, `${player.name} legt "${c.name}" an (${SPECIAL_SLOTS[special.slot].label}).`, [cardId]);
    ensureHandsLength(player);
    touchRoom(room);
    return;
  }
  if (c.category !== 'item') return;
  // Geschummelt: ab auf den Spezialplatz, ohne Slot- und Handzahl-Pruefung.
  if (geschummelt) { removeFromHand(player, cardId); player.equipped.special = [...specialSlotCards(player, 'special'), cardId]; }
  else if (c.slotKind === 'head') { if (player.equipped.head) return; removeFromHand(player, cardId); player.equipped.head = cardId; }
  else if (c.slotKind === 'armor') { if (player.equipped.armor) return; removeFromHand(player, cardId); player.equipped.armor = cardId; }
  else if (c.slotKind === 'feet') { if (player.equipped.feet) return; removeFromHand(player, cardId); player.equipped.feet = cardId; }
  else if (c.slotKind === 'hand') {
    // ZWEIHÄNDIGES SCHWERT gibt eine Hand zurueck, kostet also netto keine.
    const kosten = FREE_HAND_ITEMS.has(c.name) ? 0 : c.handsCost;
    const freeSlots = player.equipped.hands.filter((h) => h === null).length;
    if (freeSlots < kosten) return;
    removeFromHand(player, cardId);
    if (kosten === 2) {
      const idx1 = player.equipped.hands.indexOf(null);
      player.equipped.hands[idx1] = cardId;
      const idx2 = player.equipped.hands.indexOf(null);
      player.equipped.hands[idx2] = cardId;
    }
    else if (kosten === 1) { const idx = player.equipped.hands.indexOf(null); player.equipped.hands[idx] = cardId; }
    else { player.equipped.special = [...specialSlotCards(player, 'special'), cardId]; }
  } else return;
  // FREUD'SCHEN SLIPPER: das Geschlecht beim Ausspielen merken - beim Verlust
  // entscheidet es ueber die -5-Strafe (siehe pruefeSlipperVerlust).
  if (GENDER_IMMUNE_ITEMS.has(c.name)) player.genderBeiSlippern = player.gender;
  log(room, geschummelt
    ? `${player.name} legt "${c.name}" geschummelt an (Spezialausrüstung - die Platzregeln gelten dafür nicht).`
    : `${player.name} legt "${c.name}" an.`, [cardId]);
  ensureHandsLength(player);
  touchRoom(room);
}

// FREUD'SCHEN SLIPPER: "Wenn du die Slipper verlierst, ... erhaeltst du eine
// -5 Strafe im naechsten Kampf, wenn es nicht das Geschlecht ist, das du beim
// Ausspielen der Karte hattest."
// ponytail: geprueft wird beim Kampfbeginn statt an jedem einzelnen Verlust-
// pfad (die Slipper koennen ueber ein Dutzend Wege verschwinden - Schlimme
// Dinge, Diebstahl, Handel, Verkauf). Wirkung ist dieselbe, weil die Strafe
// ohnehin erst im naechsten Kampf zaehlt. Das Geschlecht selbst waehlt hier
// niemand neu (Standard ist maennlich, siehe newPlayer).
function pruefeSlipperVerlust(room, player) {
  if (!player || player.genderBeiSlippern === undefined || player.genderBeiSlippern === null) return;
  const traegtNoch = equippedItemIds(player).some((id) => { const c = card(id); return c && GENDER_IMMUNE_ITEMS.has(c.name); });
  if (traegtNoch) return;
  const vorher = player.genderBeiSlippern;
  player.genderBeiSlippern = null;
  if (vorher === player.gender) return; // gleiches Geschlecht: keine Strafe
  player.activeCurses = player.activeCurses || [];
  player.activeCurses.push({
    cardId: null, name: "FREUD'SCHEN SLIPPER", kind: 'combatMalus', amount: -5, dauer: 'naechsterKampf',
    hinweis: '-5 im nächsten Kampf: die Slipper sind weg und das Geschlecht ein anderes als beim Anlegen.',
  });
  log(room, `${player.name} hat die Freud'schen Slipper verloren - -5 im nächsten Kampf.`);
}

// "Spiele diese Karte auf einen Gegenstand, den du im Spiel hast, oder dann,
// wenn du einen Gegenstand aus deiner Hand ausspielst. Diesen Gegenstand
// kannst du nun legal einsetzen, auch wenn das normalerweise nicht erlaubt
// waere. Lege diese Karte ab, wenn du den geschummelten Gegenstand verlierst
// (verkaufst usw.)." Der Anhang gilt fuer genau einen Gegenstand gleichzeitig
// (siehe attachments.cheatedItemId - kein Array).
// Kartenanhaenge: VERGIFTET/GESEGNET (+2 fuer den Gegenstand) und NÜTZLICHE
// GRIFFE (Grosser Gegenstand zaehlt als klein). Gleiche Bauform wie
// handlePlayCheat, aber der Anhang haengt am Gegenstand statt an der Person -
// er bleibt also dran, wenn der Gegenstand den Besitzer wechselt.
function handleAttachCard(room, playerId, attachCardId, targetItemId) {
  const player = findPlayer(room, playerId);
  if (!player || !player.hand.includes(attachCardId)) return;
  const anhang = card(attachCardId);
  const regel = anhang && ATTACHMENT_CARDS[anhang.name];
  if (!regel) return;
  const ziel = card(targetItemId);
  if (!ziel) return;
  const besitzt = player.hand.includes(targetItemId) || equippedItemIds(player).includes(targetItemId);
  if (!besitzt) return;
  if (regel.bedingung === 'kampfbonus' && !((ziel.bonus || 0) > 0)) {
    log(room, `"${anhang.name}" braucht einen Gegenstand mit Kampfbonus - "${ziel.name}" hat keinen.`);
    touchRoom(room);
    return;
  }
  if (regel.bedingung === 'gross' && !istGrosserGegenstand(room, targetItemId)) {
    log(room, `"${anhang.name}" gehoert an einen Grossen Gegenstand - "${ziel.name}" ist keiner (mehr).`);
    touchRoom(room);
    return;
  }
  removeFromHand(player, attachCardId);
  room.itemAttachments[targetItemId] = attachmentIds(room, targetItemId).concat(attachCardId);
  log(room, `${player.name} heftet "${anhang.name}" dauerhaft an "${ziel.name}".`, [attachCardId, targetItemId]);
  touchRoom(room);
}

function handlePlayCheat(room, playerId, cheatCardId, targetItemId) {
  const player = findPlayer(room, playerId);
  if (!player || !player.hand.includes(cheatCardId)) return;
  const cheat = card(cheatCardId);
  if (!cheat || cheat.name !== 'SCHUMMELN!') return;
  const ziel = card(targetItemId);
  if (!ziel) return;
  if (ziel.category !== 'item' && !specialSlotRule(ziel)) return;
  const besitzt = player.hand.includes(targetItemId) || equippedItemIds(player).includes(targetItemId);
  if (!besitzt) return;
  if (player.attachments.cheatedItemId) {
    log(room, `${player.name} hat bereits einen geschummelten Gegenstand.`);
    touchRoom(room);
    return;
  }
  removeFromHand(player, cheatCardId);
  discardCard(room, cheatCardId);
  player.attachments.cheatedItemId = targetItemId;
  log(room, `${player.name} schummelt bei "${ziel.name}" - die Anlege-Regeln gelten dafuer nicht mehr.`, [cheatCardId, targetItemId]);
  touchRoom(room);
}

function handleUnequipItem(room, playerId, cardId) {
  const player = findPlayer(room, playerId);
  if (!player) return;
  if (!equippedItemIds(player).includes(cardId)) return;
  // EISKALTES HAENDCHEN: die besaenftigte Monsterkarte liegt als einzige
  // Monsterkarte legitim in der Ausruestung (siehe haendchenBesaenftigen).
  // Zurueck in die Hand darf sie nicht: handleEquipItem weist Monsterkarten
  // ab, der +3 waere also dauerhaft weg - und aus der Hand liesse sich die
  // Karte als Monster ausspielen.
  const unequipKarte = card(cardId);
  // VERFLUCHTER GEGENSTAND: "Du kannst ihn nicht ablegen oder loswerden, bis
  // der Fluch aufgehoben wird."
  if (cursedItemIds(player).has(cardId)) {
    log(room, `${player.name} wird "${unequipKarte ? unequipKarte.name : cardId}" nicht los - der Fluch hält ihn fest.`);
    touchRoom(room);
    return;
  }
  if (unequipKarte && unequipKarte.category === 'monster') {
    log(room, `${player.name} kann "${unequipKarte.name}" nicht ablegen - die Karte bleibt, wo sie ist.`);
    touchRoom(room);
    return;
  }
  if (!darfAusruesten(room, player)) {
    log(room, `${player.name} kann gerade nichts ablegen - Ausruestung aendert man im eigenen Zug und nicht im Kampf.`);
    touchRoom(room);
    return;
  }
  unequipSlotCard(player, cardId);
  player.hand.push(cardId);
  const c = card(cardId);
  log(room, `${player.name} legt "${c ? c.name : cardId}" wieder in die Hand.`, [cardId]);
  // RIESENSTINKTIER-Strafe: derselbe Check wie in handleRequestHelp/
  // handleSellItems, hier direkt nach dem Ablegen ausgeloest, damit der
  // Tracker verschwindet, sobald das letzte Kleidungsstueck faellt, statt
  // erst beim naechsten Hilfegesuch oder Verkauf.
  stinktierStrafeAktiv(player);
  touchRoom(room);
}

// HALBLING: "Du darfst 1 Gegenstand pro Runde zum doppelten Preis verkaufen."
// Steht hier als eigene Funktion, weil zwei Stellen sie brauchen: die
// Abrechnung in handleSellItems und der Client, der den Verkaufen-Knopf sonst
// mit dem reinen Goldwert vergleicht und die Kraft damit unerreichbar macht.
function halblingSaleOpen(player) {
  return !!player && hasRace(player, 'HALBLING') && !player.halblingSaleUsed;
}
function handleResolveMultiCardSelection(room, playerId, cardIds, deck) {
  const player = findPlayer(room, playerId);
  if (!player) return;
  const pAction = room.pendingCardAction;
  if (!pAction || pAction.kind !== 'multiCardSelection' || pAction.actionType !== 'schicksalhafteKarten') return;
  if (pAction.playerId !== playerId) return;
  if (!Array.isArray(cardIds) || !cardIds.length) return;
  if (deck !== 'door' && deck !== 'treasure') return;
  if (!cardIds.every(id => player.hand.includes(id))) return;
  // Stoererliste: nicht vom Schatzstapel nachziehen - die Auswahl bleibt
  // offen, der Tuerstapel geht weiterhin.
  if (deck === 'treasure' && hatSchatzSperre(player)) {
    log(room, `${player.name} steht auf der Störerliste - bitte vom Türstapel nachziehen.`);
    touchRoom(room);
    return;
  }

  cardIds.forEach(id => {
    removeFromHand(player, id);
    discardCard(room, id);
  });
  
  const count = cardIds.length;
  for (let i = 0; i < count; i++) {
    const drawn = deck === 'door' ? drawDoor(room) : drawTreasure(room);
    if (drawn) player.hand.push(drawn);
  }
  
  log(room, `${player.name} hat ${count} Karten abgeworfen und neu aus dem ${deck === 'door' ? 'Türen' : 'Schätze'}-Stapel gezogen.`);
  room.pendingCardAction = null;
  touchRoom(room);
}

function handleSellItems(room, playerId, cardIds) {
  const player = findPlayer(room, playerId);
  if (!player) return;
  // "Verkaufen kannst du jederzeit in deinem Zug - aber nicht im Kampf."
  const dran = currentPlayer(room);
  if (room.combat || room.turnPhase === 'vorbereitung' || !dran || dran.id !== playerId) {
    log(room, `${player.name} kann gerade nicht verkaufen - Verkaufen geht nur im eigenen Zug und nicht im Kampf.`);
    touchRoom(room);
    return;
  }
  const ids = [...new Set(cardIds)];
  // VERFLUCHTER GEGENSTAND: der ganze Verkauf wird abgelehnt statt still
  // gefiltert - dieselbe Entscheidung wie bei der Stoererliste im Handel
  // (finishTrade): wer eine Auswahl abschickt, soll nicht heimlich weniger
  // verkaufen als er sieht.
  const verflucht = cursedItemIds(player);
  const verfluchtInAuswahl = ids.find((id) => verflucht.has(id));
  if (verfluchtInAuswahl) {
    log(room, `${player.name} kann "${(card(verfluchtInAuswahl) || {}).name || verfluchtInAuswahl}" nicht verkaufen - der Gegenstand ist verflucht.`);
    touchRoom(room);
    return;
  }
  let total = 0;
  const removable = [];
  // Machtgruppe Alchemist, "Blei zu Gold": mindestens 300 Goldstücke pro
  // verkauftem Gegenstand, bevor andere Modifikatoren angewendet werden.
  const isAlchemist = hasPowerGroup(player, 'ALCHEMIST');
  const values = [];
  ids.forEach((id) => {
    const inHand = player.hand.includes(id);
    const inEquip = equippedItemIds(player).includes(id);
    if (!inHand && !inEquip) return;
    const c = card(id);
    if (!c || typeof c.gold !== 'number') return;
    const value = isAlchemist ? Math.max(c.gold, 300) : c.gold;
    values.push(value);
    total += value;
    removable.push(id);
  });
  // HALBLING: "Du darfst 1 Gegenstand pro Runde zum doppelten Preis verkaufen
  // (und weitere Gegenstände zum normalen Preis)." Verdoppelt wird automatisch
  // der teuerste der verkauften Gegenstände - eine Auswahl wäre nur nötig, wenn
  // jemand sich bewusst schlechter stellen wollte.
  const halblingBonus = (halblingSaleOpen(player) && values.length)
    ? Math.max.apply(null, values) : 0;
  total += halblingBonus;
  // RIESENSTINKTIER: "Der Goldwert ist halbiert." Halbiert wird die Endsumme
  // (nach Alchemisten-Mindestwert und Halbling-Bonus), nicht der einzelne
  // Gegenstand: der Kartentext nennt eine Eigenschaft der Person, keine der
  // Gegenstaende - und die Endsumme ist ohnehin die Stelle, an der gerundet
  // wird. Halbiert wird VOR der Schwelle - der halbierte Wert darf einen
  // Verkauf also unter 1000 druecken und ihn scheitern lassen. Geloggt wird
  // die Halbierung aber erst NACH der Schwelle (wie der Halbling-Bonus),
  // sonst behauptet die Logzeile einen Verkauf, der gar nicht stattfand.
  const vollVorHalbierung = total;
  // Ruling 2026-09-17: wer sein LETZTES Kleidungsstueck verkauft, verkauft es
  // noch halbiert - der Check laeuft vor dem Entfernen. Absicht: die Strafe
  // endet, wenn die Kleidung ABGELEGT ist, und beim Verkauf liegt sie beim
  // Preisvergleich noch an.
  const besprueht = stinktierStrafeAktiv(player);
  if (besprueht) total = Math.floor(total / 2);
  if (total < 1000) return;
  if (halblingBonus) player.halblingSaleUsed = true;
  const levels = Math.floor(total / 1000);
  removable.forEach((id) => {
    if (card(id).name === 'BUMERANGDOLCH') {
      room.bumerangReturns = room.bumerangReturns || {};
      room.bumerangReturns[player.id] = (room.bumerangReturns[player.id] || []).concat(id);
    }
    if (player.hand.includes(id)) removeFromHand(player, id); else unequipSlotCard(player, id);
    discardCard(room, id);
  });
  setLevel(player, player.level + levels);
  if (halblingBonus) log(room, `${player.name} ist Halbling und verkauft den teuersten Gegenstand zum doppelten Preis (+${halblingBonus} Goldstücke, einmal pro Runde).`);
  if (besprueht) log(room, `${player.name} stinkt noch - der Goldwert ist halbiert: ${vollVorHalbierung} GS zählen nur ${total} GS.`);
  log(room, `${player.name} legt Gegenstände im Wert von ${total} Goldstücken ab und steigt ${levels} Stufe(n) auf (jetzt Stufe ${player.level}).`);
  // Die Siegesstufe ist laut Regelwerk nur durch ein besiegtes Monster
  // erreichbar - Verkaufen bringt auf Stufe 10, gewinnt aber nicht. Der Sieg
  // faellt beim naechsten gewonnenen Kampf (resolveCombatWin ruft checkWin
  // ohnehin auf). Einzige gedruckte Ausnahme: GOTTLICHE INTERVENTION.
  touchRoom(room);
}

const RACE_NAMES = new Set(['ELF', 'ZWERG', 'HALBLING']);
const CLASS_NAMES = new Set(['KRIEGER', 'ZAUBERER', 'DIEB', 'PRIESTER']);

// Machtgruppe (Pathfinder-Set): ein drittes Merkmal neben Rasse/Klasse, mit
// eigenen "Beitritts"-Karten (Kategorie "door_other" in den Rohdaten, aber
// mechanisch identisch zu Rassen-/Klassenkarten - Ausleihkarte, max. 1,
// solange keine Doppelleben-Karte gehalten wird). Ihre "gegen [Machtgruppe]"
// Kampfboni auf anderen Karten (z.B. TENGU: "+3 gegen Kundschafter") bleiben
// bewusst manuell: dafür müsste jede der 92 Monsterkarten mit ihrer eigenen
// Machtgruppen-Zugehörigkeit getaggt sein, ein Datenpunkt, den es nicht gibt.
// Leer, seit das Pathfinder-Set entfernt wurde: alle acht Machtgruppen-Karten
// stammten von dort. Die Maschinerie drumherum (powerGroups am Spieler,
// traitCap, Anzeige im Client) bleibt bewusst stehen - kommt ein Set mit
// Machtgruppen dazu, reichen die Namen hier.
const POWER_GROUP_NAMES = new Set([]);

function traitCap(player, kind) {
  if (kind === 'race') return player.raceCapCard ? 2 : 1;
  if (kind === 'class') return player.classCapCard ? 2 : 1;
  return player.powerGroupCapCard ? 2 : 1;
}

function handlePlayRaceOrClass(room, playerId, cardId) {
  const player = findPlayer(room, playerId);
  if (!player || !player.hand.includes(cardId)) return;
  const c = card(cardId);
  if (!c) return;
  const upper = c.name.toUpperCase();
  // ORK, GNOM, BARDE stehen in den Rohdaten als "door_other", sind aber
  // Rassen- bzw. Klassenkarten - siehe TRAIT_DOOR_CARDS in
  // src/cards/passives.js. Ab hier laufen sie durch dieselben Zweige.
  const kategorie = c.category === 'door_other' ? (TRAIT_DOOR_CARDS[upper] || c.category) : c.category;
  if (kategorie === 'race') {
    if (player.races.length >= traitCap(player, 'race')) return;
    removeFromHand(player, cardId);
    player.races.push(cardId);
  } else if (kategorie === 'class') {
    if (player.classes.length >= traitCap(player, 'class')) return;
    removeFromHand(player, cardId);
    player.classes.push(cardId);
  } else if (c.category === 'door_other' && POWER_GROUP_NAMES.has(upper)) {
    if (player.powerGroups.length >= traitCap(player, 'powerGroup')) {
      log(room, `${player.name} kann "${c.name}" nicht spielen (Machtgruppen-Obergrenze erreicht).`);
      touchRoom(room);
      return;
    }
    removeFromHand(player, cardId);
    player.powerGroups.push(cardId);
  } else if (upper === 'HALB-BLUT') {
    if (player.raceCapCard) { log(room, `${player.name} hat bereits eine Halb-Blut-Karte.`); touchRoom(room); return; }
    removeFromHand(player, cardId);
    player.raceCapCard = cardId;
  } else if (upper === 'SUPER MUNCHKIN') {
    if (player.classCapCard) { log(room, `${player.name} hat bereits eine Super-Munchkin-Karte.`); touchRoom(room); return; }
    removeFromHand(player, cardId);
    player.classCapCard = cardId;
  } else if (upper === 'DOPPELLEBEN') {
    if (player.powerGroupCapCard) { log(room, `${player.name} hat bereits eine Doppelleben-Karte.`); touchRoom(room); return; }
    removeFromHand(player, cardId);
    player.powerGroupCapCard = cardId;
  } else return;
  log(room, `${player.name} spielt "${c.name}".`, [cardId]);
  touchRoom(room);
}

function handleDiscardFromHand(room, playerId, cardId) {
  const player = findPlayer(room, playerId);
  if (!player || !player.hand.includes(cardId)) return;
  removeFromHand(player, cardId);
  discardCard(room, cardId);
  const c = card(cardId);
  log(room, `${player.name} legt "${c ? c.name : cardId}" ab.`, [cardId]);
  touchRoom(room);
}

function handleEndTurnAction(room, playerId) {
  const player = currentPlayer(room);
  if (!player || player.id !== playerId) return;
  if (room.turnPhase !== 'gabe' || zugAktionOffen(room)) return;
  if (player.hand.length > handLimit(player)) return;
  endTurn(room);
  touchRoom(room);
}

// ---------------------------------------------------------------------------
// Handel zwischen Spielenden - ausserhalb eines Kampfes jederzeit möglich und
// nicht an die Zugreihenfolge gebunden, ganz wie am echten Tisch; im Kampf
// dagegen gar nicht (siehe darfHandeln, gleiche Grenze wie beim Anlegen und
// Verkaufen). Tauschbar sind Handkarten UND angelegte
// Gegenstände; beim Empfänger landet alles auf der Hand (Anlegen bleibt eine
// eigene Aktion, damit Größen-/Slot-Regeln weiter gelten).
//
// Echter Tausch - beide Seiten müssen zustimmen:
//   1. proposeTrade: Angebot an eine Person (Status "pending").
//   2. respondTrade der Gegenseite: ablehnen, ohne Gegenleistung annehmen
//      (dann sofort fertig - Geschenk) oder eine Gegenleistung festlegen
//      (Status "countered").
//   3. respondTrade des/der Anbietenden: sieht die Gegenleistung und
//      bestätigt oder lehnt ab. cancelTrade zieht das Angebot zurück.
// Ein offener Handel pro Richtung; Angebote stehen nur im privaten yourInfo
// der beiden Beteiligten, im öffentlichen Verlauf nur Anzahlen bzw. das
// Ergebnis.
// ---------------------------------------------------------------------------

// Handelbar ist alles, was man wirklich besitzt: Handkarten und angelegte
// Gegenstände (Zweihandwaffen stehen in zwei Slots -> dedupliziert).
function tradableCardIds(player) {
  return [...new Set([...player.hand, ...equippedItemIds(player)])];
}

// Fremde IDs auf das reduzieren, was diese Person gerade wirklich besitzt.
function ownTradeIds(player, ids) {
  const own = tradableCardIds(player);
  // VERFLUCHTER GEGENSTAND: "du kannst ihn nicht ablegen oder loswerden" -
  // Verschenken und Tauschen sind auch Loswerden.
  const verflucht = cursedItemIds(player);
  return [...new Set(Array.isArray(ids) ? ids : [])]
    .filter((id) => own.includes(id) && !verflucht.has(id));
}

// Karte aus Hand oder Slot lösen (Slot-Variante wie beim Verkaufen).
function takeTradedCard(player, cardId) {
  if (player.hand.includes(cardId)) removeFromHand(player, cardId);
  else unequipSlotCard(player, cardId);
}

function tradeGoldSum(ids) {
  return ids.reduce((sum, id) => { const c = card(id); return sum + (c && typeof c.gold === 'number' ? c.gold : 0); }, 0);
}

// "Waehrend eines Kampfes wird nicht gehandelt." Sonst liesse sich die
// Kampfrechnung mitten im Kampf ueber fremde Gegenstaende verschieben - genau
// wie beim Anlegen (darfAusruesten) und Verkaufen.
function darfHandeln(room, player) {
  if (!room.combat) return true;
  log(room, `${player.name} kann im Kampf nicht handeln.`);
  touchRoom(room);
  return false;
}

function handleProposeTrade(room, playerId, toId, offerCardIds) {
  const from = findPlayer(room, playerId);
  const to = findPlayer(room, toId);
  if (!from || !to || from.id === to.id || !to.connected) return;
  if (!darfHandeln(room, from)) return;
  const ids = ownTradeIds(from, offerCardIds);
  if (!ids.length) return;
  if (!room.trades) room.trades = [];
  // Nur ein offener Handel pro Richtung gleichzeitig - ein neues Angebot ersetzt ein altes.
  room.trades = room.trades.filter((t) => !(t.fromId === from.id && t.toId === to.id));
  room.trades.push({ id: makeId(), fromId: from.id, toId: to.id, offerCardIds: ids, counterCardIds: [], status: 'pending', at: Date.now() });
  log(room, `${from.name} bietet ${to.name} einen Handel an (${ids.length} Karte(n)).`);
  touchRoom(room);
}

function handleCancelTrade(room, playerId, tradeId) {
  if (!room.trades) return;
  const trade = room.trades.find((t) => t.id === tradeId && t.fromId === playerId);
  if (!trade) return;
  room.trades = room.trades.filter((t) => t.id !== trade.id);
  const from = findPlayer(room, playerId);
  log(room, `${from.name} zieht ein Handelsangebot zurück.`);
  touchRoom(room);
}

// Antwort auf einen Handel - je nach Status und Rolle Schritt 2 oder 3.
function handleRespondTrade(room, playerId, tradeId, accept, counterCardIds) {
  if (!room.trades) return;
  const trade = room.trades.find((t) => t.id === tradeId);
  if (!trade) return;
  const from = findPlayer(room, trade.fromId);
  const to = findPlayer(room, trade.toId);
  if (!from || !to) { room.trades = room.trades.filter((t) => t.id !== trade.id); return; }
  // Auch Annehmen/Gegenangebot sind Handeln - ein vor dem Kampf gestelltes
  // Angebot darf nicht mittendrin abgeschlossen werden. Zuruecknehmen
  // (handleCancelTrade) bleibt erlaubt: es bewegt keine Karten.
  // Nur die beiden Beteiligten pruefen - wer gar nicht zum Handel gehoert,
  // faellt unten durch die Rollenpruefung und braucht keine Logzeile.
  const antwortende = playerId === from.id ? from : (playerId === to.id ? to : null);
  if (antwortende && !darfHandeln(room, antwortende)) return;

  // Schritt 2: die angefragte Seite antwortet auf das Angebot.
  if (trade.status === 'pending' && playerId === to.id) {
    if (!accept) {
      room.trades = room.trades.filter((t) => t.id !== trade.id);
      log(room, `${to.name} lehnt den Handel von ${from.name} ab.`);
      touchRoom(room);
      return;
    }
    const counterIds = ownTradeIds(to, counterCardIds);
    // Ohne Gegenleistung ist es ein Geschenk - dafür braucht es keine zweite
    // Bestätigung, das Angebot stand ja genau so da.
    if (!counterIds.length) { finishTrade(room, trade, from, to, []); return; }
    trade.counterCardIds = counterIds;
    trade.status = 'countered';
    log(room, `${to.name} will für den Handel mit ${from.name} eine Gegenleistung (${counterIds.length} Karte(n)) - ${from.name} muss noch bestätigen.`);
    touchRoom(room);
    return;
  }

  // Schritt 3: der/die Anbietende sieht die Gegenleistung und entscheidet.
  if (trade.status === 'countered' && playerId === from.id) {
    if (!accept) {
      room.trades = room.trades.filter((t) => t.id !== trade.id);
      log(room, `${from.name} lehnt die Gegenleistung von ${to.name} ab.`);
      touchRoom(room);
      return;
    }
    finishTrade(room, trade, from, to, trade.counterCardIds);
  }
}

function finishTrade(room, trade, from, to, counterCardIds) {
  room.trades = room.trades.filter((t) => t.id !== trade.id);
  // Erneut gegen den aktuellen Zustand prüfen - die Karten könnten seither
  // abgelegt, verkauft oder angelegt worden sein. Was weg ist, wird
  // übersprungen; der Rest wird getauscht.
  const offerIds = ownTradeIds(from, trade.offerCardIds);
  const counterIds = ownTradeIds(to, counterCardIds);
  // WEIHNACHTSMANN: "auch nicht von anderen Spielern". Die Annahme wird
  // ABGELEHNT, nicht gefiltert: gefiltert wurde bis 2026-09-17, und dabei gab
  // eine gesperrte Person ihre Seite des Handels her und bekam nichts zurueck
  // - ein Gegner konnte das beliebig oft wiederholen. Geprueft werden beide
  // Richtungen, denn beide Seiten koennen Schatzkarten enthalten.
  const istSchatz = (id) => (card(id) || {}).type === 'treasure';
  const gesperrt = [];
  if (hatSchatzSperre(to) && offerIds.some(istSchatz)) gesperrt.push(to);
  if (hatSchatzSperre(from) && counterIds.some(istSchatz)) gesperrt.push(from);
  if (gesperrt.length) {
    log(room, `Der Handel zwischen ${from.name} und ${to.name} kommt nicht zustande: ${gesperrt.map((p) => p.name).join(' und ')} steht auf der Störerliste und darf keine Schatzkarten annehmen.`);
    touchRoom(room);
    return;
  }
  const anEmpfaenger = offerIds;
  const anGeber = counterIds;
  anEmpfaenger.forEach((id) => { takeTradedCard(from, id); clearCheatIfLost(from, id); to.hand.push(id); });
  anGeber.forEach((id) => { takeTradedCard(to, id); clearCheatIfLost(to, id); from.hand.push(id); });
  const names = (ids) => ids.map((id) => { const c = card(id); return c ? c.name : id; }).join(', ');
  const offerText = anEmpfaenger.length ? `${names(anEmpfaenger)} - ${tradeGoldSum(anEmpfaenger)} GS` : '(nichts mehr davon verfügbar)';
  const counterText = anGeber.length ? `${names(anGeber)} - ${tradeGoldSum(anGeber)} GS` : '(nichts zurück)';
  log(room, `Handel: ${from.name} gibt [${offerText}] an ${to.name}, erhält dafür [${counterText}].`, [...anEmpfaenger, ...anGeber]);
  touchRoom(room);
}

// ---------------------------------------------------------------------------
// Bots (einfache Heuristik - siehe README)
// ---------------------------------------------------------------------------

function addBot(room) {
  if (room.players.length >= MAX_PLAYERS) return null;
  const usedNames = new Set(room.players.map((p) => p.name));
  const name = BOT_NAME_POOL.find((n) => !usedNames.has(n)) || `Bot ${room.players.length + 1}`;
  const bot = newPlayer(name, null, true);
  room.players.push(bot);
  log(room, `${name} (Bot) wurde hinzugefügt.`);
  return bot;
}

// Beantwortet eine an einen Bot gerichtete Kartenaktion (Wahl/Ziel/Karte aus
// dem Ablagestapel) mit der jeweils ersten Option - siehe
// scheduleBotActionsIfNeeded für den Aufrufkontext.
function resolveBotCardAction(room) {
  const pa = room.pendingCardAction;
  if (!pa) return;
  const bot = findPlayer(room, pa.playerId);
  if (!bot || !bot.isBot) return;
  if (pa.kind === 'choice' && (pa.options || []).length) {
    handleResolveCardChoice(room, bot.id, pa.options[0].id);
  } else if (pa.kind === 'targetPlayer' && (pa.candidateIds || []).length) {
    handleResolveCardTarget(room, bot.id, pa.candidateIds[0]);
  } else if (pa.kind === 'chooseCard' && (pa.candidateIds || []).length) {
    handleResolveCardCardChoice(room, bot.id, pa.candidateIds[0]);
  } else {
    // Nichts Waehlbares oder unbekannte Art: ueberspringen statt haengen.
    advanceCardActionQueue(room);
  }
}

const BOT_DELAY_MIN = Number(process.env.BOT_DELAY_MIN_MS) || 900;
const BOT_DELAY_MAX = Number(process.env.BOT_DELAY_MAX_MS) || 2200;
function randomDelay(min = BOT_DELAY_MIN, max = BOT_DELAY_MAX) { return min + Math.random() * (max - min); }

// Nur EIN ausstehender Bot-Timer pro Raum gleichzeitig - jeder neue Aufruf
// (z.B. durch broadcastState() nach jeder Aktion) ersetzt einen zuvor
// geplanten, noch nicht ausgelösten Timer, statt zusätzliche parallele
// Timer für denselben Bot-Zug anzuhäufen. Verhindert doppelt/mehrfach
// ausgeführte Bot-Aktionen bei schneller Aktionsfolge.
// Woran die naechste Bot-Aktion haengt. Der Timer wurde frueher bei JEDEM
// Broadcast neu gesetzt - wer schnell hintereinander handelte (mehrere
// Spieler:innen, eine Karte nach der anderen ablegen, ein Testskript),
// verschob die Bot-Aktion damit immer weiter nach hinten, und sie kam nie.
// Solange sich an dieser Lage nichts aendert, bleibt ein laufender Timer also
// stehen; aendert sich etwas, wird neu geplant.
function botSituation(room) {
  const c = room.combat;
  return JSON.stringify([
    room.phase, room.turnIndex, room.turnPhase, !!room.pendingRoll,
    room.pendingCardAction ? room.pendingCardAction.playerId : null,
    room.pendingConsequence ? room.pendingConsequence.playerId : null,
    c ? [c.actorId, c.helperId, c.helperPending ? c.helperPending.targetId : null, c.monsterIds,
      c.mustFlee, c.fleeingId, !!c.fleeRerollOffer, !!c.escapeReactionOffer, combatAllReady(room)] : null,
  ]);
}

function scheduleBotActionsIfNeeded(room) {
  const lage = botSituation(room);
  if (room.botTimer && room.botTimerLage === lage) return; // laeuft bereits fuer genau diese Lage
  if (room.botTimer) { clearTimeout(room.botTimer); room.botTimer = null; }
  room.botTimerLage = lage;
  if (room.phase !== 'playing') return;
  const actor = currentPlayer(room);
  if (!actor) return;

  // Solange ein Wurf-Reaktionsfenster offen ist, gehoert der Zug den Menschen
  // mit der passenden Karte (Gezinkter Wuerfel). reactionHolders laesst Bots
  // und Getrennte ohnehin nicht hinein, es wartet also immer auf jemanden, der
  // wirklich antworten kann - und die Antwort loest den naechsten Broadcast
  // und damit die naechste Planung aus. Ein Bot, der hier trotzdem plant,
  // laeuft im Sekundentakt gegen Handler, die ihn abweisen.
  if (room.pendingRoll) return;

  // In der Vorbereitungsrunde gibt es fuer Bots nichts zu tun (sie sind seit
  // startGame bereit) - ohne dieses return plant der Scheduler im Sekundentakt
  // Timer, deren Callback keine Phase trifft und nur broadcastState ausloest.
  if (room.turnPhase === 'vorbereitung') return;

  // Eine an einen Bot gerichtete Kartenaktion muss der Server selbst
  // beantworten - sonst wartet die Partie ewig auf einen Dialog, den niemand
  // sieht. Bots waehlen bewusst simpel (erste Option / erstes Ziel); eine
  // kluegere Auswahl waere ein eigenes Thema.
  if (room.pendingCardAction) {
    const p = findPlayer(room, room.pendingCardAction.playerId);
    if (p && p.isBot) {
      const snapshot = room.pendingCardAction;
      room.botTimer = setTimeout(() => {
        room.botTimer = null; room.botTimerLage = null;
        if (!rooms.has(room.code) || room.pendingCardAction !== snapshot) return;
        resolveBotCardAction(room);
        broadcastState(room);
      }, randomDelay());
    }
    return;
  }

  // Konsequenz eines Bots automatisch bestätigen (ohne manuelle Anpassung -
  // ein Bot "spielt einfach den Text nach bestem Wissen selbst nicht aus").
  if (room.pendingConsequence) {
    const p = findPlayer(room, room.pendingConsequence.playerId);
    if (p && p.isBot) {
      const snapshot = room.pendingConsequence;
      room.botTimer = setTimeout(() => {
        room.botTimer = null; room.botTimerLage = null;
        if (!rooms.has(room.code) || room.pendingConsequence !== snapshot) return;
        handleAckConsequence(room, p.id);
        broadcastState(room);
      }, randomDelay());
    }
    return;
  }

  if (room.combat) {
    const c = room.combat;
    if (c.helperPending) {
      const helper = findPlayer(room, c.helperPending.targetId);
      if (helper && helper.isBot) {
        room.botTimer = setTimeout(() => {
          room.botTimer = null; room.botTimerLage = null;
          if (!rooms.has(room.code) || !room.combat || !room.combat.helperPending) return;
          handleRespondHelp(room, helper.id, false); // Bots helfen aktuell nicht (Vereinfachung)
          broadcastState(room);
        }, randomDelay());
      }
      return;
    }
    if (c.escapeReactionOffer) return; // erst das Kleberflaeschchen-Fenster
    if (c.trojanerOffer) return; // erst das Trojaner-Fenster beantworten
    // Beim Weglaufen ist nicht zwingend die kaempfende Person dran: jede
    // beteiligte Person laeuft einzeln weg (fleeingId). Ein Bot als Helfer:in
    // muss deshalb hier eingeplant werden, sonst steht die Partie.
    //
    // ponytail (Fix): vor der Auswertung (noch nicht mustFlee) fiel das hier
    // faelschlich auf "actor" zurueck - das ist currentPlayer(room), also die
    // Person, die gerade AM ZUG ist, NICHT zwingend c.actorId. Normalerweise
    // sind beide identisch (wer seinen Zug hat, startet auch den Kampf), aber
    // UEBERFALLTRANK ("Ein anderer Spieler kaempft stattdessen") aendert
    // c.actorId mitten im Kampf, ohne den Zug zu wechseln. Wurde der Kampf an
    // einen BOT uebergeben, wartete der Scheduler dann ewig auf "actor"
    // (weiterhin die urspruengliche, menschliche, zugfuehrende Person) statt
    // auf den tatsaechlichen (Bot-)Kaempfenden zu schauen - der Kampf blieb
    // fuer immer haengen (auch nachfolgende "Schlimme Dinge" z.B. von
    // NETZ-TROLL kamen dadurch nie zustande, siehe Bugreport). Deshalb zuerst
    // c.actorId selbst nachschlagen, "actor" nur als letzte Absicherung.
    const dran = (c.mustFlee && findPlayer(room, fluechtenderId(room)))
      || findPlayer(room, c.actorId) || actor;
    if (dran.isBot) {
      // Solange noch jemand bestätigen muss, gar nicht erst einplanen -
      // handleEvaluateCombat würde nur wirkungslos abprallen und der Bot
      // liefe im Sekundentakt dagegen. Das nächste "Bereit" löst ohnehin
      // einen Broadcast und damit eine neue Planung aus.
      if (!c.mustFlee && !combatAllReady(room)) return;
      const snapshotCombat = c;
      room.botTimer = setTimeout(() => {
        room.botTimer = null; room.botTimerLage = null;
        if (!rooms.has(room.code) || room.combat !== snapshotCombat) return;
        // Ein Bot-Halbling muss das Wiederholungsangebot selbst beantworten,
        // sonst wartet die Partie ewig auf eine Entscheidung.
        if (room.combat.fleeRerollOffer) handleFleeReroll(room, dran.id, botFleeRerollCard(room, dran));
        else if (room.combat.mustFlee) handleAttemptFlee(room, dran.id, 0);
        else handleEvaluateCombat(room, dran.id);
        broadcastState(room);
      }, randomDelay());
    }
    return;
  }

  if (!actor.isBot) return;

  const snapshotPhase = room.turnPhase;
  room.botTimer = setTimeout(() => {
    room.botTimer = null; room.botTimerLage = null;
    if (!rooms.has(room.code) || room.phase !== 'playing') return;
    if (currentPlayer(room) !== actor || room.turnPhase !== snapshotPhase) return;
    if (room.turnPhase === 'tuer') {
      if (room.revealedDoorCard) handleTakeRevealedDoor(room, actor.id);
      else handleDrawDoor(room, actor.id);
    } else if (room.turnPhase === 'aerger') {
      // Bot spielt nie freiwillig ein Monster aus der Hand (Vereinfachung).
      handleSkipToLoot(room, actor.id);
    } else if (room.turnPhase === 'pluendern') {
      handleLootRoom(room, actor.id);
    } else if (room.turnPhase === 'gabe') {
      while (actor.hand.length > handLimit(actor)) {
        handleDiscardFromHand(room, actor.id, actor.hand[actor.hand.length - 1]);
      }
      handleEndTurnAction(room, actor.id);
    }
    broadcastState(room);
  }, randomDelay());
}

// ---------------------------------------------------------------------------
// Socket.IO
// ---------------------------------------------------------------------------

// Ein Client bestimmt Event-Namen UND Payload selbst - beides ist ungeprüfte
// Fremdeingabe. Ohne Absicherung genügte ein `socket.emit('removeBot')` ganz
// ohne Argument, um den kompletten Serverprozess zu beenden (Destrukturierung
// von undefined im Parameter der Handler-Funktion) und damit ALLE laufenden
// Spiele zu verlieren - die Räume liegen nur im Arbeitsspeicher.
//
// Deshalb wird jeder Handler zentral über diese Funktion registriert statt
// über socket.on() direkt: fehlender Payload wird zu {}, ein fehlender
// Callback zu einer No-Op-Funktion, und ein Fehler im Handler beendet nur
// dieses eine Event statt des Prozesses. Damit greift der Schutz auch für
// jeden künftig ergänzten Handler, ohne dass daran gedacht werden muss.
function onSafe(socket, event, handler) {
  socket.on(event, (payload, cb) => {
    try {
      handler(payload == null ? {} : payload, typeof cb === 'function' ? cb : () => {});
    } catch (err) {
      console.error(`Fehler im Event "${event}" (Socket ${socket.id}):`, err && err.message);
    }
  });
}

io.on('connection', (socket) => {
  onSafe(socket, 'createRoom', ({ name }, cb) => {
    try {
      if (isRateLimited(`createRoom:${getClientIp(socket)}`, 8, 60 * 1000)) {
        return cb({ ok: false, error: 'Zu viele neue Räume in kurzer Zeit. Bitte kurz warten.' });
      }
      if (rooms.size >= MAX_ROOMS) return cb({ ok: false, error: 'Gerade zu viele aktive Räume. Bitte später erneut versuchen.' });
      name = (name || '').trim().slice(0, 20) || 'Spieler';
      const room = createRoom();
      const player = newPlayer(name, socket.id, false);
      room.hostId = player.id;
      room.players.push(player);
      socket.join(room.code);
      socket.data.roomCode = room.code;
      socket.data.playerId = player.id;
      log(room, `${name} hat den Raum erstellt.`);
      cb({ ok: true, code: room.code, playerId: player.id, token: player.token });
      broadcastState(room);
    } catch (err) {
      cb({ ok: false, error: 'Raum konnte nicht erstellt werden.' });
    }
  });

  onSafe(socket, 'joinRoom', ({ code, name, token }, cb) => {
    if (isRateLimited(`joinRoom:${getClientIp(socket)}`, 20, 60 * 1000)) {
      return cb({ ok: false, error: 'Zu viele Versuche. Bitte kurz warten.' });
    }
    code = (code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'Diesen Raum gibt es nicht.' });

    if (token) {
      const existing = room.players.find((p) => p.token === token);
      if (existing) {
        existing.socketId = socket.id;
        existing.connected = true;
        socket.join(room.code);
        socket.data.roomCode = room.code;
        socket.data.playerId = existing.id;
        log(room, `${existing.name} ist wieder verbunden.`);
        cb({ ok: true, code: room.code, playerId: existing.id, token: existing.token, rejoined: true });
        broadcastState(room);
        return;
      }
    }
    // Die Partie läuft schon: statt einer Fehlermeldung setzen wir die Person
    // direkt als Zuschauer:in in den Raum - kein Sackgassen-Fehler, sondern
    // derselbe Weg wie über den expliziten "Nur zuschauen"-Schalter.
    if (room.phase !== 'lobby') return trySpectatorJoin(room, name, socket, cb, { auto: true });
    if (room.players.length >= MAX_PLAYERS) return cb({ ok: false, error: `Der Raum ist voll (max. ${MAX_PLAYERS}).` });
    name = (name || '').trim().slice(0, 20) || 'Spieler';
    if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return cb({ ok: false, error: 'Dieser Name ist bereits vergeben.' });
    }
    const player = newPlayer(name, socket.id, false);
    room.players.push(player);
    if (!room.hostId) room.hostId = player.id;
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    log(room, `${name} ist dem Raum beigetreten.`);
    cb({ ok: true, code: room.code, playerId: player.id, token: player.token });
    broadcastState(room);
  });

  // Zuschauer:innen: eigener Beitritt (kein Namens-/Platzlimit wie bei
  // Spielenden, kein room.phase==='lobby'-Zwang - Zuschauen soll auch bei
  // einer schon laufenden Partie jederzeit moeglich sein), mit demselben
  // Token-Wiederverbinden wie joinRoom. WICHTIG: socket.data.playerId bleibt
  // dabei unangetastet (null) - act() (jede Spielaktion) verlangt genau das
  // Feld, ein Zuschauer-Socket kann also serverseitig gar keine Spielaktion
  // ausloesen, selbst wenn der Client manipuliert wuerde.
  onSafe(socket, 'joinAsSpectator', ({ code, name, token }, cb) => {
    if (isRateLimited(`joinSpectator:${getClientIp(socket)}`, 20, 60 * 1000)) {
      return cb({ ok: false, error: 'Zu viele Versuche. Bitte kurz warten.' });
    }
    code = (code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'Diesen Raum gibt es nicht.' });

    if (token) {
      const existing = room.spectators.find((s) => s.token === token);
      if (existing) {
        existing.socketId = socket.id;
        existing.connected = true;
        socket.join(room.code);
        socket.data.roomCode = room.code;
        socket.data.spectatorId = existing.id;
        log(room, `${existing.name} schaut wieder als Zuschauer:in zu.`);
        cb({ ok: true, code: room.code, spectatorId: existing.id, token: existing.token, rejoined: true });
        broadcastState(room);
        return;
      }
    }
    trySpectatorJoin(room, name, socket, cb);
  });

  onSafe(socket, 'leaveRoom', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.spectatorId) {
      const spec = room.spectators.find((s) => s.id === socket.data.spectatorId);
      if (spec) {
        room.spectators = room.spectators.filter((s) => s.id !== spec.id);
        log(room, `${spec.name} (Zuschauer:in) hat den Raum verlassen.`);
      }
      socket.leave(room.code);
      socket.data.roomCode = null;
      socket.data.spectatorId = null;
      if (room.players.length === 0 && room.spectators.length === 0) {
        if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
        if (room.botTimer) clearTimeout(room.botTimer);
        rooms.delete(room.code);
      } else broadcastState(room);
      return;
    }
    const player = findPlayer(room, socket.data.playerId);
    if (!player) return;
    if (room.phase === 'lobby') {
      room.players = room.players.filter((p) => p.id !== player.id);
      if (room.hostId === player.id) room.hostId = room.players.length ? room.players[0].id : null;
      log(room, `${player.name} hat den Raum verlassen.`);
    } else {
      player.connected = false;
      log(room, `${player.name} hat das Spiel verlassen.`);
      // Wie beim Verbindungsabbruch: offene Reaktionsfenster und die
      // Vorbereitungsrunde duerfen nicht auf jemanden warten, der weg ist.
      loeseReaktionsfensterOhne(room, player.id);
      pruefeVorbereitungFertig(room);
    }
    socket.leave(room.code);
    socket.data.roomCode = null;
    socket.data.playerId = null;
    if (room.players.length === 0 && room.spectators.length === 0) {
      // Aufräum-Timer mitnehmen, sonst hält er den Raum noch stundenlang im
      // Speicher, obwohl ihn niemand mehr erreichen kann.
      if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
      if (room.botTimer) clearTimeout(room.botTimer);
      rooms.delete(room.code);
    } else broadcastState(room);
  });

  onSafe(socket, 'addBot', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'lobby' || socket.data.playerId !== room.hostId) return;
    addBot(room);
    broadcastState(room);
  });

  onSafe(socket, 'removeBot', ({ botId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'lobby' || socket.data.playerId !== room.hostId) return;
    const bot = findPlayer(room, botId);
    if (!bot || !bot.isBot) return;
    room.players = room.players.filter((p) => p.id !== botId);
    broadcastState(room);
  });

  onSafe(socket, 'updateSets', (sets) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'lobby' || socket.data.playerId !== room.hostId) return;
    SET_KEYS.forEach((k) => { if (typeof sets[k] === 'boolean') room.settings.sets[k] = sets[k]; });
    if (!activeSetKeys(room).length) room.settings.sets.base = true;
    broadcastState(room);
  });

  onSafe(socket, 'startGame', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'lobby' || socket.data.playerId !== room.hostId) return;
    if (room.players.length < 1 || room.players.length > MAX_PLAYERS) return;
    startGame(room);
    broadcastState(room);
  });

  onSafe(socket, 'resetGame', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.playerId !== room.hostId) return;
    room.phase = 'lobby';
    room.turnPhase = null;
    room.combat = null;
    zaubercouchZuruecksetzen(room);
    room.pendingConsequence = null;
    room.winner = null;
    room.revealedDoorCard = null;
    log(room, 'Zurück zur Lobby.');
    broadcastState(room);
  });

  // --- Spielzüge ---
  onSafe(socket, 'drawDoor', () => act(socket, (room, pid) => handleDrawDoor(room, pid)));
  onSafe(socket, 'takeRevealedDoor', () => act(socket, (room, pid) => handleTakeRevealedDoor(room, pid)));
  onSafe(socket, 'ackConsequence', () => act(socket, (room, pid) => handleAckConsequence(room, pid)));
  onSafe(socket, 'applyConsequenceAction', (action) => act(socket, (room, pid) => handleApplyConsequenceAction(room, pid, action)));
  onSafe(socket, 'resolveConsequenceChoice', ({ optionId }) => act(socket, (room, pid) => handleResolveConsequenceChoice(room, pid, optionId)));
  onSafe(socket, 'useCardPower', ({ cardId }) => act(socket, (room, pid) => handleUseCardPower(room, pid, cardId)));
  onSafe(socket, 'resolveCardChoice', ({ optionId }) => act(socket, (room, pid) => handleResolveCardChoice(room, pid, optionId)));
  onSafe(socket, 'resolveCardTarget', ({ targetId }) => act(socket, (room, pid) => handleResolveCardTarget(room, pid, targetId)));
  onSafe(socket, 'resolveCardCardChoice', ({ cardId }) => act(socket, (room, pid) => handleResolveCardCardChoice(room, pid, cardId)));
  onSafe(socket, 'useGuaranteedFlee', ({ cardId }) => act(socket, (room, pid) => handleUseGuaranteedFlee(room, pid, cardId)));
  onSafe(socket, 'playMonsterFromHand', ({ cardId }) => act(socket, (room, pid) => handlePlayMonsterFromHand(room, pid, cardId)));
  onSafe(socket, 'playCurseFromHand', ({ cardId, targetId }) => act(socket, (room, pid) => handlePlayCurseFromHand(room, pid, cardId, targetId)));
  onSafe(socket, 'skipToLoot', () => act(socket, (room, pid) => handleSkipToLoot(room, pid)));
  onSafe(socket, 'lootRoom', () => act(socket, (room, pid) => handleLootRoom(room, pid)));
  onSafe(socket, 'setCombatModifier', ({ who, value }) => act(socket, (room, pid) => handleSetCombatModifier(room, pid, who, value)));
  onSafe(socket, 'playCombatCard', ({ cardId }) => act(socket, (room, pid) => handlePlayCombatCard(room, pid, cardId)));
  onSafe(socket, 'useClassCombatDiscard', ({ cardId }) => act(socket, (room, pid) => handleUseClassCombatDiscard(room, pid, cardId)));
  onSafe(socket, 'proposeTrade', ({ toId, offerCardIds }) => act(socket, (room, pid) => handleProposeTrade(room, pid, toId, offerCardIds)));
  onSafe(socket, 'cancelTrade', ({ tradeId }) => act(socket, (room, pid) => handleCancelTrade(room, pid, tradeId)));
  onSafe(socket, 'respondTrade', ({ tradeId, accept, counterCardIds }) => act(socket, (room, pid) => handleRespondTrade(room, pid, tradeId, accept, counterCardIds)));
  onSafe(socket, 'requestHelp', ({ targetId, reward }) => act(socket, (room, pid) => handleRequestHelp(room, pid, targetId, reward)));
  onSafe(socket, 'respondHelp', ({ accept }) => act(socket, (room, pid) => handleRespondHelp(room, pid, accept)));
  onSafe(socket, 'bardeVerzaubern', ({ cardId, targetId }) => act(socket, (room, pid) => handleBardeVerzaubern(room, pid, cardId, targetId)));
  onSafe(socket, 'setCombatReady', ({ ready }) => act(socket, (room, pid) => handleSetCombatReady(room, pid, ready !== false)));
  onSafe(socket, 'answerZaubercouch', ({ benutzen }) => act(socket, (room, pid) => handleAnswerZaubercouch(room, pid, benutzen === true)));
  onSafe(socket, 'evaluateCombat', () => act(socket, (room, pid) => handleEvaluateCombat(room, pid)));
  onSafe(socket, 'attemptFlee', ({ modifier }) => act(socket, (room, pid) => handleAttemptFlee(room, pid, modifier)));
  onSafe(socket, 'fleeReroll', ({ cardId }) => act(socket, (room, pid) => handleFleeReroll(room, pid, cardId === undefined ? null : cardId)));
  onSafe(socket, 'fleeEscape', ({ cardId }) => act(socket, (room, pid) => handleFleeEscape(room, pid, cardId)));
  onSafe(socket, 'useLamp', ({ cardId, monsterId }) => act(socket, (room, pid) => handleUseLamp(room, pid, cardId, monsterId)));
  onSafe(socket, 'playReactionCard', ({ cardId, value }) => act(socket, (room, pid) => handlePlayReactionCard(room, pid, cardId, value)));
  onSafe(socket, 'passReaction', () => act(socket, (room, pid) => handlePassReaction(room, pid)));
  onSafe(socket, 'playTrojaner', ({ cardId }) => act(socket, (room, pid) => handlePlayTrojaner(room, pid, cardId)));
  onSafe(socket, 'enchantMonster', () => act(socket, (room, pid) => handleEnchantMonster(room, pid)));
  onSafe(socket, 'thiefBackstab', ({ cardId, targetId }) => act(socket, (room, pid) => handleThiefBackstab(room, pid, cardId, targetId)));
  onSafe(socket, 'thiefSteal', ({ cardId, targetId }) => act(socket, (room, pid) => handleThiefSteal(room, pid, cardId, targetId)));
  onSafe(socket, 'priestResurrect', ({ pile }) => act(socket, (room, pid) => handlePriestResurrect(room, pid, pile)));
  onSafe(socket, 'equipItem', ({ cardId }) => act(socket, (room, pid) => handleEquipItem(room, pid, cardId)));
  onSafe(socket, 'unequipItem', ({ cardId }) => act(socket, (room, pid) => handleUnequipItem(room, pid, cardId)));
  onSafe(socket, 'playCheat', ({ cheatCardId, targetItemId }) => act(socket, (room, pid) => handlePlayCheat(room, pid, cheatCardId, targetItemId)));
  onSafe(socket, 'resolveMultiCardSelection', ({ cardIds, deck }) => act(socket, (room, pid) => handleResolveMultiCardSelection(room, pid, cardIds, deck)));
  onSafe(socket, 'sellItems', ({ cardIds }) => act(socket, (room, pid) => handleSellItems(room, pid, cardIds)));
  onSafe(socket, 'attachCard', ({ attachCardId, targetItemId }) => act(socket, (room, pid) => handleAttachCard(room, pid, attachCardId, targetItemId)));
  onSafe(socket, 'playRaceOrClass', ({ cardId }) => act(socket, (room, pid) => handlePlayRaceOrClass(room, pid, cardId)));
  onSafe(socket, 'discardFromHand', ({ cardId }) => act(socket, (room, pid) => handleDiscardFromHand(room, pid, cardId)));
  onSafe(socket, 'endTurn', () => act(socket, (room, pid) => handleEndTurnAction(room, pid)));
  onSafe(socket, 'prepReady', ({ ready }) => act(socket, (room, pid) => handlePrepReady(room, pid, ready)));

  onSafe(socket, 'disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.spectatorId) {
      const spec = room.spectators.find((s) => s.id === socket.data.spectatorId);
      if (spec) {
        spec.connected = false;
        log(room, `${spec.name} (Zuschauer:in) hat die Verbindung verloren.`);
        broadcastState(room);
      }
      return;
    }
    const player = findPlayer(room, socket.data.playerId);
    if (!player) return;
    player.connected = false;
    log(room, `${player.name} hat die Verbindung verloren.`);
    // Offene Reaktionsfenster warten sonst ewig auf jemanden, der nicht mehr
    // am Geraet ist - dieselbe Regel wie in reactionHolders (Getrennte
    // oeffnen gar kein Fenster) und advanceCardActionQueue (Getrennte werden
    // uebersprungen).
    loeseReaktionsfensterOhne(room, player.id);
    pruefeVorbereitungFertig(room);
    broadcastState(room);
  });
});

function act(socket, fn) {
  const room = rooms.get(socket.data.roomCode);
  if (!room || room.phase !== 'playing') return;
  const pid = socket.data.playerId;
  if (!pid) return;
  fn(room, pid);
  broadcastState(room);
}

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Munchkin läuft auf Port ${PORT}`);
    console.log(`Lokal öffnen unter: http://localhost:${PORT}`);
  });
}

module.exports = {
  shuffle, ALL_CARDS, CARDS_BY_ID, SET_KEYS, MIN_PLAYERS, MAX_PLAYERS, MAX_LEVEL, HAND_LIMIT,
  buildDecks, DEAKTIVIERTE_KARTEN, handlePlayMonsterFromHand, handleSkipToLoot, handleLootRoom,
  parseAutoConsequence, isMonsterEnhancerCard, resolveConsequenceSpec, CONSEQUENCE_OVERRIDES,
  DOOR_OTHER_AS_CURSE, isInstantLevelUpCard, TREASURE_POWER_OVERRIDES,
  parseCombatPotion, isCombatPotionCard, COMBAT_POTION_OVERRIDES,
  TREASURE_POWER_CARD_NAMES, COMBAT_POTION_CARD_NAMES,
  // publicState/createRoom: damit tests/card-clerical-ui.test.js die echte
  // Nutzlast pruefen kann, die der Client bekommt - nicht nur die Tabellen,
  // aus denen sie gebaut wird.
  publicState, createRoom,
  POWER_GROUP_NAMES, GUARANTEED_FLEE_CARDS, ITEM_CONDITIONAL_BONUS,
  TRAIT_DOOR_CARDS, MONSTER_SEES_AS_RACE, RACE_ITEM_BONUS, FLEE_AUTOMATIC_BY_RACE,
  handlePlayRaceOrClass, raceItemBonusSum, monsterSeesRace, fleeIsAutomatic,
  monsterVictoryExtras, baseStrength,
  monsterRefusesTarget, monsterPassOption, fleeModifierParts, monsterTraitBonusSum,
  istGeschlecht, GENDER_IMMUNE_ITEMS, pruefeSlipperVerlust, handleEquipItem,
  applyCombatPotionAction, combatHasUndead, addActiveCurse, curseCombatModifier,
  aktiveEnhancers, enhancerBonusEintrag, enhancerBonusSumme, enhancerTreasureSumme, enhancerKartenIds,
  handleAttachCard, attachmentIds, attachmentBonusSum, istGrosserGegenstand, backstabMalus,
  canCarryAnotherBigItem, applyPrimitiveAction, fluchZiel, ROLL_REROLL_CARDS,
  rollWithWindow, handlePlayReactionCard, ITEM_GRANTS_TRAIT, itemGrantsTrait,
  dryadeWirkung, hasenWurf, startCombat, applyTargetAction, handlePlayCurseFromHand,
  kartenSperreAktiv,
  ATTACHMENT_CARDS, equippedBonusSum, handItemIds, waffenIds,
  handleDrawDoor, handleTakeRevealedDoor, handleEvaluateCombat, resolveCombat, handleAttemptFlee, baseStrength,
  handlePrepReady, darfAusruesten,
  handleFleeReroll, botFleeRerollCard, handleFleeEscape, handleEnchantMonster, enchantInfo,
  POST_FLEE_ESCAPE_CARDS, DOOR_COMBAT_CARDS, handleSellItems, halblingSaleOpen, endTurn, handleResolveMultiCardSelection,
  handleApplyConsequenceAction, handleRequestHelp, handleUseGuaranteedFlee, handlePlayCurseFromHand,
  CURSE_PROOF_ITEMS, MONSTER_REFUSES, MONSTER_REFUSES_TREASURE, MONSTER_TRAIT_BONUS, MONSTER_IGNORES_LEVEL,
  SPECIAL_SLOT_ITEMS, SPECIAL_SLOTS, newEquipped, handleEquipItem, handleUnequipItem, equippedItemIds,
  handlePlayCheat, handleRespondHelp, resolveCombatWin, applyPrimitiveAction,
  MONSTER_AUTO_KILL_BY_RACE, MONSTER_PASS_OPTION, handleResolveCardChoice,
  playerQueueFrom, openQueuedCardAction, advanceCardActionQueue, resolveBotCardAction,
  handleResolveCardTarget, handleResolveCardCardChoice,
  MONSTER_IGNORES_BONUSES, MONSTER_FORBIDS_HELP, FLEE_ITEM_BONUS, FLEE_MONSTER_MOD,
  FLEE_IMPOSSIBLE, FLEE_AUTOMATIC, FLEE_PENALTY, FLEE_TREASURE_ITEMS,
  MONSTER_EXTRA_LEVEL, FIRE_ITEMS, GUARANTEED_FLEE_MAX_MONSTER_LEVEL,
  combatTotals, handLimit, hasRace, hasClass,
  CLASS_COMBAT_DISCARD, CLASS_FLEE_DISCARD, UNDEAD_MONSTERS,
  handleUseClassCombatDiscard, classCombatPowerInfo, combatSignature,
  bardenVerzauberInfo, handleBardeVerzaubern,
  handleThiefBackstab, handleThiefSteal, thiefPowerInfo,
  handlePriestResurrect, priestResurrectPiles,
  handleSetCombatReady, combatReadyRequired, combatAllReady, refreshCombatReady,
  handleSetCombatModifier, handlePlayCombatCard,
  handleProposeTrade, handleCancelTrade, handleRespondTrade, tradableCardIds,
  BIG_ITEMS, isBigItem, bigItemCount, canCarryAnotherBigItem,
  ROLL_REACTION_CARDS, ESCAPE_REACTION_CARDS, reactionHolders, rollWithWindow,
  handlePlayReactionCard, handlePassReaction, loeseReaktionsfensterOhne, LAMP_CARDS, lampCardIds, handleUseLamp,
  fluechtenderId, naechsterFluechtling, beendeFluchtphase,
  handleUseCardPower, DOOR_POWER_CARDS,
  LINGERING_CURSES, addActiveCurse, clearActiveCurseByKind, applyLingeringRule,
  curseCombatModifier, curseSuppressesItemBonuses, curseHidesHandItems, hatHilfeSperre, hatSchatzSperre,
  hatKampfschatzSperre, hatUntotenAngst, cursedItemIds, unequipSlotCard, ownTradeIds,
  clearNextCombatCurses, COMBAT_REACTION_CARDS, TREASURE_REACTION_CARDS, applyCombatReaction, handleAckConsequence, setzeZugphase,
  zieheSchaetzeFuer, handleResolveConsequenceChoice,
  autoApplyLossConsequence,
  COMBAT_START_OPTIONS, COMBAT_START_COST, STAFF_ITEMS, combatStartOptionRule,
  scheduleBotActionsIfNeeded,
  handleAnswerZaubercouch,
  handlePlayTrojaner,
};
