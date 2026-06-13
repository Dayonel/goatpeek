import { spawn, execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, readFileSync, renameSync } from 'fs';
import { join } from 'path';
import { ChatMonitor } from './chat';
import 'dotenv/config';

// ─── CONFIG ────────────────────────────────────────────────────────
const CHANNEL = 'eslcsb';
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

// ─── AI & PLAY DETECTION ───────────────────────────────────────────
interface ClipMeta {
  map: number;
  round: number;
  player: string;
  description: string;
}

// Derive the description from the chat context, not the image
function getPlayDescription(chatWords: string[]): string {
  if (chatWords.some((w) => ['ace', '5k'].includes(w))) return 'Ace';
  if (chatWords.includes('4k')) return '4K';
  if (chatWords.includes('3k')) return '3K';
  if (chatWords.includes('clutch')) return 'Clutch';
  if (chatWords.some((w) => ['ninja', 'defuse'].includes(w)))
    return 'Ninja Defuse';
  return 'Highlight';
}

async function analyze(clip: string, chatWords: string[]): Promise<ClipMeta> {
  const frame = join(WORK_DIR, `f_${Date.now()}.jpg`);
  const midPoint = Math.floor((BUF_BEFORE + BUF_AFTER) / 2);

  // 1. SURGICAL CROP: Extract only the top center (Score) and bottom center (Player)
  // and stack them. This makes text huge and removes all visual distractions for the AI.
  const cropFilter =
    '[0:v]crop=800:150:560:0[top];[0:v]crop=800:150:560:930[bot];[top][bot]vstack';
  execSync(
    `ffmpeg -ss ${midPoint} -i "${clip}" -vframes 1 -filter_complex "${cropFilter}" "${frame}" -y -loglevel error`,
  );

  const imgBase64 = readFileSync(frame).toString('base64');
  rm(frame);

  const prompt = `This image contains two cropped UI elements from Counter-Strike 2.
  Top element: Scoreboard showing Map Number (stars/pips) and Round Number.
  Bottom element: Current Player Nameplate.
  Extract the data and reply ONLY with this exact JSON format. Do not add any text or explanation:
  {"map": 1, "round": 0, "player": "Name"}
  If the player name is dead/empty, output "cmtry".`;

  let meta = {
    map: 1,
    round: 0,
    player: 'cmtry',
    description: getPlayDescription(chatWords),
  };

  try {
    const res = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llava',
        prompt,
        images: [imgBase64],
        stream: false,
        format: 'json', // Force Ollama to strictly return valid JSON
      }),
      signal: AbortSignal.timeout(20000),
    });

    if (res.ok) {
      const data = (await res.json()) as { response: string };
      const parsed = JSON.parse(data.response);

      meta.map = Number(parsed.map) || 1;
      meta.round = Number(parsed.round) || 0;

      const p = String(parsed.player).trim();
      if (
        p.length > 1 &&
        !['unknown', 'null', 'name', 'cmtry'].includes(p.toLowerCase())
      ) {
        meta.player = p;
      }
    }
  } catch (err) {
    console.error('  [AI parsing failed, using fallbacks]');
  }

  return meta;
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

  const chat = new ChatMonitor(CHANNEL);
  chat.start();
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
      console.log(
        `\n\n⚡ Hype Spike! (Score: ${totalHype}) Extracting clip...`,
      );

      const playTimeMs = now - CHAT_DELAY * 1000;

      setTimeout(async () => {
        const videoStartSec = Math.max(
          0,
          (playTimeMs - streamStartMs) / 1000 - BUF_BEFORE,
        );
        const totalDuration = BUF_BEFORE + BUF_AFTER;
        const tmpClip = join(WORK_DIR, `tmp_${Date.now()}.mp4`);

        execSync(
          `ffmpeg -ss ${videoStartSec} -t ${totalDuration} -i "${LIVE_FILE}" -c copy "${tmpClip}" -y -loglevel error`,
        );

        console.log('🤖 Parsing UI via LLaVA...');
        const meta = await analyze(tmpClip, topWords);

        // Sanitize strings for Windows file system safety
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
