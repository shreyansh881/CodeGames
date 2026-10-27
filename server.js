const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = process.env.CODEGAMES_DATA_DIR || path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const rooms = new Map();
let statsByPlayer = {};
let matchHistory = [];

class StatePersistenceError extends Error {}

function isValidState(state) {
  const isPlayer = (player) =>
    player && typeof player.id === "string" && typeof player.name === "string" &&
    ["blue", "red"].includes(player.team) &&
    ["spymaster", "operative"].includes(player.role) &&
    Number.isFinite(player.lastSeen);
  const isCard = (card) =>
    card && typeof card.word === "string" &&
    ["blue", "red", "neutral", "assassin"].includes(card.team) &&
    typeof card.revealed === "boolean";
  return state &&
    state.format === "codegames-state" &&
    state.version === 1 &&
    Array.isArray(state.rooms) &&
    state.rooms.every((room) =>
      room && typeof room.code === "string" && /^[A-Z0-9]{5}$/.test(room.code) &&
      typeof room.hostId === "string" &&
      ["lobby", "playing", "finished"].includes(room.status) &&
      Array.isArray(room.players) && room.players.every(isPlayer) &&
      Array.isArray(room.cards) && room.cards.every(isCard) &&
      Array.isArray(room.recentWords) && room.recentWords.every((word) => typeof word === "string") &&
      Array.isArray(room.log) && room.log.every((entry) => entry && typeof entry.text === "string" && Number.isFinite(entry.at)) &&
      room.turn && (room.turn.id === null || typeof room.turn.id === "string") &&
      (room.turn.team === null || ["blue", "red"].includes(room.turn.team)) &&
      (room.turn.phase === null ||
        (room.status === "lobby" && room.turn.id === null && room.turn.phase === undefined) ||
        ["spymaster", "operative"].includes(room.turn.phase)) &&
      Number.isInteger(room.turn.guesses) && Number.isInteger(room.turn.maxGuesses) &&
      Number.isFinite(room.turn.durationSeconds) &&
      (room.turn.deadlineAt === null || Number.isFinite(room.turn.deadlineAt)) &&
      room.turnTimers && [room.turnTimers.spymasterSeconds, room.turnTimers.operativeSeconds]
        .every((seconds) => [0, 30, 45, 60, 90, 120].includes(seconds)) &&
      typeof room.statsRecorded === "boolean" &&
      Number.isInteger(room.turnNumber) && Number.isInteger(room.matchGuesses)
    ) &&
    state.statsByPlayer && typeof state.statsByPlayer === "object" && !Array.isArray(state.statsByPlayer) &&
    Object.values(state.statsByPlayer).every((stats) =>
      stats && typeof stats.name === "string" &&
      ["gamesPlayed", "wins", "losses", "guesses", "correctGuesses"].every((key) =>
        Number.isInteger(stats[key]) && stats[key] >= 0
      )
    ) &&
    Array.isArray(state.matchHistory) &&
    state.matchHistory.every((match) =>
      match && typeof match.id === "string" && typeof match.code === "string" &&
      ["blue", "red"].includes(match.winner) && Number.isFinite(match.startedAt) &&
      Number.isFinite(match.finishedAt) && Number.isInteger(match.turns) &&
      Number.isInteger(match.guesses) && Array.isArray(match.playerIds) &&
      match.playerIds.every((id) => typeof id === "string") &&
      Array.isArray(match.players) && match.players.every((player) =>
        player && typeof player.name === "string" && ["blue", "red"].includes(player.team) &&
        ["spymaster", "operative"].includes(player.role)
      )
    );
}

