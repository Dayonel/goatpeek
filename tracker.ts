import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Use the exact stealth setup you know works
puppeteer.use(StealthPlugin());

export class MatchTracker {
  private roundKills: Record<string, number> = {};
  public mapNumber: number = 1;
  public roundNumber: number = 1;
  public lastPlay: { player: string; kills: number; ts: number } | null = null;

  private browser: any;

  constructor(public matchId: number) {}

  async start() {
    console.log(
      `\n📈 Launching stealth browser to connect to HLTV (Match ID: ${this.matchId})...`,
    );

    this.browser = await puppeteer.launch({ headless: true });
    const page = await this.browser.newPage();

    // ─── THE MAGIC ──────────────────────────────────────────────────────────
    // Hook into the Chrome DevTools Protocol to listen to raw network traffic.
    // We catch the live HLTV Scorebot WebSocket frames as they arrive.
    const cdp = await page.target().createCDPSession();
    await cdp.send('Network.enable');

    cdp.on('Network.webSocketFrameReceived', (event: any) => {
      const payload = event.response?.payloadData;

      // HLTV Scorebot uses standard Socket.io. Payload '42' means a message frame.
      if (typeof payload === 'string' && payload.startsWith('42')) {
        try {
          // Parse the raw socket payload: e.g., '42["log", [ ... ]]'
          const parsed = JSON.parse(payload.substring(2));
          const msgType = parsed[0];
          const msgData = parsed[1];

          // 1. Parse Scoreboard Updates (Map & Round)
          if (msgType === 'scoreboard') {
            // Check possible HLTV JSON key variations
            const ctScore =
              msgData.counterTerroristScore ??
              msgData.ctTeamScore ??
              msgData.ctScore ??
              0;
            const tScore =
              msgData.terroristScore ??
              msgData.terroristTeamScore ??
              msgData.tScore ??
              0;
            const round = ctScore + tScore + 1;

            if (ctScore === 0 && tScore === 0 && this.roundNumber > 1) {
              this.mapNumber++;
            }
            this.roundNumber = round;
          }

          // 2. Parse Kills directly from live game log
          if (msgType === 'log') {
            const events = Array.isArray(msgData)
              ? msgData
              : msgData?.log || [];

            for (const evt of events) {
              if (evt && typeof evt === 'object') {
                if ('Kill' in evt && evt.Kill) {
                  const killer = evt.Kill.killerName;
                  if (killer) {
                    this.roundKills[killer] =
                      (this.roundKills[killer] || 0) + 1;
                    this.lastPlay = {
                      player: killer,
                      kills: this.roundKills[killer],
                      ts: Date.now(),
                    };
                  }
                }

                if ('RoundStart' in evt) {
                  this.roundKills = {};
                }
              }
            }
          }
        } catch (err) {
          // Ignore JSON parse errors on malformed network frames
        }
      }
    });

    // ─── PAGE NAVIGATION ────────────────────────────────────────────────────
    // URL fallback to generic /match endpoint, HLTV handles the redirect naturally
    const matchUrl = `https://www.hltv.org/matches/${this.matchId}/match`;
    console.log(`Navigating to ${matchUrl} to clear Cloudflare...`);

    await page.goto(matchUrl, { waitUntil: 'domcontentloaded' });

    const title = await page.title();
    if (title.includes('Just a moment')) {
      console.log(
        '⚠️ Cloudflare challenge detected! Waiting for StealthPlugin to clear it...',
      );
      // Let it sit and bypass naturally
      await page.waitForNavigation({ timeout: 20000 }).catch(() => {});
    }

    console.log(
      '🟢 Connected to HLTV Live Game Logs via Puppeteer WebSocket Interception!',
    );
  }

  getHighlightMeta(chatDescFallback: string) {
    const now = Date.now();
    let player = 'cmtry';
    let desc = chatDescFallback;

    // If a play was logged recently (within 45s to account for stream delay)
    if (this.lastPlay && now - this.lastPlay.ts < 45000) {
      player = this.lastPlay.player;
      const kills = this.lastPlay.kills;

      if (kills === 5) desc = 'Ace';
      else if (kills === 4) desc = '4K';
      else if (kills === 3 && desc === 'Highlight') desc = '3K';
      else if (kills === 2 && desc === 'Highlight') desc = '2K';
    }

    if (chatDescFallback === 'Clutch' || chatDescFallback === 'Ninja Defuse') {
      desc = chatDescFallback;
    }

    return {
      map: this.mapNumber,
      round: this.roundNumber,
      player,
      description: desc,
    };
  }
}
