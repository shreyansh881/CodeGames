const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { test } = require("node:test");

const serverFile = path.join(__dirname, "..", "server.js");

async function unusedPort() {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startServer(port, dataDirectory) {
  const child = spawn(process.execPath, [serverFile], {
    env: { ...process.env, PORT: String(port), CODEGAMES_DATA_DIR: dataDirectory },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`CodeGames exited during startup: ${stderr}`);
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return { child, baseUrl };
    } catch (error) {
      if (error.cause?.code !== "ECONNREFUSED") throw error;
    }
    await delay(50);
  }
  child.kill();
  throw new Error(`CodeGames did not start in time: ${stderr}`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await exited;
}

async function request(baseUrl, route, { playerId, method = "GET", body } = {}) {
  const url = new URL(route, baseUrl);
  if (playerId) url.searchParams.set("playerId", playerId);
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  assert.equal(response.ok, true, `${method} ${route} failed: ${data.error}`);
  return data;
}

test("active rooms and player stats survive a server restart", async (t) => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "codegames-state-"));
  const port = await unusedPort();
  t.after(() => fs.rmSync(dataDirectory, { recursive: true, force: true }));

  let server = await startServer(port, dataDirectory);
  t.after(async () => stopServer(server.child));

  const host = await request(server.baseUrl, "/api/rooms", {
    method: "POST",
    body: { name: "Blue Spy" }
  });
  const stateFile = path.join(dataDirectory, "state.json");
  const savedLobby = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedLobby.rooms[0].turn.phase, null);
  delete savedLobby.rooms[0].turn.phase;
  fs.writeFileSync(stateFile, JSON.stringify(savedLobby));

  await stopServer(server.child);
  server = await startServer(port, dataDirectory);

  const blueOperative = await request(server.baseUrl, `/api/rooms/${host.code}/join`, {
    method: "POST",
    body: { name: "Blue Operative", team: "blue", role: "operative" }
  });
  const redSpy = await request(server.baseUrl, `/api/rooms/${host.code}/join`, {
    method: "POST",
    body: { name: "Red Spy", team: "red", role: "spymaster" }
  });
  const redOperative = await request(server.baseUrl, `/api/rooms/${host.code}/join`, {
    method: "POST",
    body: { name: "Red Operative", team: "red", role: "operative" }
  });

  await request(server.baseUrl, `/api/rooms/${host.code}/timers`, {
    playerId: host.playerId,
    method: "POST",
    body: { spymasterSeconds: 0, operativeSeconds: 0 }
  });
  await request(server.baseUrl, `/api/rooms/${host.code}/start`, {
    playerId: host.playerId,
    method: "POST",
    body: {}
  });
  const keyState = await request(server.baseUrl, `/api/rooms/${host.code}`, { playerId: host.playerId });
  const firstBlueIndex = keyState.key.findIndex((team) => team === "blue");
  await request(server.baseUrl, `/api/rooms/${host.code}/clue`, {
    playerId: host.playerId,
    method: "POST",
    body: { word: "Persistence", number: 9 }
  });
  await request(server.baseUrl, `/api/rooms/${host.code}/guess`, {
    playerId: blueOperative.playerId,
    method: "POST",
    body: { index: firstBlueIndex }
  });

  await stopServer(server.child);
  server = await startServer(port, dataDirectory);

  let resumed = await request(server.baseUrl, `/api/rooms/${host.code}`, { playerId: blueOperative.playerId });
  assert.equal(resumed.status, "playing");
  assert.equal(resumed.turn.team, "blue");
  assert.equal(resumed.turn.phase, "operative");
  assert.deepEqual(resumed.turn.clue, { word: "Persistence", number: 9 });
  assert.equal(resumed.cards[firstBlueIndex].revealed, true);
  assert.equal(resumed.key, null);
  assert.equal(resumed.stats.gamesPlayed, 0);

  const remainingBlueIndices = keyState.key
    .map((team, index) => team === "blue" && !resumed.cards[index].revealed ? index : -1)
    .filter((index) => index >= 0);
  for (const index of remainingBlueIndices) {
    await request(server.baseUrl, `/api/rooms/${host.code}/guess`, {
      playerId: blueOperative.playerId,
      method: "POST",
      body: { index }
    });
  }

  resumed = await request(server.baseUrl, `/api/rooms/${host.code}`, { playerId: host.playerId });
  assert.equal(resumed.status, "finished");
  assert.equal(resumed.winner, "blue");
  assert.equal(resumed.stats.gamesPlayed, 1);
  assert.equal(resumed.stats.wins, 1);
  assert.equal(resumed.stats.recentMatches.length, 1);
  assert.equal(resumed.stats.recentMatches[0].winner, "blue");

  const blueStats = await request(server.baseUrl, `/api/rooms/${host.code}`, {
    playerId: blueOperative.playerId
  });
  assert.equal(blueStats.stats.gamesPlayed, 1);
  assert.equal(blueStats.stats.wins, 1);
  assert.equal(blueStats.stats.guesses, 9);
  assert.equal(blueStats.stats.correctGuesses, 9);
  assert.equal(blueStats.stats.accuracy, 100);

  const redStats = await request(server.baseUrl, `/api/rooms/${host.code}`, { playerId: redOperative.playerId });
  assert.equal(redStats.stats.gamesPlayed, 1);
  assert.equal(redStats.stats.losses, 1);
  const redSpyStats = await request(server.baseUrl, `/api/rooms/${host.code}`, { playerId: redSpy.playerId });
  assert.equal(redSpyStats.stats.gamesPlayed, 1);
  assert.equal(redSpyStats.stats.losses, 1);

  await stopServer(server.child);
  server = await startServer(port, dataDirectory);
  const persistedStats = await request(server.baseUrl, `/api/rooms/${host.code}`, { playerId: host.playerId });
  assert.equal(persistedStats.stats.gamesPlayed, 1);
  assert.equal(persistedStats.stats.wins, 1);
  assert.equal(persistedStats.stats.recentMatches.length, 1);

  const newLobby = await request(server.baseUrl, `/api/rooms/${host.code}/new-game`, {
    playerId: host.playerId,
    method: "POST",
    body: {}
  });
  assert.equal(newLobby.status, "lobby");
  assert.equal(newLobby.turn.phase, null);

  await stopServer(server.child);
  server = await startServer(port, dataDirectory);
  const resumedLobby = await request(server.baseUrl, `/api/rooms/${host.code}`, { playerId: host.playerId });
  assert.equal(resumedLobby.status, "lobby");
  assert.equal(resumedLobby.turn.phase, null);
  assert.equal(resumedLobby.stats.gamesPlayed, 1);
  assert.equal(resumedLobby.stats.recentMatches.length, 1);
});
