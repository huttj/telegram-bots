import express from 'express';
import basicAuth from 'express-basic-auth';
import Database from 'better-sqlite3';
import { S3Client, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { generateEmbedding } from './embeddings.js';

const ADMIN_PORT = parseInt(process.env.ADMIN_PORT || '80', 10);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DB_PATH = process.env.NODE_ENV === 'production' ? '/data/voice-journal.db' : 'voice-journal.db';

if (!ADMIN_PASSWORD) {
  console.warn('⚠️  Warning: ADMIN_PASSWORD not set. Admin interface will be disabled.');
}

// Initialize database
const db = new Database(DB_PATH);

// Initialize S3/R2 client
const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const app = express();
app.use(express.json());

// Basic authentication middleware
if (ADMIN_PASSWORD) {
  app.use(basicAuth({
    users: { 'admin': ADMIN_PASSWORD },
    challenge: true,
    realm: 'Voice Journal Admin',
  }));
}

// Serve the admin interface HTML
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Voice Journal Admin</title>
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: #0f172a;
            color: #e2e8f0;
            padding: 20px;
            line-height: 1.6;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
        }
        h1 {
            color: #60a5fa;
            margin-bottom: 30px;
            font-size: 2em;
        }
        .controls {
            background: #1e293b;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 20px;
            display: flex;
            gap: 15px;
            flex-wrap: wrap;
            align-items: center;
        }
        input, select, button {
            padding: 10px 15px;
            border: 1px solid #334155;
            border-radius: 6px;
            background: #0f172a;
            color: #e2e8f0;
            font-size: 14px;
        }
        input:focus, select:focus {
            outline: none;
            border-color: #60a5fa;
        }
        #searchInput {
            flex: 1;
            min-width: 250px;
        }
        button {
            background: #3b82f6;
            border: none;
            cursor: pointer;
            font-weight: 500;
            transition: background 0.2s;
        }
        button:hover {
            background: #2563eb;
        }
        button.danger {
            background: #ef4444;
        }
        button.danger:hover {
            background: #dc2626;
        }
        button.secondary {
            background: #64748b;
        }
        button.secondary:hover {
            background: #475569;
        }
        .stats {
            color: #94a3b8;
            font-size: 14px;
        }
        .message-list {
            display: flex;
            flex-direction: column;
            gap: 15px;
        }
        .message-card {
            background: #1e293b;
            border-radius: 8px;
            padding: 20px;
            border: 1px solid #334155;
            transition: border-color 0.2s;
        }
        .message-card:hover {
            border-color: #475569;
        }
        .message-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 15px;
            flex-wrap: wrap;
            gap: 10px;
        }
        .message-meta {
            display: flex;
            gap: 20px;
            color: #94a3b8;
            font-size: 14px;
        }
        .message-actions {
            display: flex;
            gap: 10px;
        }
        .transcript {
            background: #0f172a;
            padding: 15px;
            border-radius: 6px;
            margin-bottom: 15px;
            line-height: 1.8;
            white-space: pre-wrap;
            word-wrap: break-word;
        }
        .transcript.editing {
            display: none;
        }
        textarea {
            width: 100%;
            min-height: 100px;
            padding: 15px;
            border: 1px solid #334155;
            border-radius: 6px;
            background: #0f172a;
            color: #e2e8f0;
            font-family: inherit;
            font-size: 14px;
            line-height: 1.8;
            resize: vertical;
            display: none;
        }
        textarea.editing {
            display: block;
        }
        audio {
            width: 100%;
            height: 40px;
            margin-bottom: 15px;
        }
        .edit-controls {
            display: none;
            gap: 10px;
            margin-top: 10px;
        }
        .edit-controls.editing {
            display: flex;
        }
        .loading {
            text-align: center;
            padding: 40px;
            color: #94a3b8;
        }
        .empty {
            text-align: center;
            padding: 60px 20px;
            color: #64748b;
            font-size: 16px;
        }
        @media (max-width: 768px) {
            .message-header {
                flex-direction: column;
            }
            .message-meta {
                flex-direction: column;
                gap: 5px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Voice Journal Admin</h1>

        <div class="controls">
            <input type="text" id="searchInput" placeholder="Search transcripts..." />
            <input type="date" id="dateFilter" />
            <button onclick="clearFilters()" class="secondary">Clear Filters</button>
            <span class="stats" id="stats">Loading...</span>
        </div>

        <div id="messageList" class="message-list">
            <div class="loading">Loading messages...</div>
        </div>
    </div>

    <script>
        let messages = [];
        let editingId = null;

        async function loadMessages() {
            try {
                const params = new URLSearchParams();
                const search = document.getElementById('searchInput').value;
                const date = document.getElementById('dateFilter').value;

                if (search) params.append('search', search);
                if (date) params.append('date', date);

                const response = await fetch('/api/messages?' + params);
                messages = await response.json();
                renderMessages();
            } catch (error) {
                console.error('Failed to load messages:', error);
                document.getElementById('messageList').innerHTML =
                    '<div class="empty">Failed to load messages. Please refresh.</div>';
            }
        }

        function renderMessages() {
            const container = document.getElementById('messageList');
            const stats = document.getElementById('stats');

            stats.textContent = \`\${messages.length} message\${messages.length !== 1 ? 's' : ''}\`;

            if (messages.length === 0) {
                container.innerHTML = '<div class="empty">No messages found.</div>';
                return;
            }

            container.innerHTML = messages.map(msg => \`
                <div class="message-card" data-id="\${msg.id}">
                    <div class="message-header">
                        <div class="message-meta">
                            <span>📅 \${formatDate(msg.created_at)}</span>
                            <span>⏱️ \${formatDuration(msg.duration)}</span>
                            <span>🆔 #\${msg.id}</span>
                        </div>
                        <div class="message-actions">
                            <button onclick="toggleEdit(\${msg.id})" class="secondary" id="edit-btn-\${msg.id}">Edit</button>
                            <button onclick="deleteMessage(\${msg.id})" class="danger">Delete</button>
                        </div>
                    </div>

                    <audio controls preload="metadata">
                        <source src="/api/audio/\${msg.id}" type="audio/ogg">
                        Your browser does not support the audio element.
                    </audio>

                    <div class="transcript" id="transcript-\${msg.id}">\${escapeHtml(msg.transcript)}</div>
                    <textarea id="textarea-\${msg.id}">\${escapeHtml(msg.transcript)}</textarea>

                    <div class="edit-controls" id="edit-controls-\${msg.id}">
                        <button onclick="saveEdit(\${msg.id})">Save Changes</button>
                        <button onclick="cancelEdit(\${msg.id})" class="secondary">Cancel</button>
                    </div>
                </div>
            \`).join('');
        }

        function toggleEdit(id) {
            if (editingId && editingId !== id) {
                cancelEdit(editingId);
            }

            const transcript = document.getElementById(\`transcript-\${id}\`);
            const textarea = document.getElementById(\`textarea-\${id}\`);
            const controls = document.getElementById(\`edit-controls-\${id}\`);
            const editBtn = document.getElementById(\`edit-btn-\${id}\`);

            transcript.classList.toggle('editing');
            textarea.classList.toggle('editing');
            controls.classList.toggle('editing');

            if (textarea.classList.contains('editing')) {
                editingId = id;
                editBtn.textContent = 'Cancel';
                textarea.focus();
            } else {
                editingId = null;
                editBtn.textContent = 'Edit';
            }
        }

        function cancelEdit(id) {
            const msg = messages.find(m => m.id === id);
            if (msg) {
                document.getElementById(\`textarea-\${id}\`).value = msg.transcript;
            }
            toggleEdit(id);
        }

        async function saveEdit(id) {
            const textarea = document.getElementById(\`textarea-\${id}\`);
            const newTranscript = textarea.value.trim();

            if (!newTranscript) {
                alert('Transcript cannot be empty.');
                return;
            }

            try {
                const response = await fetch(\`/api/messages/\${id}\`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ transcript: newTranscript })
                });

                if (!response.ok) throw new Error('Failed to update');

                const msg = messages.find(m => m.id === id);
                if (msg) msg.transcript = newTranscript;

                document.getElementById(\`transcript-\${id}\`).textContent = newTranscript;
                toggleEdit(id);
            } catch (error) {
                console.error('Failed to save:', error);
                alert('Failed to save changes. Please try again.');
            }
        }

        async function deleteMessage(id) {
            if (!confirm('Are you sure you want to delete this message? This cannot be undone.')) {
                return;
            }

            try {
                const response = await fetch(\`/api/messages/\${id}\`, {
                    method: 'DELETE'
                });

                if (!response.ok) throw new Error('Failed to delete');

                messages = messages.filter(m => m.id !== id);
                renderMessages();
            } catch (error) {
                console.error('Failed to delete:', error);
                alert('Failed to delete message. Please try again.');
            }
        }

        function clearFilters() {
            document.getElementById('searchInput').value = '';
            document.getElementById('dateFilter').value = '';
            loadMessages();
        }

        function formatDate(timestamp) {
            const date = new Date(timestamp * 1000);
            return date.toLocaleString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });
        }

        function formatDuration(seconds) {
            const mins = Math.floor(seconds / 60);
            const secs = seconds % 60;
            return \`\${mins}:\${secs.toString().padStart(2, '0')}\`;
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        // Auto-search on input
        document.getElementById('searchInput').addEventListener('input',
            debounce(() => loadMessages(), 500)
        );

        document.getElementById('dateFilter').addEventListener('change', loadMessages);

        function debounce(func, wait) {
            let timeout;
            return function executedFunction(...args) {
                const later = () => {
                    clearTimeout(timeout);
                    func(...args);
                };
                clearTimeout(timeout);
                timeout = setTimeout(later, wait);
            };
        }

        // Load messages on page load
        loadMessages();
    </script>
</body>
</html>
  `);
});

