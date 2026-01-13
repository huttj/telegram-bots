import { Telegraf } from 'telegraf';
import Database from 'better-sqlite3';
import { config } from 'dotenv';
import { unlinkSync } from 'fs';
import { randomUUID } from 'crypto';
import { initializeR2Client, uploadFileToR2 } from './lib/r2-client.js';
import { initializeGroqClient, transcribeAudio } from './lib/transcription.js';
import {
  initializeEmbeddingModel,
  isEmbeddingModelReady,
  generateEmbedding,
  embeddingToBuffer,
  backfillEmbeddings
} from './lib/embedding-utils.js';
import {
  downloadTelegramFile,
  formatTimestamp,
  formatDuration,
  createAuthMiddleware,
  extractUrls,
  containsUrl,
  getExtensionFromMimeType
} from './lib/telegram-helpers.js';

// Load environment variables
config();

// Configuration
const TASTE_BOT_TOKEN = process.env.TASTE_BOT_TOKEN;
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID);
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'telegram-bots';

// Validate required environment variables
if (!TASTE_BOT_TOKEN) {
  console.error('Missing TASTE_BOT_TOKEN!');
  process.exit(1);
}

if (!AUTHORIZED_USER_ID) {
  console.error('Missing AUTHORIZED_USER_ID!');
  process.exit(1);
}

// Initialize SQLite database
const DB_PATH = process.env.FLY_APP_NAME ? '/data/taste-bot.db' : 'taste-bot.db';
const db = new Database(DB_PATH);

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER UNIQUE NOT NULL,
    user_id INTEGER NOT NULL,
    content_type TEXT NOT NULL,
    url TEXT,
    file_id TEXT,
    r2_key TEXT,
    filename TEXT,
    caption TEXT,
    created_at INTEGER NOT NULL,
    metadata TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS annotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL,
    message_id INTEGER UNIQUE NOT NULL,
    voice_file_id TEXT NOT NULL,
    r2_key TEXT,
    transcript TEXT,
    embedding BLOB,
    created_at INTEGER NOT NULL,
    duration INTEGER NOT NULL,
    link_type TEXT NOT NULL,
    FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE
  )
`);

// Create indices
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_submissions_message_id ON submissions(message_id);
  CREATE INDEX IF NOT EXISTS idx_submissions_user_id ON submissions(user_id);
  CREATE INDEX IF NOT EXISTS idx_submissions_created_at ON submissions(created_at);
  CREATE INDEX IF NOT EXISTS idx_annotations_submission_id ON annotations(submission_id);
  CREATE INDEX IF NOT EXISTS idx_annotations_message_id ON annotations(message_id);
  CREATE INDEX IF NOT EXISTS idx_annotations_created_at ON annotations(created_at);
`);

console.log('✓ Taste Bot database initialized');

// Initialize R2 client
initializeR2Client({
  accountId: process.env.R2_ACCOUNT_ID,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
});

// Initialize Groq for transcription
initializeGroqClient(process.env.GROQ_API_KEY);

// Initialize embedding model
initializeEmbeddingModel().then(async (success) => {
  if (success) {
    // Backfill embeddings for annotations
    await backfillEmbeddings(db, 'annotations', 'transcript');
  }
});

// Initialize Telegram bot
const bot = new Telegraf(TASTE_BOT_TOKEN);

// Middleware: Check if user is authorized
bot.use(createAuthMiddleware(AUTHORIZED_USER_ID));

