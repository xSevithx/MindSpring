import { pipeline } from '@xenova/transformers';

const MODEL = 'Xenova/all-MiniLM-L6-v2';
let extractor = null;

async function getExtractor() {
  if (!extractor) {
    extractor = await pipeline('feature-extraction', MODEL);
  }
  return extractor;
}

export async function generateEmbedding(text) {
  const ext = await getExtractor();
  const output = await ext(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

export async function generateEmbeddings(texts) {
  const results = [];
  for (const text of texts) {
    results.push(await generateEmbedding(text));
  }
  return results;
}
