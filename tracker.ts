import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

export class MatchTracker {
  private currentRoundKills: Record<string, number> = {};
  private previousRoundKills: Record<string, number> = {};

  public mapNumber: number = 1;
  public roundNumber: number = 1;
  public seriesMaps: string[] = [];

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

            // ✨ Sync mapNumber dynamically via the mapName sent by the socket
            if (msgData.mapName) {
              const cleanLiveMap = msgData.mapName
                .replace('de_', '')
                .toLowerCase();
              const foundIndex = this.seriesMaps.findIndex(
                (m) => m.includes(cleanLiveMap) || cleanLiveMap.includes(m),
              );
              if (foundIndex !== -1) {
                this.mapNumber = foundIndex + 1;
              }
            } else {
              // Standard Fallback: if we hit 0-0 and we are way past round 1, bump map manually
              if (ctScore === 0 && tScore === 0 && this.roundNumber > 1) {
                this.mapNumber++;
              }
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

    // 3. ✨ Scrape the Map Number and Series Maps from the DOM
    try {
      const scrape = await page.evaluate(() => {
        const mapholders = document.querySelectorAll('.mapholder');
        let activeMap = 1;
        let mapNames: string[] = [];

        for (let i = 0; i < mapholders.length; i++) {
          const text = mapholders[i].textContent || '';

          // Get the map name (Usually in a div called .mapname)
          const nameEl = mapholders[i].querySelector('.mapname');
          if (nameEl) {
            mapNames.push(nameEl.textContent.trim().toLowerCase());
          } else {
            // Fallback to finding standard map names anywhere in the box text
            const m = text.match(
              /(mirage|inferno|nuke|overpass|vertigo|ancient|anubis|dust2)/i,
            );
            mapNames.push(m ? m[0].toLowerCase() : `map${i + 1}`);
          }
        }

        // Logic to guess the active map:
        // 1. Look for HLTV's explicit 'playing' flag (Standard for Live Matches)
        for (let i = 0; i < mapholders.length; i++) {
          if (mapholders[i].querySelector('.playing')) {
            return { activeMap: i + 1, mapNames };
          }
        }

        // 2. Fallback: Find the FIRST map without a 'STATS' label.
        // (If Map 1 is done, it has STATS. If Map 2 is live/next, it doesn't).
        for (let i = 0; i < mapholders.length; i++) {
          if (!mapholders[i].textContent?.includes('STATS')) {
            return { activeMap: i + 1, mapNames };
          }
        }

        // 3. If all maps are finished (Both have STATS), we default to the last map played.
        return { activeMap: mapholders.length || 1, mapNames };
      });

      this.mapNumber = scrape.activeMap;
      this.seriesMaps = scrape.mapNames;

      if (this.seriesMaps.length > 0) {
        console.log(
          `🗺️  Detected Series Maps: ${this.seriesMaps.join(', ').toUpperCase()}`,
        );
      }
      console.log(`🗺️  Estimated Active Map: ${this.mapNumber}`);
    } catch (err) {
      console.log(
        '⚠️  Failed to scrape DOM for Map info. Defaulting to Map 1.',
      );
    }

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
