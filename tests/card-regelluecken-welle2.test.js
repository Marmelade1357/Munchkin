// Regellücken Welle 2 (Spec 2026-09-22-regelluecken-welle2-design.md):
// Touristenfalle, Hungriger Rucksack, Temporäre Anmnesie, Gummi-Golem.
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
    code: 'TEST', players, turnIndex: 0, turnPhase: 'aerger', combatHappenedThisTurn: false,
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

// --- TOURISTENFALLE: "Du darfst nicht 'Auf Ärger aus sein'. Dieser Fluch
// bleibt bestehen, bis du einem anderen Spieler geholfen hast, einen Kampf zu
// gewinnen."
{
  const falle = findCard('TOURISTENFALLE').id;
  const monster = findCard('LAHMER GOBLIN', 'monster');
  const p = makePlayer({ hand: [monster.id] });
  const room = makeRoom([p, makePlayer({ id: 'p2', name: 'B' })]);
  S.addActiveCurse(room, p, 'TOURISTENFALLE', falle);
  assert.ok(p.activeCurses.some((f) => f.kind === 'keinAergerSuchen'), 'Fluch ist eingetragen');
  S.handlePlayMonsterFromHand(room, 'p1', monster.id);
  assert.strictEqual(room.combat, null, 'kein Kampf: "Auf Ärger aus sein" ist gesperrt');
  assert.ok(p.hand.includes(monster.id), 'das Monster bleibt auf der Hand');
  assert.ok(room.logs.some((l) => /Touristenfalle/i.test(l.text)), 'der Verlauf nennt den Grund');
}
// Gegenprobe: ohne Fluch startet der Kampf.
{
  const monster = findCard('LAHMER GOBLIN', 'monster');
  const p = makePlayer({ hand: [monster.id] });
  const room = makeRoom([p, makePlayer({ id: 'p2', name: 'B' })]);
  S.handlePlayMonsterFromHand(room, 'p1', monster.id);
  assert.ok(room.combat, 'ohne Fluch beginnt der Kampf');
}
// Ende: nur ein Sieg als HELFENDE Person beendet den Fluch.
{
  const falle = findCard('TOURISTENFALLE').id;
  const monster = findCard('LAHMER GOBLIN', 'monster');
  const a = makePlayer({ id: 'p1', name: 'A', level: 9 });
  const h = makePlayer({ id: 'p2', name: 'B' });
  const room = makeRoom([a, h]);
  S.addActiveCurse(room, h, 'TOURISTENFALLE', falle);
  S.startCombat(room, 'p1', [monster.id], { fromHand: false });
  room.combat.helperId = 'p2';
  S.resolveCombatWin(room);
  assert.ok(!h.activeCurses.some((f) => f.kind === 'keinAergerSuchen'), 'Sieg als Hilfe beendet den Fluch');
}
{
  const falle = findCard('TOURISTENFALLE').id;
  const monster = findCard('LAHMER GOBLIN', 'monster');
  const a = makePlayer({ id: 'p1', name: 'A', level: 9 });
  const room = makeRoom([a, makePlayer({ id: 'p2', name: 'B' })]);
  S.addActiveCurse(room, a, 'TOURISTENFALLE', falle);
  S.startCombat(room, 'p1', [monster.id], { fromHand: false });
  S.resolveCombatWin(room);
  assert.ok(a.activeCurses.some((f) => f.kind === 'keinAergerSuchen'), 'der eigene Sieg beendet den Fluch nicht');
}

