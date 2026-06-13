# CS2 Auto-Clipper — chat-driven highlight detection

## How it works

```
Twitch IRC (WebSocket, anonymous) ──► ChatMonitor
  scores each message by hype words (POG=6, ace=8, clutch=7, clip=6 …)
  tracks 5s / 30s rolling windows + message velocity

streamlink ──► ffmpeg ──► 30s segments

Every 30s:
  if chat hype score ≥ threshold (default 40):
    → ollama/llava reads a frame to extract player/team/round/score
    → save .mp4 + .json
  else:
    → discard segment
```

## Hype score display (live)

```
🔥 hype:  127 [████████████████████████░░░░░░░░░░░░░░░░] msgs/s:4.2 [ace poggers clutch omg]
```

## Install

```powershell
pip install streamlink
npm install -g ts-node
ollama pull llava
```

## Get Twitch OAuth token

F12 → Network → filter `gql` → any request to gql.twitch.tv → Request Headers → copy `Authorization: OAuth <token>`

## Run

```powershell
$env:TWITCH_OAUTH_TOKEN="..."
cd cs2-clipper
npm install
npm start
```

## Tune

In `src/index.ts`:

- `HYPE_THRESHOLD = 40` — lower = more clips, higher = only true highlights
- `HYPE` dict in `src/chat.ts` — add/adjust word weights
