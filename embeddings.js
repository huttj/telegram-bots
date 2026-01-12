import { EmbeddingModel, FlagEmbedding } from "fastembed";

const embeddingModelP = FlagEmbedding.init({
    model: EmbeddingModel.BGEBaseEN
});

export async function embed(document) {
  const [result] = await embedBatch([document]);
  return result;
}

export async function embedBatch(documents) {
  const embeddingModel = await embeddingModelP;
  const embeddings = embeddingModel.embed(documents);
  const results = [];
  for await (const batch of embeddings) {
    results.push(batch[0]);
  }
  return results;
}

export async function embedEach(documents) {
  const embeddingModel = await embeddingModelP;
  return embeddingModel.embed(documents);
}
