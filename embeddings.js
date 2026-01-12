const { EmbeddingModel, FlagEmbedding } = require("fastembed");

const embeddingModelP = FlagEmbedding.init({
    model: EmbeddingModel.BGEBaseEN
});

async function embed(document) {
  const [result] = await embedBatch([document]);
  return result;
}

async function embedBatch(documents) {
  const embeddingModel = await embeddingModelP;
  const embeddings = embeddingModel.embed(documents);
  const results = [];
  for await (const batch of embeddings) {
    results.push(batch[0]);
  }
  return results;
}

async function embedEach(documents) {
  const embeddingModel = await embeddingModelP;
  return embeddingModel.embed(documents);
}

module.exports = { embed, embedBatch, embedEach };
