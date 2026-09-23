// Munchkin Online - Client
(function () {
  'use strict';

  // -- Pfad-Präfix automatisch ermitteln (für Betrieb hinter dem Spielehub) --
  function computeBasePath() {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts.length && !parts[0].includes('.')) return '/' + parts[0];
    return '';
  }
  const basePath = computeBasePath();
  const socket = io({ path: basePath + '/socket.io' });

  // Läuft diese Seite hinter dem Spielehub (also unter einem Pfad-Präfix),
  // zeigen wir einen Link zurück zur Spielauswahl (Hub-Startseite). Bei
  // direktem Zugriff ohne Hub gibt es keine Spielauswahl - dann bleibt er versteckt.
  if (basePath) {
    const backHub = document.getElementById('btnBackHub');
    if (backHub) {
      backHub.href = '/';
      backHub.classList.remove('hidden');
    }
  }

  // "Meine Figur" + Handkarten stehen fest am unteren Rand (#bottomDock) und
  // sind je nach Inhalt (Anzahl Ausrüstungsteile, Sonderkräfte, Handkarten...)
  // unterschiedlich hoch. Damit das Spielfeld (weißer Bereich: Tür eintreten,
  // Kampf, Konsequenz, ...) beim Runterscrollen niemals darunter verschwindet
  // und komplett sichtbar wird, messen wir die tatsächliche Dock-Höhe und
  // reservieren per CSS-Variable exakt so viel Platz am Ende der Spalte -
  // statt eines geratenen festen Werts, der bei viel/wenig Inhalt entweder zu
  // knapp oder unnötig groß wäre.
  function setupDockHeightTracking() {
    const dock = document.getElementById('bottomDock');
    if (!dock) return;
    const apply = () => {
      document.documentElement.style.setProperty('--dock-h', `${dock.offsetHeight + 24}px`);
    };
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(apply).observe(dock);
    } else {
      window.addEventListener('resize', apply);
    }
    apply();
  }
  setupDockHeightTracking();

  const CATEGORY_LABELS = {
    monster: 'Monster', curse: 'Fluch', race: 'Rasse', class: 'Klasse',
    item: 'Gegenstand', treasure_other: 'Schatz', door_other: 'Türkarte',
  };

  let cardIndex = {};
  let state = null;
  let myInfo = { playerId: null, hand: [] };
  let session = loadSession();
  let sellSelection = new Set();
  // "Schicksalhafte Karten" (Unnatural-Axe-Set): Checkboxen zum Abwerfen
  // mehrerer Handkarten in einem Rutsch, siehe multiCardSelection-Aktion.
  let multiSelection = new Set();

  // -- Zuschauer:innen --------------------------------------------------
  // Eine Zuschauer-Person steckt NIE in state.players und bekommt nie
  // 'yourInfo' (das gibt es nur fuer echte Mitspieler:innen) - myInfo.playerId
  // bleibt fuer sie also dauerhaft null. Das macht alle bestehenden
  // "ist das MEINE Aktion"-Pruefungen im Rendering automatisch inert (siehe
  // isMyTurn/me()); die drei Variablen hier steuern nur die eigens dafuer
  // gebaute Lese-Ansicht (welche Hand gerade angezeigt wird).
  let isSpectator = false;
  let spectateTargetId = null; // wessen Hand/Ausruestung gerade angezeigt wird
  let spectatorHands = {}; // { [playerId]: cardId[] } - vom Server per spectatorInfo

  // Handkarten nach Typ sortieren. Reihenfolge bewusst nach Spielablauf, nicht
  // alphabetisch: erst was man ausspielt (Monster, Fluch), dann was man
  // anlegt (Rasse/Klasse/Gegenstand), dann der Rest.
  const HAND_SORT_ORDER = ['monster', 'curse', 'race', 'class', 'door_other', 'item', 'treasure_other'];
  // Die Einstellung ist reine Anzeigesache und gilt nur auf diesem Gerät.
  let handSort = false;
  try { handSort = localStorage.getItem('munchkin_handsort') === '1'; } catch (e) { /* ignore */ }

  // -- Handel (Trading) --
  let tradeComposeTargetId = null; // gerade ein neues Angebot an diese Person zusammenstellen
  let tradeComposeSelection = new Set(); // eigene Karten/angelegte Gegenstände, die dabei angeboten werden
  let tradeCounterForId = null; // gerade die eigene Gegenleistung für dieses eingehende Angebot zusammenstellen
  let tradeCounterSelection = new Set();

  function startTradeCompose(targetId) {
    tradeComposeTargetId = targetId;
    tradeComposeSelection = new Set();
    tradeCounterForId = null;
    render();
  }

  function loadSession() {
    try { return JSON.parse(localStorage.getItem('munchkin_session') || 'null'); } catch (e) { return null; }
  }
  function saveSession(s) {
    session = s;
    try { localStorage.setItem('munchkin_session', JSON.stringify(s)); } catch (e) { /* ignore */ }
  }
  function clearSession() {
    session = null;
    try { localStorage.removeItem('munchkin_session'); } catch (e) { /* ignore */ }
  }

  function $(id) { return document.getElementById(id); }
  function showScreen(name) {
    ['start', 'lobby', 'game'].forEach((s) => {
      $('screen-' + s).classList.toggle('hidden', s !== name);
    });
  }

  function card(id) { return cardIndex[id] || { name: id, category: 'door_other', text: '', badstuff: '' }; }

  // ---------------------------------------------------------------------
  // Start-Screen
  // ---------------------------------------------------------------------

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
      $('tab-' + btn.dataset.tab).classList.remove('hidden');
      showStartError('');
    });
  });

  $('btnCreate').addEventListener('click', () => {
    const name = $('createNameInput').value.trim();
    if (!name) return showStartError('Bitte einen Namen eingeben.');
    socket.emit('createRoom', { name }, (res) => {
      if (!res.ok) return showStartError(res.error);
      saveSession({ code: res.code, playerId: res.playerId, token: res.token, name });
    });
  });

  $('btnJoin').addEventListener('click', () => {
    const name = $('joinNameInput').value.trim();
    const code = $('codeInput').value.trim().toUpperCase();
    if (!name) return showStartError('Bitte einen Namen eingeben.');
    if (!code) return showStartError('Bitte einen Raum-Code eingeben.');
    const spectatorInput = $('joinSpectatorInput');
    if (spectatorInput && spectatorInput.checked) {
      socket.emit('joinAsSpectator', { code, name }, (res) => {
        if (!res.ok) return showStartError(res.error);
        isSpectator = true;
        saveSession({ code: res.code, spectatorId: res.spectatorId, token: res.token, name, isSpectator: true });
      });
      return;
    }
    socket.emit('joinRoom', { code, name }, (res) => {
      if (!res.ok) return showStartError(res.error);
      // Die Partie kann inzwischen schon laufen - der Server setzt uns dann
      // statt eines Fehlers direkt als Zuschauer:in in den Raum
      // (siehe trySpectatorJoin/autoSpectator in server.js).
      if (res.autoSpectator) {
        isSpectator = true;
        saveSession({ code: res.code, spectatorId: res.spectatorId, token: res.token, name, isSpectator: true });
        return;
      }
      saveSession({ code: res.code, playerId: res.playerId, token: res.token, name });
    });
  });

  function showStartError(msg) { $('startError').textContent = msg || ''; }

  function doLeaveRoom() {
    socket.emit('leaveRoom');
    clearSession();
    location.reload();
  }
  $('btnLeave').addEventListener('click', doLeaveRoom);
  $('btnLeaveLobby').addEventListener('click', doLeaveRoom);

  // Defensiv über das optionale Element: hat der Browser noch eine ältere
  // index.html im Cache, während client.js schon neu ist, wäre das hier sonst
  // ein TypeError auf null - und der würde die gesamte restliche Verdrahtung
  // in dieser Datei mitreißen, also aus einem fehlenden Schalter ein totes
  // Spiel machen.
  const handSortInput = $('handSortInput');
  if (handSortInput) {
    handSortInput.addEventListener('change', (e) => {
      handSort = e.target.checked;
      try { localStorage.setItem('munchkin_handsort', handSort ? '1' : '0'); } catch (err) { /* ignore */ }
      if (state) render();
    });
  }

  // "Meine Figur" laesst sich einklappen - eingeklappt bleiben nur Stufe,
  // Kampfwert und Rasse/Klasse sichtbar (.mypanel-head), die Ausruestungs-
  // slots verschwinden. Praktisch, wenn gerade nur die Handkarten/Zugaktionen
  // wichtig sind und die feste Leiste am unteren Rand weniger Platz brauchen
  // soll. Der Zustand wird wie handSort pro Geraet gemerkt.
  let myPanelCollapsed = false;
  try { myPanelCollapsed = localStorage.getItem('munchkin_mypanel_collapsed') === '1'; } catch (e) { /* ignore */ }
  const myPanel = $('myPanel');
  const myPanelToggle = $('myPanelToggle');
  function applyMyPanelCollapsed() {
    if (myPanel) myPanel.classList.toggle('collapsed', myPanelCollapsed);
    if (myPanelToggle) {
      myPanelToggle.textContent = myPanelCollapsed ? '▸' : '▾';
      myPanelToggle.title = myPanelCollapsed ? 'Ausrüstung anzeigen' : 'Ausrüstung ausblenden';
    }
  }
  if (myPanelToggle) {
    myPanelToggle.addEventListener('click', () => {
      myPanelCollapsed = !myPanelCollapsed;
      try { localStorage.setItem('munchkin_mypanel_collapsed', myPanelCollapsed ? '1' : '0'); } catch (err) { /* ignore */ }
      applyMyPanelCollapsed();
    });
  }
  applyMyPanelCollapsed();

  socket.on('connect', () => {
    if (session && session.code) {
      if (session.isSpectator) {
        isSpectator = true;
        socket.emit('joinAsSpectator', { code: session.code, name: session.name, token: session.token }, (res) => {
          if (!res.ok) { clearSession(); isSpectator = false; showScreen('start'); return; }
          saveSession({ code: res.code, spectatorId: res.spectatorId, token: res.token, name: session.name, isSpectator: true });
        });
        return;
      }
      socket.emit('joinRoom', { code: session.code, name: session.name, token: session.token }, (res) => {
        if (!res.ok) { clearSession(); showScreen('start'); return; }
        saveSession({ code: res.code, playerId: res.playerId, token: res.token, name: session.name });
      });
    }
  });

  // Der Server schickt bei JEDER Aktion alle drei Events neu raus - auch dann,
  // wenn sich am Inhalt nichts geaendert hat. Da jedes render() das komplette
  // Spiel-DOM samt aller <img> neu aufbaut, waren das bis zu drei komplette
  // Neuaufbauten pro Broadcast: sichtbares Flackern. Deshalb werden
  // unveraenderte Nutzlasten hier einfach verworfen.
  // Wichtig: doorReveal.seq steckt mit im gameState - ein echtes Aufdecken
  // aendert den State also immer, playDoorReveal() feuert weiterhin genau
  // einmal pro Aufdecken.
  const lastPayload = {};
  function changed(key, value) {
    const json = JSON.stringify(value);
    if (lastPayload[key] === json) return false;
    lastPayload[key] = json;
    return true;
  }

  // cardIndex ist serverseitig eine Konstante (alle Karten aller Sets) und
  // wird trotzdem bei jedem Broadcast mitgeschickt - einmal uebernehmen reicht.
  socket.on('cardIndex', (idx) => { const first = !Object.keys(cardIndex).length; cardIndex = idx; if (first && state) render(); });
  socket.on('yourInfo', (info) => { if (!changed('yourInfo', info)) return; myInfo = info; if (state) render(); });
  socket.on('gameState', (s) => { if (!changed('gameState', s)) return; state = s; render(); });
  // Nur fuer Zuschauer:innen (siehe joinAsSpectator/sendSpectatorInfo auf dem
  // Server) - alle Haende auf einmal, damit das Dropdown ohne Serverfrage
  // zwischen Spieler:innen umschalten kann.
  socket.on('spectatorInfo', (info) => { if (!changed('spectatorInfo', info)) return; spectatorHands = info.hands || {}; if (state) render(); });

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------

  function render() {
    if (!state) return;
    if (state.phase === 'lobby') { showScreen('lobby'); renderLobby(); }
    else { showScreen('game'); renderGame(); }
  }

  function me() { return state.players.find((p) => p.id === myInfo.playerId); }
  function isMyTurn() { return state.turnPlayerId === myInfo.playerId; }
  // Spiegelt darfAusruesten(room, player) im Server: Ausruestung aendert man
  // ueberall, nur nicht mitten im Kampf. Verkaufen ist strenger (eigener Zug).
  function darfAusruesten() { return !state.combat && state.phase !== 'gameend'; }
  function darfVerkaufen() { return darfAusruesten() && isMyTurn() && state.turnPhase !== 'vorbereitung'; }

  function renderLobby() {
    $('lobbyCode').textContent = state.code;
    $('lobbyCount').textContent = state.players.length;
    $('lobbyMax').textContent = state.maxPlayers;
    const list = $('lobbyPlayers');
    list.innerHTML = '';
    state.players.forEach((p) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${p.isHost ? '⭐ ' : ''}${escapeHtml(p.name)}${p.isBot ? ' <span class="tag">Bot</span>' : ''}</span>` +
        (p.id === myInfo.playerId ? '<span class="tag you">Du</span>' : '');
      if (p.isBot && me() && me().isHost) {
        const btn = document.createElement('button');
        btn.className = 'small'; btn.textContent = 'entfernen';
        btn.onclick = () => socket.emit('removeBot', { botId: p.id });
        li.appendChild(btn);
      }
      list.appendChild(li);
    });

    const toggles = $('setToggles');
    toggles.innerHTML = '<b>Sets:</b>';
    state.setKeys.forEach((k) => {
      const label = document.createElement('label');
      label.style.display = 'inline-flex'; label.style.alignItems = 'center'; label.style.gap = '4px'; label.style.margin = '0';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.style.width = 'auto';
      cb.checked = !!state.settings.sets[k];
      cb.disabled = !(me() && me().isHost);
      cb.onchange = () => {
        const sets = Object.assign({}, state.settings.sets);
        sets[k] = cb.checked;
        socket.emit('updateSets', sets);
      };
      label.appendChild(cb);
      label.appendChild(document.createTextNode(state.setLabels[k]));
      toggles.appendChild(label);
    });

    const iAmHost = me() && me().isHost;
    $('hostControls').classList.toggle('hidden', !iAmHost);
    $('btnAddBot').onclick = () => socket.emit('addBot');
    $('btnStart').onclick = () => socket.emit('startGame');
    $('btnStart').disabled = state.players.length < 1;

    // Eigener, klar abgetrennter Bereich (siehe joinAsSpectator) - bleibt
    // versteckt, solange niemand zuschaut.
    const specs = state.spectators || [];
    $('lobbySpectatorsBox').classList.toggle('hidden', !specs.length);
    $('lobbySpectatorCount').textContent = specs.length;
    const specList = $('lobbySpectators');
    specList.innerHTML = '';
    specs.forEach((s) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>👀 ${escapeHtml(s.name)}${!s.connected ? ' <span class="tag off">offline</span>' : ''}</span>` +
        (isSpectator && s.id === session.spectatorId ? '<span class="tag you">Du</span>' : '');
      specList.appendChild(li);
    });
  }

  // Sequenz-Animationen (Tuer aufdecken, Wuerfel, Beute) laufen nur bei einem
  // NEUEN Ereignis. Beim ersten Zustand nach dem Laden oder Wiederverbinden
  // wird der Stand nur uebernommen, damit ein laengst vergangenes Ereignis
  // nicht nachtraeglich abgespielt wird.
  //
  // Der Merker muss dabei auch dann gesetzt werden, wenn es noch GAR kein
  // Ereignis gibt (Feld null): sonst gilt das erste echte Ereignis der Partie
  // als "erstes Sehen" und wird geschluckt - genau das liess die Beute nach
  // dem ersten besiegten Monster ausfallen (und ebenso das erste Aufdecken
  // und den ersten Weglaufwurf).
  const animSeq = {};
  function istNeuesEreignis(schluessel, ereignis) {
    const vorher = animSeq[schluessel];
    animSeq[schluessel] = ereignis ? ereignis.seq : 0;
    return vorher !== undefined && !!ereignis && ereignis.seq !== vorher;
  }

  // Aufdeck-Animation: spielt genau einmal pro neu aufgedeckter Tuerkarte.
  let revealAnimTimer = null;
  function playDoorReveal() {
    const r = state.doorReveal;
    if (!istNeuesEreignis('reveal', r)) return;
    const box = $('revealAnim');
    box.innerHTML = '';
    box.appendChild(cardTile(r.cardId, {}));
    box.classList.remove('hidden', 'play');
    void box.offsetWidth; // Reflow erzwingen, sonst startet die Animation bei schneller Folge nicht neu
    box.classList.add('play');
    clearTimeout(revealAnimTimer);
    revealAnimTimer = setTimeout(() => { box.classList.add('hidden'); box.innerHTML = ''; }, 1500);
  }

  // Wuerfel-Animation beim Weglaufen. Gleiches Muster wie playDoorReveal:
  // genau einmal pro neuem seq, beim (Wieder-)Einstieg nur den seq uebernehmen.
  // Alle am Tisch sehen sie, deshalb steht der Name der wuerfelnden Person dabei.
  const DIE_FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
  let dieAnimTimer = null;
  let dieTickTimer = null;
  // Gespielte Kampfkarte: kurz gross in der Mitte, mit dem Namen der Person,
  // die sie spielt (siehe announceCardPlay im Server). Alle am Tisch sehen
  // sie - anders als die Beute ist eine gespielte Karte oeffentlich.
  let cardPlayTimer = null;
  function playCardPlay() {
    const e = state.cardPlay;
    if (!istNeuesEreignis('cardPlay', e)) return;
    const box = $('cardPlayAnim');
    box.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'cardplay-box';
    const who = document.createElement('div');
    who.className = 'cardplay-who';
    who.textContent = `${e.playerName} spielt:`;
    wrap.appendChild(who);
    wrap.appendChild(cardTile(e.cardId, {}));
    if (e.hinweis) {
      const note = document.createElement('div');
      note.className = 'cardplay-note';
      note.textContent = e.hinweis;
      wrap.appendChild(note);
    }
    box.appendChild(wrap);
    box.classList.remove('hidden', 'play');
    void box.offsetWidth; // Reflow erzwingen, sonst startet die Animation bei schneller Folge nicht neu
    box.classList.add('play');
    clearTimeout(cardPlayTimer);
    cardPlayTimer = setTimeout(() => { box.classList.add('hidden'); box.classList.remove('play'); box.innerHTML = ''; }, 1800);
  }

  // Aktivierte Sonderkraft ("Passiver Effekt"): dieselbe Grossanzeige wie
  // playCardPlay, aber mit "glaenzendem" Spezialeffekt (siehe .shiny-Klasse
  // in style.css) statt der schlichten Kampfkarten-Anzeige - macht sichtbar,
  // DASS und WESSEN Karte gerade eine Sonderkraft ausgeloest hat.
  let cardPowerTimer = null;
  function playCardPower() {
    const e = state.cardPower;
    if (!istNeuesEreignis('cardPower', e)) return;
    const box = $('cardPowerAnim');
    if (!box) return;
    box.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'cardplay-box shiny';
    const who = document.createElement('div');
    who.className = 'cardplay-who';
    who.textContent = `${e.playerName} aktiviert Sonderkraft:`;
    wrap.appendChild(who);
    const tile = cardTile(e.cardId, {});
    tile.classList.add('shiny-card');
    wrap.appendChild(tile);
    box.appendChild(wrap);
    box.classList.remove('hidden', 'play');
    void box.offsetWidth; // Reflow erzwingen, sonst startet die Animation bei schneller Folge nicht neu
    box.classList.add('play');
    clearTimeout(cardPowerTimer);
    cardPowerTimer = setTimeout(() => { box.classList.add('hidden'); box.classList.remove('play'); box.innerHTML = ''; }, 1800);
  }

  function playDieRoll() {
    const d = state.dieRoll;
    if (!istNeuesEreignis('die', d)) return;
    const box = $('dieAnim');
    const modText = `${d.mod >= 0 ? '+' : ''}${d.mod}`;
    box.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'die-box';
    const who = document.createElement('div');
    who.className = 'die-who';
    who.textContent = `${d.playerName} läuft weg…`;
    const face = document.createElement('div');
    face.className = 'die-face';
    face.textContent = DIE_FACES[d.roll - 1];
    const sum = document.createElement('div');
    sum.className = 'die-sum';
    sum.textContent = `${d.roll} ${modText} = ${d.total}`;
    const res = document.createElement('div');
    res.className = `die-result ${d.success ? 'good' : 'bad'}`;
    res.textContent = d.success ? 'Entkommen!' : 'Gescheitert!';
    wrap.append(who, face, sum, res);
    // Woher der Modifikator kommt (Elf, Weglaufstiefel, Monstertext ...) -
    // sonst sieht die Zahl nach einem Rechenfehler aus.
    if (d.note) {
      const note = document.createElement('div');
      note.className = 'die-note';
      note.textContent = d.note;
      wrap.appendChild(note);
    }
    box.appendChild(wrap);
    box.classList.remove('hidden', 'play');
    void box.offsetWidth; // Reflow erzwingen, sonst startet die Animation bei schneller Folge nicht neu
    box.classList.add('play');
    // Waehrend des "Rollens" wechseln die Augenzahlen; danach bleibt das echte
    // Ergebnis stehen, damit die Animation es nicht verschluckt.
    clearInterval(dieTickTimer);
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduced) {
      dieTickTimer = setInterval(() => { face.textContent = DIE_FACES[Math.floor(Math.random() * 6)]; }, 90);
      setTimeout(() => { clearInterval(dieTickTimer); face.textContent = DIE_FACES[d.roll - 1]; }, 900);
    }
    clearTimeout(dieAnimTimer);
    dieAnimTimer = setTimeout(() => { box.classList.add('hidden'); box.innerHTML = ''; }, 2600);
  }

  // Beute-Animation nach einem Kampfsieg: nur die/der Siegende bekommt sie zu
  // sehen, denn die gezogenen Schatzkarten sind Handkarten und damit geheim -
  // deshalb haengt sie an myInfo (privates yourInfo-Event), nicht am State.
  let rewardAnimTimer = null;
  let rewardFlyTimer = null;

  // Zum Schluss fliegen die Beutekarten in die eigene Handleiste, damit
  // sichtbar ist, wo der Schatz landet. FLIP-Prinzip: einmal die Zielposition
  // messen, dann pro Karte genau ein transform - kein Reflow pro Frame.
  function flyRewardCardsToHand(box) {
    const target = $('myHand').getBoundingClientRect();
    if (!target.width) return; // Handleiste nicht sichtbar - dann nur ausblenden
    box.querySelectorAll('.cardtile').forEach((tile, i) => {
      const r = tile.getBoundingClientRect();
      tile.style.animation = 'none'; // Einflug-Keyframes abschalten, sonst kaempfen sie mit dem transform
      tile.style.transition = `transform 0.6s cubic-bezier(0.4, 0, 0.7, 1) ${i * 0.07}s, opacity 0.6s ease-in ${i * 0.07}s`;
      void tile.offsetWidth;
      tile.style.transform = `translate(${target.left + target.width / 2 - (r.left + r.width / 2)}px, ${target.top + target.height / 2 - (r.top + r.height / 2)}px) scale(0.25)`;
      tile.style.opacity = '0';
    });
  }
  function playReward() {
    const r = myInfo.lastReward;
    if (!istNeuesEreignis('reward', r)) return;
    const box = $('rewardAnim');
    box.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'reward-box';
    const head = document.createElement('div');
    head.className = 'reward-head';
    // Ohne Stufengewinn wurde das Monster nicht besiegt, sondern hat seinen
    // Schatz zurueckgelassen (Polly-Trank & Co.) - dann passt "besiegt" nicht.
    // Dieselbe Animation fuer drei Anlaesse, nur mit anderer Ueberschrift:
    // Kampfsieg, Raum pluendern (kind 'loot') und der Schatz, den ein
    // Gegenstand auf dem Weg aus einem Kampf heraus mitbringt ('flucht').
    if (r.kind === 'loot') head.textContent = '📦 Raum geplündert!';
    else if (r.kind === 'flucht') head.textContent = `🏃 Entkommen - "${r.quelle}" bringt noch etwas mit!`;
    else if (r.levelsGained) head.textContent = `⚔️ ${r.monsterNames.join(' + ')} besiegt!`;
    else head.textContent = `🪙 ${r.monsterNames.join(' + ')} liess den Schatz zurueck!`;
    wrap.appendChild(head);
    if (r.levelsGained) {
      const lvl = document.createElement('div');
      lvl.className = 'reward-level';
      lvl.textContent = `+${r.levelsGained} Stufe${r.levelsGained === 1 ? '' : 'n'}`;
      wrap.appendChild(lvl);
    }
    if (r.cardIds.length) {
      const label = document.createElement('div');
      label.className = 'reward-label';
      const n = r.cardIds.length;
      if (r.kind === 'loot') label.textContent = `Verdeckt gezogen: ${n} Türkarte${n === 1 ? '' : 'n'}`;
      else if (r.kind === 'flucht') label.textContent = `Auf dem Weg nach draußen: ${n} Schatzkarte${n === 1 ? '' : 'n'}`;
      else label.textContent = `Deine Beute: ${n} Schatzkarte${n === 1 ? '' : 'n'}`;
      wrap.appendChild(label);
      const row = document.createElement('div');
      row.className = 'reward-cards';
      r.cardIds.forEach((id, i) => {
        const tile = cardTile(id, {});
        tile.style.animationDelay = `${0.25 + i * 0.18}s`; // Karten nacheinander einfliegen lassen
        row.appendChild(tile);
      });
      wrap.appendChild(row);
    } else {
      wrap.appendChild(textNode('Dieses Monster liess keinen Schatz zurueck.'));
    }
    box.appendChild(wrap);
    box.classList.remove('hidden', 'play', 'fly');
    void box.offsetWidth; // Reflow erzwingen, sonst startet die Animation bei schneller Folge nicht neu
    box.classList.add('play');
    clearTimeout(rewardAnimTimer);
    clearTimeout(rewardFlyTimer);
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduced) {
      rewardFlyTimer = setTimeout(() => { box.classList.add('fly'); flyRewardCardsToHand(box); }, 1400);
    }
    rewardAnimTimer = setTimeout(() => {
      box.classList.add('hidden');
      box.classList.remove('play', 'fly');
      box.innerHTML = '';
    }, reduced ? 3400 : 2400);
  }

  function renderGame() {
    $('gameCode').textContent = state.code;
    $('deckInfo').textContent = `🚪 Tür: ${state.doorDeckCount} | 💰 Schatz: ${state.treasureDeckCount}`;

    if (state.phase === 'gameend') {
      const winner = state.players.find((p) => p.id === state.winner);
      $('turnBanner').textContent = `🏆 ${winner ? winner.name : '?'} hat gewonnen!`;
    } else {
      const tp = state.players.find((p) => p.id === state.turnPlayerId);
      const phaseLabel = {
        tuer: 'Phase 1: Tür eintreten', aerger: 'Phase 2: Auf Ärger aus sein',
        pluendern: 'Phase 3: Raum plündern', gabe: 'Phase 4: Milde Gabe', kampf: 'Kampf!',
      }[state.turnPhase] || '';
      $('turnBanner').textContent = state.turnPhase === 'vorbereitung'
        ? 'Vorbereitung: Ausrüstung anlegen - die erste Runde startet, sobald alle bereit sind.'
        : `${tp ? tp.name : '?'} ist am Zug - ${phaseLabel}`;
    }

    playDoorReveal();
    playDieRoll();
    playCardPlay();
    playCardPower();
    playReward();
    renderPlayerList();
    renderSpectatorList();
    renderDiscardPeek();
    renderReveal();
    renderCombat();
    renderPrep();
    renderRollReaction();
    renderConsequence();
    renderCardAction();
    renderPhaseActions();
    renderTradeArea();
    renderSpectateSelect();
    renderMyPanel();
    renderLog();

    if (state.phase === 'gameend') {
      const banner = $('banner');
      banner.classList.remove('hidden');
      const winner = state.players.find((p) => p.id === state.winner);
      banner.textContent = `🏆 Spiel vorbei! ${winner ? winner.name : '?'} hat Stufe 10 erreicht.`;
      const btn = document.createElement('button');
      btn.textContent = 'Zurück zur Lobby'; btn.style.marginLeft = '12px';
      btn.onclick = () => socket.emit('resetGame');
      banner.appendChild(btn);
    } else {
      $('banner').classList.add('hidden');
    }
  }

  // Eine Zeile pro Karte auf dem Spezialplatz; ohne Karten bleibt der Platz
  // mit einer leeren Zeile sichtbar.
  function specialSlotRows(p) {
    const cfg = state.specialSlots || {};
    return Object.keys(cfg).flatMap((key) => {
      const label = cfg[key].label || key;
      const v = p.equipped[key];
      const ids = Array.isArray(v) ? v.filter(Boolean) : (v ? [v] : []);
      if (!ids.length) return [[key, label, null]];
      return ids.map((id, i) => [`${key}${i}`, ids.length > 1 ? `${label} ${i + 1}` : label, id]);
    });
  }

  function renderPlayerList() {
    const box = $('playerList');
    box.innerHTML = '<h3>Spieler:innen</h3>';
    state.players.forEach((p) => {
      const wrap = document.createElement('div');
      wrap.className = 'prow-wrap';

      // Anhaltende Flüche (z.B. HUNGRIGER RUCKSACK) stehen als eigene kleine
      // Kartenvorschau LINKS neben der Spielerzeile - vorher gab es dafür nur
      // eine Anzahl ("🌀 Fluch x1") in der Zeile selbst, ohne zu verraten,
      // WELCHER Fluch das ist.
      const curses = p.activeCurses || [];
      if (curses.length) {
        const curseCol = document.createElement('div');
        curseCol.className = 'prow-curses';
        curses.forEach((f) => {
          const img = document.createElement('img');
          img.className = 'curseicon'; img.alt = ''; img.src = cardImageUrl(f.cardId);
          img.title = `${f.name}${f.hinweis ? ` – ${f.hinweis}` : ''}`;
          img.onerror = () => img.remove();
          img.onclick = (e) => { e.stopPropagation(); openCardModal(f.cardId); };
          curseCol.appendChild(img);
        });
        wrap.appendChild(curseCol);
      }

      const row = document.createElement('div');
      row.className = 'prow clickable' + (p.id === state.turnPlayerId ? ' active-turn' : '');
      const equipIds = equippedIdsOf(p);
      row.innerHTML = `<span>${escapeHtml(p.name)}${p.isBot ? ' 🤖' : ''}</span>` +
        `<span>` +
        (p.id === state.turnPlayerId ? '<span class="tag turn">Zug</span> ' : '') +
        (p.id === myInfo.playerId ? '<span class="tag you">Du</span> ' : '') +
        (!p.connected ? '<span class="tag off">offline</span> ' : '') +
        `<span class="tag">Stufe ${p.level}</span> <span class="tag">⚔ ${p.strength}</span>` +
        `</span>`;
      row.title = 'Klicken für Ausrüstung';
      row.addEventListener('click', () => openPlayerModal(p.id));

      // Rasse/Klasse auch von ANDEREN Spieler:innen direkt sichtbar (wie im
      // eigenen Panel/#myBadges) - vorher musste man dafuer erst das
      // Spieler-Modal oeffnen. Steht bewusst UEBER der Ausruestungsreihe.
      const badgeRow = document.createElement('div');
      badgeRow.className = 'prow-badges';
      p.races.forEach((id) => badgeRow.appendChild(traitTag(p, id, 'var(--c-race)')));
      p.classes.forEach((id) => badgeRow.appendChild(traitTag(p, id, 'var(--c-class)')));
      (p.powerGroups || []).forEach((id) => badgeRow.appendChild(smallTag(card(id).name, 'var(--c-class)', id)));
      if (hatAmnesie(p) || (!p.races.length && !p.classes.length && !(p.powerGroups || []).length)) badgeRow.appendChild(textNode('Mensch, ohne Klasse'));
      row.appendChild(badgeRow);

      // Kleine Vorschau-Icons der getragenen Gegenstaende direkt in der Zeile
      // (statt nur einer Anzahl) - eigener Klick pro Icon oeffnet die
      // Grossansicht DIESER Karte, ohne die Zeile selbst auszuloesen.
      const equipRow = document.createElement('div');
      equipRow.className = 'prow-equip';
      if (equipIds.length) {
        equipIds.forEach((id) => {
          const c = card(id);
          const img = document.createElement('img');
          img.className = 'eqicon'; img.alt = ''; img.src = cardImageUrl(id);
          img.title = `${c.name}${c.bonus ? ` (+${c.bonus})` : ''}`;
          img.onerror = () => img.remove();
          img.onclick = (e) => { e.stopPropagation(); openCardModal(id); };
          equipRow.appendChild(img);
        });
      } else {
        equipRow.classList.add('eqicon-none');
        equipRow.textContent = 'keine Ausrüstung';
      }
      row.appendChild(equipRow);

      // Im Kampf wird nicht gehandelt (siehe darfHandeln im Server). Zuschauer:
      // innen handeln nie mit (myInfo.playerId ist fuer sie ohnehin immer
      // null, "!== myInfo.playerId" waere sonst fuer JEDE Person wahr).
      if (!isSpectator && p.id !== myInfo.playerId && p.connected && !state.combat) {
        const tradeBtn = document.createElement('button');
        tradeBtn.className = 'small'; tradeBtn.textContent = '🤝 Handeln';
        tradeBtn.style.marginTop = '6px';
        tradeBtn.onclick = (e) => { e.stopPropagation(); startTradeCompose(p.id); };
        row.appendChild(tradeBtn);
      }
      wrap.appendChild(row);
      box.appendChild(wrap);
    });
  }

  // Eigener, klar abgetrennter Bereich unter der Spielerliste (siehe
  // joinAsSpectator) - bleibt versteckt, solange niemand zuschaut.
  function renderSpectatorList() {
    const box = $('spectatorListBox');
    const specs = (state.spectators || []);
    box.classList.toggle('hidden', !specs.length);
    if (!specs.length) return;
    $('spectatorCount').textContent = specs.length;
    const list = $('spectatorList');
    list.innerHTML = '';
    specs.forEach((s) => {
      const row = document.createElement('div');
      row.className = 'prow';
      row.innerHTML = `<span>👀 ${escapeHtml(s.name)}</span>` +
        `<span>${!s.connected ? '<span class="tag off">offline</span>' : ''}${isSpectator && s.id === session.spectatorId ? '<span class="tag you">Du</span>' : ''}</span>`;
      list.appendChild(row);
    });
  }

  // ---------------------------------------------------------------------
  // Spieler-Modal (Ausrüstung ansehen)
  // ---------------------------------------------------------------------

  function openPlayerModal(playerId) {
    offenerAblagestapel = null;
    const p = state.players.find((pl) => pl.id === playerId);
    if (!p) return;
    const body = $('cardModalBody');
    body.innerHTML = `<h3>${escapeHtml(p.name)}${p.isBot ? ' 🤖' : ''} - Stufe ${p.level}</h3>`;

    const badges = document.createElement('div');
    badges.className = 'row gap wrap';
    badges.style.marginBottom = '12px';
    p.races.forEach((id) => badges.appendChild(traitTag(p, id, 'var(--c-race)')));
    p.classes.forEach((id) => badges.appendChild(traitTag(p, id, 'var(--c-class)')));
    (p.powerGroups || []).forEach((id) => badges.appendChild(smallTag(card(id).name, 'var(--c-class)', id)));
    if (hatAmnesie(p) || (!p.races.length && !p.classes.length && !(p.powerGroups || []).length)) badges.appendChild(textNode('Mensch, ohne Klasse'));
    body.appendChild(badges);
    if ((p.activeCurses || []).length) {
      const flueche = document.createElement('div');
      flueche.className = 'row gap wrap';
      flueche.style.marginBottom = '12px';
      curseTags(p, flueche);
      body.appendChild(flueche);
    }

    const equip = document.createElement('div');
    equip.className = 'row gap wrap';
    const slotDefs = [
      ['Kopf', p.equipped.head], ['Rüstung', p.equipped.armor], ['Schuhe', p.equipped.feet],
      ['Hand 1', p.equipped.hands[0]], ['Hand 2', p.equipped.hands[1]],
      ...specialSlotRows(p).map(([, label, cardId]) => [label, cardId]),
    ];
    slotDefs.forEach(([label, cardId]) => {
      const el = document.createElement('div');
      el.className = 'equipslot' + (cardId ? ' filled' : '');
      if (cardId) {
        const c = card(cardId);
        const img = document.createElement('img');
        img.className = 'eqimg'; img.alt = ''; img.src = cardImageUrl(cardId);
        img.onerror = () => img.remove();
        el.innerHTML = `<b>${label}</b>`;
        el.appendChild(img);
        el.appendChild(document.createTextNode(`${c.name}${c.bonus ? ` (+${c.bonus})` : ''}${anhangText(cardId)}`));
        el.style.cursor = 'pointer';
        el.onclick = () => openCardModal(cardId);
      } else {
        el.innerHTML = `<b>${label}</b><span class="hint">leer</span>`;
      }
      equip.appendChild(el);
    });
    body.appendChild(equip);
    $('cardModal').classList.remove('hidden');
  }

  // ---------------------------------------------------------------------
  // Handel (Trading) - jederzeit möglich, nicht an den eigenen Zug gebunden.
  // ---------------------------------------------------------------------

  // Handelbar sind eigene Handkarten UND eigene angelegte Gegenstände
  // (letztere sind öffentlich sichtbar und stehen im state).
  function myEquippedIds() {
    const me = state && state.players.find((p) => p.id === myInfo.playerId);
    if (!me) return [];
    return [...new Set(equippedIdsOf(me))];
  }
  function myTradableIds() {
    return [...new Set([...(myInfo.hand || []), ...myEquippedIds()])];
  }
  function goldSum(ids) {
    return (ids || []).reduce((sum, id) => sum + (typeof card(id).gold === 'number' ? card(id).gold : 0), 0);
  }

  function tradePickGrid(ids, selection) {
    const equipped = myEquippedIds();
    const grid = document.createElement('div');
    grid.className = 'row gap wrap tradegrid';
    ids.forEach((id) => {
      const c = card(id);
      const label = document.createElement('label');
      label.className = 'tradepick' + (selection.has(id) ? ' picked' : '');
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = selection.has(id);
      cb.onchange = () => {
        if (cb.checked) selection.add(id); else selection.delete(id);
        renderTradeArea();
      };
      label.appendChild(cb);
      label.appendChild(document.createTextNode(
        ` ${c.name}${typeof c.gold === 'number' ? ` (${c.gold} GS)` : ''}${equipped.includes(id) ? ' • angelegt' : ''}`
      ));
      grid.appendChild(label);
    });
    if (!ids.length) grid.appendChild(textNode('Nichts Tauschbares vorhanden.'));
    return grid;
  }

  // Anklickbare Kartenverweise (wie im Verlauf) für eine Handelshälfte.
  function tradeChips(ids) {
    const row = document.createElement('div');
    row.className = 'row gap wrap';
    (ids || []).forEach((id) => {
      const c = card(id);
      const chip = document.createElement('a');
      chip.href = '#'; chip.className = 'logcardlink';
      chip.textContent = `[${c.name}${typeof c.gold === 'number' ? ` ${c.gold} GS` : ''}]`;
      chip.onclick = (e) => { e.preventDefault(); openCardModal(id); };
      row.appendChild(chip);
    });
    if (!(ids || []).length) row.appendChild(textNode('(nichts)'));
    return row;
  }

  // "300 vs. 400 Goldstücke" - Wert gegen Wert abwägen. Gold ist im Spiel
  // keine Währung, sondern nur der Verkaufswert der Karten (Verkauf ab 1.000
  // Goldstücken über handleSellItems) - hier also reine Entscheidungshilfe.
  function tradeVsLine(giveIds, getIds) {
    return textNode(`Du gibst ${goldSum(giveIds)} GS  vs.  du bekommst ${goldSum(getIds)} GS`);
  }

  function renderTradeArea() {
    const box = $('tradeArea');
    if (!box) return;
    box.innerHTML = '';
    if (!state || state.phase !== 'playing') return;
    // Im Kampf wird nicht gehandelt (der Server weist es ohnehin ab) - dann
    // auch keine Handelsflaeche zeigen, sondern nur den Grund.
    if (state.combat) {
      const offen = (myInfo.incomingTrades || []).length + (myInfo.outgoingTrades || []).length;
      if (offen) box.appendChild(textNode('Im Kampf wird nicht gehandelt - offene Angebote warten bis danach.'));
      return;
    }

    // 1. Eigenes Angebot zusammenstellen
    if (tradeComposeTargetId) {
      const target = state.players.find((p) => p.id === tradeComposeTargetId);
      if (!target || !target.connected) {
        tradeComposeTargetId = null;
      } else {
        const panel = document.createElement('div');
        panel.className = 'tradebox';
        panel.innerHTML = `<h3>🤝 Handel anbieten an ${escapeHtml(target.name)}</h3>` +
          `<p class="hint">Wähle, was du hergeben willst - Handkarten oder angelegte Gegenstände. ` +
          `${escapeHtml(target.name)} legt dann die Gegenleistung fest, die du anschließend bestätigen musst.</p>`;
        panel.appendChild(tradePickGrid(myTradableIds(), tradeComposeSelection));
        const selected = Array.from(tradeComposeSelection);
        panel.appendChild(textNode(`Dein Angebot: ${selected.length} Karte(n), ${goldSum(selected)} Goldstücke`));
        const actions = document.createElement('div');
        actions.className = 'row gap'; actions.style.marginTop = '10px';
        const sendBtn = mkBtn('Angebot senden', () => {
          if (!tradeComposeSelection.size) return;
          socket.emit('proposeTrade', { toId: tradeComposeTargetId, offerCardIds: Array.from(tradeComposeSelection) });
          tradeComposeTargetId = null; tradeComposeSelection = new Set();
          renderTradeArea();
        });
        sendBtn.className = 'primary';
        sendBtn.disabled = !tradeComposeSelection.size;
        const cancelBtn = mkBtn('Abbrechen', () => { tradeComposeTargetId = null; tradeComposeSelection = new Set(); renderTradeArea(); });
        actions.appendChild(sendBtn); actions.appendChild(cancelBtn);
        panel.appendChild(actions);
        box.appendChild(panel);
      }
    }

    // 2. Angebote an mich - ich lege meine Hälfte fest
    (myInfo.incomingTrades || []).forEach((t) => {
      const panel = document.createElement('div');
      panel.className = 'tradebox';
      panel.innerHTML = `<h3>🤝 Handelsangebot von ${escapeHtml(t.fromName)}</h3><p>Bietet dir an:</p>`;
      panel.appendChild(tradeChips(t.offerCardIds));

      if (t.status === 'countered') {
        panel.appendChild(textNode('Du verlangst dafür:'));
        panel.appendChild(tradeChips(t.counterCardIds));
        panel.appendChild(tradeVsLine(t.counterCardIds, t.offerCardIds));
        panel.appendChild(textNode(`Wartet auf Bestätigung von ${t.fromName}...`));
        box.appendChild(panel);
        return;
      }

      const actions = document.createElement('div');
      actions.className = 'row gap wrap'; actions.style.marginTop = '10px';
      const counterBtn = mkBtn('Gegenleistung festlegen...', () => { tradeCounterForId = t.id; tradeCounterSelection = new Set(); renderTradeArea(); });
      counterBtn.className = 'primary';
      const giftBtn = mkBtn('Annehmen, ohne etwas zu geben', () => socket.emit('respondTrade', { tradeId: t.id, accept: true, counterCardIds: [] }));
      const declineBtn = mkBtn('Ablehnen', () => socket.emit('respondTrade', { tradeId: t.id, accept: false }));
      declineBtn.className = 'danger';
      actions.appendChild(counterBtn); actions.appendChild(giftBtn); actions.appendChild(declineBtn);
      panel.appendChild(actions);

      if (tradeCounterForId === t.id) {
        panel.appendChild(tradePickGrid(myTradableIds(), tradeCounterSelection));
        const mine = Array.from(tradeCounterSelection);
        panel.appendChild(tradeVsLine(mine, t.offerCardIds));
        const confirmBtn = mkBtn('Gegenleistung verlangen', () => {
          if (!tradeCounterSelection.size) return;
          socket.emit('respondTrade', { tradeId: t.id, accept: true, counterCardIds: Array.from(tradeCounterSelection) });
          tradeCounterForId = null; tradeCounterSelection = new Set();
        });
        confirmBtn.className = 'primary'; confirmBtn.style.marginTop = '6px';
        confirmBtn.disabled = !tradeCounterSelection.size;
        panel.appendChild(confirmBtn);
      }
      box.appendChild(panel);
    });

    // 3. Meine eigenen Angebote - warten bzw. Gegenleistung bestätigen
    (myInfo.outgoingTrades || []).forEach((t) => {
      const panel = document.createElement('div');
      panel.className = 'tradebox';
      panel.innerHTML = `<h3>🤝 Dein Angebot an ${escapeHtml(t.toName)}</h3><p>Du bietest:</p>`;
      panel.appendChild(tradeChips(t.offerCardIds));

      const actions = document.createElement('div');
      actions.className = 'row gap wrap'; actions.style.marginTop = '10px';
      if (t.status === 'countered') {
        panel.appendChild(textNode(`${t.toName} verlangt dafür:`));
        panel.appendChild(tradeChips(t.counterCardIds));
        panel.appendChild(tradeVsLine(t.offerCardIds, t.counterCardIds));
        const okBtn = mkBtn('Tausch bestätigen', () => socket.emit('respondTrade', { tradeId: t.id, accept: true }));
        okBtn.className = 'primary';
        const noBtn = mkBtn('Gegenleistung ablehnen', () => socket.emit('respondTrade', { tradeId: t.id, accept: false }));
        noBtn.className = 'danger';
        actions.appendChild(okBtn); actions.appendChild(noBtn);
      } else {
        panel.appendChild(textNode(`Wert: ${goldSum(t.offerCardIds)} Goldstücke - wartet auf Antwort von ${t.toName}...`));
        actions.appendChild(mkBtn('Zurückziehen', () => socket.emit('cancelTrade', { tradeId: t.id })));
      }
      panel.appendChild(actions);
      box.appendChild(panel);
    });
  }

  // Beide Ablagestapel liegen offen: ein Klick zeigt ALLE Karten darin
  // (oberste zuerst), wie das Durchblaettern am echten Tisch.
  function renderDiscardPeek() {
    // Ein offenes Stapel-Modal mitwachsen lassen: waehrend man blaettert,
    // legen die anderen weiter ab.
    if (offenerAblagestapel && !$('cardModal').classList.contains('hidden')) {
      const merk = offenerAblagestapel;
      openDiscardModal(merk);
    }
    const box = $('discardPeek');
    box.innerHTML = '<h3>Ablagestapel</h3>';
    [['door', 'Tür', state.doorDiscard || []], ['treasure', 'Schatz', state.treasureDiscard || []]]
      .forEach(([pile, label, ids]) => {
        const oben = ids.length ? card(ids[ids.length - 1]) : null;
        const btn = document.createElement('button');
        btn.className = 'small wide';
        btn.style.marginTop = '4px';
        btn.textContent = `${label} (${ids.length}): ${oben ? oben.name : '-'}`;
        btn.disabled = !ids.length;
        btn.title = 'Alle Karten in diesem Ablagestapel ansehen';
        btn.onclick = () => openDiscardModal(pile);
        box.appendChild(btn);
      });
  }

  let offenerAblagestapel = null; // 'door' | 'treasure', solange sein Modal offen ist

  function openDiscardModal(pile) {
    offenerAblagestapel = pile;
    const ids = (pile === 'door' ? state.doorDiscard : state.treasureDiscard) || [];
    const body = $('cardModalBody');
    body.innerHTML = `<h3>${pile === 'door' ? 'Tür' : 'Schatz'}-Ablagestapel (${ids.length})</h3>`;
    if (!ids.length) {
      body.appendChild(textNode('Dieser Ablagestapel ist leer.'));
    } else {
      body.appendChild(textNode('Oberste Karte zuerst. Klick auf eine Karte zeigt ihren Text.'));
      const grid = document.createElement('div');
      grid.className = 'row gap wrap';
      grid.style.marginTop = '10px';
      // Neueste zuerst - so liegt der Stapel auch auf dem Tisch.
      [...ids].reverse().forEach((id) => {
        const tile = cardTile(id, { slim: true });
        tile.onclick = () => openCardModal(id);
        grid.appendChild(tile);
      });
      body.appendChild(grid);
    }
    $('cardModal').classList.remove('hidden');
  }

  function renderReveal() {
    const box = $('revealArea');
    box.innerHTML = '';
    if (!state.revealedDoorCard) return;
    const c = card(state.revealedDoorCard);
    const div = document.createElement('div');
    div.className = 'revealbox';
    div.innerHTML = `<h3>Aufgedeckte Türkarte</h3>`;
    div.appendChild(cardTile(state.revealedDoorCard, {}));
    if (isMyTurn()) {
      const btn = document.createElement('button');
      btn.className = 'primary';
      btn.textContent = 'Auf die Hand nehmen';
      btn.onclick = () => socket.emit('takeRevealedDoor');
      div.appendChild(btn);
    } else {
      const tp = state.players.find((p) => p.id === state.turnPlayerId);
      div.appendChild(textNode(`Warte auf ${tp ? tp.name : '?'}...`));
    }
    box.appendChild(div);
  }

  function renderCombat() {
    const box = $('combatArea');
    box.innerHTML = '';
    const c = state.combat;
    if (!c) return;
    const actor = state.players.find((p) => p.id === c.actorId);
    const helper = c.helperId ? state.players.find((p) => p.id === c.helperId) : null;
    // Die Summen kommen fertig gerechnet vom Server (playerStrength/
    // monsterStrength). Früher rechnete der Client sie selbst nach und kannte
    // dabei weder die Monsterboni gegen Rassen/Klassen ("+6 gegen Elfen") noch
    // die Sonderregeln einzelner Monster - die Anzeige wich dann von dem ab,
    // was der Server tatsächlich auswertet.
    const playerStrength = c.playerStrength;
    const monsterStrength = c.monsterStrength;

    const div = document.createElement('div');
    div.className = 'combatbox';
    div.innerHTML = `<h3>⚔️ Kampf gegen ${c.monsterIds.map((id) => card(id).name).join(' + ')}</h3>`;

    // "Untot" gilt nur fuer sein Zielmonster, nicht fuer den ganzen Kampf
    // (siehe combatHasUndead/enhancerKartenIds im Server): ein Monster ist
    // untot, wenn es von Haus aus untot ist (state.undeadMonsters, z.B.
    // MR. BONES) oder wenn genau SEIN Verstaerker die Karte UNTOT ist.
    const untotZiele = new Set((c.enhancers || [])
      .filter((e) => c.monsterIds.includes(e.monsterId))
      .filter((e) => { const ec = card(e.cardId); return ec && ec.name === 'UNTOT'; })
      .map((e) => e.monsterId));
    const istUntot = (id) => untotZiele.has(id) || (state.undeadMonsters || []).includes((card(id).name || '').toUpperCase());

    const monsterRow = document.createElement('div');
    monsterRow.className = 'cardgrid';
    c.monsterIds.forEach((id) => monsterRow.appendChild(cardTile(id, { undead: istUntot(id) })));
    div.appendChild(monsterRow);

    const iAmActor = c.actorId === myInfo.playerId;
    // Beim Weglaufen laeuft jede beteiligte Person einzeln - c.fleeingId sagt,
    // wer gerade dran ist (auch eine Helfer:in).
    const ichFliehe = c.fleeingId === myInfo.playerId;
    const iAmHelper = c.helperId === myInfo.playerId;

    // KRIEGER: "Bei Gleichstand im Kampf gewinnst du." Der Server sagt uns
    // ueber c.warriorTieWins, ob genau dieser Fall vorliegt (inkl. der
    // Verlust-Zwaenge wie LUSTMONSTER/TODESANGST, die auch bei Kriegern
    // vorgehen) - dann zaehlt Gleichstand als Sieg und die Zahl darf nicht
    // rot ("verloren") aussehen.
    const geradeGewonnen = playerStrength > monsterStrength
      || (playerStrength === monsterStrength && c.warriorTieWins);
    const strengthRow = document.createElement('div');
    strengthRow.className = 'strengthrow';
    strengthRow.innerHTML = `<div>Ihr: <span class="${geradeGewonnen ? 'strengthgood' : 'strengthbad'}">${playerStrength}</span></div>` +
      `<div class="vs">vs.</div><div>Monster: <b>${monsterStrength}</b></div>`;
    div.appendChild(strengthRow);

    // ZAUBERCOUCH: Frage zu Kampfbeginn (siehe zaubercouchFragen im Server).
    const ich = state.players.find((p) => p.id === myInfo.playerId);
    if (ich && ich.zaubercouch === 'offen') {
      const couchRow = document.createElement('div');
      couchRow.className = 'row gap wrap';
      couchRow.appendChild(textNode('Zaubercouch verwenden? (Zauberer in diesem Kampf, -1 auf Weglaufen)'));
      couchRow.appendChild(mkBtn('Ja', () => socket.emit('answerZaubercouch', { benutzen: true })));
      couchRow.appendChild(mkBtn('Nein', () => socket.emit('answerZaubercouch', { benutzen: false })));
      div.appendChild(couchRow);
    }

    // Dauerwirkungen der Monsterkarte sichtbar machen, sonst wirken die Zahlen
    // willkürlich.
    const notes = [];
    if (c.monsterTraitBonus) notes.push(`Kartenbonus des Monsters gegen eure Rasse/Klasse: +${c.monsterTraitBonus}`);
    if (c.ignoresBonuses) notes.push('Gegen dieses Monster zählt nur eure Charakterstufe - keine Gegenstände, keine Boni. Karten und Klassenkräfte, die nur der Munchkin-Seite helfen, nimmt der Server deshalb gar nicht erst an - sie bleiben auf der Hand.');
    if (c.ignoresLevel) notes.push('Gegen dieses Monster zählt eure Stufe nicht - nur eure Boni.');
    if (c.forbidsHelp) notes.push('Gegen dieses Monster darf niemand helfen.');
    if (c.doubleActor) notes.push('Doppelgänger: eure Kampfstärke zählt doppelt.');
    // Die Zusage aus der Hilfe-Anfrage bleibt sichtbar, solange sie gilt -
    // eingeloest wird sie beim Sieg (resolveCombatWin).
    if (helper && c.helperReward) {
      notes.push(`${helper.name} hilft für ${c.helperReward} der erbeuteten Schatzkarte(n).`);
    } else if (helper) {
      notes.push(`${helper.name} hilft ohne zugesagte Belohnung.`);
    }
    // Anhaltende Flueche der Kaempfenden stecken schon in der Rechnung
    // (combatTotals) - ohne Hinweis wundert man sich nur ueber die Zahl.
    [actor, c.helperId ? state.players.find((p) => p.id === c.helperId) : null]
      .filter(Boolean)
      .forEach((p) => (p.activeCurses || []).forEach((f) => {
        notes.push(`🌀 ${p.name} steht unter "${f.name}"${f.hinweis ? ` - ${f.hinweis}` : ''}`);
      }));
    // Ohne Hinweis sähe die Monsterstärke 0 wie ein Anzeigefehler aus.
    (c.autoKilledMonsters || []).forEach((name) => {
      notes.push(`${name}: von Halblingen einfach eingestampft - zählt mit Stärke 0, Stufe und Schatz gibt es trotzdem.`);
    });
    const power = myInfo.classCombatPower;
    if (power && power.remaining > 0) {
      notes.push(`Deine Klassenkraft "${power.label}": bis zu ${power.remaining} weitere Handkarte(n) ablegen für je +${power.bonus} ` +
        `${power.kind === 'flee' ? 'auf Weglaufen' : 'im Kampf'} - die Knöpfe stehen unten an deinen Handkarten.`);
    }
    notes.forEach((t) => {
      const el = document.createElement('div');
      el.className = 'hint';
      el.textContent = t;
      div.appendChild(el);
    });

    // KLEBERFLÄSCHCHEN (auf eine gelungene Flucht) - das Wurf-Fenster steht
    // in renderRollReaction, weil gewuerfelt auch ausserhalb eines Kampfes
    // wird (Dungeon-Casino, Amulett, Schlimme Dinge).
    if (c.escapeReactionOffer && c.escapeReactionOffer.includes(myInfo.playerId)) {
      const row = document.createElement('div');
      row.className = 'row gap wrap';
      row.appendChild(textNode(`${actor.name} ist entkommen - du darfst noch ein "KLEBERFLÄSCHCHEN" spielen und die Flucht wiederholen lassen.`));
      row.appendChild(mkBtn('Passen', () => socket.emit('passReaction', {})));
      div.appendChild(row);
    }

    // TROJANISCHER PFERD (nach einem Kampfsieg, bevor der Schatz gezogen
    // wird) - Passen sendet dasselbe generische passReaction wie beim
    // Kleberfläschchen-Fenster.
    if (c.trojanerOffer && c.trojanerOffer.includes(myInfo.playerId)) {
      const row = document.createElement('div');
      row.className = 'row gap wrap';
      row.appendChild(textNode(`${actor.name} hat gewonnen und will einen Schatz ziehen - du darfst noch ein "TROJANISCHES PFERD" spielen.`));
      row.appendChild(mkBtn('Passen', () => socket.emit('passReaction', {})));
      div.appendChild(row);
    }

    // Jede:r am Tisch darf hier eingreifen - nicht nur Angreifer:in/Helfer:in -
    // um z.B. einen Fluch oder eine Hilfskarte zu verrechnen, die nicht
    // automatisch erkannt wird (Monster-Verstärkerkarten mit festem Bonus
    // rechnen sich weiter unten automatisch ein, siehe "Im Kampf spielen").
    if (!c.mustFlee && !c.trojanerOffer && !c.trojanerDone) {
      const modRow = document.createElement('div');
      modRow.className = 'row gap wrap';
      modRow.innerHTML = `
        <label style="margin:0">Bonus/Malus der Kämpfenden (Karteneffekte manuell eintragen)
          <input type="number" id="actorModInput" value="${c.actorModifier}" style="width:80px">
        </label>
        <label style="margin:0">Monster Bonus/Malus (Karteneffekte manuell eintragen)
          <input type="number" id="monsterModInput" value="${c.monsterModifier}" style="width:80px">
        </label>`;
      div.appendChild(modRow);
      div.appendChild(textNode('Jede:r am Tisch darf hier eintragen - z.B. um dem Monster zu helfen/schaden oder den Kämpfenden zu unterstützen.'));
      modRow.querySelector('#actorModInput').onchange = (e) => socket.emit('setCombatModifier', { who: 'actor', value: e.target.value });
      modRow.querySelector('#monsterModInput').onchange = (e) => socket.emit('setCombatModifier', { who: 'monster', value: e.target.value });
    }

    // Bereit-Check: ausgewertet wird erst, wenn niemand mehr eingreifen will.
    // Wer bestätigen muss, sagt der Server (readyRequired) - Bots und
    // Getrennte sind da nicht dabei.
    const required = c.readyRequired || [];
    if (!c.mustFlee && required.length) {
      const readyRow = document.createElement('div');
      readyRow.className = 'readyrow';
      readyRow.appendChild(textNode('Bereit zur Auswertung:'));
      required.forEach((pid) => {
        const p = state.players.find((x) => x.id === pid);
        const tag = document.createElement('span');
        const ok = !!(c.ready && c.ready[pid]);
        tag.className = `readytag ${ok ? 'yes' : 'no'}`;
        tag.textContent = `${ok ? '✅' : '⬜'} ${p ? p.name : '?'}`;
        readyRow.appendChild(tag);
      });
      div.appendChild(readyRow);

      if (required.includes(myInfo.playerId)) {
        const mine = !!(c.ready && c.ready[myInfo.playerId]);
        const btn = document.createElement('button');
        btn.className = mine ? '' : 'primary';
        btn.textContent = mine ? 'Doch noch nicht bereit' : '✅ Bereit - auswerten kann losgehen';
        btn.onclick = () => socket.emit('setCombatReady', { ready: !mine });
        div.appendChild(btn);
        if (!mine) div.appendChild(textNode('Solange du nicht bereit bist, kann der Kampf nicht ausgewertet werden - spiel jetzt, was du noch spielen willst.'));
      }
    }

    const actions = document.createElement('div');
    actions.className = 'row gap wrap';

    if (iAmActor && !c.mustFlee && !c.trojanerOffer && !c.trojanerDone) {
      const evalBtn = document.createElement('button');
      evalBtn.className = 'primary'; evalBtn.textContent = 'Kampf auswerten';
      evalBtn.disabled = !c.allReady;
      evalBtn.onclick = () => socket.emit('evaluateCombat');
      actions.appendChild(evalBtn);
      if (!c.allReady) {
        const offen = required.filter((pid) => !(c.ready && c.ready[pid]))
          .map((pid) => { const p = state.players.find((x) => x.id === pid); return p ? p.name : '?'; });
        actions.appendChild(textNode(`Warte auf: ${offen.join(', ')}`));
      }

      if (!c.helperId && !c.helperPending) {
        // Zusage: wie viele der erbeuteten Schatzkarten die Helfer:in bekommt.
        // Die Obergrenze ist die Schatzzahl des Kampfes - der Server klemmt
        // denselben Wert noch einmal (Fremdeingabe).
        // kampfSchatzZahl kommt fertig gerechnet vom Server (siehe
        // combatConditionalBonusFields) - eigenes Nachrechnen kannte den
        // Verstaerker-Anteil nicht mehr, seit der am Monster statt kampfweit
        // haengt (enhancers statt treasureDelta), und lief auseinander.
        const maxSchaetze = c.kampfSchatzZahl || 0;
        const lohn = document.createElement('input');
        lohn.type = 'number'; lohn.min = '0';
        lohn.value = '0'; lohn.style.width = '4em'; lohn.title = 'Zugesagte Schatzkarten';
        lohn.max = String(maxSchaetze);
        const helpSelect = document.createElement('select');
        helpSelect.innerHTML = '<option value="">Um Hilfe bitten...</option>' +
          state.players.filter((p) => p.id !== c.actorId && p.connected)
            .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
        helpSelect.onchange = () => {
          if (helpSelect.value) socket.emit('requestHelp', { targetId: helpSelect.value, reward: Number(lohn.value) || 0 });
        };
        actions.appendChild(helpSelect);
        actions.appendChild(textNode('Zusage:'));
        actions.appendChild(lohn);
        actions.appendChild(textNode(`Schatzkarte(n) (max. ${maxSchaetze})`));
      }
      if (c.helperPending) {
        actions.appendChild(textNode(`Warte auf Antwort von ${state.players.find((p) => p.id === c.helperPending.targetId).name}`
          + `${c.helperPending.reward ? ` (Zusage: ${c.helperPending.reward} Schatzkarte(n))` : ' (ohne Belohnung)'}...`));
      }
    }

    if (c.helperPending && c.helperPending.targetId === myInfo.playerId) {
      const ask = document.createElement('div');
      const asker = state.players.find((p) => p.id === c.actorId);
      const zusage = c.helperPending.reward || 0;
      ask.innerHTML = `<b>${escapeHtml(asker ? asker.name : '?')} bittet dich um Hilfe im Kampf!</b>`
        + `<div class="hint">${zusage ? `Zugesagt: ${zusage} der erbeuteten Schatzkarte(n) für dich.` : 'Ohne Belohnung - alles bleibt bei der kämpfenden Person.'}</div>`;
      const yes = document.createElement('button'); yes.textContent = 'Helfen'; yes.className = 'primary';
      yes.onclick = () => socket.emit('respondHelp', { accept: true });
      const no = document.createElement('button'); no.textContent = 'Ablehnen';
      no.onclick = () => socket.emit('respondHelp', { accept: false });
      ask.appendChild(yes); ask.appendChild(no);
      div.appendChild(ask);
    }

    // HALBLING: nach dem verpatzten ersten Wurf noch eine Entscheidung -
    // 1 Handkarte ablegen und nochmal würfeln (Knopf an der Karte) oder das
    // Miese Zeug hinnehmen. Solange das offen ist, kein neuer Wurf.
    // ZAUBERER "Verzauberung": ganze Hand gegen Monster+Schatz, keine Stufe.
    const enchant = myInfo.classEnchant;
    if (enchant && !c.mustFlee) {
      const btn = mkBtn(`✨ Verzauberung: ganze Hand ablegen (${enchant.handCount} Karten) und "${enchant.monsterName}" verzaubern - Schatz ja, Stufe nein`,
        () => socket.emit('enchantMonster', {}));
      btn.className = 'primary';
      div.appendChild(btn);
    }

    // BARDE "Verzaubern": Karte abwerfen, Rivalen waehlen, beide wuerfeln -
    // bei hoeherem Wurf muss der Rivale ohne Belohnung helfen. Kein Muster im
    // Client fuer "Handkarte zuerst waehlen dann Knopf" - deshalb je Rivale
    // ein Knopf, der die erste Handkarte abwirft.
    // ponytail: keine Kartenauswahl vor dem Klick, nur die erste Handkarte.
    // Aufruestweg: eigener Kartenwaehler wie bei anderen Klassenkraeften, falls
    // das je stoert.
    const verzaubern = myInfo.bardeVerzaubern;
    if (verzaubern && !c.mustFlee && myInfo.hand.length) {
      const cardId = myInfo.hand[0];
      const box = document.createElement('div');
      box.className = 'row gap wrap';
      verzaubern.rivalen.forEach((rivale) => {
        const btn = mkBtn(`🎵 Verzaubern: ${escapeHtml(rivale.name)} (1 Karte abwerfen)`,
          () => socket.emit('bardeVerzaubern', { cardId, targetId: rivale.id }));
        box.appendChild(btn);
      });
      div.appendChild(box);
    }

    const lampIds = myInfo.lampCardIds || [];
    if (isMyTurn() && lampIds.length && !c.fleeRerollOffer) {
      const lampBox = document.createElement('div');
      lampBox.className = 'row gap wrap';
      lampBox.style.marginTop = '6px';
      lampIds.forEach((lampId) => {
        (c.monsterIds || []).forEach((monsterId) => {
          const txt = (c.monsterIds.length === 1)
            ? `🧞 "${card(lampId).name}": "${card(monsterId).name}" verschwinden lassen (Schatz ja, keine Stufe)`
            : `🧞 "${card(lampId).name}": "${card(monsterId).name}" verschwinden lassen`;
          const btn = mkBtn(txt, () => socket.emit('useLamp', { cardId: lampId, monsterId }));
          btn.className = 'primary';
          lampBox.appendChild(btn);
        });
      });
      div.appendChild(lampBox);
    }

    if (ichFliehe && c.fleeRerollOffer) {
      const escapeIds = myInfo.fleeEscapeCardIds || [];
      const wege = [];
      if (c.canReroll) wege.push('als Halbling 1 Handkarte ablegen (Knopf unter der Karte) und noch einmal würfeln');
      if (escapeIds.length) wege.push('eine Rettungskarte ablegen und automatisch entkommen');
      const lampIds = myInfo.lampCardIds || [];
      if (lampIds.length) wege.push('die Magische Lampe nutzen und ein Monster verschwinden lassen');
      div.appendChild(textNode(`Der Wurf ist misslungen - du kannst noch ${wege.join(' oder ')}. Oder du stellst dich dem Miesen Zeug.`));
      escapeIds.forEach((escId) => {
        const btn = mkBtn(`🫥 "${card(escId).name}" ablegen und automatisch entkommen`, () => socket.emit('fleeEscape', { cardId: escId }));
        btn.className = 'primary';
        div.appendChild(btn);
      });
      // MAGISCHE LAMPE: pro gehaltener Lampe und pro Monster im Kampf ein
      // Knopf - war es das einzige Monster, gibt es dafür noch seinen Schatz.
      lampIds.forEach((lampId) => {
        c.monsterIds.forEach((monsterId) => {
          const btn = mkBtn(`🧞 "${card(lampId).name}": "${card(monsterId).name}" verschwinden lassen`,
            () => socket.emit('useLamp', { cardId: lampId, monsterId }));
          btn.className = 'primary';
          div.appendChild(btn);
        });
      });
      const acceptBtn = mkBtn('Miesem Zeug stellen', () => socket.emit('fleeReroll', { cardId: null }));
      div.appendChild(acceptBtn);
    } else if (ichFliehe && c.mustFlee) {
      div.appendChild(textNode('Ihr verliert diesen Kampf - jetzt fliehen (Würfelwurf ≥ 5 nötig)!'));
      const fleeRow = document.createElement('div');
      fleeRow.className = 'row gap';
      fleeRow.innerHTML = `<label style="margin:0">Wurf-Modifikator <input type="number" id="fleeModInput" value="0" style="width:70px"></label>`;
      const fleeBtn = document.createElement('button');
      fleeBtn.className = 'primary'; fleeBtn.textContent = '🎲 Fliehen';
      fleeBtn.onclick = () => socket.emit('attemptFlee', { modifier: fleeRow.querySelector('#fleeModInput').value });
      fleeRow.appendChild(fleeBtn);
      div.appendChild(fleeRow);
    } else if (c.mustFlee && c.fleeingId) {
      // Wer nicht gerade dran ist, sieht wenigstens, auf wen gewartet wird -
      // beim Weglaufen laeuft jede beteiligte Person einzeln.
      const wer = (state.players.find((p) => p.id === c.fleeingId) || {}).name || '?';
      div.appendChild(textNode(`Ihr verliert diesen Kampf. ${wer} läuft gerade weg - danach ist die nächste beteiligte Person dran.`));
    }

    div.appendChild(actions);
    box.appendChild(div);
  }

  // Wurf-Reaktionsfenster (GEZINKTER WÜRFEL, KATZENINTERVENTION). Bewusst
  // ausserhalb von renderCombat: gewuerfelt wird auch ohne Kampf, und ohne
  // diesen Kasten gaebe es dann keinen "Passen"-Knopf - das Spiel haenge.
  // Das Ausspielen selbst passiert an der Handkarte (siehe handActionsFor).
  // Wurf-Reaktionsfenster (GEZINKTER WÜRFEL, KATZENINTERVENTION). Bewusst
  // ausserhalb von renderCombat: gewuerfelt wird auch ohne Kampf, und ohne
  // diesen Kasten gaebe es dann keinen "Passen"-Knopf - das Spiel haenge.
  // Das Ausspielen selbst passiert an der Handkarte (siehe handActionsFor).
  // Vorbereitungsrunde vor dem ersten Zug: alle legen gleichzeitig ihre
  // Ausruestung an und melden sich bereit.
  function renderPrep() {
    const box = $('prepArea');
    box.innerHTML = '';
    if (state.turnPhase !== 'vorbereitung') return;
    const bereit = state.prepReady || {};
    const div = document.createElement('div');
    div.className = 'consequencebox';
    div.innerHTML = '<h3>⚔️ Vorbereitung</h3>'
      + '<p>Legt jetzt eure Ausrüstung an - danach geht das nur noch im eigenen Zug und nie im Kampf.</p>';
    const liste = document.createElement('div');
    liste.className = 'row gap wrap';
    state.players.forEach((p) => {
      liste.appendChild(smallTag(`${bereit[p.id] ? '✅' : '⏳'} ${p.name}`, bereit[p.id] ? '#2e7d32' : '#777'));
    });
    div.appendChild(liste);
    // Zuschauer:innen sind nicht Teil von state.players - fuer sie gibt es
    // nichts anzulegen/zu bestaetigen, der Knopf waere irrefuehrend.
    if (me()) {
      const row = document.createElement('div');
      row.className = 'row gap wrap';
      row.style.marginTop = '8px';
      const btn = mkBtn(bereit[myInfo.playerId] ? 'Doch noch nicht bereit' : 'Bereit', () => socket.emit('prepReady', { ready: !bereit[myInfo.playerId] }));
      if (!bereit[myInfo.playerId]) btn.className = 'primary';
      row.appendChild(btn);
      div.appendChild(row);
    }
    box.appendChild(div);
  }

  function renderRollReaction() {
    const box = $('rollReactionArea');
    box.innerHTML = '';
    if (!state.pendingRoll || !state.pendingRoll.holders.includes(myInfo.playerId)) return;
    const div = document.createElement('div');
    div.className = 'consequencebox';
    const werfer = state.players.find((p) => p.id === state.pendingRoll.playerId);
    const row = document.createElement('div');
    row.className = 'row gap wrap';
    row.appendChild(textNode(`${werfer ? werfer.name : '?'} hat ${state.pendingRoll.roll} gewürfelt - du darfst noch mit einer Würfel-Reaktionskarte reagieren.`));
    row.appendChild(mkBtn('Passen', () => socket.emit('passReaction', {})));
    div.appendChild(row);
    box.appendChild(div);
  }

  function renderConsequence() {
    const box = $('consequenceArea');
    box.innerHTML = '';
    const pc = state.pendingConsequence;
    if (!pc) return;
    const player = state.players.find((p) => p.id === pc.playerId);
    // Bei einem gespielten/umgelenkten Fluch weicht die Person, die ihn
    // ausgeloest hat, vom Opfer ab - dann zeigen wir das an ("von X verflucht"),
    // sonst (normaler eigener Tuerzug) waere es nur eine Wiederholung des Namens.
    const caster = pc.casterId ? state.players.find((p) => p.id === pc.casterId) : null;
    const div = document.createElement('div');
    div.className = 'consequencebox';
    div.innerHTML = `<h3>${pc.kind === 'curse' ? '💀 Fluch' : '☠️ Schlimme Dinge'} - ${escapeHtml(player.name)}</h3>` +
      (pc.kind === 'curse' && caster && caster.id !== player.id
        ? `<p class="hint">Verflucht von ${escapeHtml(caster.name)}</p>` : '') +
      `<p>${pc.text ? formatCardText(pc.text) : '(kein Text)'}</p>` +
      (pc.autoApplied ? `<p class="autoconsequence">✅ <b>Automatisch berechnet:</b> ${escapeHtml(pc.autoApplied)}</p>` : '');
    if (pc.cardId) div.appendChild(cardTile(pc.cardId, {}));

    if (pc.playerId === myInfo.playerId) {
      if (pc.choice) {
        const choiceBox = document.createElement('div');
        choiceBox.className = 'row gap wrap';
        choiceBox.appendChild(textNode('Diese Karte lässt dich wählen - jede Option wird automatisch berechnet:'));
        pc.choice.options.forEach((opt) => {
          const btn = document.createElement('button');
          btn.className = 'primary'; btn.textContent = opt.label;
          btn.onclick = () => socket.emit('resolveConsequenceChoice', { optionId: opt.id });
          choiceBox.appendChild(btn);
        });
        div.appendChild(choiceBox);
      }
      div.appendChild(textNode(pc.autoApplied
        ? 'Die eindeutige Auswirkung wurde bereits automatisch angewendet (siehe oben). Falls die Karte noch weitere Effekte hat (z. B. einen Gegenstand ablegen), erledige das jetzt noch, dann "Fertig".'
        : (pc.choice ? 'Wähle oben eine Option, dann "Fertig". (Oder wende die Auswirkung manuell mit den Werkzeugen unten an.)' : 'Wende die Auswirkung mit den Werkzeugen unten an (Original-Kartentext oben beachten), dann "Fertig".')));
      const tools = document.createElement('div');
      tools.className = 'row gap wrap';
      const minus = document.createElement('button'); minus.textContent = '-1 Stufe';
      minus.onclick = () => socket.emit('applyConsequenceAction', { type: 'levelDelta', delta: -1 });
      const plus = document.createElement('button'); plus.textContent = '+1 Stufe';
      plus.onclick = () => socket.emit('applyConsequenceAction', { type: 'levelDelta', delta: 1 });
      const death = document.createElement('button'); death.className = 'danger'; death.textContent = '💀 Ich bin gestorben';
      death.onclick = () => { if (confirm('Charakter wirklich zurücksetzen (Stufe 1, Hand & Ausrüstung leer)?')) socket.emit('applyConsequenceAction', { type: 'death' }); };
      tools.appendChild(minus); tools.appendChild(plus); tools.appendChild(death);
      div.appendChild(tools);

      const myPlayer = me();
      const discardables = [...myPlayer.hand || myInfo.hand, ...[]];
      const allMine = [...myInfo.hand, ...equippedIdsOf(myPlayer)];
      if (allMine.length) {
        const sel = document.createElement('select');
        sel.innerHTML = '<option value="">Gegenstand/Karte ablegen...</option>' +
          allMine.map((id) => `<option value="${id}">${escapeHtml(card(id).name)}</option>`).join('');
        sel.onchange = () => { if (sel.value) { socket.emit('applyConsequenceAction', { type: 'discardCard', cardId: sel.value }); sel.value = ''; } };
        div.appendChild(sel);
      }

      const doneBtn = document.createElement('button');
      doneBtn.className = 'primary'; doneBtn.textContent = 'Fertig';
      doneBtn.onclick = () => socket.emit('ackConsequence');
      div.appendChild(doneBtn);
    } else {
      div.appendChild(textNode('Warte darauf, dass die Auswirkung angewendet wird...'));
    }
    box.appendChild(div);
  }

  function renderCardAction() {
    const box = $('cardActionArea');
    box.innerHTML = '';
    const pa = state.pendingCardAction;
    if (!pa) return;
    const div = document.createElement('div');
    div.className = 'consequencebox';
    if (pa.playerId !== myInfo.playerId) {
      const owner = state.players.find((p) => p.id === pa.playerId);
      div.innerHTML = `<h3>✨ "${escapeHtml(pa.cardName)}"</h3><p>Warte auf ${owner ? escapeHtml(owner.name) : '?'}...</p>`;
      box.appendChild(div);
      return;
    }
    if (pa.kind === 'choice') {
      div.innerHTML = `<h3>✨ "${escapeHtml(pa.cardName)}" - Wahl</h3>`;
      const row = document.createElement('div');
      // Zeigt jede Option als volle Kachel statt als reinen Text-Knopf, wenn
      // ALLE Options-Ids echte Karten sind (z.B. FINDE EINE KARTE, FLOHMARKT)
      // - man sieht dann tatsaechlich, welche Karte man waehlt, statt nur
      // "NAME (kategorie)" als Knopftext zu lesen (Bugreport 2026-09-19).
      // Gemischte Listen (z.B. mit einer "keine Karte"-Option) behalten die
      // schlichten Text-Knoepfe, weil sich dafuer keine Kachel zeichnen laesst.
      const alleEchtenKarten = pa.options.length > 0 && pa.options.every((o) => !!cardIndex[o.id]);
      if (alleEchtenKarten) {
        row.className = 'cardgrid';
        pa.options.forEach((opt) => {
          const tile = cardTile(opt.id, {});
          const btn = mkBtn('Wählen', () => socket.emit('resolveCardChoice', { optionId: opt.id }));
          btn.className = 'primary';
          tile.querySelector('.ctbody').appendChild(btn);
          row.appendChild(tile);
        });
      } else {
        row.className = 'row gap wrap';
        pa.options.forEach((opt) => {
          const btn = mkBtn(opt.label, () => socket.emit('resolveCardChoice', { optionId: opt.id }));
          btn.className = 'primary';
          row.appendChild(btn);
        });
      }
      div.appendChild(row);
    } else if (pa.kind === 'targetPlayer') {
      div.innerHTML = `<h3>✨ "${escapeHtml(pa.cardName)}" - ${escapeHtml(pa.prompt || 'Ziel wählen')}</h3>`;
      const row = document.createElement('div');
      row.className = 'row gap wrap';
      pa.candidateIds.forEach((pid) => {
        const target = state.players.find((p) => p.id === pid);
        const btn = mkBtn(target ? target.name : pid, () => socket.emit('resolveCardTarget', { targetId: pid }));
        btn.className = 'primary';
        row.appendChild(btn);
      });
      div.appendChild(row);
    } else if (pa.kind === 'chooseCard') {
      div.innerHTML = `<h3>✨ "${escapeHtml(pa.cardName)}" - ${escapeHtml(pa.prompt || 'Karte wählen')}</h3>`;
      const row = document.createElement('div');
      row.className = 'cardgrid';
      pa.candidateIds.forEach((cid) => {
        const tile = cardTile(cid, {});
        const btn = mkBtn('Nehmen', () => socket.emit('resolveCardCardChoice', { cardId: cid }));
        btn.className = 'primary';
        tile.querySelector('.ctbody').appendChild(btn);
        row.appendChild(tile);
      });
      if (!pa.candidateIds.length) row.appendChild(textNode('(Ablagestapel sind leer.)'));
      div.appendChild(row);
    } else if (pa.kind === 'multiCardSelection') {
      // Die Haekchen an den einzelnen Handkarten kommen aus handActionsFor
      // (siehe multiSelection weiter unten) - hier nur Kopf, Zaehler und die
      // zwei "Ziehen aus..."-Knoepfe, deren Klickhandler updateMultiSelectionBar
      // gleich danach setzt (ueber renderMyPanel -> renderHand, das nach
      // renderCardAction laeuft).
      div.innerHTML = `<h3>✨ "${escapeHtml(pa.cardName || 'Schicksalhafte Karten')}"</h3>` +
        `<p>Wähle unten auf deinen Handkarten beliebig viele zum Abwerfen aus (Häkchen "Abwerfen") und ziehe genauso viele neue Karten nach.</p>`;
      const sum = document.createElement('p');
      sum.id = 'multiSelectionSum';
      sum.className = 'hint';
      sum.textContent = '0 Karten ausgewählt';
      div.appendChild(sum);
      const row = document.createElement('div');
      row.className = 'row gap wrap';
      const btnD = mkBtn('🚪 Neue Türkarten ziehen', () => {});
      btnD.id = 'btnMultiDoor';
      btnD.className = 'primary';
      const btnT = mkBtn('💰 Neue Schatzkarten ziehen', () => {});
      btnT.id = 'btnMultiTreasure';
      btnT.className = 'primary';
      row.append(btnD, btnT);
      div.appendChild(row);
    }
    box.appendChild(div);
  }

  // Spezialplaetze ("Spezialausruestung", "Beine") kommen als Konfiguration
  // vom Server (state.specialSlots / state.specialSlotItems) - hier wird
  // bewusst keine zweite Kartenliste gepflegt.
  function specialSlotIds(p) {
    return Object.keys(state.specialSlots || {}).flatMap((k) => {
      const v = p.equipped[k];
      return Array.isArray(v) ? v.filter(Boolean) : (v ? [v] : []);
    });
  }

  // Wie equippedItemIds im Server: ein zweihaendiger Gegenstand steht in
  // beiden Handslots und darf trotzdem nur einmal gezaehlt/angezeigt werden.
  function equippedIdsOf(p) {
    if (!p) return [];
    return [...new Set([p.equipped.head, p.equipped.armor, p.equipped.feet, ...p.equipped.hands,
      ...specialSlotIds(p)].filter(Boolean))];
  }

  function renderPhaseActions() {
    const box = $('phaseActions');
    box.innerHTML = '';
    // pendingRoll: solange ein Wurf-Fenster offen ist, nimmt der Server keine
    // Phasenaktion an (siehe handleDrawDoor) - dann auch keinen Knopf zeigen.
    if (state.phase === 'gameend' || state.combat || state.pendingConsequence
      || state.pendingCardAction || state.pendingRoll || state.turnPhase === 'vorbereitung') return;
    if (!isMyTurn()) { box.appendChild(textNode(isSpectator ? '👀 Du schaust nur zu - keine eigenen Aktionen.' : 'Warte, bis du an der Reihe bist...')); return; }

    if (state.turnPhase === 'tuer' && !state.revealedDoorCard) {
      const btn = document.createElement('button'); btn.className = 'primary phase-btn'; btn.textContent = '🚪 Tür eintreten (Karte aufdecken)';
      btn.onclick = () => socket.emit('drawDoor');
      box.appendChild(btn);
    } else if (state.turnPhase === 'aerger') {
      const skip = document.createElement('button'); skip.className = 'primary phase-btn'; skip.textContent = 'Kein Monster spielen -> weiter';
      skip.onclick = () => socket.emit('skipToLoot');
      box.appendChild(skip);
      const keinAergerFluch = ((me() || {}).activeCurses || []).some((f) => f.kind === 'keinAerger');
      box.appendChild(textNode(keinAergerFluch
        ? 'Touristenfalle: du darfst kein Monster aus der Hand spielen.'
        : 'Du kannst stattdessen unten bei einer Monster-Karte in deiner Hand "Als Monster spielen" wählen.'));
    } else if (state.turnPhase === 'pluendern') {
      const btn = document.createElement('button'); btn.className = 'primary phase-btn'; btn.textContent = '📦 Raum plündern (verdeckt ziehen)';
      btn.onclick = () => socket.emit('lootRoom');
      box.appendChild(btn);
    } else if (state.turnPhase === 'gabe') {
      const myPlayer = me();
      // Limit kommt vom Server - Zwerge dürfen laut Kartentext 6 Karten halten.
      const limit = (myPlayer && myPlayer.handLimit) || 5;
      const over = myPlayer ? myInfo.hand.length - limit : 0;
      if (over > 0) {
        box.appendChild(textNode(`Milde Gabe: bitte noch ${over} Karte(n) ablegen (max. ${limit} auf der Hand).`));
      } else {
        const btn = document.createElement('button'); btn.className = 'primary phase-btn'; btn.textContent = 'Zug beenden';
        btn.onclick = () => socket.emit('endTurn');
        box.appendChild(btn);
      }
    }
  }

  // Wessen Ausruestung/Hand gerade in #myPanel/#hand-bar angezeigt wird:
  // die eigene (me()), oder - als Zuschauer:in - die gerade ausgewaehlte
  // Person (siehe renderSpectateSelect).
  function panelTarget() { return isSpectator ? state.players.find((pl) => pl.id === spectateTargetId) : me(); }

  function renderSpectateSelect() {
    const sel = $('spectateSelect');
    if (!sel) return;
    sel.classList.toggle('hidden', !isSpectator);
    if (!isSpectator) return;
    // Ziel verloren (Person hat den Raum verlassen) oder noch keins gewaehlt:
    // auf die erste Person zurueckfallen, statt eine leere Ansicht zu zeigen.
    if (!spectateTargetId || !state.players.some((pl) => pl.id === spectateTargetId)) {
      spectateTargetId = state.players.length ? state.players[0].id : null;
    }
    const optionsHtml = state.players.map((pl) => `<option value="${pl.id}">${escapeHtml(pl.name)}${pl.isBot ? ' 🤖' : ''}</option>`).join('');
    if (sel.dataset.opts !== optionsHtml) { sel.innerHTML = optionsHtml; sel.dataset.opts = optionsHtml; }
    sel.value = spectateTargetId || '';
    sel.onchange = () => { spectateTargetId = sel.value; renderMyPanel(); };
  }

  function renderMyPanel() {
    const p = panelTarget();
    const label = $('myPanelLabel');
    if (label) label.textContent = isSpectator ? `👀 ${p ? p.name : '...'}` : 'Meine Figur';
    if (!p) {
      // Niemand im Raum (noch) oder Zuschauer:in ohne Auswahl - Panel/Hand leeren.
      ['myLevel', 'myStrength', 'myBadges', 'myCurses', 'myEquip', 'myHand'].forEach((id) => { const el = $(id); if (el) el.innerHTML = ''; });
      const curses = $('myCurses');
      if (curses) curses.classList.add('hidden');
      return;
    }
    $('myLevel').textContent = p.level;
    // Im eingeklappten Zustand bleibt nur .mypanel-head sichtbar - die
    // Kampfstaerke gehoert deshalb (wie Stufe und Rasse/Klasse) dort hinein,
    // nicht in die (dann versteckte) Ausruestungsreihe.
    const strengthTag = $('myStrength');
    if (strengthTag) strengthTag.textContent = `⚔ ${p.strength}`;

    const badges = $('myBadges');
    badges.innerHTML = '';
    p.races.forEach((id) => badges.appendChild(traitTag(p, id, 'var(--c-race)')));
    p.classes.forEach((id) => badges.appendChild(traitTag(p, id, 'var(--c-class)')));
    (p.powerGroups || []).forEach((id) => badges.appendChild(smallTag(card(id).name, 'var(--c-class)', id)));
    if (hatAmnesie(p) || (!p.races.length && !p.classes.length && !(p.powerGroups || []).length)) badges.appendChild(textNode('Mensch, ohne Klasse'));
    if (p.raceCapCard) badges.appendChild(smallTag(card(p.raceCapCard).name, 'var(--c-race)', p.raceCapCard));
    if (p.classCapCard) badges.appendChild(smallTag(card(p.classCapCard).name, 'var(--c-class)', p.classCapCard));
    if (p.powerGroupCapCard) badges.appendChild(smallTag(card(p.powerGroupCapCard).name, 'var(--c-class)', p.powerGroupCapCard));

    // Anhaltende Flueche bekommen eine eigene Zeile (siehe #myCurses in
    // index.html) statt zusammen mit Stufe/Rasse/Klasse in einer Zeile zu
    // laufen - nur sichtbar, solange tatsaechlich ein Fluch aktiv ist.
    const curses = $('myCurses');
    if (curses) {
      curses.innerHTML = '';
      curseTags(p, curses);
      curses.classList.toggle('hidden', !(p.activeCurses || []).length);
    }

    const equip = $('myEquip');
    equip.innerHTML = '';
    const slotDefs = [
      ['head', 'Kopf', p.equipped.head],
      ['armor', 'Rüstung', p.equipped.armor],
      ['feet', 'Schuhe', p.equipped.feet],
      ['hand1', 'Hand 1', p.equipped.hands[0]],
      ['hand2', 'Hand 2', p.equipped.hands[1]],
      ...specialSlotRows(p),
    ];
    slotDefs.forEach(([key, label, cardId]) => {
      const el = document.createElement('div');
      el.className = 'equipslot' + (cardId ? ' filled' : '');
      if (cardId) {
        const c = card(cardId);
        const img = document.createElement('img');
        img.className = 'eqimg'; img.alt = ''; img.src = cardImageUrl(cardId);
        img.onerror = () => img.remove();
        el.innerHTML = `<b>${label}</b>`;
        el.appendChild(img);
        el.appendChild(document.createTextNode(`${c.name}${c.bonus ? ` (+${c.bonus})` : ''}${anhangText(cardId)}`));
        // Getragene Karte gross ansehen - wie in der Ausruestung anderer
        // Spieler:innen (openPlayerModal) und an den Handkarten.
        el.classList.add('clickable');
        el.title = 'Karte groß ansehen';
        el.onclick = () => openCardModal(cardId);
        // Ablegen ist dieselbe Ausruestungsaenderung wie Anlegen - im Kampf
        // weist der Server sie ab, dann gibt es hier auch keinen Knopf.
        // Zuschauer:innen aendern grundsaetzlich NIE fremde Ausruestung.
        if (!isSpectator && darfAusruesten()) {
          const btn = document.createElement('button');
          btn.className = 'small'; btn.textContent = 'ablegen';
          // stopPropagation: sonst oeffnet das Ablegen zugleich die Grossansicht.
          btn.onclick = (e) => { e.stopPropagation(); socket.emit('unequipItem', { cardId }); };
          el.appendChild(btn);
        }
      } else {
        el.innerHTML = `<b>${label}</b><span class="hint">leer</span>`;
      }
      equip.appendChild(el);
    });

    renderHand(p);
  }

  // ids: optional - die anzuzeigende Handkarten-Liste. Ohne Angabe die eigene
  // (myInfo.hand); die Zuschauer-Ansicht (siehe renderHand) uebergibt hier
  // explizit die gerade ausgewaehlte fremde Hand.
  function sortedHand(ids) {
    ids = ids || myInfo.hand;
    if (!handSort) return ids;
    // Kopie: die Reihenfolge kommt vom Server und bleibt die Wahrheit (z.B.
    // fürs Ablegen beim Bot-Zug).
    return ids.slice().sort((a, b) => {
      const ca = card(a);
      const cb = card(b);
      const ia = HAND_SORT_ORDER.indexOf(ca.category);
      const ib = HAND_SORT_ORDER.indexOf(cb.category);
      if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      return ca.name.localeCompare(cb.name, 'de');
    });
  }

  function renderHand(p) {
    const box = $('myHand');
    box.innerHTML = '';
    const label = $('handBarLabel');
    if (label) label.textContent = isSpectator ? 'Handkarten von:' : 'Deine Hand';
    // Verkaufen ist eine Aktion mit der EIGENEN Hand - fuer Zuschauer:innen
    // ergibt die Leiste keinen Sinn und bleibt versteckt.
    const sellBar = $('sellBar');
    if (sellBar) sellBar.closest('.hand-bar-bottom').classList.toggle('hidden', isSpectator);

    const powersBox = $('handPowers');
    powersBox.innerHTML = '';
    if (!isSpectator) {
      // PRIESTER "Auferstehung": nicht an eine einzelne Karte gebunden, also in
      // einer eigenen Leiste ÜBER der Hand statt als Kachel dazwischen - sie ist
      // keine Karte und soll auch nicht wie eine aussehen. Welche Stapel gehen,
      // sagt der Server.
      (myInfo.resurrectPiles || []).forEach((pile) => {
        if (state.pendingCardAction || state.pendingRoll) return;
        const btn = mkBtn(`✝️ Auferstehung statt Tür eintreten: oberste Karte vom ${pile === 'door' ? 'Tür' : 'Schatz'}-Ablagestapel nehmen (kostet 1 Handkarte)`,
          () => socket.emit('priestResurrect', { pile }));
        btn.classList.remove('small');
        powersBox.appendChild(btn);
      });
    }
    powersBox.classList.toggle('hidden', !powersBox.children.length);
    if (handSortInput) handSortInput.checked = handSort;

    if (isSpectator) {
      // Reine Lese-Ansicht: Karten der ausgewaehlten Person, OHNE jede
      // Aktion (kein Ausspielen/Anlegen/Ablegen/Verkaufen) - siehe
      // sendSpectatorInfo auf dem Server (alle Haende, nur fuer Zuschauer:innen).
      const ids = (p && spectatorHands[p.id]) || [];
      sortedHand(ids).forEach((id) => box.appendChild(cardTile(id, { hand: true })));
      return;
    }
    sortedHand().forEach((id) => {
      const tile = cardTile(id, { hand: true });
      tile.querySelector('.ctbody').appendChild(handActionsFor(id, p));
      box.appendChild(tile);
    });
    updateSellBar();
    updateMultiSelectionBar();
  }

  function handActionsFor(id, p) {
    const c = card(id);
    const wrap = document.createElement('div');
    wrap.className = 'row gap wrap';
    wrap.style.marginTop = '4px';

    const myTurn = isMyTurn() && state.turnPhase && !state.combat && !state.pendingConsequence && !state.pendingCardAction;
    const darfAnlegen = darfAusruesten();

    const specialRule = (state.specialSlotItems || {})[c.name];
    const isBig = (state.bigItems || []).includes(c.name);
    if ((c.category === 'item' || specialRule) && darfAnlegen) {
      const label = specialRule
        ? `Anlegen (${(state.specialSlots[specialRule.slot] || {}).label || specialRule.slot}${specialRule.races ? `, nur ${specialRule.races.join('/')}` : ''}${isBig ? ', Großer Gegenstand' : ''})`
        : `Anlegen${isBig ? ' (Großer Gegenstand)' : ''}`;
      const btn = mkBtn(label, () => socket.emit('equipItem', { cardId: id }));
      wrap.appendChild(btn);
    }
    // SCHUMMELN!: hebt die Anlege-Regeln fuer GENAU EINEN eigenen Gegenstand
    // auf (Hand oder angelegt) - Auswahl per Dropdown, der Server prueft den
    // Rest (Besitz, schon vorhandener Anhang).
    if (c.name === 'SCHUMMELN!' && myTurn) {
      const items = myTradableIds().filter((iid) => {
        const ic = card(iid);
        return ic && iid !== id && (ic.category === 'item' || (state.specialSlotItems || {})[ic.name]);
      });
      const select = document.createElement('select');
      select.innerHTML = '<option value="">🃏 Auf Gegenstand spielen...</option>' +
        items.map((iid) => `<option value="${iid}">${escapeHtml(card(iid).name)}</option>`).join('');
      select.onchange = () => {
        if (select.value) socket.emit('playCheat', { cheatCardId: id, targetItemId: select.value });
      };
      wrap.appendChild(select);
    }
    // Kartenanhaenge (VERGIFTET/GESEGNET/NÜTZLICHE GRIFFE): dieselbe Bauform
    // wie SCHUMMELN! oben. Welche Karten das sind und welche Bedingung gilt,
    // sagt der Server ueber state.attachmentCards - keine zweite Namensliste.
    if ((state.attachmentCards || {})[c.name] && myTurn) {
      const regel = state.attachmentCards[c.name];
      const items = myTradableIds().filter((iid) => {
        const ic = card(iid);
        if (!ic || iid === id) return false;
        if (regel.bedingung === 'kampfbonus') return (ic.bonus || 0) > 0;
        if (regel.bedingung === 'gross') return (state.bigItems || []).includes(ic.name);
        return ic.category === 'item';
      });
      const select = document.createElement('select');
      select.innerHTML = `<option value="">📎 An Gegenstand heften...</option>` +
        items.map((iid) => `<option value="${iid}">${escapeHtml(card(iid).name)}</option>`).join('');
      select.onchange = () => {
        if (select.value) socket.emit('attachCard', { attachCardId: id, targetItemId: select.value });
      };
      wrap.appendChild(select);
    }
    if (c.category === 'monster' && myTurn && state.turnPhase === 'aerger'
      && !((me() || {}).activeCurses || []).some((f) => f.kind === 'keinAerger')) {
      const btn = mkBtn('Als Monster spielen', () => socket.emit('playMonsterFromHand', { cardId: id }));
      wrap.appendChild(btn);
    }
    if ((c.category === 'race' || c.category === 'class') && myTurn) {
      const btn = mkBtn('Spielen', () => socket.emit('playRaceOrClass', { cardId: id }));
      wrap.appendChild(btn);
    }
    // Machtgruppe (Pathfinder-Set) und die drei "Obergrenze +1"-Karten
    // (Halb-Blut/Super Munchkin/Doppelleben) werden mechanisch wie
    // Rasse/Klasse gespielt, sind aber als "door_other" kategorisiert.
    // Dazu ORK/GNOM/BARDE - echte Rassen/Klassen, die ebenfalls als
    // "door_other" in den Rohdaten stehen (state.traitDoorCards kommt vom
    // Server, siehe TRAIT_DOOR_CARDS).
    if (myTurn && c.category === 'door_other' && (POWER_GROUP_NAMES.has((c.name || '').toUpperCase())
      || TRAIT_CAP_CARD_NAMES.has(c.name) || (state.traitDoorCards || {})[(c.name || '').toUpperCase()])) {
      const btn = mkBtn('Spielen', () => socket.emit('playRaceOrClass', { cardId: id }));
      wrap.appendChild(btn);
    }
    // Generische "Sonderkraft nutzen"-Aktion für Schatz-/Türkarten mit
    // automatisierter Fähigkeit (Sofort-Stufenaufstieg, kuratierte
    // Einzelfälle - welche das sind, sagt der Server über
    // state.treasurePowerCards, siehe hasCardPower unten). Kein myTurn-Filter
    // mehr: einige dieser Karten sind laut Kartentext "jederzeit spielbar"
    // oder reagieren gerade auf ein fremdes Ereignis (HEIMSE DIE LORBEEREN
    // EIN) - der Server prüft die eigentliche Bedingung ohnehin selbst und
    // loggt nur einen Hinweis, wenn sie nicht erfüllt ist.
    // ...und nicht, solange dieselbe Karte gerade die garantierte Flucht
    // anbietet (DER ANDERE RING hat beide Haelften): useCardPower legt die
    // Karte ab, bevor die Wunschring-Wirkung greift - ein Fehlklick kostet
    // dann die Flucht im Moment, in dem sie gebraucht wird.
    if (!state.pendingCardAction && !state.pendingConsequence && hasCardPower(c) && !guaranteedFleeUsable(c)) {
      const btn = mkBtn('✨ Sonderkraft nutzen', () => socket.emit('useCardPower', { cardId: id }));
      wrap.appendChild(btn);
    }
    if (state.pendingCardAction && state.pendingCardAction.kind === 'multiCardSelection') {
      const label = document.createElement('label');
      label.style.margin = '0'; label.style.display = 'inline-flex'; label.style.gap = '4px'; label.style.alignItems = 'center';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.style.width = 'auto';
      cb.checked = multiSelection.has(id);
      cb.onchange = () => { if (cb.checked) multiSelection.add(id); else multiSelection.delete(id); updateMultiSelectionBar(); };
      label.appendChild(cb);
      label.appendChild(document.createTextNode('Abwerfen'));
      wrap.appendChild(label);
    } else if (typeof c.gold === 'number' && c.gold > 0) {
      const label = document.createElement('label');
      label.style.margin = '0'; label.style.display = 'inline-flex'; label.style.gap = '4px'; label.style.alignItems = 'center';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.style.width = 'auto';
      cb.checked = sellSelection.has(id);
      cb.onchange = () => { if (cb.checked) sellSelection.add(id); else sellSelection.delete(id); updateSellBar(); };
      label.appendChild(cb);
      label.appendChild(document.createTextNode(`${c.gold} GS`));
      wrap.appendChild(label);
    }
    if (myTurn) {
      const btn = mkBtn('Ablegen', () => socket.emit('discardFromHand', { cardId: id }));
      wrap.appendChild(btn);
    }
    // Monster-Verstärkerkarten ("+X für das Monster") darf jede:r am Tisch
    // jederzeit während eines laufenden Kampfes ausspielen, nicht nur die
    // kämpfende Person - der Bonus/Malus wird automatisch verrechnet.
    if (state.combat && !state.combat.mustFlee && !state.combat.trojanerOffer && !state.combat.trojanerDone && isMonsterEnhancer(c)) {
      const sign = c.bonus > 0 ? '+' : '';
      const btn = mkBtn(`⚔️ Im Kampf spielen (${sign}${c.bonus} Monster)`, () => socket.emit('playCombatCard', { cardId: id }));
      wrap.appendChild(btn);
    }
    // "Kampf-Tränke": Schatzkarten mit einem +N-Bonus für eine wählbare
    // Seite, jederzeit während eines laufenden Kampfes spielbar.
    if (state.combat && !state.combat.mustFlee && !state.combat.trojanerOffer && !state.combat.trojanerDone && !state.pendingCardAction && isCombatPotion(c)) {
      // GEMEINE GHOULE: fuer die Kaempfenden ist ein Munchkin-Bonus wirkungslos,
      // der Server weist die Karte ab. Welche Seite eine Karte genau bedient,
      // weiss nur er - deshalb hier nur ein Hinweis am Knopf statt einer
      // zweiten Regeltabelle im Client.
      const imKampf = state.combat.actorId === myInfo.playerId || state.combat.helperId === myInfo.playerId;
      const zwecklos = state.combat.ignoresBonuses && imKampf;
      const btn = mkBtn(zwecklos ? '⚔️ Im Kampf spielen (Munchkin-Boni wirken hier nicht)' : '⚔️ Im Kampf spielen',
        () => socket.emit('playCombatCard', { cardId: id }));
      wrap.appendChild(btn);
    }
    // Fluchkarten aus der Hand: "jederzeit gegen eine beliebige Person".
    // Welche Karten als Fluch gelten, sagt der Server (state.curseCards) -
    // die Rohdaten fuehren die meisten Flueche als normale Tuerkarte.
    const istFluch = c.category === 'curse' || (state.curseCards || []).includes(c.name);
    if (istFluch && !state.pendingCardAction && !state.pendingConsequence && !state.pendingRoll && !state.winner) {
      const ziele = state.players.filter((p) => p.id !== myInfo.playerId);
      const select = document.createElement('select');
      select.innerHTML = '<option value="">💀 Fluch spielen gegen...</option>' +
        ziele.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
      select.onchange = () => { if (select.value) socket.emit('playCurseFromHand', { cardId: id, targetId: select.value }); };
      wrap.appendChild(select);
    }
    // Türkarten mit eigener Kampfwirkung (MAHLZEIT!) - welche das sind, sagt
    // der Server (state.doorCombatCards), damit hier keine Namensliste liegt.
    if (state.combat && !state.combat.mustFlee && !state.combat.trojanerOffer && !state.combat.trojanerDone && (state.doorCombatCards || []).includes(c.name)) {
      const btn = mkBtn('⚔️ Im Kampf spielen', () => socket.emit('playCombatCard', { cardId: id }));
      wrap.appendChild(btn);
    }
    // Kampfreaktionskarten (Kumpel, Wanderndes Monster, Illusion, Hilf mir,
    // Ueberfalltrank) - welche das sind, sagt der Server (state.combatReactionCards).
    if (state.combat && !state.combat.mustFlee && !state.combat.trojanerOffer && !state.combat.trojanerDone && !state.pendingCardAction && (state.combatReactionCards || []).includes(c.name)) {
      // Zwei Bedingungen, die der Server kennt und der Client nur abfragt:
      // HILF MIR darf nur spielen, wer selbst im Kampf steht
      // (combatReactionOnlyInFight), und WANDERNDES MONSTER/ILLUSION brauchen
      // ein Monster auf der eigenen Hand (combatReactionNeedsMonster).
      const imKampf = state.combat.actorId === myInfo.playerId || state.combat.helperId === myInfo.playerId;
      const fehltKampf = (state.combatReactionOnlyInFight || []).includes(c.name) && !imKampf;
      const fehltMonster = (state.combatReactionNeedsMonster || []).includes(c.name)
        && !myInfo.hand.some((hid) => (card(hid) || {}).category === 'monster');
      if (!fehltKampf && !fehltMonster) {
        const btn = mkBtn('⚔️ Im Kampf spielen', () => socket.emit('playCombatCard', { cardId: id }));
        wrap.appendChild(btn);
      }
    }
    // MAGISCHE LAMPE: in der eigenen Runde während des Kampfes spielbar (auch beim Fliehen)
    if (state.combat && isMyTurn() && (myInfo.lampCardIds || []).includes(id) && !state.pendingCardAction) {
      if ((state.combat.monsterIds || []).length === 1) {
        const monId = state.combat.monsterIds[0];
        const btn = mkBtn(`🧞 Im Kampf einsetzen ("${card(monId).name}" verschwinden lassen)`,
          () => socket.emit('useLamp', { cardId: id, monsterId: monId }));
        btn.className = 'primary';
        wrap.appendChild(btn);
      } else if ((state.combat.monsterIds || []).length > 1) {
        const select = document.createElement('select');
        select.innerHTML = '<option value="">🧞 Monster verschwinden lassen...</option>' +
          state.combat.monsterIds.map((mId) => `<option value="${mId}">${escapeHtml(card(mId).name)}</option>`).join('');
        select.onchange = () => {
          if (select.value) socket.emit('useLamp', { cardId: id, monsterId: select.value });
        };
        wrap.appendChild(select);
      }
    }
    // Klassenkräfte, die Handkarten kosten (Krieger "Berserken", Priester
    // "Vertreiben", Zauberer "Flugzauber"). Welche gerade nutzbar ist und wie
    // viele Karten noch gehen, rechnet der Server - hier steht bewusst keine
    // zweite Kopie der Regeln.
    const power = myInfo.classCombatPower;
    if (power && power.remaining > 0) {
      const suffix = power.kind === 'flee' ? 'auf Weglaufen' : 'im Kampf';
      const btn = mkBtn(`⚔️ ${power.label}: ablegen für +${power.bonus} ${suffix} (noch ${power.remaining})`,
        () => socket.emit('useClassCombatDiscard', { cardId: id }));
      wrap.appendChild(btn);
    }
    // DIEB: beide Kraefte kosten genau eine Handkarte - deshalb haengen sie
    // an jeder Karte. Wer Ziel sein darf, sagt der Server (myInfo.thiefPower).
    const thief = myInfo.thiefPower;
    if (thief && thief.backstabTargets.length && !state.pendingCardAction) {
      const sel = document.createElement('select');
      sel.innerHTML = '<option value="">🗡️ In den Rücken fallen (-2)...</option>' +
        thief.backstabTargets.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
      sel.onchange = () => { if (sel.value) socket.emit('thiefBackstab', { cardId: id, targetId: sel.value }); };
      wrap.appendChild(sel);
    }
    if (thief && thief.stealTargets.length && !state.pendingCardAction && !state.pendingRoll) {
      const sel = document.createElement('select');
      sel.innerHTML = '<option value="">🗝️ Diebstahl (Wurf ab 4)...</option>' +
        thief.stealTargets.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
      sel.onchange = () => { if (sel.value) socket.emit('thiefSteal', { cardId: id, targetId: sel.value }); };
      wrap.appendChild(sel);
    }
    // HALBLING-Wiederholungswurf: jede Handkarte kann die Karte sein, die
    // dafür abgelegt wird.
    if (state.combat && state.combat.fleeRerollOffer && state.combat.canReroll && state.combat.actorId === myInfo.playerId) {
      const btn = mkBtn('🎲 Halbling: ablegen und nochmal weglaufen', () => socket.emit('fleeReroll', { cardId: id }));
      btn.className = 'primary';
      wrap.appendChild(btn);
    }
    // Garantierte Flucht-Karten: nur die aktuell kämpfende Person, nur
    // während tatsächlich geflohen werden muss.
    if (guaranteedFleeUsable(c)) {
      const btn = mkBtn(`🛡️ Garantiert entkommen mit "${c.name}"`, () => socket.emit('useGuaranteedFlee', { cardId: id }));
      btn.className = 'primary';
      wrap.appendChild(btn);
    }
    // Würfel-Reaktionskarten (GEZINKTER WÜRFEL, KATZENINTERVENTION): nur,
    // solange das Reaktionsfenster für genau diese Person offen ist
    // (state.pendingRoll.holders). KATZENINTERVENTION würfelt serverseitig
    // neu (state.rollRerollCards) - dafür braucht es keinen Wert-Prompt.
    if (state.pendingRoll && state.pendingRoll.holders.includes(myInfo.playerId)
      && (state.rollReactionCards || []).includes(c.name)
      // GEZINKTER WÜRFEL: nur auf den eigenen Wurf ("nachdem DU ... wuerfeln
      // musstest") - der Server weist es sonst ohnehin ab.
      && !((state.rollReactionOwnRollOnly || []).includes(c.name)
        && state.pendingRoll.playerId !== myInfo.playerId)) {
      const istNeuwurf = (state.rollRerollCards || []).includes(c.name);
      const btn = mkBtn(istNeuwurf ? '🐈 Wurf neu würfeln lassen' : '🎲 Wurf ändern', () => {
        if (istNeuwurf) { socket.emit('playReactionCard', { cardId: id }); return; }
        const v = Number(window.prompt('Neues Würfelergebnis (1-6)?', String(state.pendingRoll.roll)));
        if (v >= 1 && v <= 6) socket.emit('playReactionCard', { cardId: id, value: v });
      });
      btn.className = 'primary';
      wrap.appendChild(btn);
    }
    // KLEBERFLÄSCHCHEN: nur, solange das Fluchtreaktionsfenster für genau
    // diese Person offen ist (combat.escapeReactionOffer).
    if (state.combat && (state.combat.escapeReactionOffer || []).includes(myInfo.playerId) && c.name === 'KLEBERFLÄSCHCHEN') {
      const btn = mkBtn('🧪 Kleberfläschchen: Flucht wiederholen lassen', () => socket.emit('playReactionCard', { cardId: id }));
      btn.className = 'primary';
      wrap.appendChild(btn);
    }
    // TROJANISCHER PFERD: nur cardId senden - die Monsterwahl (falls
    // vorhanden) kommt danach automatisch über den generischen
    // pendingCardAction-Dialog (renderCardAction()), genau wie bei
    // WANDERNDES MONSTER/ILLUSION.
    if (state.combat && (state.combat.trojanerOffer || []).includes(myInfo.playerId) && c.name === 'TROJANISCHER PFERD') {
      const btn = mkBtn('🐴 Trojanisches Pferd spielen', () => socket.emit('playTrojaner', { cardId: id }));
      btn.className = 'primary';
      wrap.appendChild(btn);
    }
    return wrap;
  }

  // Kartenanhaenge am Gegenstand anzeigen (VERGIFTET/GESEGNET/NÜTZLICHE
  // GRIFFE) - state.itemAttachments kommt vom Server.
  function anhangText(cardId) {
    const ids = (state.itemAttachments || {})[cardId] || [];
    if (!ids.length) return '';
    return ' [' + ids.map((id) => {
      const c = card(id);
      if (!c) return '?';
      return c.name + (c.bonus ? ` +${c.bonus}` : '');
    }).join(', ') + ']';
  }

  function isMonsterEnhancer(c) {
    return c.category === 'door_other' && typeof c.bonus === 'number' && c.bonus !== 0 &&
      /für\s+(das\s+)?Monster/i.test(c.text || '');
  }

  // ---------------------------------------------------------------------
  // Client-seitige Spiegel der server.js-Erkenner (server.js bleibt die
  // Quelle der Wahrheit für die tatsächliche Auswirkung - hier geht es nur
  // darum, ob überhaupt ein Knopf angezeigt wird; siehe isMonsterEnhancer
  // oben, das nach demselben Muster funktioniert).
  // ---------------------------------------------------------------------
  const POWER_GROUP_NAMES = new Set([
    'KUNDSCHAFTER', 'NEKROMANT', 'HEXE', 'HÖLLENRITTER', 'ADLERRITTER',
    'PAKTMAGIER', 'ALCHEMIST', 'ASSASSINE DER ROTEN MANTIS',
  ]);
  const TRAIT_CAP_CARD_NAMES = new Set(['HALB-BLUT', 'SUPER MUNCHKIN', 'DOPPELLEBEN']);
  const GUARANTEED_FLEE_NAMES = new Set(['FERTIGMAUER', 'BABY-ÖL', 'DER ANDERE RING', 'RATTE AM SPIESS']);
  // Karten, die nur gegen schwache Monster garantiert wirken - der Server
  // prüft das nochmal, hier wird der Knopf nur gar nicht erst angeboten.
  const GUARANTEED_FLEE_MAX_LEVEL = { 'RATTE AM SPIESS': 8 };

  function guaranteedFleeUsable(c) {
    if (!state.combat || !state.combat.mustFlee) return false;
    if (state.combat.fleeingId !== myInfo.playerId) return false;
    if (!GUARANTEED_FLEE_NAMES.has(c.name)) return false;
    const max = GUARANTEED_FLEE_MAX_LEVEL[c.name];
    if (typeof max !== 'number') return true;
    return state.combat.monsterIds.every((id) => (card(id).level || 0) <= max);
  }
  // Sofortkraft-Schatz-/Türkarten (server.js: TREASURE_POWER_OVERRIDES,
  // DOOR_POWER_CARDS, isInstantLevelUpCard) und Kampf-Tränke
  // (isCombatPotionCard) - der Server veröffentlicht die fertigen Namen über
  // publicState (state.treasurePowerCards/state.combatPotionCards), damit
  // hier keine zweite, drift-anfällige Kopie liegt (siehe
  // tests/card-clerical-ui.test.js).
  function hasCardPower(c) {
    return !!c && (state.treasurePowerCards || []).includes(c.name);
  }

  function isCombatPotion(c) {
    return !!c && (state.combatPotionCards || []).includes(c.name);
  }

  function mkBtn(label, onClick) {
    const b = document.createElement('button');
    b.className = 'small'; b.textContent = label; b.onclick = onClick;
    return b;
  }

  function updateMultiSelectionBar() {
    for (const id of Array.from(multiSelection)) {
      if (!myInfo.hand.includes(id)) multiSelection.delete(id);
    }
    const count = multiSelection.size;
    const multiSum = $('multiSelectionSum');
    if (multiSum) multiSum.textContent = count + (count === 1 ? ' Karte' : ' Karten') + ' ausgewählt';
    const btnD = $('btnMultiDoor');
    const btnT = $('btnMultiTreasure');
    // "Lege eine beliebige ODER ALLE Karten ab" - mindestens eine muss es
    // sein, sonst gaebe es nichts zu ziehen.
    if (btnD) {
      btnD.disabled = count === 0;
      btnD.onclick = () => { socket.emit('resolveMultiCardSelection', { cardIds: Array.from(multiSelection), deck: 'door' }); multiSelection.clear(); updateMultiSelectionBar(); };
    }
    if (btnT) {
      btnT.disabled = count === 0;
      btnT.onclick = () => { socket.emit('resolveMultiCardSelection', { cardIds: Array.from(multiSelection), deck: 'treasure' }); multiSelection.clear(); updateMultiSelectionBar(); };
    }
  }

  function updateSellBar() {
    // ungültige Auswahl (Karte nicht mehr auf der Hand) entfernen
    for (const id of Array.from(sellSelection)) {
      if (!myInfo.hand.includes(id)) sellSelection.delete(id);
    }
    let sum = 0;
    const werte = [];
    sellSelection.forEach((id) => { const g = card(id).gold || 0; sum += g; werte.push(g); });
    // HALBLING: "1 Gegenstand pro Runde zum doppelten Preis" - der Server
    // verdoppelt den teuersten der verkauften Gegenstände (handleSellItems).
    // Ohne diese Zeile misst der Knopf am reinen Goldwert und bleibt grau,
    // obwohl der Verkauf durchginge.
    const halblingBonus = (myInfo.halblingSaleOpen && werte.length) ? Math.max.apply(null, werte) : 0;
    const echt = sum + halblingBonus;
    $('sellSum').textContent = halblingBonus
      ? `Ausgewählt: ${sum} Goldstücke - als Halbling ${echt} (teuerster Gegenstand zählt doppelt)`
      : `Ausgewählt: ${sum} Goldstücke`;
    const btn = $('btnSell');
    // Verkaufen geht nur im eigenen Zug und nicht im Kampf (handleSellItems).
    btn.disabled = echt < 1000 || !darfVerkaufen();
    btn.onclick = () => {
      socket.emit('sellItems', { cardIds: Array.from(sellSelection) });
      sellSelection.clear();
    };
  }

  function renderLog() {
    const feed = $('logFeed');
    feed.innerHTML = '';
    state.logs.slice().reverse().forEach((l, i) => {
      const div = document.createElement('div');
      div.className = 'logline' + (i === 0 ? ' logline-latest' : '');
      div.appendChild(document.createTextNode(l.text));
      // Bezieht sich der Eintrag auf öffentlich bekannte Karten (z.B. eine
      // aufgedeckte Türkarte), zeigen wir sie als anklickbare Verweise an,
      // die die Karte im Modal aufrufen.
      if (l.cardIds && l.cardIds.length) {
        div.appendChild(document.createTextNode(' '));
        l.cardIds.forEach((id) => {
          const c = cardIndex[id];
          if (!c) return;
          const link = document.createElement('a');
          link.href = '#'; link.className = 'logcardlink';
          link.textContent = `[${c.name}]`;
          link.addEventListener('click', (e) => { e.preventDefault(); openCardModal(id); });
          div.appendChild(link);
          div.appendChild(document.createTextNode(' '));
        });
      }
      feed.appendChild(div);
    });
  }

  // ---------------------------------------------------------------------
  // Karten-Kacheln + Modal
  // ---------------------------------------------------------------------

  function cardImageUrl(id) { return `images/${id}.webp`; }

  function cardTile(id, opts) {
    opts = opts || {};
    const c = card(id);
    const div = document.createElement('div');
    div.className = `cardtile cat-${c.category}${opts.slim ? ' slim' : ''}`;
    let meta = '';
    if (c.category === 'monster') meta = `Stufe ${c.level} | 🎁 ${c.treasureCount || 0}`;
    else if (c.category === 'item') meta = `${c.slotLabel || ''}${c.bonus ? ` +${c.bonus}` : ''}${typeof c.gold === 'number' ? ` | ${c.gold} GS` : ''}`;
    else if (typeof c.gold === 'number') meta = `${c.gold} GS`;

    const imgWrap = document.createElement('div');
    imgWrap.className = 'ctimgwrap';
    const img = document.createElement('img');
    // Kein loading="lazy": die Kacheln sind beim Neuaufbau ohnehin sofort
    // sichtbar, und ein verzoegertes Nachladen liess das (laengst im Cache
    // liegende) Bild bei jedem Re-Render kurz aufblitzen.
    img.className = 'ctimg'; img.alt = '';
    img.src = cardImageUrl(id);
    img.onerror = () => { div.classList.add('noimg'); imgWrap.remove(); };
    imgWrap.appendChild(img);
    // Untot-Indikator (siehe renderCombat): von Haus aus untote Monster oder
    // per Verstaerkerkarte UNTOT "zu Untoten gemachte" Monster bekommen ein
    // Totenkopf-Abzeichen auf der Kachel - relevant fuer Priester-"Vertreiben"
    // und die GHOULPEITSCHE.
    if (opts.undead) {
      const badge = document.createElement('span');
      badge.className = 'undead-badge';
      badge.textContent = '☠️ Untot';
      badge.title = 'Zaehlt fuer alle Zwecke als untot (Priester-Vertreiben, Ghoulpeitsche, ...).';
      imgWrap.appendChild(badge);
    }
    div.appendChild(imgWrap);

    const type = document.createElement('span');
    type.className = 'cttype'; type.textContent = CATEGORY_LABELS[c.category] || '';
    div.appendChild(type);

    const body = document.createElement('div');
    body.className = 'ctbody';
    // Der Name wird per CSS auf zwei Zeilen begrenzt (siehe .ctname), damit
    // Extremfaelle wie "DING MIT EINEM ÜBERLANGEN NAMEN, DESSEN BILD NICHT AUF
    // DIE KARTE PASST" die Kachel nicht in die Hoehe ziehen. Vollstaendig
    // lesbar bleibt er im Karten-Modal (Klick auf die Kachel) und im Tooltip.
    body.innerHTML = `<span class="ctname" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</span>` +
      (meta ? `<span class="ctmeta">${escapeHtml(meta)}</span>` : '');
    div.appendChild(body);

    div.addEventListener('click', (e) => {
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'LABEL') return;
      openCardModal(id);
    });
    return div;
  }

  // Werte-Zeile fuer die Grossansicht: zeigt nur, was die Karte wirklich hat -
  // eine Monsterkarte hat keinen Slot, ein Schatz keine Stufe. "Grosser
  // Gegenstand" kommt als c.big direkt vom Server mit (siehe ALL_CARDS in
  // server.js), damit hier keine zweite Namensliste gepflegt werden muss.
  function cardValuesHtml(c) {
    const teile = [];
    if (typeof c.level === 'number') teile.push(`Stufe ${c.level}`);
    if (typeof c.treasureCount === 'number') teile.push(`🎁 ${c.treasureCount} Schatz/Schaetze`);
    if (c.slotLabel) teile.push(escapeHtml(c.slotLabel));
    if (c.handsCost) teile.push(`${c.handsCost} Hand${c.handsCost > 1 ? 'e' : ''}`);
    if (c.bonus) teile.push(`${c.bonus > 0 ? '+' : ''}${c.bonus} im Kampf`);
    if (typeof c.gold === 'number' && c.gold > 0) teile.push(`${c.gold} GS`);
    if (c.big) teile.push('📦 <b>Grosser Gegenstand</b>');
    if (!teile.length) return '';
    return `<p class="cardvalues">${teile.join(' &middot; ')}</p>`;
  }

  function openCardModal(id) {
    offenerAblagestapel = null;
    const c = card(id);
    const img = new Image();
    img.className = 'modalimg';
    img.alt = '';
    img.src = cardImageUrl(id);
    img.onerror = () => img.remove();
    $('cardModalBody').innerHTML = `<h3>${escapeHtml(c.name)}</h3>` +
      `<p class="hint">${CATEGORY_LABELS[c.category] || ''} - ${escapeHtml(c.setLabel || '')}</p>` +
      cardValuesHtml(c) +
      (c.text ? `<p>${formatCardText(c.text)}</p>` : '') +
      (c.badstuff ? `<p><b>Schlimme Dinge:</b> ${formatCardText(c.badstuff)}</p>` : '');
    $('cardModalBody').prepend(img);
    $('cardModal').classList.remove('hidden');
  }
  $('cardModalClose').addEventListener('click', () => {
    offenerAblagestapel = null;
    $('cardModal').classList.add('hidden');
  });

  // Anhaltende Flueche als Marke mit Klartext - der Text kommt vom Server
  // (LINGERING_CURSES.hinweis), damit die Wirkung nur an einer Stelle
  // beschrieben ist.
  function curseTags(p, ziel) {
    (p.activeCurses || []).forEach((f) => {
      const tag = smallTag(`🌀 ${f.name}`, '#7b3fa0');
      tag.title = f.hinweis || 'Anhaltender Fluch';
      ziel.appendChild(tag);
      if (f.hinweis) {
        const hint = document.createElement('span');
        hint.className = 'hint';
        hint.textContent = f.hinweis;
        ziel.appendChild(hint);
      }
    });
  }

  // cardId optional: macht die Marke anklickbar und oeffnet die Grossansicht.
  function smallTag(text, color, cardId) {
    const span = document.createElement('span');
    span.className = 'tag'; span.style.background = color; span.style.color = 'white';
    span.textContent = text;
    if (cardId) {
      span.style.cursor = 'pointer';
      span.title = 'Karte ansehen';
      span.onclick = () => openCardModal(cardId);
    }
    return span;
  }
  // TEMPORAERE ANMNESIE: die Klassen-/Rassenkarten liegen weiter aus, zaehlen
  // aber nicht - ausgegraut und als "vergessen" beschriftet.
  function hatAmnesie(p) { return (p.activeCurses || []).some((f) => f.kind === 'traitsVergessen'); }
  function traitTag(p, id, color) {
    if (!hatAmnesie(p)) return smallTag(card(id).name, color, id);
    const tag = smallTag(`${card(id).name} (vergessen)`, color, id);
    tag.style.opacity = '0.45';
    return tag;
  }
  function textNode(text) { const s = document.createElement('span'); s.className = 'hint'; s.textContent = text; return s; }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }
  // Kartentexte aus den eigenen Spieldaten enthalten vereinzelt einfache
  // Formatierungs-Tags (<b>, <i>, <br>) - escapen und dann gezielt wieder
  // freigeben, statt sie als sichtbaren Text ("&lt;b&gt;") anzuzeigen. Ein
  // Teil der Texte enthält außerdem ein literales "\n" (Backslash + n, kein
  // echter Zeilenumbruch - ein Artefakt aus der Datenaufbereitung) statt
  // eines <br> - wird hier ebenfalls in einen Zeilenumbruch umgewandelt.
  function formatCardText(s) {
    return escapeHtml(s)
      .replace(/\\n/g, '<br>')
      .replace(/&lt;b&gt;/gi, '<b>').replace(/&lt;\/b&gt;/gi, '</b>')
      .replace(/&lt;i&gt;/gi, '<i>').replace(/&lt;\/i&gt;/gi, '</i>')
      .replace(/&lt;br\s*\/?&gt;/gi, '<br>');
  }

  // ---------------------------------------------------------------------
  // Komfort: gemerkter Name, Enter-Taste, Einladungslink, Regeln, ARIA
  // ---------------------------------------------------------------------
  (function comfort() {
    const NAME_KEY = 'spiele_name';
    const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
    const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* optional */ } };
    const cn = $('createNameInput'); const jn = $('joinNameInput'); const jc = $('codeInput');
    const cached = lsGet(NAME_KEY);
    [cn, jn].forEach((inp) => {
      if (!inp) return;
      if (cached && !inp.value) inp.value = cached;
      inp.addEventListener('input', () => { const v = inp.value.trim(); if (v) { lsSet(NAME_KEY, v); [cn, jn].forEach((o) => { if (o && o !== inp) o.value = inp.value; }); } });
      inp.setAttribute('autocomplete', 'nickname'); inp.setAttribute('autocapitalize', 'words');
      inp.setAttribute('aria-label', 'Dein Name'); inp.setAttribute('enterkeyhint', 'go');
    });
    jc.setAttribute('autocomplete', 'off'); jc.setAttribute('autocapitalize', 'characters');
    jc.setAttribute('autocorrect', 'off'); jc.setAttribute('spellcheck', 'false');
    jc.setAttribute('aria-label', 'Raum-Code'); jc.setAttribute('enterkeyhint', 'go');
    jc.addEventListener('input', () => { jc.value = jc.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
    cn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('btnCreate').click(); } });
    jn.addEventListener('keydown', (e) => { if (e.key !== 'Enter') return; e.preventDefault(); if (!jc.value.trim()) jc.focus(); else $('btnJoin').click(); });
    jc.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('btnJoin').click(); } });

    try {
      const urlCode = (new URLSearchParams(window.location.search).get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
      if (urlCode) {
        if (session && session.code && session.code !== urlCode) clearSession();
        jc.value = urlCode;
        const tabBtn = document.querySelector('.tab-btn[data-tab="join"]');
        if (tabBtn) tabBtn.click();
        const target = !jn.value.trim() ? jn : $('btnJoin');
        setTimeout(() => target.focus(), 50);
      }
    } catch (e) { /* ignore */ }

    async function copyText(text) {
      try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch (e) { /* Fallback unten */ }
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
        document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
        const ok = document.execCommand('copy'); document.body.removeChild(ta); return ok;
      } catch (e) { return false; }
    }
    const share = $('btnShareLink');
    if (share) share.addEventListener('click', async () => {
      const code = ($('lobbyCode').textContent || '').trim();
      if (!/^[A-Z0-9]{4}$/.test(code)) return;
      const url = window.location.origin + window.location.pathname + '?code=' + code;
      if (await copyText(url)) { share.textContent = '✅ Link kopiert'; setTimeout(() => { share.textContent = '🔗 Einladungslink kopieren'; }, 2500); }
      else window.prompt('Link zum Kopieren:', url);
    });

    const rm = $('rulesModal');
    ['btnRules', 'btnRulesLobby'].forEach((id) => { const b = $(id); if (b) b.addEventListener('click', () => rm.classList.remove('hidden')); });
    $('rulesClose').addEventListener('click', () => rm.classList.add('hidden'));
    rm.addEventListener('click', (e) => { if (e.target === rm) rm.classList.add('hidden'); });

    const se = $('startError'); if (se) { se.setAttribute('role', 'alert'); }
    const tabs = document.querySelector('.tabs');
    if (tabs) {
      tabs.setAttribute('role', 'tablist');
      const sync = () => tabs.querySelectorAll('.tab-btn').forEach((b) => b.setAttribute('aria-selected', b.classList.contains('active') ? 'true' : 'false'));
      tabs.querySelectorAll('.tab-btn').forEach((b) => b.setAttribute('role', 'tab'));
      document.querySelectorAll('.tab-panel').forEach((pn) => pn.setAttribute('role', 'tabpanel'));
      new MutationObserver(sync).observe(tabs, { subtree: true, attributes: true, attributeFilter: ['class'] });
      sync();
    }
    const lc = $('lobbyCode'); if (lc) lc.setAttribute('aria-label', 'Raum-Code');
  })();
})();
