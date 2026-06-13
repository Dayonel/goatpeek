# goatpeek

Automate cs2 highlight extraction

# Installation

```
pnpm i
```

# Env

Create a .env file with the following

```
TWITCH_OAUTH_TOKEN=
```

# Run

```
pnpm start
```

# Trim

```
npx tsx trimmer.ts "clips/M1R24 ｜ cmtry - Highlight.mp4"
```

## How it works

```
Reads twitch chat
Reads HLTV game log
Records with streamlink
```

## Hype

```
🔥 hype:  127 [████████████████████████░░░░░░░░░░░░░░░░] msgs/s:4.2 [ace poggers clutch omg]
```

## Get Twitch OAuth token

F12 → Network → filter `gql` → any request to gql.twitch.tv → Request Headers → copy `Authorization: OAuth <token>`
