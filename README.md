# CodeGames

CodeGames is a browser-based, multiplayer Codenames-style word game. Players join a shared room, choose a team and role, and play together in real time.

## Run locally

1. Install [Node.js](https://nodejs.org/) 18 or newer.
2. From this folder, run `npm start`.
3. Open `http://localhost:3000`.
4. Create a room, then share its five-character code with the other players.

No package installation is required. Run `npm test` to exercise room recovery and match-stat persistence. Rooms and match stats are saved locally in `data/state.json`, so players can refresh or reconnect with their saved browser session, and rooms survive a server restart. Set `CODEGAMES_DATA_DIR` to choose another data directory. Back up this directory to preserve rooms and stats. Run one server process against a data directory at a time; this local-file storage is not intended for multiple server instances or ephemeral hosting. To play over a local network, other players can open the host computer's local network address on port `3000`.

## Deploy on Render

The included `render.yaml` configures a free Render web service. Push this project to GitHub, then in Render choose **New → Blueprint**, connect the repository, and deploy the `codegames` service. Render provides the public URL when the deploy finishes.

The free service uses ephemeral storage. Rooms and match stats are written to `data/state.json`, but they may be lost when the service restarts or is redeployed. Use a host with a persistent disk if you need saved games and stats to survive those events.

## Word selection

The server uses a built-in curated pool of 688 distinct, clue-friendly words. It chooses 25 words at random for each board and avoids words used on the previous four boards in that room. Word matching ignores capitalization, spacing, punctuation, and accents when filtering duplicates and rejecting clues that match a board word. The per-room recent-word history is kept in memory and resets when the server restarts.

## How to play

- Choose Blue or Red and select Spymaster or Operative in the lobby. Each team needs at least one spymaster and one operative; the host starts the game.
- Spymasters see the hidden word key and give a word clue with a number. Clues matching a word on the board are rejected.
- The host chooses separate spymaster clue and operative guessing timers (off, 30, 45, 60, 90, or 120 seconds) in the lobby or during play. The operative timer starts after the clue is given; a timeout passes play to the other team.
- Your team and role stay visible beside the room code while playing. Operatives can queue up to their remaining guess limit and confirm each directly on its card, one at a time; selecting a wrong word still ends the turn immediately.
- Revealed cards display a team-colored emblem. Tap a revealed card to fade the emblem and bring its word into focus, then tap again to restore the emblem.
- Correct picks for their team allow another guess, up to the clue number plus one. Picking a neutral or opposing agent ends the turn; finding the assassin ends the game immediately.
- The first team to find all of its agents wins. Blue starts and has nine agents; Red has eight.

The interface refreshes game state from the server every 1.5 seconds. Rooms remain available after restarting the server when the same data directory is retained. A room is removed when every player explicitly leaves.

The layout adapts to laptop, tablet, and phone-sized screens. On narrow screens, the player panels move below the board and controls reflow to avoid horizontal scrolling.

## Match stats and sound

- Each browser player session keeps its own persistent games, wins, losses, guesses, and accuracy totals. The game also shows that player's five most recent completed matches. Clearing browser storage creates a new player identity and does not merge old stats.
- Sound effects for clues, card reveals, turn changes, and wins are synthesized by the browser. Use the Sound toggle in the lobby or game controls to turn them on or off; the preference is saved on that browser.
