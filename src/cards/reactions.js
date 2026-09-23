// Karten, die auf ein Ereignis REAGIEREN statt aktiv ausgespielt zu werden.
// Sie brauchen ein Zeitfenster, das der Server sonst nirgends hat.
module.exports = () => {
  // "Spiel ihn, nachdem du aus einem beliebigen Grund wuerfeln musstest.
  // Aendere das Wuerfelergebnis so wie du willst. Nur einmal einsetzbar."
  // KATZENINTERVENTION: "Spielbar, nachdem irgendjemand gewuerfelt hat, aus
  // welchem Grund auch immer. Die Katze ist auf den Wuerfel gesprungen ... der
  // Wurf und alle Karten, die gespielt wurden, um ihn zu beeinflussen, sind
  // verloren. Wuerfel nochmal."
  // ponytail: "alle Karten, die gespielt wurden, um ihn zu beeinflussen" ist
  // hier gegenstandslos - das Wurf-Fenster schliesst sich, sobald der
  // GEZINKTE WÜRFEL gespielt wurde, danach ist die Katze gar nicht mehr
  // moeglich. Beide Karten reagieren also auf denselben, unberuehrten Wurf.
  const ROLL_REACTION_CARDS = new Set(['GEZINKTER WÜRFEL', 'KATZENINTERVENTION']);
  // Wer davon wuerfelt neu, statt den Wert zu setzen.
  const ROLL_REROLL_CARDS = new Set(['KATZENINTERVENTION']);
  // "Spiel ihn, nachdem DU ... wuerfeln musstest" - der gezinkte Wuerfel gilt
  // nur fuer den eigenen Wurf. Die KATZENINTERVENTION ausdruecklich nicht
  // ("nachdem irgendjemand gewuerfelt hat").
  const ROLL_REACTION_OWN_ROLL_ONLY = new Set(['GEZINKTER WÜRFEL']);

  // "Einsetzbar, wenn jemand erfolgreich (egal warum) einem Kampf entkommt.
  // Er muss seine Flucht noch einmal wuerfeln, sogar wenn sie das erste Mal
  // automatisch gelungen war. Nur einmal einsetzbar."
  const ESCAPE_REACTION_CARDS = new Set(['KLEBERFLÄSCHCHEN']);

  // Tuerkarten mit aktiver Sonderkraft. handleUseCardPower kennt bisher nur
  // Schatzkarten - diese Tabelle oeffnet denselben Weg fuer Tuerkarten.
  const DOOR_POWER_CARDS = {
    // "Alle Priester steigen sofort 1 Stufe auf. Dies darf die Siegesstufe
    // sein." Kartenname in den Rohdaten ohne Umlaut.
    'GOTTLICHE INTERVENTION': () => ({ type: 'levelUpAllPriests' }),
    'SCHICKSALHAFTE KARTEN': () => ({ type: 'multiCardSelection', actionType: 'schicksalhafteKarten' }),
    'FINDE EINE KARTE': () => ({ type: 'findeEineKarte' }),
  };

  // Flueche, die NACH dem Ziehen weiterwirken (statt sofort und einmalig).
  // CONSEQUENCE_OVERRIDES behandelt sie weiterhin als "bewusst manuell" (kein
  // Sofort-Effekt) - dieser Tracker kommt zusaetzlich obendrauf, siehe
  // addActiveCurse/curseCombatModifier/curseSuppressesItemBonuses in server.js.
  const LINGERING_CURSES = {
    // "(Nur) In deinem naechsten Kampf erhaeltst du keine Boni durch
    // Gegenstaende, die einzige Ausnahme sind Ruestungsboni."
    'MIESER SPIEGEL': { kind: 'noItemBonusExceptArmor', dauer: 'naechsterKampf',
      hinweis: 'Im nächsten Kampf zählen keine Gegenstandsboni - nur Rüstung.' },
    // "-5 auf deinen naechsten Kampf, weil du abgelenkt bist."
    'GESCHLECHTSUMWANDLUNG': { kind: 'combatMalus', amount: -5, dauer: 'naechsterKampf',
      hinweis: '-5 im nächsten Kampf.' },
    // "-1 auf alle Wuerfe. Jeder Fluch oder alle Schlimmen Dinge, die deine
    // Kopfbedeckung entfernen, nehmen das Huhn mit."
    // Der zweite Satz (Huhn faellt mit der Kopfbedeckung) steht in
    // huhnMitKopfbedeckung (server.js).
    'HUHN AUF DEINEM KOPF': { kind: 'rollMalus', amount: -1, dauer: 'dauerhaft',
      hinweis: '-1 auf alle Würfe, bis der Fluch endet (z.B. Wunschring).' },
    // "Du kannst keine Gegenstaende tragen, die mehr als eine Hand benoetigen."
    'WINZIGE HÄNDE': { kind: 'noTwoHandedItems', dauer: 'dauerhaft',
      hinweis: 'Keine Gegenstände, die zwei Hände brauchen, bis der Fluch endet.' },
    // "-4 fuer deinen naechsten (oder aktuellen) Kampf ... ausser du bist ein
    // Zwerg ... dann erhaeltst du durch den 'Fluch' stattdessen +4."
    // amountFuerRasse wird in addActiveCurse EINMAL aufgeloest und als feste
    // Zahl gespeichert - so bleibt der Eintrag reine Daten und geht
    // unveraendert ueber publicState an den Client.
    'ZWERGENBIER': { kind: 'combatMalus', amount: -4, amountFuerRasse: { 'ZWERG': 4 },
      dauer: 'naechsterKampf',
      hinweis: '-4 im nächsten Kampf (Zwerge bekommen stattdessen +4).' },
    // "Niemand hilft dir in deinem naechsten Kampf." Wer waehrend eines
    // Kampfes verflucht wird, bekommt den Eintrag fuer DIESEN Kampf: die
    // Dauer 'naechsterKampf' laeuft am Ende des laufenden Kampfes ab
    // (clearNextCombatCurses), der Kartentext will genau das.
    'STINKER': { kind: 'noHelp', dauer: 'naechsterKampf',
      hinweis: 'Im nächsten Kampf hilft dir niemand.' },
    // "Du erhaeltst keinen Schatz im naechsten Kampf." Sperrt NUR die
    // Kampfbeute - nicht jede Schatzkarte (das ist die Stoererliste des
    // Weihnachtsmanns, kind 'noTreasure').
    'NARRENGOLD': { kind: 'noCombatTreasure', dauer: 'naechsterKampf',
      hinweis: 'Im nächsten Kampf gibt es für dich keinen Schatz.' },
    // GUMMI-GOLEM, Schlimme Dinge: "Zuckerschock! Du musst in JEDEM Kampf
    // deine Hilfe anbieten, darfst keinen Schatz annehmen, bis du einen
    // verlierst." "einen verlierst" bezieht sich laut Nutzerentscheidung
    // 2026-09-23 auf einen KAMPF, nicht auf eine Schatzkarte - Ende in
    // beendeFluchtphase (server.js), Schatzsperre teilt sich hatSchatzSperre()
    // mit der Stoererliste. Die Hilfe-Pflicht ist Trust-Prinzip (kein Zwang,
    // jemanden zum Annehmen oder Anbieten zu bringen) - nur der Hinweistext
    // erinnert daran.
    'GUMMI-GOLEM': { kind: 'zuckerschock', dauer: 'dauerhaft',
      hinweis: 'Zuckerschock: du musst in jedem Kampf deine Hilfe anbieten (niemand muss sie annehmen) und darfst keinen Schatz annehmen, bis du einen Kampf verlierst.' },
    // "Am Ende jedes deiner Zuege wuerfelst du, bevor 'Milde Gabe' verteilt
    // oder abgelegt wird. Dein Rucksack frisst entsprechend des Wurfs so viele
    // zufaellige Karten deiner Hand! Bei einer gewuerfelten 6 verschluckt der
    // Rucksack sich selbst und verschwindet." Wurf: rucksackWurf in server.js.
    'HUNGRIGER RUCKSACK': { kind: 'hungrigerRucksack', dauer: 'dauerhaft',
      hinweis: 'Am Ende jedes deiner Züge frisst der Rucksack gewürfelt viele Handkarten (bei einer 6 ist er weg).' },
    // "Eine Beule am Kopf laesst dich deine Klasse(n) und Rasse(n) vergessen
    // ... Bis dahin wirst du ueberall als klassenloser Mensch gezaehlt."
    // Wirkung in hasRace/hasClass/itemGrantsTrait, Ende in finishCombatWin.
    'TEMPORÄRE ANMNESIE': { kind: 'traitsVergessen', dauer: 'dauerhaft',
      hinweis: 'Rasse und Klasse zählen nicht, bis du einen Kampf gewinnst.' },
    // "Du darfst nicht 'Auf Aerger aus sein'. Dieser Fluch bleibt bestehen,
    // bis du einem anderen Spieler geholfen hast, einen Kampf zu gewinnen."
    // Sperre und Ende: keinAergerSuchen in server.js.
    'TOURISTENFALLE': { kind: 'keinAergerSuchen', dauer: 'dauerhaft',
      hinweis: 'Kein "Auf Ärger aus sein", bis du jemandem zum Sieg verhilfst.' },
    // "Du hast Angst vor den Untoten." Dauerhaft - der Kartentext nennt kein
    // Ende, nur der WUNSCHRING beendet ihn.
    'TODESANGST': { kind: 'fearUndead', dauer: 'dauerhaft',
      hinweis: 'Angst vor Untoten: du hilfst nicht gegen sie, und gegen Untote hilft dir niemand.' },
  };

  // Karten, die einen LAUFENDEN Kampf veraendern. Sie reiten auf der
  // bestehenden combatAllReady-Schranke: solange nicht alle bereit sind, darf
  // eingegriffen werden, und jede Aenderung setzt den Bereit-Status
  // automatisch zurueck (combatSignature).
  const COMBAT_REACTION_CARDS = {
    // "Ein weiteres Monster mit der gleichen Stufe und mit den gleichen
    // Monsterverstaerker-Karten taucht auf. Werden die Monster besiegt, ziehst
    // du fuer beide Monster Schaetze und steigst fuer beide Stufen auf."
    'KUMPEL': { kind: 'duplicateMonster' },
    // "Spiele diese Karte mit einem Monster von deiner Hand, wenn jemand im
    // Kampf ist. Dein Monster schliesst sich dem schon kaempfenden an."
    'WANDERNDES MONSTER': { kind: 'addMonsterFromHand', brauchtHandmonster: true },
    // "Lege ein beliebiges Monster in diesem Kampf ab ... und ersetze es durch
    // eine Monsterkarte von deiner Hand."
    'ILLUSION': { kind: 'replaceMonsterFromHand', brauchtHandmonster: true },
    // "Spiele diese Karte, WAEHREND DU DICH IM KAMPF BEFINDEST. Nimm einen
    // Gegenstand von einem beliebigen Spieler." Die einzige der fuenf
    // Reaktionskarten mit dieser Bedingung - die anderen sagen ausdruecklich
    // das Gegenteil ("wenn jemand (du eingeschlossen!) im Kampf ist",
    // "Waehrend beliebigem Kampf spielen").
    'HILF MIR': { kind: 'takeItemFromPlayer', nurImKampf: true },
    // "Ein anderer Spieler (deiner Wahl) kaempft gegen das/die Monster."
    'ÜBERFALLTRANK': { kind: 'handOverCombat' },
  };

  // TROJANISCHER PFERD: "Spiele diese Karte zusammen mit einem Monster aus
  // deiner Hand aus, wenn jemand gerade nach dem Kampf einen Schatz ziehen
  // will. Die Person erhält keinen Schatz. Stattdessen geht es in den Kampf
  // gegen dein Monster. (Oder spiele diese Karte ohne Monster, um einfach
  // den Schatz wegzunehmen.)"
  const TREASURE_REACTION_CARDS = new Set(['TROJANISCHER PFERD']);

  return {
    ROLL_REACTION_CARDS, ROLL_REROLL_CARDS, ROLL_REACTION_OWN_ROLL_ONLY,
    ESCAPE_REACTION_CARDS, DOOR_POWER_CARDS,
    LINGERING_CURSES, COMBAT_REACTION_CARDS,
    TREASURE_REACTION_CARDS,
  };
};
