// TROJANISCHER PFERD (Unnatural Axe): Reaktionsfenster nach Kampfsieg. Mit
// Monster: kein Schatz, neuer Kampf gegen genau dieses Monster. Ohne Monster:
// nur Schatzentzug. GUMMI-GOLEMs Zuckerschock wird in
// tests/card-regelluecken-welle2.test.js getestet (dort schon vorhanden).
const assert = require('assert');
const S = require('../server.js');
const { ALL_CARDS, newEquipped } = S;

const findCard = (name, category) => {
  const c = ALL_CARDS.find((x) => x.name === name && (!category || x.category === category));
  if (!c) throw new Error(`Testkarte nicht gefunden: ${name}`);
  return c;
};
function makePlayer(o) {
  return Object.assign({
    id: 'p1', name: 'A', level: 5, hand: [], races: [], classes: [], powerGroups: [],
    raceCapCard: null, classCapCard: null, powerGroupCapCard: null,
    equipped: newEquipped(), attachments: { cheatedItemId: null }, activeCurses: [],
    isBot: false, connected: true, gender: 'm', genderBeiSlippern: null,
  }, o || {});
}
const raeume = [];
function makeRoom(players, extra) {
  const room = Object.assign({
    code: 'TEST', players, turnIndex: 0, turnPhase: 'kampf', combatHappenedThisTurn: true,
    doorDeck: [], doorDiscard: [],
    treasureDeck: ALL_CARDS.filter((c) => c.type === 'treasure').slice(0, 20).map((c) => c.id),
    treasureDiscard: [], itemAttachments: {},
    revealedDoorCard: null, pendingConsequence: null, pendingCardAction: null, pendingRoll: null,
    combat: null, winner: null, logs: [], lastActivity: Date.now(), cleanupTimer: null, botTimer: null,
    settings: { sets: {} },
  }, extra || {});
  raeume.push(room);
  return room;
}
const fertig = () => raeume.forEach((r) => { if (r.cleanupTimer) clearTimeout(r.cleanupTimer); if (r.botTimer) clearTimeout(r.botTimer); });