// --- TEMPORÄRE ANMNESIE: "Bis dahin wirst du überall als klassenloser Mensch
// gezählt." Ende: ein gewonnener Kampf, an dem die Person beteiligt war.
{
  const anmnesie = findCard('TEMPORÄRE ANMNESIE').id;
  const elf = findCard('ELF', 'race').id;
  const krieger = findCard('KRIEGER', 'class').id;
  const p = makePlayer({ races: [elf], classes: [krieger] });
  const room = makeRoom([p]);
  assert.ok(S.hasRace(p, 'ELF') && S.hasClass(p, 'KRIEGER'), 'Testvoraussetzung');
  S.addActiveCurse(room, p, 'TEMPORÄRE ANMNESIE', anmnesie);
  assert.ok(!S.hasRace(p, 'ELF'), 'Rasse vergessen');
  assert.ok(!S.hasClass(p, 'KRIEGER'), 'Klasse vergessen');
  assert.deepStrictEqual([p.races.length, p.classes.length], [1, 1], 'die Karten bleiben ausliegen');
  // Monsterbonus gegen Elfen greift nicht mehr.
  const sauger = findCard('GESICHTSSAUGER', 'monster');
  S.startCombat(room, 'p1', [sauger.id], { fromHand: false });
  assert.strictEqual(S.combatTotals(room).monsterStrength, sauger.level, '"+6 gegen Elfen" zaehlt nicht mehr');
  room.combat = null;
}
// Ein Gegenstand, der eine Klasse verleiht, zaehlt ebenfalls nicht.
{
  const anmnesie = findCard('TEMPORÄRE ANMNESIE').id;
  const ohren = findCard('FALSCHE OHREN');
  const p = makePlayer();
  p.equipped.special = [ohren.id];
  const room = makeRoom([p]);
  assert.ok(S.monsterSeesRace(p, 'ELF'), 'Testvoraussetzung: Falsche Ohren machen zum Elfen');
  S.addActiveCurse(room, p, 'TEMPORÄRE ANMNESIE', anmnesie);
  assert.ok(!S.monsterSeesRace(p, 'ELF'), 'auch geliehene Rassen sind vergessen');
}
// Ende: gewonnener Kampf, kaempfend ODER helfend.
{
  const anmnesie = findCard('TEMPORÄRE ANMNESIE').id;
  const monster = findCard('LAHMER GOBLIN', 'monster');
  const ende = (alsHelfer) => {
    const a = makePlayer({ id: 'p1', name: 'A', level: 9 });
    const h = makePlayer({ id: 'p2', name: 'B' });
    const room = makeRoom([a, h]);
    const opfer = alsHelfer ? h : a;
    S.addActiveCurse(room, opfer, 'TEMPORÄRE ANMNESIE', anmnesie);
    S.startCombat(room, 'p1', [monster.id], { fromHand: false });
    if (alsHelfer) room.combat.helperId = 'p2';
    S.resolveCombatWin(room);
    return !opfer.activeCurses.some((f) => f.kind === 'traitsVergessen');
  };
  assert.ok(ende(false), 'eigener Sieg beendet die Anmnesie');
  assert.ok(ende(true), 'Sieg als Hilfe beendet die Anmnesie');
}

