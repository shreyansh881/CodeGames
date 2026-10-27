const app = document.querySelector("#app");
const toast = document.querySelector("#toast");
const STORAGE_KEY = "codegames-player";
const SOUND_STORAGE_KEY = "codegames-sounds";
let current = null;
let pollTimer = null;
let timerTicker = null;
let toastTimer = null;
let inFlightPoll = false;
let lastRenderedState = null;
let selectedGuesses = [];
let selectedGuessTurn = null;
let soundsEnabled = localStorage.getItem(SOUND_STORAGE_KEY) !== "off";
let audioContext = null;
let lastGameSoundState = null;
const revealedWordVisible = new Set();

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function initials(name) {
  return name.split(/\s+/).map((part) => part[0] || "").join("").slice(0, 2).toUpperCase();
}

function savedSession() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    return null;
  }
}

function saveSession(session) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  current = session;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2800);
}

function soundButtonMarkup() {
  return `<button class="small-button sound-toggle" id="sound-toggle" aria-pressed="${soundsEnabled}">Sound: ${soundsEnabled ? "On" : "Off"}</button>`;
}

function bindSoundToggle() {
  document.querySelector("#sound-toggle")?.addEventListener("click", (event) => {
    soundsEnabled = !soundsEnabled;
    localStorage.setItem(SOUND_STORAGE_KEY, soundsEnabled ? "on" : "off");
    event.currentTarget.setAttribute("aria-pressed", String(soundsEnabled));
    event.currentTarget.textContent = `Sound: ${soundsEnabled ? "On" : "Off"}`;
    if (soundsEnabled) {
      unlockAudio();
      playSound("turn");
    }
  });
}

function unlockAudio() {
  if (!soundsEnabled || !window.AudioContext) return;
  audioContext ||= new window.AudioContext();
  if (audioContext.state === "suspended") {
    audioContext.resume().catch(() => showToast("Sound playback is unavailable in this browser."));
  }
}

function playTone(frequency, startAt, duration, type = "sine") {
  if (!soundsEnabled || !audioContext || audioContext.state !== "running") return;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const starts = audioContext.currentTime + startAt;
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, starts);
  gain.gain.setValueAtTime(0.0001, starts);
  gain.gain.exponentialRampToValueAtTime(0.12, starts + 0.025);
  gain.gain.exponentialRampToValueAtTime(0.0001, starts + duration);
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start(starts);
  oscillator.stop(starts + duration);
}

function playSound(name) {
  const notes = {
    clue: [[523, 0, .13], [659, .12, .18]],
    reveal: [[740, 0, .16]],
    turn: [[392, 0, .14], [523, .11, .18]],
    win: [[523, 0, .16], [659, .14, .16], [784, .28, .3]]
  };
  for (const [frequency, startAt, duration] of notes[name] || []) {
    playTone(frequency, startAt, duration, name === "reveal" ? "triangle" : "sine");
  }
}

function playStateSounds(state) {
  const snapshot = {
    status: state.status,
    matchId: state.matchId,
    turnId: state.turn.id,
    clue: state.turn.clue?.word || null,
    revealed: state.cards.filter((card) => card.revealed).length,
    winner: state.winner
  };
  if (!lastGameSoundState || lastGameSoundState.matchId !== snapshot.matchId) {
    lastGameSoundState = snapshot;
    return;
  }
  if (snapshot.revealed > lastGameSoundState.revealed && snapshot.status === "playing") playSound("reveal");
  if (!lastGameSoundState.clue && snapshot.clue) playSound("clue");
  if (snapshot.turnId !== lastGameSoundState.turnId && snapshot.status === "playing") playSound("turn");
  if (lastGameSoundState.status !== "finished" && snapshot.status === "finished") playSound("win");
  lastGameSoundState = snapshot;
}