// --- TROJANISCHER PFERD: Reaktionsfenster nach Kampfsieg. Mit Monster: kein
// Schatz, neuer Kampf gegen genau dieses Monster. Ohne Monster: nur
// Schatzentzug.
{
  const goblin = findCard('LAHMER GOBLIN', 'monster');
  const zweitesMonster = findCard('MR. BONES', 'monster');
  const pferd = findCard('TROJANISCHER PFERD');
  const actor = makePlayer({ id: 'p1', name: 'A' });
  const spieler = makePlayer({ id: 'p2', name: 'B', hand: [pferd.id, zweitesMonster.id] });
  const room = makeRoom([actor, spieler]);
  S.startCombat(room, 'p1', [goblin.id], { fromHand: false });
  S.resolveCombatWin(room);
  assert.ok(room.combat.trojanerOffer && room.combat.trojanerOffer.includes('p2'), 'B haelt die Karte, das Fenster oeffnet sich');
  S.handlePlayTrojaner(room, 'p2', pferd.id);
  assert.ok(!spieler.hand.includes(pferd.id), 'die Karte ist gespielt');
  assert.strictEqual(room.pendingCardAction.kind, 'choice');
  const monsterOption = room.pendingCardAction.options.find((o) => o.id === `mon-${zweitesMonster.id}`);
  assert.ok(monsterOption, 'MR. BONES steht als Wahlmoeglichkeit');
  // Ueber den echten Weg (handleResolveCardChoice) statt applyCombatPotionAction
  // direkt: so faellt auf, wenn 'trojanerMitMonster' mal aus den
  // COMBAT_ACTION_TYPES verschwindet und die Wahl falsch geroutet wird.
  S.handleResolveCardChoice(room, 'p2', monsterOption.id);
  assert.ok(/neuer Kampf/.test(room.logs[room.logs.length - 1].text), 'Log nennt den neuen Kampf');
  assert.ok(!spieler.hand.includes(zweitesMonster.id), 'MR. BONES ist aus Bs Hand verschwunden');
  assert.deepStrictEqual(room.combat.monsterIds, [zweitesMonster.id], 'der neue Kampf laeuft gegen MR. BONES');
  assert.strictEqual(room.combat.actorId, 'p1', 'A muss gegen MR. BONES kaempfen');
  assert.strictEqual(actor.hand.length, 0, 'A hat aus dem ersten Kampf keinen Schatz bekommen');
}
// Ohne Monster: nur Schatzentzug, kein neuer Kampf.
{
  const goblin = findCard('LAHMER GOBLIN', 'monster');
  const pferd = findCard('TROJANISCHER PFERD');
  const actor = makePlayer({ id: 'p1', name: 'A' });
  const spieler = makePlayer({ id: 'p2', name: 'B', hand: [pferd.id] });
  const room = makeRoom([actor, spieler]);
  S.startCombat(room, 'p1', [goblin.id], { fromHand: false });
  S.resolveCombatWin(room);
  S.handlePlayTrojaner(room, 'p2', pferd.id);
  const ohneOption = room.pendingCardAction.options.find((o) => o.id === 'ohne');
  assert.ok(ohneOption, '"Ohne Monster" steht auch ohne Handmonster zur Wahl');
  const action = room._pendingCardActionResolvers[ohneOption.id];
  S.applyCombatPotionAction(room, spieler, action, null);
  assert.strictEqual(room.combat, null, 'kein neuer Kampf ohne Monster');
  assert.strictEqual(actor.hand.length, 0, 'A bekommt keinen Schatz');
}
// Gewinnt der erste Kampf schon das Spiel, startet kein zweiter Kampf.
{
  const goblin = findCard('LAHMER GOBLIN', 'monster');
  const zweitesMonster = findCard('MR. BONES', 'monster');
  const pferd = findCard('TROJANISCHER PFERD');
  const actor = makePlayer({ id: 'p1', name: 'A', level: 9 });
  const spieler = makePlayer({ id: 'p2', name: 'B', hand: [pferd.id, zweitesMonster.id] });
  const room = makeRoom([actor, spieler]);
  S.startCombat(room, 'p1', [goblin.id], { fromHand: false });
  S.resolveCombatWin(room);
  S.handlePlayTrojaner(room, 'p2', pferd.id);
  const monsterOption = room.pendingCardAction.options.find((o) => o.id === `mon-${zweitesMonster.id}`);
  const action = room._pendingCardActionResolvers[monsterOption.id];
  S.applyCombatPotionAction(room, spieler, action, null);
  assert.ok(room.winner, 'Stufe 10 durch den ersten Kampf gewinnt sofort');
  assert.strictEqual(room.combat, null, 'kein zweiter Kampf nach Spielsieg');
}

// --- Passen: die letzte haltende Person sagt ab, der urspruengliche Sieg
// wird ganz normal verbucht (Schatz kommt an).
{
  const goblin = findCard('LAHMER GOBLIN', 'monster');
  const pferd = findCard('TROJANISCHER PFERD');
  const actor = makePlayer({ id: 'p1', name: 'A' });
  const spieler = makePlayer({ id: 'p2', name: 'B', hand: [pferd.id] });
  const room = makeRoom([actor, spieler]);
  S.startCombat(room, 'p1', [goblin.id], { fromHand: false });
  S.resolveCombatWin(room);
  assert.ok(room.combat.trojanerOffer.includes('p2'));
  S.handlePassReaction(room, 'p2');
  assert.strictEqual(room.combat, null, 'der Kampf ist normal zu Ende');
  assert.ok(actor.hand.length > 0 || room.treasureDeck.length === 0, 'A haette normal Schatz bekommen (oder der Stapel ist leer)');
}
// Verbindungsabbruch der einzigen haltenden Person loest das Fenster auf.
{
  const goblin = findCard('LAHMER GOBLIN', 'monster');
  const pferd = findCard('TROJANISCHER PFERD');
  const actor = makePlayer({ id: 'p1', name: 'A' });
  const spieler = makePlayer({ id: 'p2', name: 'B', hand: [pferd.id] });
  const room = makeRoom([actor, spieler]);
  S.startCombat(room, 'p1', [goblin.id], { fromHand: false });
  S.resolveCombatWin(room);
  S.loeseReaktionsfensterOhne(room, 'p2');
  assert.strictEqual(room.combat, null, 'das Fenster loest sich ohne die getrennte Person auf');
}

