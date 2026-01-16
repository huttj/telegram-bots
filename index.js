import { Telegraf } from 'telegraf';
import OpenAI from 'openai';
import Database from 'better-sqlite3';
import { config } from 'dotenv';
import { unlinkSync } from 'fs';
import { randomUUID } from 'crypto';
import { embed } from './embeddings.js';
import { startAdminServer } from './admin-server.js';
import { initializeR2Client, uploadFileToR2 } from './lib/r2-client.js';
import { initializeGroqClient, transcribeAudio } from './lib/transcription.js';
import {
  initializeEmbeddingModel,
  isEmbeddingModelReady,
  generateEmbedding,
  embeddingToBuffer,
  bufferToEmbedding,
  cosineSimilarity,
  backfillEmbeddings
} from './lib/embedding-utils.js';
import {
  downloadTelegramFile,
  formatTimestamp,
  formatDuration,
  createAuthMiddleware
} from './lib/telegram-helpers.js';
// Taste Bot temporarily disabled to reduce connection load
// import { startTasteBot } from './taste-bot.js';

// Load environment variables
config();

// Configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID);
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'voice-journal';
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN;
const PORT = process.env.PORT || 3000;

// Validate required environment variables
if (!TELEGRAM_BOT_TOKEN || !AUTHORIZED_USER_ID) {
  console.error('Missing required environment variables!');
  console.error('Required: TELEGRAM_BOT_TOKEN, AUTHORIZED_USER_ID');
  process.exit(1);
}

if (!OPENROUTER_API_KEY) {
  console.error('Missing OPENROUTER_API_KEY!');
  console.error('Required for embeddings and AI inference');
  process.exit(1);
}

if (!GROQ_API_KEY) {
  console.warn('⚠ GROQ_API_KEY not set - audio transcription will not be available');
  console.warn('  Voice messages will fail to transcribe. Set GROQ_API_KEY if you need this feature.');
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
    duration INTEGER,
    embedding BLOB
  )
`);

// Migration: Add embedding column if it doesn't exist
try {
  const tableInfo = db.prepare("PRAGMA table_info(transcripts)").all();
  const hasEmbeddingColumn = tableInfo.some(col => col.name === 'embedding');

  if (!hasEmbeddingColumn) {
    console.log('Running migration: Adding embedding column to transcripts table...');
    db.exec('ALTER TABLE transcripts ADD COLUMN embedding BLOB');
    console.log('✓ Migration complete: embedding column added');
  }
} catch (error) {
  console.error('Error checking/adding embedding column:', error);
}

// Initialize R2 client (S3-compatible)
initializeR2Client({
  accountId: R2_ACCOUNT_ID,
  accessKeyId: R2_ACCESS_KEY_ID,
  secretAccessKey: R2_SECRET_ACCESS_KEY,
});

// Initialize Groq for transcription
initializeGroqClient(GROQ_API_KEY);

const openrouter = new OpenAI({
  apiKey: OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});

// Use OpenRouter as primary AI client, fallback to Groq for transcription if available
const aiClient = openrouter;
console.log('✓ Using OpenRouter for AI inference');

// Initialize embedding model
initializeEmbeddingModel().then(async (success) => {
  if (success) {
    // Backfill embeddings for existing transcripts
    await backfillEmbeddings(db, 'transcripts', 'transcript');
  }
});

// Initialize Telegram bot
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// Middleware: Check if user is authorized
bot.use(createAuthMiddleware(AUTHORIZED_USER_ID));

// Helper: Classify query and extract search parameters using small LLM
async function classifyQuery(userQuery) {
  const currentDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
  const prompt = `Classify this voice journal query and extract date filters. Today's date is ${currentDate}.

User query: "${userQuery}"

STEP 1 - Check for time references and extract specific dates:

Quick time references:
- "today" → type: "today"
- "this week" / "week" → type: "week"
- "this month" / "month" → type: "month"
- "this year" / "year" → type: "year"