document.addEventListener("pointerdown", unlockAudio, { once: true });
document.addEventListener("keydown", unlockAudio, { once: true });

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (current?.playerId) headers["X-Player-Id"] = current.playerId;
  let response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch {
    throw new Error("Could not reach the game server. Check your connection.");
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  if (timerTicker) clearInterval(timerTicker);
  pollTimer = null;
  timerTicker = null;
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(refreshState, 1500);
  timerTicker = setInterval(updateTurnCountdown, 250);
}

function updateTurnCountdown() {
  document.querySelectorAll(".timer-value").forEach((element) => {
    const deadline = Number(element.dataset.deadline);
    if (!deadline) {
      element.textContent = "No timer";
      element.classList.remove("timer-urgent");
      return;
    }
    const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    element.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    element.classList.toggle("timer-urgent", seconds <= 10);
  });
}

async function refreshState() {
  if (!current || inFlightPoll) return;
  inFlightPoll = true;
  try {
    const state = await api(`/api/rooms/${encodeURIComponent(current.code)}?playerId=${encodeURIComponent(current.playerId)}`);
    render(state);
  } catch (error) {
    if (error.message.includes("expired") || error.message.includes("Room not found")) {
      stopPolling();
      localStorage.removeItem(STORAGE_KEY);
      current = null;
      renderHome();
      showToast(error.message);
    } else if (!document.querySelector(".toast.visible")) {
      showToast(error.message);
    }
  } finally {
    inFlightPoll = false;
  }
}

async function act(action, payload = {}) {
  try {
    const state = await api(`/api/rooms/${encodeURIComponent(current.code)}/${action}`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    if (state.code) {
      if (action === "guess") {
        selectedGuesses = selectedGuesses.filter((index) => index !== payload.index);
      }
      render(state);
    }
    else if (action === "leave") {
      stopPolling();
      current = null;
      localStorage.removeItem(STORAGE_KEY);
      renderHome();
    }
  } catch (error) {
    showToast(error.message);
  }
}

function renderHome() {
  stopPolling();
  lastRenderedState = null;
  const prior = savedSession();
  current = prior;
  app.innerHTML = `
    <section class="home">
      <div class="hero">
        <div class="eyebrow">THE WORD GAME FOR YOUR CREW</div>
        <h1>Say less.<br><em>Guess more.</em></h1>
        <p class="lede">One clever clue. A whole board of possibilities. Bring your people together and find the words that connect.</p>
        <div class="feature-line"><span><b>✳</b> 4–20 players</span><span><b>↗</b> Free to play</span><span><b>⌁</b> Play anywhere</span></div>
        <div class="hero-table" aria-hidden="true">
          <div class="hero-table-top"><span>TONIGHT'S TABLE</span><span><i></i> 25 WORDS IN PLAY</span></div>
          <div class="hero-word-grid">
            <span class="hero-word hero-word-blue">ORBIT</span>
            <span class="hero-word">MIRROR</span>
            <span class="hero-word hero-word-red">EMBER</span>
            <span class="hero-word">JUNGLE</span>
            <span class="hero-word hero-word-gold">CROWN</span>
            <span class="hero-word">SATELLITE</span>
          </div>
          <div class="hero-table-bottom"><span>ONE CLUE CHANGES EVERYTHING</span><span>✳</span></div>
        </div>
      </div>
      <div class="entry-card">
        <h2>Ready when you are.</h2>
        <p>Start a new table or join your friends.</p>
        <form id="create-form">
          <label class="field-label" for="player-name">Your name</label>
          <input class="text-input" id="player-name" name="name" maxlength="24" placeholder="What should we call you?" required value="${escapeHtml(prior?.name || "")}">
          <button class="button button-primary button-full" type="submit">Create a room <span aria-hidden="true">↗</span></button>
        </form>
        <div class="divider">OR JOIN YOUR CREW</div>
        <form id="join-form">
          <label class="field-label" for="room-code">Room code</label>
          <div class="join-row">
            <input class="text-input join-code" id="room-code" name="code" maxlength="5" placeholder="E.G. K7P2Q" required autocomplete="off">
            <button class="button button-quiet" type="submit">Join room</button>
          </div>
        </form>
        ${prior ? `<button class="small-button button-full" id="resume-button" style="margin-top:13px">Resume room ${escapeHtml(prior.code)}</button>` : ""}
      </div>
    </section>`;

  document.querySelector("#create-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = new FormData(event.currentTarget).get("name").trim();
    await enterRoom("/api/rooms", { name });
  });
  document.querySelector("#join-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = new FormData(event.currentTarget).get("code").trim().toUpperCase();
    const name = document.querySelector("#player-name").value.trim();
    if (!name) return showToast("Add your name first.");
    await enterRoom(`/api/rooms/${encodeURIComponent(code)}/join`, { name });
  });
  document.querySelector("#room-code").addEventListener("input", (event) => {
    event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  });
  document.querySelector("#resume-button")?.addEventListener("click", resumeRoom);
}