// --- HUNGRIGER RUCKSACK: "Am Ende jedes deiner Zuege wuerfelst du, bevor
// 'Milde Gabe' verteilt oder abgelegt wird ... Bei einer gewuerfelten 6
// verschluckt der Rucksack sich selbst und verschwindet."
{
  const rucksack = findCard('HUNGRIGER RUCKSACK').id;
  const handKarten = ALL_CARDS.filter((c) => c.type === 'treasure').slice(0, 4).map((c) => c.id);
  const wurf = (zahl) => {
    const p = makePlayer({ hand: handKarten.slice() });
    const room = makeRoom([p], { turnPhase: 'pluendern' });
    S.addActiveCurse(room, p, 'HUNGRIGER RUCKSACK', rucksack);
    const zufall = Math.random;
    Math.random = () => (zahl - 1) / 6 + 0.01; // rollDie() -> zahl
    try { S.setzeZugphase(room, 'gabe'); } finally { Math.random = zufall; }
    return { p, room };
  };
  const zwei = wurf(2);
  assert.strictEqual(zwei.p.hand.length, 2, 'Wurf 2: zwei Handkarten gefressen');
  assert.strictEqual(zwei.room.treasureDiscard.length, 2, 'die Karten liegen auf dem Ablagestapel');
  assert.ok(zwei.p.activeCurses.some((f) => f.kind === 'hungrigerRucksack'), 'der Fluch bleibt');

  const sechs = wurf(6);
  assert.strictEqual(sechs.p.hand.length, 4, 'Wurf 6: die Hand bleibt unversehrt');
  assert.ok(!sechs.p.activeCurses.some((f) => f.kind === 'hungrigerRucksack'), 'Wurf 6: der Fluch endet');
}
// Nur einmal pro Zug, und nur im Zug der verfluchten Person.
{
  const rucksack = findCard('HUNGRIGER RUCKSACK').id;
  const handKarten = ALL_CARDS.filter((c) => c.type === 'treasure').slice(0, 4).map((c) => c.id);
  const zufall = Math.random;
  const p = makePlayer({ hand: handKarten.slice() });
  const room = makeRoom([p, makePlayer({ id: 'p2', name: 'B' })], { turnPhase: 'pluendern' });
  S.addActiveCurse(room, p, 'HUNGRIGER RUCKSACK', rucksack);
  Math.random = () => 0.01; // rollDie() -> 1
  try {
    S.setzeZugphase(room, 'gabe');
    S.setzeZugphase(room, 'gabe'); // zweiter Uebergang im selben Zug
  } finally { Math.random = zufall; }
  assert.strictEqual(p.hand.length, 3, 'der Wurf faellt pro Zug nur einmal');

  const fremd = makePlayer({ id: 'p2', name: 'B', hand: handKarten.slice() });
  const room2 = makeRoom([makePlayer({ id: 'p1', name: 'A' }), fremd], { turnPhase: 'pluendern', turnIndex: 0 });
  S.addActiveCurse(room2, fremd, 'HUNGRIGER RUCKSACK', rucksack);
  Math.random = () => 0.01;
  try { S.setzeZugphase(room2, 'gabe'); } finally { Math.random = zufall; }
  assert.strictEqual(fremd.hand.length, 4, 'im fremden Zug frisst der Rucksack nicht');
}