function loadPersistedState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let contents;
  try {
    contents = fs.readFileSync(STATE_FILE, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw new Error(`Could not read saved CodeGames state at ${STATE_FILE}: ${error.message}`);
  }
  let state;
  try {
    state = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Saved CodeGames state is corrupt at ${STATE_FILE}: ${error.message}`);
  }
  if (!isValidState(state)) {
    throw new Error(`Saved CodeGames state has an unsupported format or invalid data: ${STATE_FILE}`);
  }
  for (const room of state.rooms) {
    if (room.turn.phase === undefined) room.turn.phase = null;
    rooms.set(room.code, room);
  }
  statsByPlayer = state.statsByPlayer;
  matchHistory = state.matchHistory;
}

function persistState() {
  const state = JSON.stringify({
    format: "codegames-state",
    version: 1,
    rooms: [...rooms.values()],
    statsByPlayer,
    matchHistory
  });
  const temporaryFile = `${STATE_FILE}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, state, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporaryFile, STATE_FILE);
  } catch (error) {
    try {
      if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
    } catch (cleanupError) {
      console.error(`Could not clean up temporary state file ${temporaryFile}: ${cleanupError.message}`);
    }
    console.error(`Could not persist CodeGames state: ${error.message}`);
    throw new StatePersistenceError("Could not save game state. Please retry.");
  }
}