async function enterRoom(endpoint, body) {
  try {
    const session = await api(endpoint, { method: "POST", body: JSON.stringify(body) });
    saveSession({ ...session, name: body.name });
    await refreshState();
    startPolling();
  } catch (error) {
    showToast(error.message);
  }
}

async function resumeRoom() {
  const session = savedSession();
  if (!session) return;
  current = session;
  await refreshState();
  if (current) startPolling();
}

function playerRow(player, hostId, compact = false) {
  return `<div class="${compact ? "mini-player" : "player-row"}">
    <span class="avatar">${escapeHtml(initials(player.name))}</span>
    <span><span class="player-name">${escapeHtml(player.name)}</span><span class="player-role">${player.role === "spymaster" ? "Spymaster" : "Operative"}${player.online === false ? " · away" : ""}</span></span>
    ${player.id === hostId ? '<span class="host-tag">HOST</span>' : ""}
    ${compact ? `<span class="team-label">${player.team}</span>` : ""}
  </div>`;
}

function render(state) {
  const signature = JSON.stringify(state);
  if (signature === lastRenderedState) return;
  if (state.status !== "lobby") playStateSounds(state);
  const activeElement = document.activeElement;
  const preservedInput = activeElement &&
    app.contains(activeElement) &&
    activeElement.dataset.preserveInput
    ? {
      key: activeElement.dataset.preserveInput,
      value: activeElement.value,
      start: activeElement.selectionStart,
      end: activeElement.selectionEnd
    }
    : null;
  lastRenderedState = signature;
  if (state.status === "lobby") renderLobby(state);
  else renderGame(state);
  if (preservedInput) {
    const replacement = app.querySelector(`[data-preserve-input="${preservedInput.key}"]`);
    if (replacement) {
      replacement.value = preservedInput.value;
      replacement.focus();
      if (preservedInput.start !== null) {
        replacement.setSelectionRange(preservedInput.start, preservedInput.end);
      }
    }
  }
}

