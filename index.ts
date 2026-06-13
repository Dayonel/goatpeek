import { spawn, execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, renameSync } from 'fs';
import { join } from 'path';
import { ChatMonitor } from './chat';
import { MatchTracker } from './tracker';
import 'dotenv/config';

// ─── CONFIG ────────────────────────────────────────────────────────
const CHANNEL = 'eslcsb';
// Extract this ID from the HLTV match URL (e.g., .../matches/2394986/...)
const MATCH_ID = 2394986;

const OAUTH = process.env.TWITCH_OAUTH_TOKEN ?? '';
const WORK_DIR = './work';
const CLIPS_DIR = './clips';
const LIVE_FILE = join(WORK_DIR, 'live.ts');

const HYPE_THRESH = 60;
const CHAT_DELAY = 7;
const BUF_BEFORE = 20;
const BUF_AFTER = 20;
const COOLDOWN = 30;

const rm = (p: string) => {
  try {
    rmSync(p, { force: true });
  } catch {}
};

function getPlayDescription(chatWords: string[]): string {
  if (chatWords.some((w) => ['ace', '5k'].includes(w))) return 'Ace';
  if (chatWords.includes('4k')) return '4K';
  if (chatWords.includes('3k')) return '3K';
  if (chatWords.includes('clutch')) return 'Clutch';
  if (chatWords.some((w) => ['ninja', 'defuse'].includes(w)))
    return 'Ninja Defuse';
  return 'Highlight';
}

// ─── MAIN APP ──────────────────────────────────────────────────────
async function main() {
  if (!OAUTH) throw new Error('Missing TWITCH_OAUTH_TOKEN env variable.');
  [WORK_DIR, CLIPS_DIR].forEach(
    (d) => !existsSync(d) && mkdirSync(d, { recursive: true }),
  );
  rm(LIVE_FILE);

  console.log(`📡 Starting Capture: twitch.tv/${CHANNEL}...`);
  const streamStartMs = Date.now();

  const streamlink = spawn(
    'streamlink',
    [
      '--twitch-api-header',
      `Authorization=OAuth ${OAUTH}`,
      `twitch.tv/${CHANNEL}`,
      'best',
      '-o',
      '-',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const ffmpeg = spawn(
    'ffmpeg',
    [
      '-i',
      'pipe:0',
      '-c',
      'copy',
      LIVE_FILE,
      '-af',
      'ebur128=video=0',
      '-f',
      'null',
      '-',
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );

  streamlink.stdout.pipe(ffmpeg.stdin);

  let currentVolume = -50;
  ffmpeg.stderr.on('data', (data) => {
    const match = data.toString().match(/M:\s*(-?\d+\.\d+)/);
    if (match) currentVolume = parseFloat(match[1]);
  });

  // Start Monitors
  const chat = new ChatMonitor(CHANNEL);
  chat.start();

  const hltv = new MatchTracker(MATCH_ID);
  hltv.start();

  let lastClipMs = 0;

  setInterval(() => {
    const { chatScore, multiplier, topWords } = chat.getHype(10, 60);

    let audioBonus = 0;
    if (currentVolume > -14) audioBonus += 10;
    if (currentVolume > -9) audioBonus += 25;

    const totalHype = chatScore + audioBonus;

    const volVisual =
      currentVolume === -50 ? 'Muted' : `${currentVolume.toFixed(1)}dB`;
    const speedVisual =
      multiplier > 1.5 ? `Chat:${multiplier.toFixed(1)}x` : `Chat:Normal`;
    const bar = '█'.repeat(Math.min(20, Math.floor(totalHype / 4)));

    process.stdout.write(
      `\r🔥 Hype: ${String(totalHype).padStart(3)} | ${speedVisual.padEnd(10)} | Vol: ${volVisual} [${bar.padEnd(20)}]   `,
    );

    const now = Date.now();
    if (totalHype >= HYPE_THRESH && now - lastClipMs > COOLDOWN * 1000) {
      lastClipMs = now;
      console.log(`\n\n⚡ Hype Spike! Extracting clip...`);

      const playTimeMs = now - CHAT_DELAY * 1000;

      setTimeout(() => {
        const videoStartSec = Math.max(
          0,
          (playTimeMs - streamStartMs) / 1000 - BUF_BEFORE,
        );
        const totalDuration = BUF_BEFORE + BUF_AFTER;
        const tmpClip = join(WORK_DIR, `tmp_${Date.now()}.mp4`);

        // 1. Instantly pull clip from the buffer
        execSync(
          `ffmpeg -ss ${videoStartSec} -t ${totalDuration} -i "${LIVE_FILE}" -c copy "${tmpClip}" -y -loglevel error`,
        );

        // 2. Poll the MatchTracker memory for context (No AI required!)
        const chatFallback = getPlayDescription(topWords);
        const meta = hltv.getHighlightMeta(chatFallback);

        // Sanitize strings
        const safeDesc = meta.description.replace(/[<>:"/\\|?*]/g, '').trim();
        const safePlayer = meta.player.replace(/[<>:"/\\|?*]/g, '').trim();

        const filename = `M${meta.map}R${meta.round} ｜ ${safePlayer} - ${safeDesc}.mp4`;
        const finalClip = join(CLIPS_DIR, filename);

        renameSync(tmpClip, finalClip);
        console.log(`✅ Saved Highlight: ${filename}\n`);
      }, BUF_AFTER * 1000);
    }
  }, 2000);

  const exit = () => {
    streamlink.kill();
    ffmpeg.kill();
    process.exit();
  };
  process.on('SIGINT', exit);
  process.on('SIGTERM', exit);
}

main();