const WORDS = [
  "ANCHOR", "APPLE", "ARROW", "ATLANTIS", "AVOCADO", "BACKSTAGE",
  "BAND", "BANK", "BARK", "BAT", "BEACH", "BEAR", "BEAT", "BELL",
  "BERLIN", "BOLT", "BOND", "BOOM", "BOOT", "BOTTLE", "BOX", "BRIDGE",
  "BRUSH", "BUCK", "BUG", "BUTTON", "CAP", "CAPITAL", "CARD", "CAST",
  "CAT", "CELL", "CENTER", "CHANGE", "CHARGE", "CHECK", "CHEST", "CHICK",
  "CHINA", "CHOCOLATE", "CHURCH", "CIRCLE", "CLIFF", "CLOUD", "CLUB",
  "CODE", "COLD", "CONCERT", "COOK", "COPPER", "COTTON", "CRANE", "CROSS",
  "CROWN", "CYCLE", "DANCE", "DATE", "DECK", "DIAMOND", "DICE", "DINOSAUR",
  "DOCTOR", "DOG", "DRAFT", "DRAGON", "DREAM", "DRILL", "DROP", "DUCK",
  "EAGLE", "ENGINE", "EUROPE", "EYE", "FACE", "FAIR", "FALL", "FAN",
  "FENCE", "FIELD", "FIGURE", "FILE", "FILM", "FIRE", "FISH", "FLUTE",
  "FLY", "FOOT", "FORCE", "FOREST", "FORK", "FRANCE", "GAME", "GAS",
  "GHOST", "GIANT", "GLASS", "GLOVE", "GOLD", "GRACE", "GRASS", "GREECE",
  "GREEN", "GROUND", "HAM", "HAND", "HAWK", "HEAD", "HEART", "HELICOPTER",
  "HIMALAYAS", "HOLE", "HOLLYWOOD", "HONEY", "HOOD", "HOOK", "HORN",
  "HORSE", "HOSPITAL", "HOTEL", "ICE", "IRON", "IVORY", "JACK", "JAM",
  "JAPAN", "JUPITER", "KANGAROO", "KETCHUP", "KEY", "KID", "KING", "KIWI",
  "KNIFE", "KNIGHT", "LAB", "LAP", "LASER", "LEAD", "LEMON", "LIFE",
  "LIGHT", "LIMOUSINE", "LINE", "LION", "LITTER", "LOCH NESS", "LOCK",
  "LOG", "LONDON", "LUCK", "MAIL", "MAMMOTH", "MAPLE", "MARBLE", "MARCH",
  "MASS", "MATCH", "MERCURY", "MEXICO", "MILLIONAIRE", "MINE", "MINT",
  "MISSILE", "MODEL", "MOLE", "MOON", "MOSCOW", "MOUNT", "MOUSE", "MOUTH",
  "MUG", "NAIL", "NEEDLE", "NET", "NEW YORK", "NIGHT", "NINJA", "NOTE",
  "NUT", "OCTOPUS", "OIL", "OLIVE", "OPERA", "ORANGE", "ORGAN", "PALM",
  "PAN", "PANTS", "PAPER", "PARACHUTE", "PARK", "PART", "PASS", "PASTE",
  "PEAR", "PENGUIN", "PHOENIX", "PIANO", "PIE", "PILOT", "PIN", "PIPE",
  "PIRATE", "PISTOL", "PITCH", "PLATE", "PLATYPUS", "PLAY", "POCKET",
  "POINT", "POISON", "POLE", "POLICE", "POOL", "PORT", "POST", "POUND",
  "PRESS", "PRINCESS", "PUMPKIN", "PUPIL", "PYRAMID", "QUEEN", "RABBIT",
  "RACKET", "RAY", "REVOLUTION", "RING", "ROBIN", "ROBOT", "ROCK", "ROME",
  "ROOT", "ROSE", "ROW", "RULER", "SATELLITE", "SATURN", "SCALE", "SCHOOL",
  "SCIENTIST", "SCORPION", "SCREEN", "SCUBA DIVER", "SEAL", "SERVER",
  "SHADOW", "SHAKESPEARE", "SHARK", "SHIP", "SHOE", "SHOP", "SHOT", "SINK",
  "SKYSCRAPER", "SLIP", "SLUG", "SMUGGLER", "SNOW", "SOCK", "SOLDIER",
  "SOUL", "SOUND", "SPACE", "SPELL", "SPIDER", "SPIKE", "SPINE", "SPOT",
  "SPRING", "SPY", "SQUARE", "STAFF", "STAR", "STATE", "STICK", "STOCK",
  "STRAW", "STREAM", "STRING", "SUB", "SUIT", "SUPERHERO", "SWING",
  "SWITCH", "TABLE", "TAIL", "TAP", "TEACHER", "TELESCOPE", "TEMPLE",
  "THEATER", "THUMB", "TICK", "TIE", "TIME", "TOKYO", "TOOTH", "TORCH",
  "TOWER", "TRACK", "TRAIN", "TRIANGLE", "TRIP", "TRUNK", "TUBE", "TURKEY",
  "UNDERTAKER", "UNICORN", "VACUUM", "VAN", "VET", "WAKE", "WALL", "WAR",
  "WASHER", "WASHINGTON", "WATCH", "WATER", "WAVE", "WEB", "WELL", "WHALE",
  "WHIP", "WIND", "WITCH", "WORM", "YARD",
  "AIRPORT", "ALBUM", "ALLEY", "ALMOND", "AMBER", "AMERICA", "AMULET",
  "ANIMAL", "APRON", "AQUARIUM", "ARCH", "ARM", "ARMOR", "ARTIST", "ASH",
  "ASIA", "ASTRONAUT", "ATHLETE", "ATTIC", "AUNT", "AUTUMN", "AWARD",
  "BABY", "BACKPACK", "BAKER", "BALCONY", "BALLOON", "BANANA", "BANNER",
  "BARREL", "BASKET", "BASKETBALL", "BATH", "BATTERY", "BAY", "BEAN",
  "BED", "BEDROOM", "BEE", "BEETLE", "BICYCLE", "BIRD", "BLANKET",
  "BLENDER", "BLOCK", "BLUE", "BOAT", "BONE", "BOOK", "BOSS", "BOW",
  "BOWL", "BRAIN", "BRANCH", "BREAD", "BREAKFAST", "BRICK", "BROTHER",
  "BUBBLE", "BUCKET", "BUILDING", "BUNNY", "BURGER", "BUS", "BUTTER",
  "CABIN", "CACTUS", "CAKE", "CAMERA", "CAMP", "CANDLE", "CANDY", "CANYON",
  "CAR", "CARPET", "CARROT", "CASTLE", "CEILING", "CHAIN", "CHAIR",
  "CHAMPION", "CHEESE", "CHERRY", "CHESS", "CHIEF", "CHILD", "CINEMA",
  "CITIZEN", "CLOCK", "CLOWN", "COACH", "COAST", "COBRA", "COFFEE",
  "COIN", "COMET", "COMPASS", "COMPUTER", "COOKIE", "CORAL", "CORNER",
  "COUSIN", "COW", "CRAB", "CREEK", "CREW", "CRICKET", "CRYSTAL", "CUP",
  "CURTAIN", "CUSHION", "DAISY", "DASH", "DAWN", "DESERT", "DESK",
  "DETECTIVE", "DIARY", "DISH", "DOOR", "DOT", "DOWN", "DRUM", "DUST",
  "EAR", "EARTH", "ECHO", "EGG", "ELBOW", "ELEVATOR", "EMERALD",
  "ENVELOPE", "ERASER", "EVENING", "EXPERT", "FACTORY", "FARM", "FEATHER",
  "FERRY", "FINGER", "FIREWORK", "FLAG", "FLASH", "FLOOR", "FLOWER",
  "FOG", "FOUNTAIN", "FOX", "FRAME", "FREEZER", "FRIEND", "FROG", "FROST",
  "FURNITURE", "GALAXY", "GALLERY", "GARAGE", "GARDEN", "GARLIC", "GATE",
  "GEM", "GEOGRAPHY", "GIRAFFE", "GIRL", "GUITAR", "GUM", "GYM", "HAIR",
  "HALL", "HAMMER", "HARBOR", "HAT", "HAY", "HILL", "HISTORY", "HOBBY",
  "HOME", "HORIZON", "HOUR", "HUNTER", "HURRICANE", "ICE CREAM", "INK",
  "ISLAND", "JACKET", "JAZZ", "JELLY", "JELLYFISH", "JOURNEY", "JUDGE",
  "JUICE", "JUNGLE", "KETTLE", "KITE", "KNEE", "LADDER", "LADYBUG",
  "LAKE", "LAMP", "LAND", "LEAF", "LIBRARY", "LILY", "LUNCH", "MAGIC",
  "MAGNET", "MAILBOX", "MANAGER", "MANGO", "MARKET", "MASK", "MEADOW",
  "MEDAL", "MEDICINE", "MELODY", "MEMORY", "MERMAID", "MIRROR", "MONKEY",
  "MORNING", "MOTOR", "MOUNTAIN", "MUSEUM", "MUSIC", "MYSTERY", "NATURE",
  "NEIGHBOR", "NEST", "NOTEBOOK", "NURSE", "OAK", "OCEAN", "ONION",
  "ORBIT", "OUTDOOR", "OVEN", "OWL", "PAINT", "PAINTER", "PANCAKE",
  "PANDA", "PARADE", "PEACH", "PEANUT", "PENCIL", "PEPPER", "PET",
  "PICNIC", "PILLOW", "PINE", "PIZZA", "PLANET", "PLANT", "POEM", "PONY",
  "POPCORN", "POSTER", "POTATO", "PRIZE", "PUZZLE", "RAIN", "RAINBOW",
  "RAINCOAT", "RANCH", "RECIPE", "RECORD", "REFLECTION", "RESTAURANT",
  "RIVER", "ROAD", "ROCKET", "ROOF", "ROOM", "RUBBER", "SADDLE", "SALAD",
  "SALT", "SAND", "SANDWICH", "SCARF", "SCISSORS", "SEA", "SEASON",
  "SHAMPOO", "SHEEP", "SHELF", "SHELL", "SHIELD", "SHIRT", "SHOWER",
  "SIDEWALK", "SIGN", "SILK", "SILVER", "SKATE", "SKETCH", "SKI", "SKIRT",
  "SKULL", "SKY", "SLEEP", "SLIDE", "SMILE", "SNAKE", "SNEAKER", "SOAP",
  "SOFA", "SPARK", "SPEAKER", "SPEED", "SPOON", "STADIUM", "STAIR",
  "STATION", "STEAM", "STORM", "STORY", "STREET", "SUN", "SUNRISE",
  "SUNSET", "SWEATER", "SWIM", "TACO", "TALENT", "TANK", "TAXI", "TEA",
  "TIGER", "TOOL", "TOURIST", "TOWEL", "TREE", "TROPHY", "TULIP", "TUNNEL",
  "TV", "UMBRELLA", "UNIVERSE", "UP", "VALLEY", "VEGETABLE", "VILLAGE",
  "VIOLET", "VOLCANO", "WAGON", "WALLET", "WARM", "WEDDING", "WEEKEND",
  "WHEEL", "WINDOW", "WING", "WOLF", "WOOD", "WOOL", "WORLD", "ZEBRA",
  "ZIPPER", "ZOO"
];

