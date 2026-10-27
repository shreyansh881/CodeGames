# CodeGames

CodeGames is a responsive, browser-based multiplayer word game inspired by Codenames. Split into Blue and Red teams, give clever clues, find your agents, and avoid the assassin.

## Features

- Multiplayer rooms with shareable five-character invite codes
- Spymaster and Operative roles for both teams
- Hidden word key for spymasters and role/team indicators for players
- Selectable guesses that can be queued and confirmed on each card
- Separate host-controlled timers for clues and guesses
- A curated pool of 688 distinct words, with recent-board word avoidance
- Match history, player statistics, and optional synthesized sound effects
- Responsive layout for desktop, tablet, and phone screens
- Locally persisted rooms and stats for reconnecting after a server restart

## Quick start

**Requirements:** Node.js 18 or newer.

```bash
git clone https://github.com/shreyansh881/CodeGames.git
cd CodeGames
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser. No third-party packages are required. To run the automated test suite:

```bash
npm test
```

## How to play

1. Create a room and share its code with your players.
2. Choose Blue or Red and a role: Spymaster or Operative. Each team needs at least one of each role before the host can start.
3. Spymasters see the hidden key and give a word clue with a number. Clues matching a board word are rejected.
4. Operatives select and confirm guesses. A correct guess allows another pick up to the clue number plus one; a neutral or opposing agent ends the turn.
5. Find all of your team's agents to win. Finding the assassin immediately gives the other team the win.

Blue starts with nine agents; Red has eight. The board also contains neutral cards and one assassin. The host can set separate clue and guessing timers, or turn either timer off.

Revealed cards show a team-colored emblem. Tap or click one to bring its word into focus, and tap or click again to restore the emblem view.

## Run on a local network

Start the server on a computer connected to your network. Other players can visit that computer's local IP address on port `3000` (for example, `http://192.168.1.10:3000`). Make sure your firewall permits connections to that port.

## Deploy on Render

The included [`render.yaml`](./render.yaml) configures a free Render web service:

1. Push the project, including `render.yaml`, to GitHub.
2. In Render, choose **New → Blueprint** and connect the repository.
3. Deploy the `codegames` service and open the URL Render provides.

**Free-service storage warning:** CodeGames writes room and match data to a local JSON file. Free hosting uses ephemeral storage, so this data may be lost after a restart or redeploy. For persistent room and stats data, deploy on a service with a persistent disk.

## Data and persistence

- By default, room and match data is saved in `data/state.json`.
- Set `CODEGAMES_DATA_DIR` to use a different data directory.
- Run only one server process against a data directory at a time; local-file storage is not designed for multiple server instances.
- Reconnecting in the same browser uses its saved player session. Clearing browser storage creates a new player identity, so personal stats do not carry over.
- The recent-word avoidance history is kept in memory and resets when the server restarts.

## Tech

CodeGames uses a dependency-free Node.js HTTP server and a vanilla HTML, CSS, and JavaScript client. Multiplayer state is refreshed from the server every 1.5 seconds.
