import express from 'express';
import basicAuth from 'express-basic-auth';
import Database from 'better-sqlite3';
import { GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { embed } from './embeddings.js';
import { getR2Client } from './lib/r2-client.js';

const ADMIN_PORT = parseInt(process.env.ADMIN_PORT || '80', 10);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const VOICE_JOURNAL_DB_PATH = process.env.FLY_APP_NAME ? '/data/voice-journal.db' : 'voice-journal.db';
const TASTE_BOT_DB_PATH = process.env.FLY_APP_NAME ? '/data/taste-bot.db' : 'taste-bot.db';
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'telegram-bots';

if (!ADMIN_PASSWORD) {
  console.warn('⚠️  Warning: ADMIN_PASSWORD not set. Admin interface will be disabled.');
}

// Initialize databases
const voiceJournalDb = new Database(VOICE_JOURNAL_DB_PATH);
const tasteBotDb = new Database(TASTE_BOT_DB_PATH);

// Reuse shared R2 client instance to avoid connection pool duplication
const r2Client = getR2Client();

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
    <title>Telegram Bots Admin</title>
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
            margin-bottom: 20px;
            font-size: 2em;
        }
        .tabs {
            display: flex;
            gap: 10px;
            margin-bottom: 30px;
            border-bottom: 2px solid #334155;
        }
        .tab {
            padding: 12px 24px;
            background: transparent;
            border: none;
            border-bottom: 3px solid transparent;
            color: #94a3b8;
            cursor: pointer;
            font-size: 16px;
            font-weight: 500;
            transition: all 0.2s;
        }
        .tab:hover {
            color: #e2e8f0;
            background: #1e293b;
        }
        .tab.active {
            color: #60a5fa;
            border-bottom-color: #60a5fa;
        }
        .tab-content {
            display: none;
        }
        .tab-content.active {
            display: block;
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
        <h1>Telegram Bots Admin</h1>

        <div class="tabs">
            <button class="tab active" onclick="switchTab('voice-journal')">🎙 Voice Journal</button>
            <button class="tab" onclick="switchTab('taste-bot')">🎨 Taste Bot</button>
        </div>

        <!-- Voice Journal Tab -->
        <div id="voice-journal" class="tab-content active">
            <div class="controls">
                <input type="text" id="vj-searchInput" placeholder="Search transcripts..." />
                <input type="date" id="vj-dateFilter" />
                <button onclick="clearFiltersVJ()" class="secondary">Clear Filters</button>
                <span class="stats" id="vj-stats">Loading...</span>
            </div>

            <div id="vj-messageList" class="message-list">
                <div class="loading">Loading messages...</div>
            </div>
        </div>

        <!-- Taste Bot Tab -->
        <div id="taste-bot" class="tab-content">
            <div class="controls">
                <input type="text" id="tb-searchInput" placeholder="Search submissions..." />
                <select id="tb-contentTypeFilter">
                    <option value="">All Types</option>
                    <option value="url">URLs</option>
                    <option value="photo">Photos</option>
                    <option value="video">Videos</option>
                    <option value="gif">GIFs</option>
                    <option value="audio">Audio</option>
                    <option value="document">Documents</option>
                </select>
                <button onclick="clearFiltersTB()" class="secondary">Clear Filters</button>
                <span class="stats" id="tb-stats">Loading...</span>
            </div>

            <div id="tb-submissionList" class="message-list">
                <div class="loading">Loading submissions...</div>
            </div>
        </div>
    </div>

    <script>
        // Tab switching
        let currentTab = 'voice-journal';

        function switchTab(tabName) {
            // Update active tab
            document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

            event.target.classList.add('active');
            document.getElementById(tabName).classList.add('active');

            currentTab = tabName;

            // Load data for the tab
            if (tabName === 'voice-journal') {
                loadVJMessages();
            } else if (tabName === 'taste-bot') {
                loadTBSubmissions();
            }
        }

        // ========== VOICE JOURNAL TAB ==========
        let vjMessages = [];
        let vjEditingId = null;

        async function loadVJMessages() {
            try {
                const params = new URLSearchParams();
                const search = document.getElementById('vj-searchInput').value;
                const date = document.getElementById('vj-dateFilter').value;

                if (search) params.append('search', search);
                if (date) params.append('date', date);

                const response = await fetch('/api/voice-journal/messages?' + params);
                vjMessages = await response.json();
                renderVJMessages();
            } catch (error) {
                console.error('Failed to load messages:', error);
                document.getElementById('vj-messageList').innerHTML =
                    '<div class="empty">Failed to load messages. Please refresh.</div>';
            }
        }

        function renderVJMessages() {
            const container = document.getElementById('vj-messageList');
            const stats = document.getElementById('vj-stats');

            stats.textContent = \`\${vjMessages.length} message\${vjMessages.length !== 1 ? 's' : ''}\`;

            if (vjMessages.length === 0) {
                container.innerHTML = '<div class="empty">No messages found.</div>';
                return;
            }

            container.innerHTML = vjMessages.map(msg => \`
                <div class="message-card" data-id="\${msg.id}">
                    <div class="message-header">
                        <div class="message-meta">
                            <span>📅 \${formatDate(msg.created_at)}</span>
                            <span>⏱️ \${formatDuration(msg.duration)}</span>
                            <span>🆔 #\${msg.id}</span>
                        </div>
                        <div class="message-actions">
                            <button onclick="toggleVJEdit(\${msg.id})" class="secondary" id="vj-edit-btn-\${msg.id}">Edit</button>
                            <button onclick="deleteVJMessage(\${msg.id})" class="danger">Delete</button>
                        </div>
                    </div>

                    <audio controls preload="metadata">
                        <source src="/api/voice-journal/audio/\${msg.id}" type="audio/ogg">
                        Your browser does not support the audio element.
                    </audio>

                    <div class="transcript" id="vj-transcript-\${msg.id}">\${escapeHtml(msg.transcript)}</div>
                    <textarea id="vj-textarea-\${msg.id}">\${escapeHtml(msg.transcript)}</textarea>

                    <div class="edit-controls" id="vj-edit-controls-\${msg.id}">
                        <button onclick="saveVJEdit(\${msg.id})">Save Changes</button>
                        <button onclick="cancelVJEdit(\${msg.id})" class="secondary">Cancel</button>
                    </div>
                </div>
            \`).join('');
        }

        function toggleVJEdit(id) {
            if (vjEditingId && vjEditingId !== id) {
                cancelVJEdit(vjEditingId);
            }

            const transcript = document.getElementById(\`vj-transcript-\${id}\`);
            const textarea = document.getElementById(\`vj-textarea-\${id}\`);
            const controls = document.getElementById(\`vj-edit-controls-\${id}\`);
            const editBtn = document.getElementById(\`vj-edit-btn-\${id}\`);

            transcript.classList.toggle('editing');
            textarea.classList.toggle('editing');
            controls.classList.toggle('editing');

            if (textarea.classList.contains('editing')) {
                vjEditingId = id;
                editBtn.textContent = 'Cancel';
                textarea.focus();
            } else {
                vjEditingId = null;
                editBtn.textContent = 'Edit';
            }
        }

        function cancelVJEdit(id) {
            const msg = vjMessages.find(m => m.id === id);
            if (msg) {
                document.getElementById(\`vj-textarea-\${id}\`).value = msg.transcript;
            }
            toggleVJEdit(id);
        }

        async function saveVJEdit(id) {
            const textarea = document.getElementById(\`vj-textarea-\${id}\`);
            const newTranscript = textarea.value.trim();

            if (!newTranscript) {
                alert('Transcript cannot be empty.');
                return;
            }

            try {
                const response = await fetch(\`/api/voice-journal/messages/\${id}\`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ transcript: newTranscript })
                });

                if (!response.ok) throw new Error('Failed to update');

                const msg = vjMessages.find(m => m.id === id);
                if (msg) msg.transcript = newTranscript;

                document.getElementById(\`vj-transcript-\${id}\`).textContent = newTranscript;
                toggleVJEdit(id);
            } catch (error) {
                console.error('Failed to save:', error);
                alert('Failed to save changes. Please try again.');
            }
        }

        async function deleteVJMessage(id) {
            if (!confirm('Are you sure you want to delete this message? This cannot be undone.')) {
                return;
            }

            try {
                const response = await fetch(\`/api/voice-journal/messages/\${id}\`, {
                    method: 'DELETE'
                });

                if (!response.ok) throw new Error('Failed to delete');

                vjMessages = vjMessages.filter(m => m.id !== id);
                renderVJMessages();
            } catch (error) {
                console.error('Failed to delete:', error);
                alert('Failed to delete message. Please try again.');
            }
        }

        function clearFiltersVJ() {
            document.getElementById('vj-searchInput').value = '';
            document.getElementById('vj-dateFilter').value = '';
            loadVJMessages();
        }

        // ========== TASTE BOT TAB ==========
        let tbSubmissions = [];

        async function loadTBSubmissions() {
            try {
                const params = new URLSearchParams();
                const search = document.getElementById('tb-searchInput').value;
                const contentType = document.getElementById('tb-contentTypeFilter').value;

                if (search) params.append('search', search);
                if (contentType) params.append('content_type', contentType);

                const response = await fetch('/api/taste-bot/submissions?' + params);
                tbSubmissions = await response.json();
                renderTBSubmissions();
            } catch (error) {
                console.error('Failed to load submissions:', error);
                document.getElementById('tb-submissionList').innerHTML =
                    '<div class="empty">Failed to load submissions. Please refresh.</div>';
            }
        }

        function renderTBSubmissions() {
            const container = document.getElementById('tb-submissionList');
            const stats = document.getElementById('tb-stats');

            stats.textContent = \`\${tbSubmissions.length} submission\${tbSubmissions.length !== 1 ? 's' : ''}\`;

            if (tbSubmissions.length === 0) {
                container.innerHTML = '<div class="empty">No submissions found.</div>';
                return;
            }

            container.innerHTML = tbSubmissions.map(sub => {
                const annotations = sub.annotations || [];
                const contentDisplay = getContentDisplay(sub);

                return \`
                    <div class="message-card" data-id="\${sub.id}">
                        <div class="message-header">
                            <div class="message-meta">
                                <span>📅 \${formatDate(sub.created_at)}</span>
                                <span>📁 \${sub.content_type}</span>
                                <span>🆔 #\${sub.id}</span>
                            </div>
                            <div class="message-actions">
                                <button onclick="deleteTBSubmission(\${sub.id})" class="danger">Delete</button>
                            </div>
                        </div>

                        \${contentDisplay}

                        \${sub.caption ? \`<div class="transcript">\${escapeHtml(sub.caption)}</div>\` : ''}

                        <div style="margin-top: 15px;">
                            <strong>🎤 Voice Annotations (\${annotations.length})</strong>
                            \${annotations.map(ann => \`
                                <div style="background: #0f172a; padding: 10px; margin-top: 10px; border-radius: 6px;">
                                    <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
                                        <span style="color: #94a3b8; font-size: 13px;">
                                            📅 \${formatDate(ann.created_at)} • ⏱️ \${formatDuration(ann.duration)} • 🔗 \${ann.link_type}
                                        </span>
                                        <button onclick="deleteTBAnnotation(\${ann.id}, \${sub.id})" class="danger" style="padding: 5px 10px; font-size: 12px;">Delete</button>
                                    </div>
                                    <audio controls preload="metadata" style="width: 100%; margin-bottom: 10px;">
                                        <source src="/api/taste-bot/audio/\${ann.id}" type="audio/ogg">
                                    </audio>
                                    <div>\${escapeHtml(ann.transcript)}</div>
                                </div>
                            \`).join('')}
                            \${annotations.length === 0 ? '<div style="color: #64748b; font-size: 14px; margin-top: 10px;">No voice annotations yet.</div>' : ''}
                        </div>
                    </div>
                \`;
            }).join('');
        }

        function getContentDisplay(sub) {
            if (sub.content_type === 'url') {
                return \`<div class="transcript"><a href="\${sub.url}" target="_blank" style="color: #60a5fa;">\${sub.url}</a></div>\`;
            } else if (sub.content_type === 'photo') {
                return \`<img src="/api/taste-bot/media/\${sub.id}" style="max-width: 100%; border-radius: 6px; margin-bottom: 10px;" />\`;
            } else if (sub.content_type === 'video' || sub.content_type === 'gif') {
                return \`<video controls style="max-width: 100%; border-radius: 6px; margin-bottom: 10px;">
                    <source src="/api/taste-bot/media/\${sub.id}">
                </video>\`;
            } else if (sub.content_type === 'audio') {
                return \`<audio controls preload="metadata" style="width: 100%; margin-bottom: 10px;">
                    <source src="/api/taste-bot/media/\${sub.id}">
                </audio>\`;
            } else if (sub.content_type === 'document') {
                return \`<div class="transcript">📄 \${sub.filename || 'Document'}</div>\`;
            }
            return '';
        }

        async function deleteTBSubmission(id) {
            if (!confirm('Are you sure you want to delete this submission and all its annotations? This cannot be undone.')) {
                return;
            }

            try {
                const response = await fetch(\`/api/taste-bot/submissions/\${id}\`, {
                    method: 'DELETE'
                });

                if (!response.ok) throw new Error('Failed to delete');

                tbSubmissions = tbSubmissions.filter(s => s.id !== id);
                renderTBSubmissions();
            } catch (error) {
                console.error('Failed to delete:', error);
                alert('Failed to delete submission. Please try again.');
            }
        }

        async function deleteTBAnnotation(annotationId, submissionId) {
            if (!confirm('Are you sure you want to delete this annotation? This cannot be undone.')) {
                return;
            }

            try {
                const response = await fetch(\`/api/taste-bot/annotations/\${annotationId}\`, {
                    method: 'DELETE'
                });

                if (!response.ok) throw new Error('Failed to delete');

                // Update local data
                const sub = tbSubmissions.find(s => s.id === submissionId);
                if (sub) {
                    sub.annotations = sub.annotations.filter(a => a.id !== annotationId);
                }
                renderTBSubmissions();
            } catch (error) {
                console.error('Failed to delete:', error);
                alert('Failed to delete annotation. Please try again.');
            }
        }

        function clearFiltersTB() {
            document.getElementById('tb-searchInput').value = '';
            document.getElementById('tb-contentTypeFilter').value = '';
            loadTBSubmissions();
        }

        // ========== UTILITY FUNCTIONS ==========
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
        document.getElementById('vj-searchInput').addEventListener('input',
            debounce(() => loadVJMessages(), 500)
        );
        document.getElementById('vj-dateFilter').addEventListener('change', loadVJMessages);

        document.getElementById('tb-searchInput').addEventListener('input',
            debounce(() => loadTBSubmissions(), 500)
        );
        document.getElementById('tb-contentTypeFilter').addEventListener('change', loadTBSubmissions);

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
        loadVJMessages();
    </script>
</body>
</html>
  `);
});