// --- GUMMI-GOLEM: "Du musst in jedem Kampf deine Hilfe anbieten, darfst
// keinen Schatz annehmen, bis du einen verlierst." Nutzerentscheidung
// 2026-09-23: "einen verlierst" bezieht sich auf einen KAMPF, nicht auf eine
// Schatzkarte - die Sperre endet ueber beendeFluchtphase (server.js), nicht
// beim Lesen einer geschrumpften Hand.
{
  const golem = findCard('GUMMI-GOLEM', 'monster');
  const schatz = findCard('FLAMMENDER GIFTTRANK').id;
  const p = makePlayer({ hand: [schatz] });
  const room = makeRoom([p, makePlayer({ id: 'p2', name: 'B' })]);
  S.addActiveCurse(room, p, 'GUMMI-GOLEM', golem.id);
  const eintrag = p.activeCurses.find((f) => f.kind === 'zuckerschock');
  assert.ok(eintrag, 'Zuckerschock ist eingetragen');
  assert.ok(eintrag.hinweis && /Hilfe anbieten/.test(eintrag.hinweis), 'Hinweistext nennt die Hilfe-Pflicht');
  assert.ok(S.hatSchatzSperre(p), 'kein Schatz, solange der Fluch laeuft');
  assert.deepStrictEqual(S.zieheSchaetzeFuer(room, p, 2), [], 'es wird kein Schatz gezogen');

  // Verlorene Schatzkarte allein beendet die Sperre NICHT (anders als in
  // einer frueheren Fassung dieser Datei).
  p.hand = [];
  assert.ok(S.hatSchatzSperre(p), 'Schatzverlust allein beendet die Sperre nicht');
  assert.ok(p.activeCurses.some((f) => f.kind === 'zuckerschock'), 'der Fluch steht noch');

  // Ende: ein verlorener Kampf (fehlgeschlagene Flucht).
  const goblin = findCard('LAHMER GOBLIN', 'monster');
  const c = { actorId: 'p1', monsterIds: [goblin.id], helperId: null, enhancers: [], fleeFailed: ['p1'], mustFlee: false };
  room.combat = c;
  S.beendeFluchtphase(room, c);
  assert.ok(!S.hatSchatzSperre(p), 'nach dem Kampfverlust endet die Sperre');
  assert.ok(!p.activeCurses.some((f) => f.kind === 'zuckerschock'), 'der Fluch ist beendet');
}
// Ein gewonnener Kampf beendet den Fluch NICHT.
{
  const golem = findCard('GUMMI-GOLEM', 'monster');
  const goblin = findCard('LAHMER GOBLIN', 'monster');
  const p = makePlayer();
  const room = makeRoom([p]);
  S.addActiveCurse(room, p, 'GUMMI-GOLEM', golem.id);
  S.startCombat(room, 'p1', [goblin.id], { fromHand: false });
  S.resolveCombatWin(room);
  assert.ok(p.activeCurses.some((f) => f.kind === 'zuckerschock'), 'ein gewonnener Kampf laesst den Fluch stehen');
}
// Verliert die Person GENAU gegen einen zweiten Gummi-Golem, ersetzt der neue
// Fluch den alten (nicht: der neue loescht sich selbst wieder). Pin fuer die
// Reihenfolge in beendeFluchtphase - die Loeschung muss VOR
// oeffneVerlustKonsequenz laufen, sonst wuerde dieser Test bei vertauschter
// Reihenfolge trotzdem gruen bleiben (der urspruengliche Fluch bliebe einfach
// stehen), obwohl der Bug (frischer Fluch loescht sich selbst) real waere.
{
  const golem = findCard('GUMMI-GOLEM', 'monster');
  const p = makePlayer();
  const room = makeRoom([p]);
  S.addActiveCurse(room, p, 'GUMMI-GOLEM', golem.id); // alter Fluch, z.B. aus einer frueheren Begegnung
  const c = { actorId: 'p1', monsterIds: [golem.id], helperId: null, enhancers: [], fleeFailed: ['p1'], mustFlee: false };
  room.combat = c;
  S.beendeFluchtphase(room, c);
  assert.ok(p.activeCurses.some((f) => f.kind === 'zuckerschock'), 'der neue Zuckerschock aus DIESEM verlorenen Kampf steht noch');
}
// Hilfe anbieten: Logzeile bei Kampfbeginn, Trust-Prinzip - die um Hilfe
// gebetene Person unter Zuckerschock darf trotzdem ablehnen ("Keiner muss
// deine Hilfe annehmen, aber du musst sie anbieten" beschreibt nur die
// EIGENE Pflicht anzubieten, nicht die Pflicht anderer, immer zu helfen).
{
  const golem = findCard('GUMMI-GOLEM', 'monster');
  const monster = findCard('LAHMER GOBLIN', 'monster');
  const a = makePlayer({ id: 'p1', name: 'A' });
  const h = makePlayer({ id: 'p2', name: 'B' });
  const room = makeRoom([a, h]);
  S.addActiveCurse(room, h, 'GUMMI-GOLEM', golem.id);
  S.startCombat(room, 'p1', [monster.id], { fromHand: false });
  assert.ok(room.logs.some((l) => /Zuckerschock/i.test(l.text) && /Hilfe/i.test(l.text)), 'das Angebot steht im Verlauf');
  S.handleRequestHelp(room, 'p1', 'p2', 0);
  S.handleRespondHelp(room, 'p2', false); // Ablehnen
  assert.strictEqual(room.combat.helperId, null, 'wer im Zuckerschock ist, darf trotzdem ablehnen (Trust-Prinzip)');
}