function sendJson(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(data));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 16_384) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeWord(word) {
  return word.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z]/g, "");
}

function createBoard(room) {
  const uniqueWords = [...new Map(WORDS.map((word) => [normalizeWord(word), word])).values()];
  const recentWords = new Set(room.recentWords.map(normalizeWord));
  let words = uniqueWords.filter((word) => !recentWords.has(normalizeWord(word)));
  if (words.length < 25) words = uniqueWords;
  for (let i = words.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [words[i], words[j]] = [words[j], words[i]];
  }
  const selectedWords = words.slice(0, 25);
  room.recentWords = [...room.recentWords, ...selectedWords].slice(-100);
  const cards = selectedWords.map((word, index) => ({
    word,
    team: index < 9 ? "blue" : index < 17 ? "red" : index === 17 ? "assassin" : "neutral",
    revealed: false
  }));
  for (let i = cards.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

function publicState(room, playerId) {
  const player = room.players.find((entry) => entry.id === playerId);
  if (!player) return null;
  const isSpymaster = player.role === "spymaster";
  const personalStats = statsByPlayer[playerId] || {
    name: player.name,
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
    guesses: 0,
    correctGuesses: 0
  };
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    matchId: room.matchId,
    players: room.players.map(({ id, name, team, role, lastSeen }) => ({
      id,
      name,
      team,
      role,
      online: Date.now() - lastSeen < 15_000
    })),
    me: { id: player.id, name: player.name, team: player.team, role: player.role },
    cards: room.cards.map((card) => ({
      word: card.word,
      team: card.revealed || room.status === "finished" ? card.team : null,
      revealed: card.revealed || room.status === "finished"
    })),
    key: isSpymaster || room.status === "finished"
      ? room.cards.map((card) => card.team)
      : null,
    turn: room.turn,
    turnNumber: room.turnNumber,
    turnTimers: room.turnTimers,
    winner: room.winner,
    stats: {
      ...personalStats,
      accuracy: personalStats.guesses
        ? Math.round((personalStats.correctGuesses / personalStats.guesses) * 100)
        : 0,
      recentMatches: matchHistory
        .filter((match) => match.playerIds.includes(playerId))
        .slice(-5)
        .reverse()
        .map(({ playerIds, ...match }) => match)
    },
    log: room.log.slice(-24),
    counts: room.cards.reduce((result, card) => {
      if (!card.revealed) result[card.team] += 1;
      return result;
    }, { blue: 0, red: 0, neutral: 0, assassin: 0 })
  };
}

function addLog(room, text) {
  room.log.push({ text, at: Date.now() });
  if (room.log.length > 60) room.log.shift();
}

function updatePlayerStats(player, update) {
  const stats = statsByPlayer[player.id] || {
    name: player.name,
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
    guesses: 0,
    correctGuesses: 0
  };
  stats.name = player.name;
  update(stats);
  statsByPlayer[player.id] = stats;
}

function finishGame(room, winner) {
  room.status = "finished";
  room.winner = winner;
  if (room.statsRecorded) return;
  room.statsRecorded = true;
  for (const player of room.players) {
    updatePlayerStats(player, (stats) => {
      stats.gamesPlayed += 1;
      if (player.team === winner) stats.wins += 1;
      else stats.losses += 1;
    });
  }
  matchHistory.push({
    id: room.matchId,
    code: room.code,
    winner,
    startedAt: room.startedAt,
    finishedAt: Date.now(),
    turns: room.turnNumber,
    guesses: room.matchGuesses,
    playerIds: room.players.map((player) => player.id),
    players: room.players.map(({ name, team, role }) => ({ name, team, role }))
  });
  if (matchHistory.length > 100) matchHistory.shift();
}

function createTurn(room, team) {
  const durationSeconds = room.turnTimers.spymasterSeconds;
  return {
    id: randomUUID(),
    team,
    phase: "spymaster",
    clue: null,
    guesses: 0,
    maxGuesses: 0,
    durationSeconds,
    deadlineAt: durationSeconds ? Date.now() + durationSeconds * 1000 : null
  };
}

function nextTurn(room) {
  room.turn = createTurn(room, room.turn.team === "blue" ? "red" : "blue");
  room.turnNumber += 1;
}

function expireTurnIfNeeded(room) {
  if (room.status !== "playing" || !room.turn.deadlineAt || Date.now() < room.turn.deadlineAt) return false;
  const team = room.turn.team === "blue" ? "Blue" : "Red";
  addLog(room, `${team} ran out of time.`);
  nextTurn(room);
  return true;
}

function fail(response, status, message) {
  sendJson(response, status, { error: message });
}

async function handleApi(request, response, url) {
  const segments = url.pathname.split("/").filter(Boolean);
  if (request.method === "POST" && segments.length === 2 && segments[1] === "rooms") {
    const body = await readBody(request);
    const name = cleanText(body.name, 24);
    if (!name) return fail(response, 400, "Enter a player name.");
    let code;
    do {
      code = Math.random().toString(36).slice(2, 7).toUpperCase();
    } while (rooms.has(code));
    const id = randomUUID();
    const now = Date.now();
    const room = {
      code,
      hostId: id,
      status: "lobby",
      players: [{
        id,
        name,
        team: body.team === "red" ? "red" : "blue",
        role: body.role === "operative" ? "operative" : "spymaster",
        lastSeen: now
      }],
      cards: [],
      recentWords: [],
      turn: { id: null, team: null, phase: null, clue: null, guesses: 0, maxGuesses: 0, deadlineAt: null, durationSeconds: 0 },
      turnTimers: { spymasterSeconds: 60, operativeSeconds: 60 },
      matchId: null,
      startedAt: null,
      turnNumber: 0,
      matchGuesses: 0,
      statsRecorded: false,
      winner: null,
      log: []
    };
    rooms.set(code, room);
    persistState();
    return sendJson(response, 201, { code, playerId: id });
  }

  if (segments.length < 3 || segments[1] !== "rooms") return fail(response, 404, "Not found.");
  const code = segments[2].toUpperCase();
  const room = rooms.get(code);
  if (!room) return fail(response, 404, "Room not found. Check the code and try again.");

  if (request.method === "POST" && segments.length === 4 && segments[3] === "join") {
    const body = await readBody(request);
    const name = cleanText(body.name, 24);
    if (!name) return fail(response, 400, "Enter a player name.");
    if (room.status !== "lobby") return fail(response, 409, "This game has already started.");
    if (room.players.length >= 20) return fail(response, 409, "This room is full.");
    const id = randomUUID();
    const player = {
      id,
      name,
      team: body.team === "red" ? "red" : "blue",
      role: body.role === "operative" ? "operative" : "spymaster",
      lastSeen: Date.now()
    };
    room.players.push(player);
    addLog(room, `${name} joined the room.`);
    persistState();
    return sendJson(response, 201, { code, playerId: id });
  }

  const playerId = url.searchParams.get("playerId") || request.headers["x-player-id"];
  const player = room.players.find((entry) => entry.id === playerId);
  if (!player) return fail(response, 401, "Your player session has expired. Rejoin the room.");
  player.lastSeen = Date.now();
  if (expireTurnIfNeeded(room)) persistState();

  if (request.method === "GET" && segments.length === 3) {
    return sendJson(response, 200, publicState(room, playerId));
  }

  if (request.method !== "POST") return fail(response, 405, "Method not allowed.");
  const action = segments[3];
  const body = await readBody(request);

  if (action === "timers") {
    if (playerId !== room.hostId) return fail(response, 403, "Only the host can change turn timers.");
    if (room.status !== "lobby" && room.status !== "playing") {
      return fail(response, 409, "Turn timers can only be changed before or during a game.");
    }
    const spymasterSeconds = Number(body.spymasterSeconds);
    const operativeSeconds = Number(body.operativeSeconds);
    if (![0, 30, 45, 60, 90, 120].includes(spymasterSeconds) ||
        ![0, 30, 45, 60, 90, 120].includes(operativeSeconds)) {
      return fail(response, 400, "Choose a valid timer for both roles.");
    }
    room.turnTimers = { spymasterSeconds, operativeSeconds };
    if (room.status === "playing") {
      const seconds = room.turn.phase === "operative" ? operativeSeconds : spymasterSeconds;
      room.turn.durationSeconds = seconds;
      room.turn.deadlineAt = seconds ? Date.now() + seconds * 1000 : null;
      addLog(room, "The host updated the role timers.");
    }
    persistState();
    return sendJson(response, 200, publicState(room, playerId));
  }

  if (action === "settings") {
    if (room.status !== "lobby") return fail(response, 409, "Teams and roles are locked after the game starts.");
    if (body.team === "blue" || body.team === "red") player.team = body.team;
    if (body.role === "spymaster" || body.role === "operative") player.role = body.role;
    persistState();
    return sendJson(response, 200, publicState(room, playerId));
  }

  if (action === "leave") {
    room.players = room.players.filter((entry) => entry.id !== playerId);
    if (room.hostId === playerId && room.players.length) room.hostId = room.players[0].id;
    if (room.players.length === 0) rooms.delete(code);
    else addLog(room, `${player.name} left the room.`);
    persistState();
    return sendJson(response, 200, { ok: true });
  }

  if (action === "start") {
    if (room.hostId !== playerId) return fail(response, 403, "Only the host can start the game.");
    if (room.status !== "lobby") return fail(response, 409, "The game is not in the lobby.");
    const blue = room.players.filter((entry) => entry.team === "blue");
    const red = room.players.filter((entry) => entry.team === "red");
    if (!blue.length || !red.length) return fail(response, 409, "Both teams need at least one player.");
    if ([blue, red].some((team) => !team.some((entry) => entry.role === "spymaster"))) {
      return fail(response, 409, "Each team needs a spymaster before the game can start.");
    }
    if ([blue, red].some((team) => !team.some((entry) => entry.role === "operative"))) {
      return fail(response, 409, "Each team needs an operative before the game can start.");
    }
    room.cards = createBoard(room);
    room.status = "playing";
    room.turn = createTurn(room, "blue");
    room.firstTeam = "blue";
    room.matchId = randomUUID();
    room.startedAt = Date.now();
    room.turnNumber = 1;
    room.matchGuesses = 0;
    room.statsRecorded = false;
    addLog(room, "The game is on! Blue goes first.");
    persistState();
    return sendJson(response, 200, publicState(room, playerId));
  }

  if (action === "clue") {
    if (room.status !== "playing") return fail(response, 409, "The game is not in progress.");
    if (player.role !== "spymaster") return fail(response, 403, "Only spymasters can give clues.");
    if (player.team !== room.turn.team) return fail(response, 403, "It is the other team's turn.");
    if (room.turn.clue) return fail(response, 409, "A clue has already been given for this turn.");
    const word = cleanText(body.word, 40).replace(/\s+/g, " ");
    const number = Number(body.number);
    if (!word || !/^[\p{L}'-]+(?: [\p{L}'-]+)*$/u.test(word)) {
      return fail(response, 400, "Clue must be a word or short phrase.");
    }
    if (!Number.isInteger(number) || number < 1 || number > 9) {
      return fail(response, 400, "The clue number must be between 1 and 9.");
    }
    const normalized = normalizeWord(word);
    if (room.cards.some((card) => normalizeWord(card.word) === normalized)) {
      return fail(response, 400, "Clue cannot be one of the words on the board.");
    }
    room.turn.clue = { word, number };
    room.turn.guesses = 0;
    room.turn.maxGuesses = number + 1;
    room.turn.phase = "operative";
    room.turn.durationSeconds = room.turnTimers.operativeSeconds;
    room.turn.deadlineAt = room.turn.durationSeconds
      ? Date.now() + room.turn.durationSeconds * 1000
      : null;
    addLog(room, `${player.name} gave a clue: ${word} (${number}).`);
    persistState();
    return sendJson(response, 200, publicState(room, playerId));
  }

  if (action === "guess") {
    if (room.status !== "playing") return fail(response, 409, "The game is not in progress.");
    if (player.role !== "operative") return fail(response, 403, "Only operatives can select words.");
    if (player.team !== room.turn.team) return fail(response, 403, "It is the other team's turn.");
    if (!room.turn.clue || room.turn.phase !== "operative") {
      return fail(response, 409, "Wait for your spymaster to give a clue.");
    }
    const index = Number(body.index);
    if (!Number.isInteger(index) || index < 0 || index >= room.cards.length) return fail(response, 400, "Invalid card.");
    const card = room.cards[index];
    if (card.revealed) return fail(response, 409, "That word has already been revealed.");
    card.revealed = true;
    room.turn.guesses += 1;
    room.matchGuesses += 1;
    updatePlayerStats(player, (stats) => {
      stats.guesses += 1;
      if (card.team === player.team) stats.correctGuesses += 1;
    });
    addLog(room, `${player.name} guessed ${card.word}.`);

    if (card.team === "assassin") {
      finishGame(room, player.team === "blue" ? "red" : "blue");
      addLog(room, `The assassin was found. ${room.winner === "blue" ? "Blue" : "Red"} wins!`);
    } else if (card.team === player.team) {
      if (room.cards.filter((entry) => entry.team === player.team && !entry.revealed).length === 0) {
        finishGame(room, player.team);
        addLog(room, `${player.team === "blue" ? "Blue" : "Red"} found all their agents and wins!`);
      } else if (room.turn.guesses >= room.turn.maxGuesses) {
        addLog(room, `${player.team === "blue" ? "Blue" : "Red"} used all their guesses.`);
        nextTurn(room);
      }
    } else {
      if (card.team !== "neutral") addLog(room, `An opposing agent was revealed. ${card.team === "blue" ? "Blue" : "Red"} gains a point.`);
      nextTurn(room);
    }
    persistState();
    return sendJson(response, 200, publicState(room, playerId));
  }

  if (action === "end-turn") {
    if (room.status !== "playing") return fail(response, 409, "The game is not in progress.");
    if (player.role !== "operative" || player.team !== room.turn.team) {
      return fail(response, 403, "Only your team's operatives can end the turn.");
    }
    if (!room.turn.clue) return fail(response, 409, "A clue is needed before ending the turn.");
    addLog(room, `${player.team === "blue" ? "Blue" : "Red"} ended their turn.`);
    nextTurn(room);
    persistState();
    return sendJson(response, 200, publicState(room, playerId));
  }

  if (action === "new-game") {
    if (room.hostId !== playerId) return fail(response, 403, "Only the host can start a new game.");
    if (room.status !== "finished") return fail(response, 409, "Finish the current game first.");
    room.status = "lobby";
    room.cards = [];
    room.turn = { id: null, team: null, phase: null, clue: null, guesses: 0, maxGuesses: 0, deadlineAt: null, durationSeconds: 0 };
    room.winner = null;
    room.matchId = null;
    room.startedAt = null;
    room.turnNumber = 0;
    room.matchGuesses = 0;
    room.statsRecorded = false;
    addLog(room, `${player.name} opened a new lobby.`);
    persistState();
    return sendJson(response, 200, publicState(room, playerId));
  }

  return fail(response, 404, "Unknown action.");
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

loadPersistedState();

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    try {
      await handleApi(request, response, url);
    } catch (error) {
      if (!response.headersSent) {
        const status = error instanceof StatePersistenceError ? 500 : 400;
        sendJson(response, status, { error: error.message || "Request failed." });
      }
    }
    return;
  }

  const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const filePath = path.resolve(PUBLIC_DIR, requested);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    response.writeHead(403);
    return response.end("Forbidden");
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return response.end("Not found");
    }
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    response.end(content);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`CodeGames is running at http://localhost:${PORT}`);
});
