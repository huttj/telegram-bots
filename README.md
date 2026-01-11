# Voice Journal Telegram Bot

A Telegram bot that automatically transcribes voice messages and saves them with timestamps for later retrieval. Built with Node.js, uses Groq's free Whisper API for transcription, and stores voice files in Cloudflare R2.

## Features

- **Voice Transcription**: Automatically transcribe voice messages using Groq's Whisper API (free tier available)
- **Cloud Storage**: Store original voice files in Cloudflare R2
- **User Authentication**: Hard-coded user ID authorization for privacy
- **Durable Storage**: SQLite database for transcripts with timestamps
- **Auto-Deploy**: GitHub Actions workflow for automatic deployment to Fly.io

## Setup Instructions

### 1. Create a Telegram Bot

1. Message [@BotFather](https://t.me/botfather) on Telegram
2. Send `/newbot` and follow the prompts
3. Save the bot token you receive
4. Get your Telegram User ID by messaging [@userinfobot](https://t.me/userinfobot)

### 2. Get Groq API Key (Free)

1. Sign up at [https://console.groq.com](https://console.groq.com)
2. Navigate to API Keys section
3. Create a new API key
4. Save the key (it starts with `gsk_`)

### 3. Set up Cloudflare R2 (Optional but Recommended)

1. Sign up for Cloudflare account at [https://cloudflare.com](https://cloudflare.com)
2. Navigate to R2 Object Storage
3. Create a new bucket (e.g., "voice-journal")
4. Create an API token with R2 permissions
5. Save your:
   - Account ID
   - Access Key ID
   - Secret Access Key
   - Bucket name

### 4. Deploy to Fly.io

#### Install Fly CLI

```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh

# Login to Fly.io
flyctl auth login
```

#### Create and Configure App

```bash
# Create Fly.io app (first time only)
flyctl apps create voice-journal

# Create persistent volume for database
flyctl volumes create voice_journal_data --size 1 --region iad

# Set secrets (do this one by one)
flyctl secrets set TELEGRAM_BOT_TOKEN="your_bot_token"
flyctl secrets set AUTHORIZED_USER_ID="your_telegram_user_id"
flyctl secrets set GROQ_API_KEY="your_groq_api_key"

# Set R2 secrets (optional)
flyctl secrets set R2_ACCOUNT_ID="your_r2_account_id"
flyctl secrets set R2_ACCESS_KEY_ID="your_r2_access_key"
flyctl secrets set R2_SECRET_ACCESS_KEY="your_r2_secret_key"
flyctl secrets set R2_BUCKET_NAME="voice-journal"

# Get your Fly.io app URL
flyctl info

# Set webhook domain (use your app URL from above)
flyctl secrets set WEBHOOK_DOMAIN="https://voice-journal.fly.dev"

# Deploy
flyctl deploy
```

### 5. Set up Auto-Deploy with GitHub Actions

1. Get your Fly.io API token:
   ```bash
   flyctl auth token
   ```

2. Add the token to your GitHub repository:
   - Go to your repo's Settings > Secrets and variables > Actions
   - Click "New repository secret"
   - Name: `FLY_API_TOKEN`
   - Value: Your Fly.io token

3. Push to `main` or any `claude/*` branch to auto-deploy!

## Local Development

### Setup

```bash
# Install dependencies
npm install

# Copy environment variables template
cp .env.example .env

# Edit .env with your credentials
# Leave WEBHOOK_DOMAIN empty for local development
nano .env
```

### Run

```bash
# Development mode with auto-reload
npm run dev

# Production mode
npm start
```

## Usage

Once deployed, message your bot on Telegram:

- **Send a voice message**: The bot will transcribe it and save both the audio file and transcript
- **`/start`**: Get a welcome message
- **`/stats`**: See how many voice notes you've recorded and total duration

The bot will react with:
- 👂 When it starts processing
- ✅ When successfully transcribed and saved
- ❌ If an error occurred

## Database Schema

The bot uses SQLite with the following schema:

```sql
CREATE TABLE transcripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER UNIQUE,
  voice_file_id TEXT,
  r2_key TEXT,
  transcript TEXT,
  created_at INTEGER,
  duration INTEGER
)
```

## Data Export

To export your data:

### Option 1: Download database from Fly.io

```bash
# SSH into your Fly.io machine
flyctl ssh console

# Download the database
flyctl ssh sftp get /data/voice-journal.db ./voice-journal.db
```

### Option 2: Query the database locally

```bash
# After downloading the database
sqlite3 voice-journal.db "SELECT * FROM transcripts ORDER BY created_at DESC" > transcripts.csv
```

### Option 3: Download voice files from R2

Use the [Cloudflare R2 dashboard](https://dash.cloudflare.com/) or [rclone](https://rclone.org/) to bulk download voice files.

## Cost Estimate

- **Groq Whisper API**: FREE (with rate limits)
- **Cloudflare R2**: FREE for first 10GB storage + 10GB/month egress
- **Fly.io**: FREE tier includes 3 shared-cpu-1x VMs + 3GB persistent storage
- **Telegram**: FREE

**Total estimated cost: $0-5/month** (depending on usage)

## Architecture

```
User → Telegram Bot → Voice Message
                 ↓
         Download to temp file
                 ↓
         Upload to Cloudflare R2
                 ↓
         Transcribe with Groq Whisper
                 ↓
         Save to SQLite database
                 ↓
         React with ✅
```

## Future Features (TODO)

- Text query support with AI-powered search
- Date range filtering (today, this week, etc.)
- Vector search for semantic queries
- Export command (`/export`) to download all data
- Multi-language support
- Tastemaker bot (separate bot for saving links and media)

## Troubleshooting

### Bot doesn't respond

1. Check if bot is running: `flyctl logs`
2. Verify your Telegram User ID is correct
3. Make sure all environment variables are set: `flyctl secrets list`

### Transcription fails

1. Check Groq API key is valid
2. Verify rate limits on Groq console
3. Check voice file format is supported

### R2 upload fails

1. Verify R2 credentials are correct
2. Check bucket exists and permissions are set
3. Note: Bot will still work without R2, just won't backup voice files

## License

MIT