// --- RIESENKAKERLAKE "+5 gegen Elfen oder Menschen": ein Halb-Blut-Elf hat
// laut Karte keine Nachteile seiner Rasse - und ist auch kein Mensch.
{
  const kakerlake = findCard('RIESENKAKERLAKE', 'monster');
  const elf = findCard('ELF', 'race').id;
  const halbBlut = findCard('HALB-BLUT').id;
  const staerke = (p) => {
    const room = makeRoom([p]);
    S.startCombat(room, p.id, [kakerlake.id], { fromHand: false });
    const wert = S.combatTotals(room).monsterStrength;
    room.combat = null;
    return wert;
  };
  assert.strictEqual(staerke(makePlayer({ races: [elf] })), kakerlake.level + 5, 'Gegenprobe: echter Elf bekommt +5 ab');
  assert.strictEqual(staerke(makePlayer({ races: [elf], raceCapCard: halbBlut })), kakerlake.level, 'Halb-Blut-Elf: kein Bonus');
  assert.strictEqual(staerke(makePlayer({})), kakerlake.level + 5, 'Mensch bekommt weiter +5 ab');
}

// --- Der WUNSCHRING ("Beendet jeden Fluch") beendet jeden der vier neuen.
{
  const ring = findCard('WUNSCHRING');
  [['TOURISTENFALLE', 'keinAergerSuchen'], ['TEMPORÄRE ANMNESIE', 'traitsVergessen'],
    ['HUNGRIGER RUCKSACK', 'hungrigerRucksack'], ['GUMMI-GOLEM', 'zuckerschock']].forEach(([name, kind]) => {
    const quelle = findCard(name);
    const p = makePlayer({ hand: [ring.id] });
    const room = makeRoom([p]);
    S.addActiveCurse(room, p, name, quelle.id);
    assert.ok(p.activeCurses.some((f) => f.kind === kind), `${name}: Fluch eingetragen`);
    S.handleUseCardPower(room, 'p1', ring.id);
    if (room.pendingCardAction && room.pendingCardAction.options) {
      S.handleResolveCardChoice(room, 'p1', room.pendingCardAction.options[0].id);
    }
    assert.ok(!p.activeCurses.some((f) => f.kind === kind), `${name}: der Wunschring beendet ihn`);
  });
}

// --- Review-Fund 1: istMensch (src/cards/passives.js) las p.races direkt und
// ignorierte TEMPORÄRE ANMNESIE. Verflucht gilt "ueberall als klassenloser
// Mensch" - RIESENKAKERLAKE ("+5 gegen Elfen oder Menschen") und GRASGNOLL
// ("+5 gegen Menschen") muessen also trotz Elfen-Karten auf dem Tisch greifen.
{
  const elf = findCard('ELF', 'race').id;
  const anmnesie = findCard('TEMPORÄRE ANMNESIE').id;
  const staerkeGegen = (monsterCard) => {
    const p = makePlayer({ races: [elf] });
    const room = makeRoom([p]);
    S.addActiveCurse(room, p, 'TEMPORÄRE ANMNESIE', anmnesie);
    S.startCombat(room, p.id, [monsterCard.id], { fromHand: false });
    const wert = S.combatTotals(room).monsterStrength;
    room.combat = null;
    return wert;
  };
  const kakerlake = findCard('RIESENKAKERLAKE', 'monster');
  assert.strictEqual(staerkeGegen(kakerlake), kakerlake.level + 5, 'verfluchter Elf zaehlt der Kakerlake als Mensch');
  const grasgnoll = findCard('GRASGNOLL', 'monster');
  assert.strictEqual(staerkeGegen(grasgnoll), grasgnoll.level + 5, 'verfluchter Elf zaehlt dem Grasgnoll als Mensch');
}