Specific date references (return as dateFilter array):
- "yesterday" → [{date: "YYYY-MM-DD"}] (calculate yesterday's date)
- "January 15" / "Jan 15" → [{date: "YYYY-MM-DD"}] (infer current year if not specified)
- "2026-01-15" / "01/15/2026" → [{date: "2026-01-15"}]
- "last Monday" / "last week Tuesday" → [{date: "YYYY-MM-DD"}] (calculate the specific date)

Date ranges (return as dateFilter array):
- "from Jan 1 to Jan 15" → [{start: "YYYY-MM-DD", end: "YYYY-MM-DD"}]
- "between 2026-01-01 and 2026-01-15" → [{start: "2026-01-01", end: "2026-01-15"}]
- "last week" → [{start: "YYYY-MM-DD", end: "YYYY-MM-DD"}] (previous week's start/end)
- "January" / "January 2026" → [{start: "2026-01-01", end: "2026-02-01"}]

Multiple dates/ranges:
- "January 15 and January 20" → [{date: "YYYY-MM-DD"}, {date: "YYYY-MM-DD"}]
- "last Monday and yesterday" → [{date: "YYYY-MM-DD"}, {date: "YYYY-MM-DD"}]
- "from Jan 1-5 and Jan 10-15" → [{start: "...", end: "..."}, {start: "...", end: "..."}]

STEP 2 - If NO time reference, it's a semantic search:
- type: "semantic"
- For introspective/analytical questions (about feelings, personality, patterns, impressions), use first-person phrases that appear in journal entries: "I feel" "I think" "I am" "I want" "I need"
- For questions about specific topics, use those topic keywords

Examples:
"What did I say today?" → type: "today", dateFilter: null
"What did I say yesterday?" → type: "semantic", dateFilter: [{date: "2026-01-15"}]
"Show me January 15" → type: "semantic", dateFilter: [{date: "2026-01-15"}]
"entries from Jan 1 to Jan 15" → type: "semantic", dateFilter: [{start: "2026-01-01", end: "2026-01-15"}]
"What's your impression of me?" → type: "semantic", searchTerms: "I feel I think I am", dateFilter: null
"What did I talk about coffee last week?" → type: "semantic", searchTerms: "coffee", dateFilter: [{start: "2026-01-05", end: "2026-01-12"}]

Respond ONLY with JSON:
{
  "type": "today|week|month|year|semantic",
  "searchTerms": "first-person phrases or topic keywords (for semantic searches)",
  "dateFilter": null or [{date: "YYYY-MM-DD"}] or [{start: "YYYY-MM-DD", end: "YYYY-MM-DD"}] or array of multiple ranges
}`;

  try {
    const response = await aiClient.chat.completions.create({
      model: 'anthropic/claude-3.5-haiku',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 300,
    });

    const content = response.choices[0].message.content.trim();
    // Extract JSON from response (handles markdown code blocks)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Failed to parse classification response');
    }
    return JSON.parse(jsonMatch[0]);
  } catch (error) {
    console.error('Error classifying query:', error);
    // Default to semantic search if classification fails
    return { type: 'semantic', searchTerms: userQuery, dateFilter: null };
  }
}

// Helper: Get transcripts from today
function getTranscriptsToday() {
  const todayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
  const stmt = db.prepare('SELECT * FROM transcripts WHERE created_at >= ? ORDER BY created_at DESC');
  return stmt.all(todayStart);
}

// Helper: Get transcripts from this week
function getTranscriptsThisWeek() {
  const now = new Date();
  const weekStart = new Date(now.setDate(now.getDate() - now.getDay()));
  weekStart.setHours(0, 0, 0, 0);
  const weekStartTimestamp = Math.floor(weekStart.getTime() / 1000);

  const stmt = db.prepare('SELECT * FROM transcripts WHERE created_at >= ? ORDER BY created_at DESC');
  return stmt.all(weekStartTimestamp);
}

// Helper: Get transcripts from this month
function getTranscriptsThisMonth() {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthStartTimestamp = Math.floor(monthStart.getTime() / 1000);

  const stmt = db.prepare('SELECT * FROM transcripts WHERE created_at >= ? ORDER BY created_at DESC');
  return stmt.all(monthStartTimestamp);
}

// Helper: Get transcripts from this year
function getTranscriptsThisYear() {
  const now = new Date();
  const yearStart = new Date(now.getFullYear(), 0, 1);
  const yearStartTimestamp = Math.floor(yearStart.getTime() / 1000);

  const stmt = db.prepare('SELECT * FROM transcripts WHERE created_at >= ? ORDER BY created_at DESC');
  return stmt.all(yearStartTimestamp);
}

// Helper: Parse date filter array and return array of {start, end} timestamp ranges
function parseDateFilter(dateFilter) {
  if (!dateFilter) return null;
  if (!Array.isArray(dateFilter)) return null;

  const ranges = [];

  for (const filter of dateFilter) {
    // Handle specific single date: {date: "YYYY-MM-DD"}
    if (filter.date) {
      const date = new Date(filter.date + 'T00:00:00Z');
      const startOfDay = Math.floor(date.getTime() / 1000);
      // End of day (23:59:59) - add 86400 seconds (1 day) to get start of next day
      const endOfDay = startOfDay + 86400;
      ranges.push({
        start: startOfDay,
        end: endOfDay,
        description: filter.date
      });
    }
    // Handle date range: {start: "YYYY-MM-DD", end: "YYYY-MM-DD"}
    else if (filter.start && filter.end) {
      const startDate = new Date(filter.start + 'T00:00:00Z');
      const endDate = new Date(filter.end + 'T00:00:00Z');
      const startTimestamp = Math.floor(startDate.getTime() / 1000);
      // End is inclusive, so add one full day to include the entire end date
      const endTimestamp = Math.floor(endDate.getTime() / 1000) + 86400;
      ranges.push({
        start: startTimestamp,
        end: endTimestamp,
        description: `${filter.start} to ${filter.end}`
      });
    }
    // Handle start date only (open-ended range from start date onwards)
    else if (filter.start) {
      const startDate = new Date(filter.start + 'T00:00:00Z');
      const startTimestamp = Math.floor(startDate.getTime() / 1000);
      ranges.push({
        start: startTimestamp,
        end: null, // null means no end limit
        description: `from ${filter.start}`
      });
    }
  }

  return ranges.length > 0 ? ranges : null;
}

// Helper: Apply date filter to transcripts (supports multiple date ranges)
function applyDateFilter(transcripts, dateFilter) {
  const ranges = parseDateFilter(dateFilter);
  if (!ranges) return transcripts;

  return transcripts.filter(t => {
    // Check if transcript matches ANY of the date ranges
    return ranges.some(range => {
      // Check if created_at is within this range
      if (range.start && t.created_at < range.start) return false;
      if (range.end && t.created_at >= range.end) return false;
      return true;
    });
  });
}

// Helper: Perform vector similarity search
async function vectorSearch(queryText, topK = 5, dateFilter = null) {
  if (!isEmbeddingModelReady()) {
    throw new Error('Embedding model not initialized');
  }

  // Generate embedding for query
  const queryEmbedding = await generateEmbedding(queryText);

  // Get all transcripts with embeddings
  const stmt = db.prepare('SELECT * FROM transcripts WHERE embedding IS NOT NULL');
  let transcripts = stmt.all();

  // Apply date filter if provided
  if (dateFilter) {
    transcripts = applyDateFilter(transcripts, dateFilter);
  }

  // Calculate similarity scores
  const results = transcripts.map(transcript => {
    const transcriptEmbedding = bufferToEmbedding(transcript.embedding);
    const similarity = cosineSimilarity(queryEmbedding, transcriptEmbedding);
    return { ...transcript, similarity };
  });

  // Sort by similarity and return top K
  return results.sort((a, b) => b.similarity - a.similarity).slice(0, topK);
}

// Helper: Generate response using medium LLM
async function generateResponse(userQuery, relevantTranscripts) {
  // Format transcripts for context
  const context = relevantTranscripts.map((t, i) => {
    const date = new Date(t.created_at * 1000).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
    return `[${i + 1}] ${date} (${formatDuration(t.duration)}):\n${t.transcript}`;
  }).join('\n\n');

  const prompt = `You are a helpful assistant for a voice journal system. You asked: "${userQuery}"

Here are your relevant voice journal entries:

${context}

Respond naturally to the question. Match the level of detail and thoroughness requested in the query. If asked to be brief, keep it concise. If asked to be thorough, detailed, or to read between the lines, provide a comprehensive analysis.`;

  try {
    const response = await aiClient.chat.completions.create({
      model: 'anthropic/claude-3.5-sonnet',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 1000,
    });

    const llmResponse = response.choices[0].message.content;

    // Add sources at the bottom
    const sourcesList = relevantTranscripts.map((t, i) => {
      const date = new Date(t.created_at * 1000).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' });
      const time = new Date(t.created_at * 1000).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit' });
      return `${i + 1}. ${date} at ${time} (${formatDuration(t.duration)})`;
    }).join('\n');

    return `${llmResponse}\n\n---\n📎 Sources (${relevantTranscripts.length}):\n${sourcesList}`;
  } catch (error) {
    console.error('Error generating response:', error);
    throw error;
  }
}

// Handle voice messages
bot.on('voice', async (ctx) => {
  const voice = ctx.message.voice;
  const messageId = ctx.message.message_id;
  const timestamp = ctx.message.date;

  try {
    // React to show we're processing
    await ctx.react('👀');

    // Check if this voice file has already been processed (deduplication)
    const existing = db.prepare('SELECT id FROM transcripts WHERE voice_file_id = ?').get(voice.file_id);
    if (existing) {
      console.log(`Voice message ${messageId} already exists (duplicate), skipping`);
      await ctx.react('✅');
      return;
    }

    // Download voice file from Telegram
    const tempFilePath = await downloadTelegramFile(voice.file_id, TELEGRAM_BOT_TOKEN, 'ogg');

    // Upload to R2
    const formattedTimestamp = formatTimestamp(timestamp);
    const r2Key = `voice-journal/voice-notes/${formattedTimestamp}-${messageId}.ogg`;
    const uploadedKey = await uploadFileToR2(tempFilePath, r2Key, R2_BUCKET_NAME, 'audio/ogg');

    // Transcribe with Groq
    const transcript = await transcribeAudio(tempFilePath);

    // Generate embedding for transcript
    let embeddingBuffer = null;
    if (isEmbeddingModelReady()) {
      try {
        const embedding = await generateEmbedding(transcript);
        embeddingBuffer = embeddingToBuffer(embedding);
      } catch (error) {
        console.error('Error generating embedding:', error);
      }
    }

    // Save to database
    const stmt = db.prepare(`
      INSERT INTO transcripts (message_id, voice_file_id, r2_key, transcript, created_at, duration, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(messageId, voice.file_id, uploadedKey, transcript, timestamp, voice.duration, embeddingBuffer);

    // Clean up temp file
    unlinkSync(tempFilePath);

    // React with success
    await ctx.react('👍');
  } catch (error) {
    console.error('Error processing voice message:', error);
    await ctx.react('👎');
  }
});