function renderLobby(state) {
  const blue = state.players.filter((player) => player.team === "blue");
  const red = state.players.filter((player) => player.team === "red");
  const isHost = state.me.id === state.hostId;
  const teamsReady = [blue, red].every((team) =>
    team.some((player) => player.role === "spymaster") &&
    team.some((player) => player.role === "operative")
  );
  const startLabel = !isHost ? "Waiting for host…" : teamsReady ? "Start the game ↗" : "Assign both team roles";
  const timerOptions = [[0, "Off"], [30, "30 seconds"], [45, "45 seconds"], [60, "1 minute"], [90, "90 seconds"], [120, "2 minutes"]];
  app.innerHTML = `
    <section class="room">
      <div class="room-head">
        <div><div class="room-kicker">THE TABLE IS OPEN</div><h1 class="room-title">Your room is ready.</h1></div>
        <div class="room-code"><div class="code-box">${escapeHtml(state.code)}</div><button class="small-button" id="copy-code">Copy invite</button>${soundButtonMarkup()}</div>
      </div>
      <div class="lobby-layout">
        <section class="panel">
          <div class="panel-heading"><h3>Your crew</h3><span class="count-label">${state.players.length} / 20 PLAYERS</span></div>
          <div class="team-columns">
            <div class="team-column blue"><div class="team-header">BLUE TEAM · ${blue.length}</div>${blue.map((player) => playerRow(player, state.hostId)).join("") || '<p class="hint" style="padding:0 12px">Waiting for your team…</p>'}</div>
            <div class="team-column red"><div class="team-header">RED TEAM · ${red.length}</div>${red.map((player) => playerRow(player, state.hostId)).join("") || '<p class="hint" style="padding:0 12px">Waiting for your team…</p>'}</div>
          </div>
        </section>
        <aside class="panel settings-panel">
          <h3>Pick your place</h3>
          <label class="field-label" for="team-select">Your team</label>
          <select class="text-input" id="team-select"><option value="blue" ${state.me.team === "blue" ? "selected" : ""}>Blue team</option><option value="red" ${state.me.team === "red" ? "selected" : ""}>Red team</option></select>
          <label class="field-label" for="role-select">Your role</label>
          <select class="text-input" id="role-select"><option value="spymaster" ${state.me.role === "spymaster" ? "selected" : ""}>Spymaster — give clues</option><option value="operative" ${state.me.role === "operative" ? "selected" : ""}>Operative — guess words</option></select>
          <label class="field-label" for="lobby-spymaster-timer">Spymaster clue timer · ${isHost ? "host setting" : "set by host"}</label>
          ${isHost
            ? `<select class="text-input" id="lobby-spymaster-timer">${timerOptions.map(([seconds, label]) => `<option value="${seconds}" ${state.turnTimers.spymasterSeconds === seconds ? "selected" : ""}>${label}</option>`).join("")}</select>
               <label class="field-label" for="lobby-operative-timer">Operative guess timer</label>
               <select class="text-input" id="lobby-operative-timer">${timerOptions.map(([seconds, label]) => `<option value="${seconds}" ${state.turnTimers.operativeSeconds === seconds ? "selected" : ""}>${label}</option>`).join("")}</select>`
            : `<div class="timer-summary">Spymaster: ${state.turnTimers.spymasterSeconds ? `${state.turnTimers.spymasterSeconds} sec` : "off"} · Operatives: ${state.turnTimers.operativeSeconds ? `${state.turnTimers.operativeSeconds} sec` : "off"}</div>`}
          <button class="button button-primary button-full" id="start-game" ${isHost && teamsReady ? "" : "disabled"}>${startLabel}</button>
          <p class="hint">Each team needs a spymaster and an operative. Share the room code to invite up to 19 friends.</p>
        </aside>
      </div>
      <section class="panel rules"><h3>HOW TO PLAY</h3><p>Spymasters give a one-word clue and a number. Operatives can queue several words, then tap a queued card to confirm guesses one at a time. Find all your team's agents to win — but avoid the assassin. A wrong guess ends your turn.</p></section>
      <button class="small-button" id="leave-room" style="margin-top:14px">Leave room</button>
    </section>`;
  document.querySelector("#team-select").addEventListener("change", (event) => act("settings", { team: event.target.value }));
  document.querySelector("#role-select").addEventListener("change", (event) => act("settings", { role: event.target.value }));
  document.querySelector("#lobby-spymaster-timer")?.addEventListener("change", (event) =>
    act("timers", {
      spymasterSeconds: Number(event.target.value),
      operativeSeconds: Number(document.querySelector("#lobby-operative-timer").value)
    })
  );
  document.querySelector("#lobby-operative-timer")?.addEventListener("change", (event) =>
    act("timers", {
      spymasterSeconds: Number(document.querySelector("#lobby-spymaster-timer").value),
      operativeSeconds: Number(event.target.value)
    })
  );
  document.querySelector("#start-game").addEventListener("click", () => act("start"));
  document.querySelector("#leave-room").addEventListener("click", () => act("leave"));
  bindSoundToggle();
  document.querySelector("#copy-code").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(state.code);
      showToast("Room code copied.");
    } catch {
      showToast(`Share this code: ${state.code}`);
    }
  });
}

