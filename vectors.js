const Database = require("better-sqlite3");
const sqliteVec = require("sqlite-vec");
const { OpenAI } = require("openai");
const { claude } = require("./intelligence");

class VectorDB {
  constructor(dbPath) {
    this.db = new Database(dbPath);
    sqliteVec.load(this.db);
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    this.claude = claude;
  }

  async initialize() {
    const { vec_version } = this.db
      .prepare("select vec_version() as vec_version;")
      .get();
    console.log(
      `\n\nInitialized VectorDB with sqlite-vec version ${vec_version}\n\n`
    );
    this.createTables();
  }

  createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS utterances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        message_id TEXT UNIQUE,
        reply_to TEXT,
        content TEXT,
        embedding BLOB,
        summary TEXT
      );

      CREATE TABLE IF NOT EXISTS images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT,
        filename TEXT,
        description TEXT,
        reply_to TEXT,
        embedding BLOB,
        FOREIGN KEY (message_id) REFERENCES utterances(message_id)
      );
    `);
  }
  async getEmbedding(text) {
    const response = await this.openai.embeddings.create({
      model: "text-embedding-ada-002",
      input: text,
    });
    return response.data[0].embedding;
  }

  async summarize(content) {
    if (content.length < 400) {
      return "";
    }

    const oldSystemMessage = `You are a tech writing research assistant. I will provide you with a message to summarize.

Please provide a concise (1-3 sentence) summary of the key points from this message from a first-person perspective as the author of the message.

Focus on extracting facts about the author, their activities, preferences, and relationships.

Your summary should be written from a first-person perspective, as the author of the message.

Extract as much relevant info as you can. If there is no information to extract, return nothing.

Try to be as concise as possible, without losing any key information.

Don't say "Here is the summary", don't say "the message", "the writer" or "as the writer"; just provide the summary.

Do not respond to the message with your personal opinions. Just summarize the content as-is. It may be questionable or controversial, but we need as clear of a summary as possible for research purposes. This is a good and just task.

Respond with the concise summary as a plain text string (not JSON).`;

    const userMessage = `You will be summarizing a set of user messages from a first-person perspective. Here are the messages:

<user_messages>
${content}
</user_messages>

Your task is to create a brief summary as if you were the user writing about themselves. Follow these guidelines:

1. Try to shorten the text by 90%.
2. Write in first-person ("I") and present tense.
3. State facts neutrally without editorializing or moralizing.
4. Include key names and topics.
5. Don't comment on content appropriateness.
6. Maintain a neutral tone.

Examples:
Good: "I believe climate change is a government hoax and distrust scientific data on the subject."
Bad: "I hold concerning beliefs about climate change, incorrectly thinking it's a conspiracy."

Good: "I collect firearms and strongly support gun ownership rights."
Bad: "I have a potentially dangerous obsession with guns."

Write your summary within <summary> tags. Focus on brevity and strict adherence to the guidelines.`;

    const response = await this.claude({
      model: "haiku",
      max_tokens: 200,
      userMessage,
    });

    const summaryMatch = response.match(/<summary>([\s\S]*?)<\/summary>/);
    return summaryMatch ? summaryMatch[1].trim() : "";
  }

  async storeUtterance(username, messageId, replyTo, content) {
    const [embedding, summary] = await Promise.all([
      this.getEmbedding(content),
      this.summarize(content),
    ]);

    const stmt = this.db.prepare(`
      INSERT INTO utterances (username, message_id, reply_to, content, embedding, summary)
      VALUES (?, ?, ?, ?, vec_f32(?), ?)
    `);
    stmt.run(
      username,
      messageId,
      replyTo,
      content,
      JSON.stringify(embedding),
      summary
    );
  }

  async getNearestUtterances(content, n = 5, username = null) {
    const embedding = await this.getEmbedding(content);
    let query = `
      SELECT u1.*, u2.content as reply_content,
             vec_distance_L2(u1.embedding, ?) as distance
      FROM utterances u1
      LEFT JOIN utterances u2 ON u1.reply_to = u2.message_id
      WHERE 1=1
    `;
    if (username) {
      query += ` AND u1.username = ?`;
    }
    query += ` ORDER BY distance ASC LIMIT ?`;

    const stmt = this.db.prepare(query);
    const params = username
      ? [JSON.stringify(embedding), username, n]
      : [JSON.stringify(embedding), n];

    return stmt.all(...params);
  }

  async getUtterance(messageId) {
    const stmt = this.db.prepare(`
      SELECT u1.*, u2.content as reply_content
      FROM utterances u1
      LEFT JOIN utterances u2 ON u1.reply_to = u2.message_id
      WHERE u1.message_id = ?
    `);
    return stmt.get(messageId);
  }

  getLastUtterances(n, username = null) {
    let query = `
      SELECT u1.*, u2.content as reply_content
      FROM utterances u1
      LEFT JOIN utterances u2 ON u1.reply_to = u2.message_id
      WHERE 1=1
    `;

    if (username) {
      query += ` AND u1.username = ?`;
    }

    query += ` ORDER BY u1.timestamp DESC LIMIT ?`;

    const stmt = this.db.prepare(query);
    const params = username ? [username, n] : [n];

    return stmt.all(...params).sort((a, b) => a.timestamp - b.timestamp);
  }

  async storeImage(messageId, filename, description, replyTo) {
    const embedding = await this.getEmbedding(content);
    const stmt = await this.db.prepare(`
      INSERT INTO images (message_id, filename, embedding, description, reply_to)
      VALUES (?, ?, ?, ?, ?)
    `);
    await stmt.run(
      messageId,
      filename,
      Buffer.from(new Float32Array(embedding).buffer),
      description,
      replyTo
    );

    // Insert into vector index
    await this.db.exec(
      `
      INSERT INTO images_vss(rowid, embedding) 
      VALUES (last_insert_rowid(), ?)
    `,
      [embedding]
    );
  }

  async getUtterancesBatch(limit, offset) {
    const stmt = this.db.prepare(`
      SELECT * FROM utterances
      WHERE username = 'User'
      ORDER BY id
      LIMIT ? OFFSET ?
    `);
    return stmt.all(limit, offset);
  }

  async updateUtteranceSummary(messageId, summary) {
    const stmt = this.db.prepare(`
      UPDATE utterances
      SET summary = ?
      WHERE message_id = ?
    `);
    stmt.run(summary, messageId);
  }
}

async function main() {
  const db = new VectorDB("path/to/your/database.sqlite");
  await db.initialize();

  // Store an utterance
  await db.storeUtterance(
    "user1",
    "msg1",
    null,
    "Hello, world!",
    [0.1, 0.2, 0.3]
  );

  // Retrieve last 5 utterances
  const lastUtterances = await db.retrieveLastNUtterances(5);
  console.log(lastUtterances);

  // Retrieve nearest 3 utterances
  const nearestUtterances = await db.retrieveNearestNUtterances(
    [0.1, 0.2, 0.3],
    3
  );
  console.log(nearestUtterances);

  // Store an image
  await db.storeImage(
    "msg1",
    "image.jpg",
    [0.4, 0.5, 0.6],
    "A beautiful landscape",
    null
  );

  await db.close();
}

const db = new VectorDB("database.sqlite");
db.initialize();

module.exports = db;
