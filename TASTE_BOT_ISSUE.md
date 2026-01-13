# Taste Bot: Personal taste archive with voice annotations

## Overview

A new Telegram bot that allows saving items you like (URLs, photos, videos, social links) and annotating them with voice recordings describing what you like about each item.

## Key Features

### 1. Multi-Format Submissions (Priority 1)
- Accept: URLs/links, photos, videos/gifs, music, documents, social links
- Save to SQLite database + R2 storage
- Store metadata: date, content type, URL/path, filename
- For now: Just capture the link/content (no scraping/downloading external media)

### 2. Smart Voice Memo Linking (Priority 2)

Voice memos can be linked to submissions using three methods:

**a. Reply-based linking**: Voice memo replies to a submission → links to that submission

**b. Sequential linking**: Voice memo immediately follows a submission (no other submissions between) → links to that submission. Multiple consecutive voice memos all link to the most recent submission.

**c. Voice-reply chaining**: Voice memo replies to another voice memo → links to the same submission that voice memo is linked to

This enables both immediate annotation AND post-hoc labeling/elaboration.

### 3. Voice Processing
- Transcribe voice memos (Groq Whisper, same as Voice Journal)
- Generate embeddings for transcripts (OpenRouter, same as Voice Journal)
- Store transcript, embedding, and date

## Technical Architecture

### Database Schema

```sql
-- Submissions: URLs, photos, videos, etc.
CREATE TABLE submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER UNIQUE NOT NULL,
  user_id INTEGER NOT NULL,
  content_type TEXT NOT NULL,  -- 'url', 'photo', 'video', 'audio', 'document'
  url TEXT,
  file_id TEXT,
  r2_key TEXT,
  filename TEXT,
  caption TEXT,
  created_at INTEGER NOT NULL,
  metadata TEXT  -- JSON blob
);

-- Annotations: Voice memos linked to submissions
CREATE TABLE annotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL,
  message_id INTEGER UNIQUE NOT NULL,
  voice_file_id TEXT NOT NULL,
  r2_key TEXT,
  transcript TEXT,
  embedding BLOB,
  created_at INTEGER NOT NULL,
  duration INTEGER NOT NULL,
  link_type TEXT NOT NULL,  -- 'reply', 'sequential', 'voice_reply'
  FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE
);
```

### Project Structure

```
telegram-bots/
├── taste-bot.js               # NEW: Main bot
├── lib/                       # NEW: Shared utilities
│   ├── r2-client.js          # R2/S3 client
│   ├── transcription.js      # Groq Whisper
│   ├── embedding-utils.js    # OpenRouter embeddings
│   └── telegram-helpers.js   # File downloads, etc.
├── taste-bot-admin.js        # NEW: Admin interface
├── taste-bot.fly.toml        # NEW: Deployment config
└── litestream.yml            # UPDATE: Backup both DBs
```

### Storage Separation
- **Bot**: Separate TELEGRAM_BOT_TOKEN
- **Database**: taste-bot.db (separate from voice-journal.db)
- **R2**: taste-bot/ prefix (separate from voice-journal/)

## Implementation Plan

### Phase 1: Project Setup
1. Create lib/ folder with shared utilities
2. Extract common code from Voice Journal (R2, transcription, embeddings)
3. Create taste-bot.js skeleton
4. Set up taste-bot.db with schema

### Phase 2: Submission Handling ⚡️ Priority 1
1. URL/link detection and storage
2. Photo submission handler
3. Video/GIF submission handler
4. Audio submission handler
5. Document submission handler
6. Confirmation reactions and /stats command

### Phase 3: Voice Memo Linking ⚡️ Priority 2
1. Voice message handler skeleton
2. Reply-based linking
3. Sequential linking
4. Voice-reply chaining
5. Transcription integration
6. Embedding generation
7. User feedback (reactions + confirmations)

### Phase 4: Admin Interface
1. Create taste-bot-admin.js (port 8080)
2. API endpoints for submissions
3. API endpoints for annotations
4. HTML interface with cards
5. Media streaming from R2

### Phase 5: Deployment
1. Update Dockerfile
2. Create taste-bot.fly.toml
3. Update Litestream config
4. Deploy to Fly.io
5. End-to-end testing

## Environment Variables

```bash
# Taste Bot
TASTE_BOT_TOKEN=...
TASTE_BOT_AUTHORIZED_USER_ID=...
TASTE_BOT_ADMIN_PORT=8080

# Shared (R2, Groq, OpenRouter)
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=telegram-bots
GROQ_API_KEY=...
OPENROUTER_API_KEY=...
```

## Future Enhancements (Out of Scope)

- Media download & archival (scrape YouTube, Instagram, etc.)
- LLM-powered categorization/tagging
- Semantic search across annotations
- Export/sharing features

## Design Rationale

**Separate databases**: Clean separation, easier backups, independent evolution

**Shared utilities**: DRY principle, consistent behavior, easier maintenance

**File_id storage first**: Faster implementation, can backfill media downloads later

**Non-linking behavior**: If submissions exist between voice and target, don't auto-link (prevents incorrect associations)

**Link type tracking**: Useful for debugging, analytics, future features
