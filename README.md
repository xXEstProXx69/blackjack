# 1win Blackjack — Multiplayer Setup

## Deploy to Railway (recommended, free)

1. Go to https://railway.app and sign up (free)
2. Click **New Project → Deploy from GitHub repo**
   - Or use **Deploy from local** and upload this folder
3. Railway auto-detects Node.js and runs `npm start`
4. Once deployed, copy your URL (e.g. `https://bj-xyz.railway.app`)
5. Share that URL with friends — they open it in their browser

## Deploy to Render (alternative, free)

1. Go to https://render.com, sign up
2. New → **Web Service** → connect your GitHub repo (or upload)
3. Build command: `npm install`
4. Start command: `node server.js`
5. Free tier spins down after 15min idle — first load may be slow

## Run locally (same network only)

```bash
npm install
node server.js
```
Then both PCs on the same WiFi open: `http://YOUR-LOCAL-IP:3000`
Find your IP with `ipconfig` (Windows) or `ifconfig` (Mac/Linux)

## How to play

1. Player 1 opens the URL, enters name, clicks **Create Room**
2. Share the 4-digit code shown on screen
3. Player 2 opens the same URL, enters name, types the code, clicks **Join**
4. Player 1 clicks **Start Game** when everyone is in
5. Each player claims seats by clicking the main circle
6. Place bets, click Deal — the server runs the game for everyone