// --- Review-Fund 2: drei weitere Direktzugriffe auf player.races/classes
// umgehen die Anmnesie - jetzt ueber hasRace/hasClass bzw. hatFluchArt.
{
  // raceItemBonusSum: Gnom-Bonus zaehlt fuer einen Verfluchten nicht mehr.
  const gnom = findCard('GNOM', 'door_other');
  const anmnesie = findCard('TEMPORÄRE ANMNESIE').id;
  const g = findCard('GHOULPEITSCHE');
  const p = makePlayer({ races: [gnom.id] });
  p.equipped.hands = [g.id, null];
  assert.strictEqual(S.raceItemBonusSum(p), 1, 'Testvoraussetzung: Gnom-Bonus greift normal');
  const room = makeRoom([p]);
  S.addActiveCurse(room, p, 'TEMPORÄRE ANMNESIE', anmnesie);
  assert.strictEqual(S.raceItemBonusSum(p), 0, 'verflucht: kein Gnom-Bonus mehr');
}
{
  // fleeIsAutomatic: automatische Flucht vor "Nase"-Monstern entfaellt.
  const gnom = findCard('GNOM', 'door_other');
  const anmnesie = findCard('TEMPORÄRE ANMNESIE').id;
  const nase = findCard('LAUFENDE NASE', 'monster');
  const p = makePlayer({ races: [gnom.id] });
  const room = makeRoom([p]);
  room.combat = { actorId: p.id, monsterIds: [nase.id] };
  assert.ok(S.fleeIsAutomatic(room, p), 'Testvoraussetzung: Gnom entkommt automatisch');
  S.addActiveCurse(room, p, 'TEMPORÄRE ANMNESIE', anmnesie);
  assert.ok(!S.fleeIsAutomatic(room, p), 'verflucht: keine automatische Flucht mehr');
}
{
  // dryadeWirkung: ein verfluchter "Zauberer" gilt nicht mehr als Zauberer,
  // die Dryade darf ihm die Klasse nicht wegnehmen.
  const zauberer = findCard('ZAUBERER', 'class');
  const anmnesie = findCard('TEMPORÄRE ANMNESIE').id;
  const dryade = findCard('DRYADE', 'monster');
  const p = makePlayer({ classes: [zauberer.id] });
  const room = makeRoom([p]);
  room.combat = {
    actorId: p.id, helperId: null, monsterIds: [dryade.id],
    actorModifier: 0, monsterModifier: 0, backstabbed: {},
  };
  S.addActiveCurse(room, p, 'TEMPORÄRE ANMNESIE', anmnesie);
  S.dryadeWirkung(room, p);
  assert.deepStrictEqual(p.classes, [zauberer.id], 'die Zauberer-Karte bleibt liegen, kein Verlust');
  assert.ok(!room.logs.some((l) => /Dryade schwaecht/i.test(l.text)), 'kein Log-Eintrag ueber verlorene Klasse');
}

// --- Review-Fund 3 (ueberholt seit der Kampfverlust-Ueberarbeitung 2026-09-23):
// GUMMI-GOLEMs Zuckerschock endet jetzt event-getrieben in beendeFluchtphase
// (clearActiveCurseByKind), nicht mehr beim Lesen einer geschrumpften Hand -
// es gibt also keinen "beim Lesen abgelaufen"-Zustand mehr zu pruefen. Statt
// dessen: publicState zeigt einen noch laufenden Zuckerschock korrekt an.
{
  const golem = findCard('GUMMI-GOLEM', 'monster');
  const p = makePlayer();
  const room = makeRoom([p]);
  S.addActiveCurse(room, p, 'GUMMI-GOLEM', golem.id);
  const state = S.publicState(room);
  assert.ok(state.players[0].activeCurses.some((f) => f.kind === 'zuckerschock'),
    'publicState zeigt den laufenden Zuckerschock an');
}

fertig();
console.log('card-regelluecken-welle2: alle Checks gruen');