// API endpoint to get messages with optional search and date filter
app.get('/api/messages', (req, res) => {
  try {
    const { search, date } = req.query;
    let query = 'SELECT id, message_id, transcript, created_at, duration, r2_key FROM transcripts';
    const params = [];
    const conditions = [];

    if (search) {
      conditions.push('transcript LIKE ?');
      params.push(`%${search}%`);
    }

    if (date) {
      // Convert date to Unix timestamp range (start and end of day)
      const startOfDay = new Date(date + 'T00:00:00Z').getTime() / 1000;
      const endOfDay = new Date(date + 'T23:59:59Z').getTime() / 1000;
      conditions.push('created_at BETWEEN ? AND ?');
      params.push(startOfDay, endOfDay);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY created_at DESC';

    const stmt = db.prepare(query);
    const messages = stmt.all(...params);
    res.json(messages);
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// API endpoint to stream audio
app.get('/api/audio/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const message = db.prepare('SELECT r2_key FROM transcripts WHERE id = ?').get(id);

    if (!message || !message.r2_key) {
      return res.status(404).json({ error: 'Audio not found' });
    }

    const command = new GetObjectCommand({
      Bucket: 'voice-journal',
      Key: message.r2_key,
    });

    const response = await r2Client.send(command);
    res.setHeader('Content-Type', 'audio/ogg');
    res.setHeader('Accept-Ranges', 'bytes');
    response.Body.pipe(res);
  } catch (error) {
    console.error('Error streaming audio:', error);
    res.status(500).json({ error: 'Failed to stream audio' });
  }
});

// API endpoint to update transcript
app.put('/api/messages/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { transcript } = req.body;

    if (!transcript || typeof transcript !== 'string') {
      return res.status(400).json({ error: 'Invalid transcript' });
    }

    // Update transcript
    const updateStmt = db.prepare('UPDATE transcripts SET transcript = ? WHERE id = ?');
    const result = updateStmt.run(transcript.trim(), id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }

    // Re-generate embedding if embeddings are enabled
    if (process.env.OPENROUTER_API_KEY) {
      try {
        const embedding = await generateEmbedding(transcript.trim());
        const embeddingBuffer = Buffer.alloc(embedding.length * 4);
        embedding.forEach((val, i) => embeddingBuffer.writeFloatLE(val, i * 4));

        const embeddingStmt = db.prepare('UPDATE transcripts SET embedding = ? WHERE id = ?');
        embeddingStmt.run(embeddingBuffer, id);

        console.log(`✓ Re-embedded transcript for message ${id}`);
      } catch (embeddingError) {
        console.error('Failed to regenerate embedding:', embeddingError);
        // Continue anyway - transcript was updated successfully
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating message:', error);
    res.status(500).json({ error: 'Failed to update message' });
  }
});

// API endpoint to delete message
app.delete('/api/messages/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Get R2 key before deleting
    const message = db.prepare('SELECT r2_key FROM transcripts WHERE id = ?').get(id);

    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }

    // Delete from database
    const deleteStmt = db.prepare('DELETE FROM transcripts WHERE id = ?');
    deleteStmt.run(id);

    // Delete from R2
    if (message.r2_key) {
      try {
        const command = new DeleteObjectCommand({
          Bucket: 'voice-journal',
          Key: message.r2_key,
        });
        await r2Client.send(command);
        console.log(`✓ Deleted audio file from R2: ${message.r2_key}`);
      } catch (r2Error) {
        console.error('Failed to delete from R2:', r2Error);
        // Continue anyway - database record was deleted
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting message:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

export function startAdminServer() {
  if (!ADMIN_PASSWORD) {
    console.log('⚠️  Admin server not started (ADMIN_PASSWORD not set)');
    return null;
  }

  return new Promise((resolve) => {
    const server = app.listen(ADMIN_PORT, () => {
      console.log(`✓ Admin interface running on port ${ADMIN_PORT}`);
      console.log(`  Username: admin`);
      console.log(`  Password: ${ADMIN_PASSWORD.substring(0, 3)}${'*'.repeat(ADMIN_PASSWORD.length - 3)}`);
      resolve(server);
    });
  });
}
