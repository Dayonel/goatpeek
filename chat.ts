import WebSocket from 'ws';

const IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';
const HYPE_WORDS: Record<string, number> = {
  pog: 6,
  poggers: 6,
  pogchamp: 6,
  omegalul: 4,
  kekw: 3,
  ez: 3,
  ace: 8,
  '5k': 8,
  '4k': 6,
  clutch: 7,
  ninja: 7,
  defuse: 5,
  highlight: 4,
  omg: 5,
  wtf: 4,
  holy: 8,
  clip: 6,
  clipit: 7,
  cracked: 5,
  insane: 5,
  vac: 10,
  wow: 10,
};

// ─── FUZZY MATCHING LOGIC ──────────────────────────────────────────
// Pre-compile regular expressions for every hype word.
// Example: 'poggers' -> collapsed: 'pogers' -> pattern: /^p+o+g+e+r+s+$/
const HYPE_RULES = Object.entries(HYPE_WORDS).map(([word, score]) => {
  // Remove consecutive duplicate characters from the base word
  const collapsedWord = word.replace(/(.)\1+/g, '$1');

  // Create a regex allowing 1 or more of each character in sequence
  const pattern =
    '^' +
    collapsedWord
      .split('')
      .map((c) => `[${c}]+`)
      .join('') +
    '$';

  return {
    word, // The standard canonical word (e.g., 'wow')
    score, // The score mapping
    regex: new RegExp(pattern), // Compiled Regex
  };
});

export class ChatMonitor {
  private ws!: WebSocket;
  private msgs: { ts: number; score: number; words: string[] }[] = [];

  constructor(public channel: string) {}

  start() {
    this.ws = new WebSocket(IRC_URL);
    this.ws.on('open', () => {
      this.ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      this.ws.send('PASS SCHMOOPIIE');
      this.ws.send('NICK justinfan31337');
      this.ws.send(`JOIN #${this.channel}`);
      console.log(`\n💬 Connected to Chat: #${this.channel}`);
    });

    this.ws.on('message', (raw: Buffer) => {
      const text = raw.toString();
      if (text.startsWith('PING')) return this.ws.send('PONG :tmi.twitch.tv');

      const match = text.match(/PRIVMSG #[^\s]+ :(.+)/);
      if (!match) return;

      // 1. Convert to lowercase
      // 2. Strip out punctuation (so "OMGGGG!!!" becomes "omgggg")
      const rawMessage = match[1]
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .trim();
      if (!rawMessage) return;

      const words = rawMessage.split(/\s+/);
      const found: string[] = [];
      let score = 0;

      // Check each word in the chat message against our fuzzy regex rules
      for (const w of words) {
        for (const rule of HYPE_RULES) {
          if (rule.regex.test(w)) {
            // Push the *canonical* word (so "woooow" gets tracked as simply "wow")
            found.push(rule.word);
            score += rule.score;
            break; // Stop checking other rules for this specific word
          }
        }
      }

      this.msgs.push({ ts: Date.now(), score, words: found });
    });

    this.ws.on('close', () => setTimeout(() => this.start(), 3000));
    this.ws.on('error', () => {});
  }

  getHype(shortWindowSecs = 10, longWindowSecs = 60) {
    const now = Date.now();
    // Keep 60 seconds of chat history to establish a "normal baseline"
    this.msgs = this.msgs.filter((m) => now - m.ts < longWindowSecs * 1000);

    // 1. Calculate Base Score from specific words in the short window
    const shortWindow = this.msgs.filter(
      (m) => now - m.ts < shortWindowSecs * 1000,
    );
    const baseScore = shortWindow.reduce((s, m) => s + m.score, 0);

    // 2. Calculate the Relative Velocity (Speed Spike)
    const baselineVelocity = this.msgs.length / longWindowSecs;
    const currentVelocity = shortWindow.length / shortWindowSecs;

    let velocityBonus = 0;
    const velocitySpike = currentVelocity - baselineVelocity;

    // To protect against zero-division or tiny streams, assume a minimum 1 msg/s baseline
    const safeBaseline = Math.max(1, baselineVelocity);
    const multiplier = currentVelocity / safeBaseline;

    // If chat is suddenly going at least 1.5x faster than normal, it's a spike!
    if (velocitySpike > 0 && multiplier > 1.5) {
      // Bonus scales perfectly: A spike of +5 msgs/s gives 15 points. A spike of +30 msgs/s gives 90 points.
      velocityBonus = Math.floor(velocitySpike * 3);
    }

    const wordCounts = shortWindow
      .flatMap((m) => m.words)
      .reduce(
        (acc, w) => {
          acc[w] = (acc[w] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );

    const topWords = Object.entries(wordCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map((e) => e[0]);

    return {
      chatScore: baseScore + velocityBonus,
      multiplier,
      topWords,
    };
  }
}