// --- "Kampf auswerten" waehrend offenem/gerade aufgeloestem Trojaner-Fenster
// ist gesperrt: sonst koennte die kaempfende Person waehrend der laufenden
// Kartenwahl (Karte schon gespielt, trojanerDone=true, aber die Wahl "ohne
// Monster"/"mit Monster" noch offen) einfach nochmal auswerten - resolveCombat
// wuerde dann via finishCombatWin sofort Schatz ziehen, obwohl die
// Trojaner-Reaktion noch gar nicht fertig ist.
{
  const goblin = findCard('LAHMER GOBLIN', 'monster');
  const pferd = findCard('TROJANISCHER PFERD');
  const actor = makePlayer({ id: 'p1', name: 'A' });
  const spieler = makePlayer({ id: 'p2', name: 'B', hand: [pferd.id] });
  const room = makeRoom([actor, spieler]);
  S.startCombat(room, 'p1', [goblin.id], { fromHand: false });
  S.resolveCombatWin(room);
  assert.ok(room.combat.trojanerOffer && room.combat.trojanerOffer.includes('p2'),
    'das Fenster ist offen');
  S.handlePlayTrojaner(room, 'p2', pferd.id);
  assert.strictEqual(room.pendingCardAction.kind, 'choice', 'die Wahl (ohne/mit Monster) steht noch offen');
  assert.ok(room.combat.trojanerDone, 'die Karte ist gespielt, das Fenster gilt als beantwortet');
  const vorherHand = actor.hand.length;
  room.combat.ready = { p2: true }; // "alle bereit", wie es im echten Spiel waere
  S.handleEvaluateCombat(room, 'p1');
  assert.ok(room.combat, 'der Kampf ist waehrend der laufenden Wahl NICHT durchgewunken worden');
  assert.ok(room.pendingCardAction, 'die Wahl steht immer noch offen');
  assert.strictEqual(actor.hand.length, vorherHand, 'kein Schatz durch das erneute Auswerten');
}

// --- Waehrend das Trojaner-Fenster offen ist (oder gerade aufgeloest wird),
// darf niemand mehr in den Kampf eingreifen - sonst liesse sich z.B. ueber
// WANDERNDES MONSTER noch ein zusaetzliches Monster (und damit Stufen/
// Schaetze) in einen schon gewonnenen Kampf nachschieben, bevor die
// Trojaner-Reaktion ueberhaupt entschieden ist.
{
  const goblin = findCard('LAHMER GOBLIN', 'monster');
  const zweitesMonster = findCard('MR. BONES', 'monster');
  const wandernd = findCard('WANDERNDES MONSTER');
  const pferd = findCard('TROJANISCHER PFERD');
  const actor = makePlayer({ id: 'p1', name: 'A', hand: [wandernd.id, zweitesMonster.id] });
  const spieler = makePlayer({ id: 'p2', name: 'B', hand: [pferd.id] });
  const room = makeRoom([actor, spieler]);
  S.startCombat(room, 'p1', [goblin.id], { fromHand: false });
  S.resolveCombatWin(room);
  assert.ok(room.combat.trojanerOffer && room.combat.trojanerOffer.includes('p2'), 'das Fenster ist offen');
  S.handlePlayCombatCard(room, 'p1', wandernd.id);
  assert.ok(actor.hand.includes(wandernd.id), 'WANDERNDES MONSTER bleibt auf der Hand - kein Eingriff waehrend des Fensters');
  assert.deepStrictEqual(room.combat.monsterIds, [goblin.id], 'kein zusaetzliches Monster im Kampf');
}

fertig();
console.log('card-regelluecken-welle5: alle Checks gruen');
