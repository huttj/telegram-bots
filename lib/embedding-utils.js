import { embed } from '../embeddings.js';

let embeddingModelReady = false;

/**
 * Initialize embedding model
 * @returns {Promise<boolean>} - True if successful, false otherwise
 */
export async function initializeEmbeddingModel() {
  console.log('Initializing embedding model...');
  try {
    // Test that embedding function works
    await embed('test');
    embeddingModelReady = true;
    console.log('✓ Embedding model initialized');
    return true;
  } catch (err) {
    console.error('Failed to initialize embedding model:', err);
    embeddingModelReady = false;
    return false;
  }
}

/**
 * Check if embedding model is ready
 * @returns {boolean} - True if ready, false otherwise
 */
export function isEmbeddingModelReady() {
  return embeddingModelReady;
}

/**
 * Generate embedding for text
 * @param {string} text - Text to generate embedding for
 * @returns {Promise<number[]>} - Embedding vector
 */
export async function generateEmbedding(text) {
  if (!embeddingModelReady) {
    throw new Error('Embedding model not initialized');
  }
  const embedding = await embed(text);
  return embedding;
}

/**
 * Calculate cosine similarity between two vectors
 * @param {number[]} vecA - First vector
 * @param {number[]} vecB - Second vector
 * @returns {number} - Similarity score (0-1)
 */
export function cosineSimilarity(vecA, vecB) {
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

/**
 * Convert embedding array to buffer for storage
 * @param {number[]} embedding - Embedding vector
 * @returns {Buffer} - Buffer representation
 */
export function embeddingToBuffer(embedding) {
  const buffer = Buffer.allocUnsafe(embedding.length * 4);
  for (let i = 0; i < embedding.length; i++) {
    buffer.writeFloatLE(embedding[i], i * 4);
  }
  return buffer;
}

/**
 * Convert buffer to embedding array
 * @param {Buffer} buffer - Buffer representation
 * @returns {number[]} - Embedding vector
 */
export function bufferToEmbedding(buffer) {
  const embedding = [];
  for (let i = 0; i < buffer.length; i += 4) {
    embedding.push(buffer.readFloatLE(i));
  }
  return embedding;
}

/**
 * Backfill embeddings for records without embeddings
 * @param {Object} db - Database instance
 * @param {string} tableName - Table name (e.g., 'transcripts', 'annotations')
 * @param {string} textColumn - Column containing text to embed (e.g., 'transcript')
 * @param {string} idColumn - Primary key column (default: 'id')
 * @returns {Promise<number>} - Number of records backfilled
 */
export async function backfillEmbeddings(db, tableName, textColumn, idColumn = 'id') {
  if (!embeddingModelReady) {
    console.log('Embedding model not ready, skipping backfill');
    return 0;
  }

  try {
    const stmt = db.prepare(`SELECT ${idColumn}, ${textColumn} FROM ${tableName} WHERE embedding IS NULL`);
    const recordsWithoutEmbeddings = stmt.all();

    if (recordsWithoutEmbeddings.length === 0) {
      console.log(`✓ All ${tableName} records already have embeddings`);
      return 0;
    }

    console.log(`Backfilling embeddings for ${recordsWithoutEmbeddings.length} ${tableName} records...`);

    const updateStmt = db.prepare(`UPDATE ${tableName} SET embedding = ? WHERE ${idColumn} = ?`);

    let successCount = 0;
    for (const record of recordsWithoutEmbeddings) {
      try {
        const embedding = await generateEmbedding(record[textColumn]);
        const embeddingBuffer = embeddingToBuffer(embedding);
        updateStmt.run(embeddingBuffer, record[idColumn]);
        successCount++;
      } catch (error) {
        console.error(`Error generating embedding for ${tableName} ${record[idColumn]}:`, error);
      }
    }

    console.log(`✓ Backfilled embeddings for ${successCount} ${tableName} records`);
    return successCount;
  } catch (error) {
    console.error(`Error backfilling embeddings for ${tableName}:`, error);
    return 0;
  }
}
