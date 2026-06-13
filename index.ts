import { spawn, execSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  rmSync,
  renameSync,
  readFileSync,
  createReadStream,
} from 'fs';
import { join } from 'path';
import OpenAI from 'openai';
import { ChatMonitor } from './chat';
import { MatchTracker } from './tracker';
import 'dotenv/config';

// ─── CONFIG ────────────────────────────────────────────────────────
const CHANNEL = 'eslcsb';
const MATCH_ID = 2394986;

const OAUTH = process.env.TWITCH_OAUTH_TOKEN ?? '';

// Initialize the OpenAI SDK to point to your LOCAL Ollama instance
const ollama = new OpenAI({
  baseURL: 'http://localhost:11434/v1',
  apiKey: 'ollama', // Required by the SDK, but totally ignored by Ollama
});

const WORK_DIR = './work';
const CLIPS_DIR = './clips';
const LIVE_FILE = join(WORK_DIR, 'live.ts');

const HYPE_THRESH = 60;
const CHAT_DELAY = 7;
const BUF_BEFORE = 60;
const BUF_AFTER = 60;
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

// ─── AUDIO AI PARSING ──────────────────────────────────────────────
async function getPlayerFromAudio(clipPath: string): Promise<string> {
  const audioFile = clipPath.replace('.mp4', '.mp3');
  const txtFile = audioFile.replace('.mp3', '.txt');

  try {
    // 1. Extract 15 seconds of audio from the center of the clip (the action peak)
    const midPoint = Math.max(0, BUF_BEFORE - 5);
    execSync(
      `ffmpeg -i "${clipPath}" -ss ${midPoint} -t 15 -q:a 0 -map a "${audioFile}" -y -loglevel error`,
    );

    // 2. Transcribe locally using Whisper CLI (Requires: pip install -U openai-whisper)
    console.log(`\n🎙️  Transcribing audio locally...`);
    execSync(
      `whisper "${audioFile}" --model tiny.en --output_format txt --output_dir "${WORK_DIR}"`,
      { stdio: 'ignore' },
    );

    let transcript = '';
    if (existsSync(txtFile)) {
      transcript = readFileSync(txtFile, 'utf8').trim();
    }

    console.log(`🎙️  Caster Transcript: "${transcript}"`);
    if (!transcript) return 'cmtry';

    // 3. Ask your local Ollama to find the name using the OpenAI SDK format
    const prompt = `You are a data extractor. Read this CS2 caster commentary: "${transcript}"
    Identify the player who made the highlight play. 
    Reply ONLY with the player's exact name. No punctuation, no explanation.
    If no clear player is mentioned, reply with "cmtry".`;

    const completion = await ollama.chat.completions.create(
      {
        model: 'llama3', // Must match the exact model name pulled in Ollama
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      },
      { timeout: 10000 }, // 10 second timeout
    );

    const name = completion.choices[0]?.message?.content
      ?.trim()
      .replace(/[.,!?'"]/g, '');
    if (name && name.length > 1 && name.toLowerCase() !== 'cmtry') {
      return name;
    }
  } catch (err) {
    console.log('  [Audio parsing failed or skipped]');
  } finally {
    rm(audioFile);
    rm(txtFile); // Clean up the text file too
  }

  return 'cmtry';
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

      // Because setTimeout creates a closure, 'totalHype' here will
      // accurately reflect the hype score at the exact moment the threshold was crossed.
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

        // 1. Get accurate Map and Round from your HLTV socket
        const map = hltv.mapNumber;
        const round = hltv.roundNumber;

        // 2. Get Highlight Type from Chat Fuzzy Matcher, and append Hype Level
        const baseDesc = getPlayDescription(topWords);
        const descWithHype = `${baseDesc} (Hype ${Math.round(totalHype)})`;

        // 3. ✨ Listen to the caster to figure out who made the play (100% locally)
        const rawPlayer = await getPlayerFromAudio(tmpClip);

        // Clean strings for Windows filesystem
        const safeDesc = descWithHype.replace(/[<>:"/\\|?*]/g, '').trim();
        const safePlayer = rawPlayer.replace(/[<>:"/\\|?*]/g, '').trim();

        const filename = `M${map}R${round} ｜ ${safePlayer} - ${safeDesc}.mp4`;
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