function renderGame(state) {
  const { me, turn } = state;
  const isMyTeamTurn = me.team === turn.team;
  const isSpymaster = me.role === "spymaster";
  const canGuess = state.status === "playing" && isMyTeamTurn && !isSpymaster && Boolean(turn.clue);
  const canClue = state.status === "playing" && isMyTeamTurn && isSpymaster && !turn.clue;
  const teamName = turn.team === "blue" ? "Blue" : "Red";
  const keyCounts = { blue: 0, red: 0, neutral: 0, assassin: 0 };
  if (state.key) state.key.forEach((team) => { keyCounts[team] += 1; });
  const isFinished = state.status === "finished";
  const winnerName = state.winner === "blue" ? "Blue team" : "Red team";
  const isHost = me.id === state.hostId;
  const remainingGuesses = Math.max(0, turn.maxGuesses - turn.guesses);
  const personalStats = state.stats;
  const timerOptions = [[0, "Off"], [30, "30 sec"], [45, "45 sec"], [60, "1 min"], [90, "90 sec"], [120, "2 min"]];

  if (!canGuess || selectedGuessTurn !== turn.id) {
    selectedGuesses = [];
    selectedGuessTurn = canGuess ? turn.id : null;
  }
  selectedGuesses = selectedGuesses.filter((index) => !state.cards[index]?.revealed);
  for (const index of [...revealedWordVisible]) {
    if (!state.cards[index]?.revealed) revealedWordVisible.delete(index);
  }

  let instruction;
  if (isFinished) instruction = "The game is over.";
  else if (!isMyTeamTurn) instruction = `${teamName} team is thinking.`;
  else if (isSpymaster && !turn.clue) instruction = "Give your team one clever clue.";
  else if (isSpymaster) instruction = "Your operatives are making their picks.";
  else if (!turn.clue) instruction = "Waiting for your spymaster's clue.";
  else instruction = "Queue words, then confirm each guess on its card.";

  const board = state.cards.map((card, index) => {
    const revealed = card.revealed;
    const key = state.key?.[index];
    const cssTeam = revealed ? card.team : key;
    const colorClass = cssTeam ? ` ${cssTeam}-card` : "";
    const keyClass = !revealed && key ? ` key-${key}` : "";
    const selectedPosition = selectedGuesses.indexOf(index);
    const selectedClass = selectedPosition >= 0 ? " selected" : "";
    const wordVisible = revealedWordVisible.has(index);
    const disabled = !revealed && (!canGuess || isFinished) ? "disabled" : "";
    const staged = selectedPosition >= 0;
    const revealArt = revealed ? `<svg class="reveal-art" viewBox="0 0 64 64" aria-hidden="true">${card.team === "assassin"
      ? '<path d="M32 6 54 18v20L32 58 10 38V18L32 6Z" fill="currentColor"/><path d="M23 27h5m8 0h5M24 40c4-5 12-5 16 0M28 18l4 5 4-5" fill="none" stroke="#fff7e9" stroke-linecap="round" stroke-width="3"/>'
      : card.team === "neutral"
        ? '<path d="M32 5 59 32 32 59 5 32 32 5Z" fill="currentColor"/><circle cx="32" cy="32" r="9" fill="none" stroke="#fff9e8" stroke-width="3"/>'
        : '<path d="M32 5 57 19v26L32 59 7 45V19L32 5Z" fill="currentColor"/><path d="m20 33 8 8 17-19" fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round" stroke-width="5"/>'
    }</svg>` : "";
    return `<button class="word-card${revealed ? " revealed" : ""}${wordVisible ? " show-word" : ""}${colorClass}${keyClass}${selectedClass}" data-index="${index}" data-revealed="${revealed}" ${disabled} aria-label="${escapeHtml(card.word)}${revealed ? `, ${escapeHtml(card.team)}, ${wordVisible ? "word visible" : "tap to reveal word"}` : ""}${staged ? `, guess ${selectedPosition + 1} selected, tap to confirm` : ""}">${revealArt}<span class="word-label">${escapeHtml(card.word)}</span>${staged ? `<span class="card-stage">${selectedPosition + 1} IN QUEUE</span><span class="card-confirm-hit">CONFIRM GUESS ↗</span>` : ""}${state.key && !revealed ? `<span class="card-count">${escapeHtml((card.team || key || "").slice(0, 1).toUpperCase())}</span>` : ""}</button>`;
  }).join("");

  app.innerHTML = `
    <section class="game">
      <div class="game-top"><div class="game-top-left"><div class="game-room"><span class="room-code-label">ROOM</span><strong>${escapeHtml(state.code)}</strong><span class="room-divider">·</span><span>${state.players.length} PLAYERS</span></div><div class="identity-pill ${me.team}"><span class="identity-dot"></span><span>YOU · ${me.team.toUpperCase()} ${me.role === "spymaster" ? "SPYMASTER" : "OPERATIVE"}</span></div></div><div class="game-top-actions">${isHost && !isFinished ? `<label class="timer-control"><span>SPYMASTER</span><select class="small-select" id="game-spymaster-timer" aria-label="Spymaster timer">${timerOptions.map(([seconds, label]) => `<option value="${seconds}" ${state.turnTimers.spymasterSeconds === seconds ? "selected" : ""}>${label}</option>`).join("")}</select></label><label class="timer-control"><span>OPERATIVE</span><select class="small-select" id="game-operative-timer" aria-label="Operative timer">${timerOptions.map(([seconds, label]) => `<option value="${seconds}" ${state.turnTimers.operativeSeconds === seconds ? "selected" : ""}>${label}</option>`).join("")}</select></label>` : ""}${soundButtonMarkup()}<button class="small-button" id="leave-room">Leave game</button></div></div>
      ${isFinished ? `<div class="game-over ${state.winner === me.team ? "" : "lost"}"><span>${winnerName} wins${state.winner === me.team ? " — nice work!" : ""}</span>${state.hostId === me.id ? '<button class="small-button" id="new-game">New game</button>' : ""}</div>` : ""}
      <div class="game-layout">
        <div class="board-wrap">
          ${!isFinished ? `<div class="turn-banner ${turn.team}-turn"><div class="turn-main"><span class="turn-swatch"></span><span class="turn-heading">${teamName} team's turn<span class="turn-sub">${escapeHtml(instruction)}</span></span></div>
            <div class="turn-clock"><span class="timer-caption">${turn.phase === "spymaster" ? "CLUE" : "GUESSES"}</span><span class="timer-value" data-deadline="${turn.deadlineAt || ""}">${turn.deadlineAt ? "" : "No timer"}</span></div>
            ${canClue ? `<form class="clue-form" id="clue-form"><input class="text-input" name="word" data-preserve-input="clue-word" maxlength="40" placeholder="Your clue" aria-label="Clue word" required><input class="text-input number-input" name="number" data-preserve-input="clue-number" type="number" min="1" max="9" value="1" aria-label="Clue number" required><button class="button button-primary" type="submit">Give clue</button></form>` : ""}
            ${turn.clue ? `<div class="turn-actions"><div class="clue-display">${escapeHtml(turn.clue.word)} <span>${turn.clue.number}</span></div>${canGuess ? `<div class="guess-controls">${selectedGuesses.length ? `<span class="selected-word">${selectedGuesses.length} ${selectedGuesses.length === 1 ? "guess" : "guesses"} queued · tap a queued card to confirm</span><button class="button button-quiet" id="clear-guesses">Clear all</button>` : '<span class="turn-note">Select one or more words</span>'}<button class="button button-quiet" id="end-turn">End turn</button></div>` : `<span class="turn-note">${isSpymaster ? "CLUE GIVEN" : instruction.toUpperCase()}</span>`}</div>` : ""}
          </div>` : ""}
          <div class="board">${board}</div>
          <section class="side-panel game-stats-panel">
            <div class="panel-heading"><h3>Your stats</h3></div>
            <div class="player-stats">
              <div><strong>${personalStats.gamesPlayed}</strong><span>GAMES</span></div>
              <div><strong>${personalStats.wins}–${personalStats.losses}</strong><span>W–L</span></div>
              <div><strong>${personalStats.accuracy}%</strong><span>ACCURACY</span></div>
              <div><strong>${personalStats.correctGuesses}/${personalStats.guesses}</strong><span>HITS</span></div>
            </div>
            <details class="match-history">
              <summary>Recent match history <span>${personalStats.recentMatches.length}</span></summary>
              <div class="history-list">${personalStats.recentMatches.map((match) => `<div class="history-entry">
                <strong>${match.winner === "blue" ? "Blue" : "Red"} won</strong>
                <span>${new Date(match.finishedAt).toLocaleDateString()} · ${match.turns} turns · ${match.guesses} guesses</span>
              </div>`).join("") || '<div class="history-empty">Your completed matches will appear here.</div>'}</div>
            </details>
          </section>
        </div>
        <aside class="side-stack">
          <section class="side-panel"><div class="panel-heading"><h3>Agents remaining</h3></div><div class="score-grid">
            <div class="score-item"><div class="score-team">BLUE</div><div class="score-number">${state.counts.blue}<span class="score-total"> / 9</span></div></div>
            <div class="score-item red-score"><div class="score-team">RED</div><div class="score-number">${state.counts.red}<span class="score-total"> / 8</span></div></div>
          </div></section>
          <section class="side-panel"><div class="panel-heading"><h3>Players</h3><span class="count-label">${state.players.length}</span></div><div class="players-list">${state.players.map((player) => playerRow(player, state.hostId, true)).join("")}</div></section>
          <section class="side-panel"><div class="panel-heading"><h3>Round notes</h3></div><div class="log-list">${state.log.slice().reverse().map((entry) => `<div class="log-entry">${escapeHtml(entry.text)}</div>`).join("") || '<div class="log-entry">Your game starts here.</div>'}</div></section>
        </aside>
      </div>
      ${isSpymaster && !isFinished ? `<p class="hint" style="text-align:center;margin-top:11px">You can see the hidden word key. Keep it secret from your operatives.</p>` : ""}
    </section>`;

  document.querySelector("#leave-room").addEventListener("click", () => act("leave"));
  document.querySelector("#new-game")?.addEventListener("click", () => act("new-game"));
  bindSoundToggle();
  const updateTimers = () => act("timers", {
    spymasterSeconds: Number(document.querySelector("#game-spymaster-timer").value),
    operativeSeconds: Number(document.querySelector("#game-operative-timer").value)
  });
  document.querySelector("#game-spymaster-timer")?.addEventListener("change", updateTimers);
  document.querySelector("#game-operative-timer")?.addEventListener("change", updateTimers);
  document.querySelector("#clue-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    act("clue", { word: form.get("word"), number: form.get("number") });
  });
  document.querySelector("#end-turn")?.addEventListener("click", () => act("end-turn"));
  document.querySelectorAll(".word-card[data-revealed='true']").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.index);
      if (revealedWordVisible.has(index)) revealedWordVisible.delete(index);
      else revealedWordVisible.add(index);
      lastRenderedState = null;
      render(state);
    });
  });
  document.querySelectorAll(".word-card:not(:disabled):not([data-revealed='true'])").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.index);
      selectedGuessTurn = turn.id;
      if (selectedGuesses.includes(index)) {
        act("guess", { index });
        return;
      }
      if (selectedGuesses.length >= remainingGuesses) {
        showToast("Guess limit reached. Confirm or clear your queued words.");
        return;
      }
      selectedGuesses.push(index);
      lastRenderedState = null;
      render(state);
    });
  });
  document.querySelector("#clear-guesses")?.addEventListener("click", () => {
    selectedGuesses = [];
    lastRenderedState = null;
    render(state);
  });
  updateTurnCountdown();
}

const session = savedSession();
if (session) {
  current = session;
  resumeRoom();
} else {
  renderHome();
}