// Handle text messages (queries)
bot.on('text', async (ctx) => {
  // Skip if it's a command
  if (ctx.message.text.startsWith('/')) {
    return;
  }

  const userQuery = ctx.message.text;

  try {
    // Check if embedding model is ready
    if (!isEmbeddingModelReady()) {
      await ctx.reply('⚠️ The embedding model is still initializing. Please try again in a moment.');
      return;
    }

    // Step 1: Classify query using small LLM
    const classification = await classifyQuery(userQuery);

    // Build search description message
    let searchDescription = '🔍 ';
    if (classification.type === 'semantic') {
      const searchTerms = classification.searchTerms || userQuery;
      searchDescription += `Searching for: "${searchTerms}"`;
      if (classification.dateFilter) {
        const dateRanges = parseDateFilter(classification.dateFilter);
        if (dateRanges && dateRanges.length > 0) {
          const descriptions = dateRanges.map(r => r.description).join(', ');
          searchDescription += ` (${descriptions})`;
        }
      } else {
        searchDescription += ' (all time)';
      }
    } else if (classification.type === 'today') {
      searchDescription += 'Searching today\'s notes';
    } else if (classification.type === 'week') {
      searchDescription += 'Searching this week\'s notes';
    } else if (classification.type === 'month') {
      searchDescription += 'Searching this month\'s notes';
    } else if (classification.type === 'year') {
      searchDescription += 'Searching this year\'s notes';
    }

    // Send search notification
    await ctx.reply(searchDescription);

    // Step 2: Retrieve relevant transcripts based on query type
    let relevantTranscripts = [];

    if (classification.type === 'today') {
      relevantTranscripts = getTranscriptsToday();
    } else if (classification.type === 'week') {
      relevantTranscripts = getTranscriptsThisWeek();
    } else if (classification.type === 'month') {
      relevantTranscripts = getTranscriptsThisMonth();
    } else if (classification.type === 'year') {
      relevantTranscripts = getTranscriptsThisYear();
    } else {
      // Semantic search with optional date filter
      const searchTerms = classification.searchTerms || userQuery;
      relevantTranscripts = await vectorSearch(searchTerms, 5, classification.dateFilter);
    }

    if (relevantTranscripts.length === 0) {
      await ctx.reply('I couldn\'t find any relevant voice notes for your query. Try recording some voice notes first!');
      return;
    }

    // Step 3: Generate response using medium LLM
    const response = await generateResponse(userQuery, relevantTranscripts);

    // Send response to user
    await ctx.reply(response);
  } catch (error) {
    console.error('❌ Error processing query:', error);
    try {
      await ctx.reply('Sorry, I encountered an error processing your query. Please try again.');
    } catch (replyError) {
      console.error('Failed to send error message to user:', replyError);
    }
  }
});

