import { Telegraf } from 'telegraf';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import Groq from 'groq-sdk';
import Database from 'better-sqlite3';
import { config } from 'dotenv';
import { createWriteStream, createReadStream, unlinkSync } from 'fs';
import { pipeline } from 'stream/promises';
import { randomUUID } from 'crypto';
import https from 'https';
import http from 'http';

// Load environment variables
config();

// Configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID);
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'voice-journal';
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN;
const PORT = process.env.PORT || 3000;

// Validate required environment variables
if (!TELEGRAM_BOT_TOKEN || !AUTHORIZED_USER_ID || !GROQ_API_KEY) {
  console.error('Missing required environment variables!');
  console.error('Required: TELEGRAM_BOT_TOKEN, AUTHORIZED_USER_ID, GROQ_API_KEY');
  process.exit(1);
}

// Initialize SQLite database
const DB_PATH = process.env.FLY_APP_NAME ? '/data/voice-journal.db' : 'voice-journal.db';
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS transcripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER UNIQUE,
    voice_file_id TEXT,
    r2_key TEXT,
    transcript TEXT,
    created_at INTEGER,
    duration INTEGER
  )
`);

// Initialize R2 client (S3-compatible)
let r2Client = null;
if (R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY) {
  r2Client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
  console.log('✓ R2 storage initialized');
} else {
  console.warn('⚠ R2 credentials not found - voice files will not be uploaded to cloud storage');
}

// Initialize Groq client
const groq = new Groq({ apiKey: GROQ_API_KEY });

// Initialize Telegram bot
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// Middleware: Check if user is authorized
bot.use((ctx, next) => {
  if (ctx.from?.id !== AUTHORIZED_USER_ID) {
    console.log(`Unauthorized access attempt from user ${ctx.from?.id}`);
    return; // Silently ignore unauthorized users
  }
  return next();
});

// Helper: Download file from Telegram
async function downloadTelegramFile(fileId) {
  const file = await bot.telegram.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const tempPath = `/tmp/${randomUUID()}.ogg`;

  return new Promise((resolve, reject) => {
    const fileStream = createWriteStream(tempPath);
    const protocol = fileUrl.startsWith('https') ? https : http;

    protocol.get(fileUrl, (response) => {
      response.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close();
        resolve(tempPath);
      });
    }).on('error', (err) => {
      unlinkSync(tempPath);
      reject(err);
    });
  });
}

// Helper: Upload file to R2
async function uploadToR2(filePath, key) {
  if (!r2Client) {
    console.log('R2 not configured, skipping upload');
    return null;
  }

  try {
    const fileStream = createReadStream(filePath);
    const command = new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: fileStream,
      ContentType: 'audio/ogg',
    });

    await r2Client.send(command);
    console.log(`✓ Uploaded to R2: ${key}`);
    return key;
  } catch (error) {
    console.error('Error uploading to R2:', error);
    return null;
  }
}

// Helper: Format Unix timestamp to readable filename format
function formatTimestamp(unixTimestamp) {
  const date = new Date(unixTimestamp * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
}

// Helper: Transcribe audio with Groq Whisper
async function transcribeAudio(filePath) {
  try {
    const transcription = await groq.audio.transcriptions.create({
      file: createReadStream(filePath),
      model: 'whisper-large-v3-turbo',
      response_format: 'json',
      language: 'en', // Change if needed, or remove to auto-detect
    });

    return transcription.text;
  } catch (error) {
    console.error('Error transcribing audio:', error);
    throw error;
  }
}

// Handle voice messages
bot.on('voice', async (ctx) => {
  const voice = ctx.message.voice;
  const messageId = ctx.message.message_id;
  const timestamp = ctx.message.date;

  console.log(`Received voice message ${messageId} (${voice.duration}s)`);

  try {
    // React to show we're processing
    await ctx.react('👀');

    // Download voice file from Telegram
    console.log('Downloading voice file...');
    const tempFilePath = await downloadTelegramFile(voice.file_id);

    // Upload to R2
    const formattedTimestamp = formatTimestamp(timestamp);
    const r2Key = `voice-journal/voice-notes/${formattedTimestamp}-${messageId}.ogg`;
    const uploadedKey = await uploadToR2(tempFilePath, r2Key);

    // Transcribe with Groq
    console.log('Transcribing...');
    const transcript = await transcribeAudio(tempFilePath);
    console.log(`Transcript: ${transcript.substring(0, 100)}...`);

    // Save to database
    const stmt = db.prepare(`
      INSERT INTO transcripts (message_id, voice_file_id, r2_key, transcript, created_at, duration)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(messageId, voice.file_id, uploadedKey, transcript, timestamp, voice.duration);

    // Clean up temp file
    unlinkSync(tempFilePath);

    // React with success
    await ctx.react('👍');

    console.log(`✓ Successfully processed voice message ${messageId}`);
  } catch (error) {
    console.error('Error processing voice message:', error);
    await ctx.react('👎');
  }
});

// Handle start command
bot.command('start', (ctx) => {
  ctx.reply('🎙 Voice Journal Bot\n\nSend me voice notes and I\'ll transcribe and save them for you!');
});

// Handle stats command
bot.command('stats', (ctx) => {
  const stats = db.prepare('SELECT COUNT(*) as count, SUM(duration) as total_duration FROM transcripts').get();
  const totalMinutes = Math.round((stats.total_duration || 0) / 60);
  ctx.reply(`📊 Stats:\n\nTotal voice notes: ${stats.count}\nTotal duration: ${totalMinutes} minutes`);
});

// Start the bot
console.log('Starting Voice Journal Bot...');

if (WEBHOOK_DOMAIN) {
  // Use webhooks for production
  const webhookPath = `/webhook/${randomUUID()}`;

  bot.launch({
    webhook: {
      domain: WEBHOOK_DOMAIN,
      port: PORT,
      path: webhookPath,
    },
  });

  console.log(`✓ Bot started with webhook: ${WEBHOOK_DOMAIN}${webhookPath}`);
} else {
  // Use polling for development
  bot.launch();
  console.log('✓ Bot started with polling (development mode)');
}

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

console.log('✓ Voice Journal Bot is running!');
console.log(`✓ Authorized user ID: ${AUTHORIZED_USER_ID}`);
