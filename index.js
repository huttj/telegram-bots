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
import { embeddings } from 'embeddings';

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
    duration INTEGER,
    embedding BLOB
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

// Initialize embedding model
let embeddingModel = null;
console.log('Initializing embedding model...');
embeddings('Xenova/all-MiniLM-L6-v2').then(async model => {
  embeddingModel = model;
  console.log('✓ Embedding model initialized (384 dimensions)');

  // Backfill embeddings for existing transcripts
  await backfillEmbeddings();
}).catch(err => {
  console.error('Failed to initialize embedding model:', err);
});

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

// Helper: Generate embedding for text
async function generateEmbedding(text) {
  if (!embeddingModel) {
    throw new Error('Embedding model not initialized');
  }
  const embedding = await embeddingModel.embed(text);
  return embedding;
}

// Helper: Calculate cosine similarity between two vectors
function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Helper: Convert embedding array to buffer for storage
function embeddingToBuffer(embedding) {
  const buffer = Buffer.allocUnsafe(embedding.length * 4);
  for (let i = 0; i < embedding.length; i++) {
    buffer.writeFloatLE(embedding[i], i * 4);
  }
  return buffer;
}

// Helper: Convert buffer to embedding array
function bufferToEmbedding(buffer) {
  const embedding = [];
  for (let i = 0; i < buffer.length; i += 4) {
    embedding.push(buffer.readFloatLE(i));
  }
  return embedding;
}

// Helper: Classify query and extract search parameters using small LLM
async function classifyQuery(userQuery) {
  const prompt = `You are a query classifier for a voice journal system. Analyze the user's query and determine:
1. The query type: "today", "week", "month", or "semantic" (for semantic search)
2. For semantic searches, extract the key search terms

User query: "${userQuery}"

Respond ONLY with a JSON object in this exact format:
{
  "type": "today|week|month|semantic",
  "searchTerms": "extracted search terms for semantic search (empty for time-based queries)"
}`;

  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 200,
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
    return { type: 'semantic', searchTerms: userQuery };
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

// Helper: Perform vector similarity search
async function vectorSearch(queryText, topK = 5) {
  if (!embeddingModel) {
    throw new Error('Embedding model not initialized');
  }

  // Generate embedding for query
  const queryEmbedding = await generateEmbedding(queryText);

  // Get all transcripts with embeddings
  const stmt = db.prepare('SELECT * FROM transcripts WHERE embedding IS NOT NULL');
  const transcripts = stmt.all();

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
    const date = new Date(t.created_at * 1000).toLocaleString();
    return `[${i + 1}] ${date} (${t.duration}s):\n${t.transcript}`;
  }).join('\n\n');

  const prompt = `You are a helpful assistant for a voice journal system. The user asked: "${userQuery}"

Here are the relevant voice journal entries:

${context}

Based on these entries, provide a helpful and conversational response to the user's query. Summarize key points, identify patterns, and answer their question directly. If the entries don't contain relevant information, say so politely.`;

  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 1000,
    });

    return response.choices[0].message.content;
  } catch (error) {
    console.error('Error generating response:', error);
    throw error;
  }
}

// Helper: Backfill embeddings for existing transcripts
async function backfillEmbeddings() {
  if (!embeddingModel) {
    console.log('Embedding model not ready, skipping backfill');
    return;
  }

  try {
    const stmt = db.prepare('SELECT id, transcript FROM transcripts WHERE embedding IS NULL');
    const transcriptsWithoutEmbeddings = stmt.all();

    if (transcriptsWithoutEmbeddings.length === 0) {
      console.log('✓ All transcripts already have embeddings');
      return;
    }

    console.log(`Backfilling embeddings for ${transcriptsWithoutEmbeddings.length} transcripts...`);

    const updateStmt = db.prepare('UPDATE transcripts SET embedding = ? WHERE id = ?');

    for (const transcript of transcriptsWithoutEmbeddings) {
      try {
        const embedding = await generateEmbedding(transcript.transcript);
        const embeddingBuffer = embeddingToBuffer(embedding);
        updateStmt.run(embeddingBuffer, transcript.id);
      } catch (error) {
        console.error(`Error generating embedding for transcript ${transcript.id}:`, error);
      }
    }

    console.log(`✓ Backfilled embeddings for ${transcriptsWithoutEmbeddings.length} transcripts`);
  } catch (error) {
    console.error('Error backfilling embeddings:', error);
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

    // Generate embedding for transcript
    let embeddingBuffer = null;
    if (embeddingModel) {
      try {
        console.log('Generating embedding...');
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

    console.log(`✓ Successfully processed voice message ${messageId}`);
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
  console.log(`Received query: ${userQuery}`);

  try {
    // React to show we're processing
    await ctx.react('🤔');

    // Check if embedding model is ready
    if (!embeddingModel) {
      await ctx.reply('⚠️ The embedding model is still initializing. Please try again in a moment.');
      return;
    }

    // Step 1: Classify query using small LLM
    console.log('Classifying query...');
    const classification = await classifyQuery(userQuery);
    console.log(`Query classified as: ${classification.type}`);

    // Step 2: Retrieve relevant transcripts based on query type
    let relevantTranscripts = [];

    if (classification.type === 'today') {
      relevantTranscripts = getTranscriptsToday();
    } else if (classification.type === 'week') {
      relevantTranscripts = getTranscriptsThisWeek();
    } else if (classification.type === 'month') {
      relevantTranscripts = getTranscriptsThisMonth();
    } else {
      // Semantic search
      const searchTerms = classification.searchTerms || userQuery;
      console.log(`Performing vector search for: ${searchTerms}`);
      relevantTranscripts = await vectorSearch(searchTerms, 5);
    }

    console.log(`Found ${relevantTranscripts.length} relevant transcripts`);

    if (relevantTranscripts.length === 0) {
      await ctx.reply('I couldn\'t find any relevant voice notes for your query. Try recording some voice notes first!');
      await ctx.react('🤷');
      return;
    }

    // Step 3: Generate response using medium LLM
    console.log('Generating response...');
    const response = await generateResponse(userQuery, relevantTranscripts);

    // Send response to user
    await ctx.reply(response);
    await ctx.react('✅');

    console.log('✓ Query processed successfully');
  } catch (error) {
    console.error('Error processing query:', error);
    await ctx.reply('Sorry, I encountered an error processing your query. Please try again.');
    await ctx.react('❌');
  }
});

// Handle start command
bot.command('start', (ctx) => {
  ctx.reply('🎙 Voice Journal Bot\n\nSend me voice notes and I\'ll transcribe and save them for you!\n\nYou can also send text messages to query your voice notes. Ask about today\'s notes, this week, or search for specific topics!');
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