// Handle start command
bot.command('start', (ctx) => {
  ctx.reply('🎙 Voice Journal Bot\n\nSend me voice notes and I\'ll transcribe and save them for you!\n\nYou can also send text messages to query your voice notes. Ask about today\'s notes, this week, or search for specific topics!');
});

// Handle stats command
bot.command('stats', (ctx) => {
  const stats = db.prepare('SELECT COUNT(*) as count, SUM(duration) as total_duration FROM transcripts').get();
  const formattedDuration = formatDuration(stats.total_duration || 0);
  ctx.reply(`📊 Stats:\n\nTotal voice notes: ${stats.count}\nTotal duration: ${formattedDuration}`);
});

// Start the admin server
startAdminServer().catch(err => console.error('Failed to start admin server:', err));

// Start the Voice Journal Bot
console.log('Starting Voice Journal Bot...');

if (WEBHOOK_DOMAIN) {
  // Use webhooks for production
  const voiceJournalWebhookPath = `/webhook/voice-journal/${randomUUID()}`;

  bot.launch({
    webhook: {
      domain: WEBHOOK_DOMAIN,
      port: PORT,
      path: voiceJournalWebhookPath,
    },
  });

  console.log(`✓ Voice Journal Bot started with webhook: ${WEBHOOK_DOMAIN}${voiceJournalWebhookPath}`);

  // Taste Bot temporarily disabled to reduce connection load
  // const tasteBotWebhookPath = `/webhook/taste-bot/${randomUUID()}`;
  // startTasteBot({
  //   domain: WEBHOOK_DOMAIN,
  //   port: PORT,
  //   path: tasteBotWebhookPath,
  // });
  // console.log(`✓ Taste Bot started with webhook: ${WEBHOOK_DOMAIN}${tasteBotWebhookPath}`);
} else {
  // Use polling for development
  bot.launch();
  console.log('✓ Voice Journal Bot started with polling (development mode)');

  // Taste Bot temporarily disabled to reduce connection load
  // startTasteBot();
}

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

console.log('✓ Voice Journal Bot is running!');
// console.log('✓ Taste Bot is running!');
console.log(`✓ Authorized user ID: ${AUTHORIZED_USER_ID}`);
