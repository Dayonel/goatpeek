import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

export class MatchTracker {
  private currentRoundKills: Record<string, number> = {};
  private previousRoundKills: Record<string, number> = {};

  public mapNumber: number = 1;
  public roundNumber: number = 1;

  private browser: any;

  constructor(public matchId: number) {}

  async start() {
    console.log(
      `\n📈 Launching stealth browser to connect to HLTV (Match ID: ${this.matchId})...`,
    );

    this.browser = await puppeteer.launch({ headless: true });
    const page = await this.browser.newPage();

    // 1. Hook into raw network traffic
    const cdp = await page.target().createCDPSession();
    await cdp.send('Network.enable');

    cdp.on('Network.webSocketFrameReceived', (event: any) => {
      const payload = event.response?.payloadData;

      if (typeof payload === 'string' && payload.startsWith('42')) {
        try {
          const parsed = JSON.parse(payload.substring(2));
          const msgType = parsed[0];
          const msgData = parsed[1];

          // ─── PARSE MAP AND ROUND ───
          if (msgType === 'scoreboard') {
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

          // ─── PARSE KILLS ───
          if (msgType === 'log') {
            const events = Array.isArray(msgData)
              ? msgData
              : msgData?.log || [];

            for (const evt of events) {
              if (evt && typeof evt === 'object') {
                if ('Kill' in evt && evt.Kill) {
                  const killer = evt.Kill.killerName;
                  if (killer) {
                    this.currentRoundKills[killer] =
                      (this.currentRoundKills[killer] || 0) + 1;
                  }
                }

                // If a round ends/starts, snapshot the stats to the 'previous' buffer.
                // This bridges the gap for Twitch stream delay!
                if ('RoundStart' in evt || 'RoundEnd' in evt) {
                  if (Object.keys(this.currentRoundKills).length > 0) {
                    this.previousRoundKills = { ...this.currentRoundKills };
                  }
                  if ('RoundStart' in evt) {
                    this.currentRoundKills = {};
                  }
                }
              }
            }
          }
        } catch (err) {}
      }
    });

    // 2. Navigate to match page
    const matchUrl = `https://www.hltv.org/matches/${this.matchId}/match`;
    await page.goto(matchUrl, { waitUntil: 'domcontentloaded' });

    const title = await page.title();
    if (title.includes('Just a moment')) {
      await page.waitForNavigation({ timeout: 20000 }).catch(() => {});
    }

    // 3. Scrape the Map Number from the DOM (fixes joining on Map 3)
    try {
      const domMapNum = await page.evaluate(() => {
        const mapholders = document.querySelectorAll('.mapholder');
        for (let i = 0; i < mapholders.length; i++) {
          // HLTV flags the currently active map div with a 'playing' class
          if (mapholders[i].querySelector('.playing')) return i + 1;
        }
        return 1;
      });
      this.mapNumber = domMapNum;
      console.log(`🗺️  Detected Active Map: ${this.mapNumber}`);
    } catch (err) {}

    console.log('🟢 Connected to HLTV Live Game Logs via Puppeteer WebSocket!');
  }

  getHighlightMeta(chatDescFallback: string) {
    let player = 'cmtry';
    let desc = chatDescFallback;
    let maxKills = 0;

    // 1. Who has the most kills in the CURRENT round?
    let bestPlayer = '';
    for (const [p, kills] of Object.entries(this.currentRoundKills)) {
      if (kills > maxKills) {
        maxKills = kills;
        bestPlayer = p;
      }
    }

    // 2. Stream Delay Compensation: If Twitch reacts but the current HLTV round
    // literally just started, check the PREVIOUS round for the multi-kill!
    if (maxKills < 2) {
      let prevMax = 0;
      let prevBest = '';
      for (const [p, kills] of Object.entries(this.previousRoundKills)) {
        if (kills > prevMax) {
          prevMax = kills;
          prevBest = p;
        }
      }

      if (prevMax >= 2) {
        maxKills = prevMax;
        bestPlayer = prevBest;
      }
    }

    // 3. Assign Multi-kill Descriptions
    if (bestPlayer) {
      player = bestPlayer;
      if (maxKills === 5) desc = 'Ace';
      else if (maxKills === 4) desc = '4K';
      else if (maxKills === 3 && desc === 'Highlight') desc = '3K';
      else if (maxKills === 2 && desc === 'Highlight') desc = '2K';
    }

    // 4. Force override if chat was explicitly screaming "ninja defuse"
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