// Helper: Store submission in database
function storeSubmission({ messageId, userId, contentType, url, fileId, filename, caption, createdAt, metadata }) {
  const stmt = db.prepare(`
    INSERT INTO submissions (message_id, user_id, content_type, url, file_id, filename, caption, created_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    messageId,
    userId,
    contentType,
    url || null,
    fileId || null,
    filename || null,
    caption || null,
    createdAt,
    metadata ? JSON.stringify(metadata) : null
  );

  return result.lastInsertRowid;
}

// Helper: Find submission for voice memo linking
async function findSubmissionForVoiceMemo(ctx, voiceMessage, userId) {
  const messageId = voiceMessage.message_id;
  const timestamp = voiceMessage.date;

  // Case 1: Voice memo is a REPLY to another message
  if (ctx.message.reply_to_message) {
    const repliedToMessageId = ctx.message.reply_to_message.message_id;

    // Case 1a: Replied to a submission directly
    const submission = db.prepare(
      'SELECT id FROM submissions WHERE message_id = ? AND user_id = ?'
    ).get(repliedToMessageId, userId);

    if (submission) {
      return { submissionId: submission.id, linkType: 'reply' };
    }

    // Case 1b: Replied to another voice memo (chain linking)
    const annotation = db.prepare(
      'SELECT submission_id FROM annotations WHERE message_id = ?'
    ).get(repliedToMessageId);

    if (annotation) {
      return { submissionId: annotation.submission_id, linkType: 'voice_reply' };
    }
  }

  // Case 2: No reply - check for SEQUENTIAL linking
  // Find the most recent submission before this voice memo
  const recentSubmission = db.prepare(`
    SELECT id, message_id, created_at
    FROM submissions
    WHERE user_id = ? AND created_at < ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(userId, timestamp);

  if (!recentSubmission) {
    return null; // No submission to link to
  }

  // Check if there are any submissions between the recent one and this voice memo
  const submissionsBetween = db.prepare(`
    SELECT COUNT(*) as count
    FROM submissions
    WHERE user_id = ?
      AND created_at > ?
      AND created_at < ?
  `).get(userId, recentSubmission.created_at, timestamp);

  if (submissionsBetween.count === 0) {
    // No submissions in between - link sequentially
    return { submissionId: recentSubmission.id, linkType: 'sequential' };
  }

  // There are submissions in between - don't auto-link
  return null;
}

// Handle voice messages
bot.on('voice', async (ctx) => {
  const voice = ctx.message.voice;
  const messageId = ctx.message.message_id;
  const timestamp = ctx.message.date;
  const userId = ctx.from.id;

  try {
    await ctx.react('👀'); // Processing

    // Find linked submission
    const linkResult = await findSubmissionForVoiceMemo(ctx, ctx.message, userId);

    if (!linkResult) {
      await ctx.reply(
        '❓ Couldn\'t automatically link this voice memo to a submission.\n\n' +
        'Tip: Reply to a submission with your voice memo, or send it right after a submission.'
      );
      await ctx.react('❓');
      return;
    }

    // Download voice file
    const tempFilePath = await downloadTelegramFile(voice.file_id, TASTE_BOT_TOKEN, 'ogg');

    // Upload to R2
    const r2Key = `taste-bot/annotations/${formatTimestamp(timestamp)}-${messageId}.ogg`;
    await uploadFileToR2(tempFilePath, r2Key, R2_BUCKET_NAME, 'audio/ogg');

    // Transcribe
    const transcript = await transcribeAudio(tempFilePath);

    // Generate embedding
    let embeddingBuffer = null;
    if (isEmbeddingModelReady()) {
      try {
        const embedding = await generateEmbedding(transcript);
        embeddingBuffer = embeddingToBuffer(embedding);
      } catch (error) {
        console.error('Error generating embedding:', error);
      }
    }

    // Save annotation
    const stmt = db.prepare(`
      INSERT INTO annotations (
        submission_id, message_id, voice_file_id, r2_key,
        transcript, embedding, created_at, duration, link_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      linkResult.submissionId,
      messageId,
      voice.file_id,
      r2Key,
      transcript,
      embeddingBuffer,
      timestamp,
      voice.duration,
      linkResult.linkType
    );

    // Clean up
    unlinkSync(tempFilePath);

    // Success feedback
    await ctx.react('👍');

    // Get submission info for confirmation
    const submission = db.prepare('SELECT * FROM submissions WHERE id = ?')
      .get(linkResult.submissionId);

    const submissionPreview = submission.url ||
      submission.caption ||
      `${submission.content_type} (${new Date(submission.created_at * 1000).toLocaleDateString()})`;

    await ctx.reply(
      `✅ Voice memo linked to:\n${submissionPreview}\n\n` +
      `Link type: ${linkResult.linkType}`
    );

  } catch (error) {
    console.error('Error processing voice memo:', error);
    await ctx.react('👎');
    await ctx.reply('Sorry, there was an error processing your voice memo.');
  }
});

// Handle messages (detect content type and store)
bot.on('message', async (ctx) => {
  const msg = ctx.message;
  const userId = ctx.from.id;
  const messageId = msg.message_id;
  const timestamp = msg.date;

  // Skip if we already handled this as voice
  if (msg.voice) {
    return;
  }

  let contentType = null;
  let url = null;
  let fileId = null;
  let filename = null;
  let caption = msg.caption || null;
  let metadata = {};

  // 1. TEXT with URLs
  if (msg.text && containsUrl(msg.text)) {
    contentType = 'url';
    const urls = extractUrls(msg.text);
    url = urls[0]; // Store first URL
    caption = msg.text;
  }

  // 2. PHOTO
  else if (msg.photo) {
    contentType = 'photo';
    const photo = msg.photo[msg.photo.length - 1]; // Largest size
    fileId = photo.file_id;
    metadata = { width: photo.width, height: photo.height };
  }

  // 3. VIDEO / GIF
  else if (msg.video || msg.animation) {
    contentType = msg.video ? 'video' : 'gif';
    const media = msg.video || msg.animation;
    fileId = media.file_id;
    filename = media.file_name;
    metadata = {
      duration: media.duration,
      width: media.width,
      height: media.height,
      mime_type: media.mime_type
    };
  }

  // 4. AUDIO / MUSIC
  else if (msg.audio) {
    contentType = 'audio';
    fileId = msg.audio.file_id;
    filename = msg.audio.file_name;
    metadata = {
      duration: msg.audio.duration,
      mime_type: msg.audio.mime_type,
      performer: msg.audio.performer,
      title: msg.audio.title
    };
  }

  // 5. DOCUMENT
  else if (msg.document) {
    contentType = 'document';
    fileId = msg.document.file_id;
    filename = msg.document.file_name;
    metadata = { mime_type: msg.document.mime_type };
  }

  // Store submission if we identified content
  if (contentType) {
    try {
      storeSubmission({
        messageId,
        userId,
        contentType,
        url,
        fileId,
        filename,
        caption,
        createdAt: timestamp,
        metadata
      });

      await ctx.react('✅');
    } catch (error) {
      console.error('Error storing submission:', error);
      await ctx.react('👎');
    }
  }
});

// Handle start command
bot.command('start', (ctx) => {
  ctx.reply(
    '🎨 Taste Bot\n\n' +
    'Save things you like and annotate them with voice notes!\n\n' +
    '📌 Send me:\n' +
    '- URLs/links\n' +
    '- Photos\n' +
    '- Videos/GIFs\n' +
    '- Music\n' +
    '- Documents\n\n' +
    '🎤 Add voice annotations:\n' +
    '- Reply to a submission with a voice note\n' +
    '- Or send a voice note right after a submission\n' +
    '- Reply to a voice note to add more to the same submission'
  );
});

// Handle stats command
bot.command('stats', (ctx) => {
  const submissionCount = db.prepare('SELECT COUNT(*) as count FROM submissions').get();
  const annotationCount = db.prepare('SELECT COUNT(*) as count FROM annotations').get();
  const totalDuration = db.prepare('SELECT SUM(duration) as total FROM annotations').get();

  ctx.reply(
    `📊 Taste Bot Stats:\n\n` +
    `Submissions: ${submissionCount.count}\n` +
    `Voice annotations: ${annotationCount.count}\n` +
    `Total voice duration: ${formatDuration(totalDuration.total || 0)}`
  );
});

/**
 * Export the bot instance and start function for use in index.js
 */
export function startTasteBot(webhookConfig = null) {
  console.log('Starting Taste Bot...');

  if (webhookConfig) {
    // Use webhooks for production
    bot.launch({
      webhook: webhookConfig,
    });
    console.log(`✓ Taste Bot started with webhook`);
  } else {
    // Use polling for development
    bot.launch();
    console.log('✓ Taste Bot started with polling (development mode)');
  }

  // Enable graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));

  console.log('✓ Taste Bot is running!');
  console.log(`✓ Authorized user ID: ${AUTHORIZED_USER_ID}`);

  return bot;
}

// Export db for admin interface
export { db };