// ========== VOICE JOURNAL API ENDPOINTS ==========

// API endpoint to get messages with optional search and date filter
app.get('/api/voice-journal/messages', (req, res) => {
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

    const stmt = voiceJournalDb.prepare(query);
    const messages = stmt.all(...params);
    res.json(messages);
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// API endpoint to stream audio
app.get('/api/voice-journal/audio/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const message = voiceJournalDb.prepare('SELECT r2_key FROM transcripts WHERE id = ?').get(id);

    if (!message || !message.r2_key) {
      return res.status(404).json({ error: 'Audio not found' });
    }

    const command = new GetObjectCommand({
      Bucket: R2_BUCKET_NAME,
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
app.put('/api/voice-journal/messages/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { transcript } = req.body;

    if (!transcript || typeof transcript !== 'string') {
      return res.status(400).json({ error: 'Invalid transcript' });
    }

    // Update transcript
    const updateStmt = voiceJournalDb.prepare('UPDATE transcripts SET transcript = ? WHERE id = ?');
    const result = updateStmt.run(transcript.trim(), id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }

    // Re-generate embedding if embeddings are enabled
    if (process.env.OPENROUTER_API_KEY) {
      try {
        const embedding = await embed(transcript.trim());
        const embeddingBuffer = Buffer.alloc(embedding.length * 4);
        embedding.forEach((val, i) => embeddingBuffer.writeFloatLE(val, i * 4));

        const embeddingStmt = voiceJournalDb.prepare('UPDATE transcripts SET embedding = ? WHERE id = ?');
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
app.delete('/api/voice-journal/messages/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Get R2 key before deleting
    const message = voiceJournalDb.prepare('SELECT r2_key FROM transcripts WHERE id = ?').get(id);

    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }

    // Delete from database
    const deleteStmt = voiceJournalDb.prepare('DELETE FROM transcripts WHERE id = ?');
    deleteStmt.run(id);

    // Delete from R2
    if (message.r2_key) {
      try {
        const command = new DeleteObjectCommand({
          Bucket: R2_BUCKET_NAME,
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

// ========== TASTE BOT API ENDPOINTS ==========

// API endpoint to get submissions with annotations
app.get('/api/taste-bot/submissions', (req, res) => {
  try {
    const { search, content_type } = req.query;
    let query = 'SELECT * FROM submissions';
    const params = [];
    const conditions = [];

    if (search) {
      conditions.push('(url LIKE ? OR caption LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }

    if (content_type) {
      conditions.push('content_type = ?');
      params.push(content_type);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY created_at DESC';

    const stmt = tasteBotDb.prepare(query);
    const submissions = stmt.all(...params);

    // Add annotations for each submission
    const annotationsStmt = tasteBotDb.prepare('SELECT * FROM annotations WHERE submission_id = ? ORDER BY created_at ASC');
    submissions.forEach(sub => {
      sub.annotations = annotationsStmt.all(sub.id);
    });

    res.json(submissions);
  } catch (error) {
    console.error('Error fetching submissions:', error);
    res.status(500).json({ error: 'Failed to fetch submissions' });
  }
});

// API endpoint to stream media from submissions
app.get('/api/taste-bot/media/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const submission = tasteBotDb.prepare('SELECT * FROM submissions WHERE id = ?').get(id);

    if (!submission || !submission.r2_key) {
      return res.status(404).json({ error: 'Media not found' });
    }

    const command = new GetObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: submission.r2_key,
    });

    const response = await r2Client.send(command);

    // Set appropriate content type
    const metadata = submission.metadata ? JSON.parse(submission.metadata) : {};
    const contentType = metadata.mime_type || 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    response.Body.pipe(res);
  } catch (error) {
    console.error('Error streaming media:', error);
    res.status(500).json({ error: 'Failed to stream media' });
  }
});

// API endpoint to stream audio from annotations
app.get('/api/taste-bot/audio/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const annotation = tasteBotDb.prepare('SELECT r2_key FROM annotations WHERE id = ?').get(id);

    if (!annotation || !annotation.r2_key) {
      return res.status(404).json({ error: 'Audio not found' });
    }

    const command = new GetObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: annotation.r2_key,
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

// API endpoint to delete submission (cascades to annotations)
app.delete('/api/taste-bot/submissions/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Get submission and all its annotations
    const submission = tasteBotDb.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    const annotations = tasteBotDb.prepare('SELECT * FROM annotations WHERE submission_id = ?').all(id);

    // Delete from database (CASCADE will delete annotations)
    const deleteStmt = tasteBotDb.prepare('DELETE FROM submissions WHERE id = ?');
    deleteStmt.run(id);

    // Delete submission media from R2
    if (submission.r2_key) {
      try {
        const command = new DeleteObjectCommand({
          Bucket: R2_BUCKET_NAME,
          Key: submission.r2_key,
        });
        await r2Client.send(command);
        console.log(`✓ Deleted submission media from R2: ${submission.r2_key}`);
      } catch (r2Error) {
        console.error('Failed to delete submission media from R2:', r2Error);
      }
    }

    // Delete annotation audio files from R2
    for (const ann of annotations) {
      if (ann.r2_key) {
        try {
          const command = new DeleteObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: ann.r2_key,
          });
          await r2Client.send(command);
          console.log(`✓ Deleted annotation audio from R2: ${ann.r2_key}`);
        } catch (r2Error) {
          console.error('Failed to delete annotation audio from R2:', r2Error);
        }
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting submission:', error);
    res.status(500).json({ error: 'Failed to delete submission' });
  }
});

// API endpoint to delete annotation
app.delete('/api/taste-bot/annotations/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Get annotation
    const annotation = tasteBotDb.prepare('SELECT * FROM annotations WHERE id = ?').get(id);
    if (!annotation) {
      return res.status(404).json({ error: 'Annotation not found' });
    }

    // Delete from database
    const deleteStmt = tasteBotDb.prepare('DELETE FROM annotations WHERE id = ?');
    deleteStmt.run(id);

    // Delete audio from R2
    if (annotation.r2_key) {
      try {
        const command = new DeleteObjectCommand({
          Bucket: R2_BUCKET_NAME,
          Key: annotation.r2_key,
        });
        await r2Client.send(command);
        console.log(`✓ Deleted annotation audio from R2: ${annotation.r2_key}`);
      } catch (r2Error) {
        console.error('Failed to delete annotation audio from R2:', r2Error);
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting annotation:', error);
    res.status(500).json({ error: 'Failed to delete annotation' });
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
