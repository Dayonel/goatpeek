import { spawn } from 'child_process';
import { existsSync } from 'fs';

interface AudioData {
  time: number;
  volume: number; // In LUFS (negative values, closer to 0 is louder)
}

// ─── CONFIGURATION ──────────────────────────────────────────
const PRE_CLIMAX_SECONDS = 15; // Build-up time before the peak shout
const POST_CLIMAX_SECONDS = 8; // Reaction time after the peak shout
const FLEX_SECONDS = 3; // Search window to find a quiet moment to cut on

/**
 * Analyzes the audio of a video file and returns a time-series array of loudness.
 */
async function analyzeAudio(filePath: string): Promise<AudioData[]> {
  return new Promise((resolve, reject) => {
    console.log(`📊 Analyzing audio track for hype peaks in: "${filePath}"...`);
    const dataPoints: AudioData[] = [];

    const ffmpeg = spawn('ffmpeg', [
      '-i',
      filePath,
      '-af',
      'ebur128=video=0',
      '-f',
      'null',
      '-',
    ]);

    let stderrBuffer = '';

    // Catch if FFmpeg itself fails to start
    ffmpeg.on('error', (err) => {
      reject(new Error(`Failed to start FFmpeg: ${err.message}`));
    });

    ffmpeg.stderr.on('data', (data) => {
      stderrBuffer += data.toString();

      // FFmpeg uses \r to overwrite lines. We split by both \r and \n.
      const lines = stderrBuffer.split(/[\r\n]+/);

      // The last element might be an incomplete line, so we keep it in the buffer
      stderrBuffer = lines.pop() || '';

      for (const line of lines) {
        const match = line.match(/t:\s*([\d.]+).*?M:\s*([-\d.inf]+)/i);
        if (match) {
          let vol = parseFloat(match[2]);
          if (isNaN(vol) || match[2].toLowerCase().includes('inf')) {
            vol = -120; // Cap infinite silence at -120 LUFS
          }

          dataPoints.push({
            time: parseFloat(match[1]),
            volume: vol,
          });
        }
      }
    });

    ffmpeg.on('close', (code) => {
      // Process anything left in the buffer
      if (stderrBuffer) {
        const match = stderrBuffer.match(/t:\s*([\d.]+).*?M:\s*([-\d.inf]+)/i);
        if (match) {
          const vol = parseFloat(match[2]);
          dataPoints.push({
            time: parseFloat(match[1]),
            volume: isNaN(vol) ? -120 : vol,
          });
        }
      }

      if (code === 0 || dataPoints.length > 0) {
        console.log(`✅ Extracted ${dataPoints.length} audio data points.`);
        resolve(dataPoints);
      } else {
        reject(
          new Error(`FFmpeg exited with code ${code} and found no audio.`),
        );
      }
    });
  });
}

/**
 * Smooths data to find the rolling average (prevents brief pops from ruining the data)
 */
function getMovingAverage(
  data: AudioData[],
  windowSizeSec: number,
): AudioData[] {
  if (data.length === 0) return [];

  const smoothed: AudioData[] = [];
  const pointsPerSec = 10;
  const windowPoints = windowSizeSec * pointsPerSec;

  for (let i = 0; i < data.length; i++) {
    const start = Math.max(0, i - Math.floor(windowPoints / 2));
    const end = Math.min(data.length - 1, i + Math.floor(windowPoints / 2));

    let sum = 0;
    for (let j = start; j <= end; j++) {
      sum += data[j].volume;
    }

    smoothed.push({
      time: data[i].time,
      volume: sum / (end - start + 1),
    });
  }
  return smoothed;
}

/**
 * Finds the exact start and end times for the most "elegant" cut
 */
function findCutPoints(audioData: AudioData[]) {
  if (audioData.length === 0) {
    throw new Error(
      'No audio data found. The file might be corrupted or lack an audio track.',
    );
  }

  // 1. Find the Climax (using a 3-second smoothed window)
  const smoothed = getMovingAverage(audioData, 3);
  if (smoothed.length === 0) {
    throw new Error('Clip is too short to analyze.');
  }

  const climaxPoint = smoothed.reduce((prev, current) =>
    current.volume > prev.volume ? current : prev,
  );

  console.log(
    `🔥 Climax found at ${climaxPoint.time.toFixed(2)}s (Vol: ${climaxPoint.volume.toFixed(1)} LUFS)`,
  );

  // 2. Determine rough boundaries
  const rawStart = Math.max(0, climaxPoint.time - PRE_CLIMAX_SECONDS);
  const rawEnd = Math.min(
    audioData[audioData.length - 1].time,
    climaxPoint.time + POST_CLIMAX_SECONDS,
  );

  // 3. Elegant Start
  const startSearchZone = audioData.filter(
    (d) =>
      d.time >= rawStart - FLEX_SECONDS && d.time <= rawStart + FLEX_SECONDS,
  );
  let elegantStart = audioData.find((d) => d.time >= rawStart) || audioData[0];
  if (startSearchZone.length > 0) {
    elegantStart = startSearchZone.reduce((prev, current) =>
      current.volume < prev.volume ? current : prev,
    );
  }

  // 4. Elegant End
  const endSearchZone = audioData.filter(
    (d) => d.time >= rawEnd - FLEX_SECONDS && d.time <= rawEnd + FLEX_SECONDS,
  );
  let elegantEnd =
    audioData.find((d) => d.time >= rawEnd) || audioData[audioData.length - 1];
  if (endSearchZone.length > 0) {
    elegantEnd = endSearchZone.reduce((prev, current) =>
      current.volume < prev.volume ? current : prev,
    );
  }

  return {
    start: elegantStart.time,
    end: elegantEnd.time,
    duration: elegantEnd.time - elegantStart.time,
  };
}

/**
 * Trims the video.
 */
async function trimVideo(
  input: string,
  output: string,
  start: number,
  duration: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(
      `✂️  Cutting clip: Start ${start.toFixed(2)}s | Length ${duration.toFixed(2)}s`,
    );

    const ffmpeg = spawn('ffmpeg', [
      '-ss',
      start.toString(),
      '-t',
      duration.toString(),
      '-i',
      input,
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '21',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-y',
      output,
    ]);

    ffmpeg.on('error', (err) => reject(err));

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        console.log(
          `✅ Perfectly trimmed highlight saved to:\n   -> ${output}\n`,
        );
        resolve();
      } else {
        reject(new Error(`Trimming failed with code ${code}`));
      }
    });
  });
}

// ─── RUN EXECUTABLE ─────────────────────────────────────────
async function run() {
  console.log('🚀 Starting Trimmer...');

  const inputClip = process.argv[2];
  if (!inputClip) {
    console.error('❌ Please provide an input file path.');
    console.log(
      'Usage: npx tsx trimmer.ts "clips/M1R24 ｜ cmtry - Highlight.mp4"',
    );
    process.exit(1);
  }

  if (!existsSync(inputClip)) {
    console.error(`❌ File not found: "${inputClip}"`);
    process.exit(1);
  }

  const outputClip =
    process.argv[3] || inputClip.replace('.mp4', '_highlight.mp4');

  try {
    const audioData = await analyzeAudio(inputClip);
    const cuts = findCutPoints(audioData);
    await trimVideo(inputClip, outputClip, cuts.start, cuts.duration);
  } catch (err) {
    console.error('\n❌ Error processing clip:', err);
  }
}

run();
