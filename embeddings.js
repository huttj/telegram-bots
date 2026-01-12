import OpenAI from 'openai';

// Initialize OpenRouter client with OpenAI SDK
const openrouter = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});

// Using OpenAI's text-embedding-3-small model through OpenRouter
const EMBEDDING_MODEL = 'openai/text-embedding-3-small';

export async function embed(document) {
  const [result] = await embedBatch([document]);
  return result;
}

export async function embedBatch(documents) {
  try {
    const response = await openrouter.embeddings.create({
      model: EMBEDDING_MODEL,
      input: documents,
    });

    return response.data.map(item => item.embedding);
  } catch (error) {
    console.error('Error generating embeddings:', error);
    throw error;
  }
}

export async function* embedEach(documents) {
  // For streaming support, we'll process in batches
  // OpenRouter doesn't support true streaming for embeddings, so we yield each result
  for (const doc of documents) {
    const embedding = await embed(doc);
    yield embedding;
  }
}
