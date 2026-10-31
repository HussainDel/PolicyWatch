# PolicyWatch

**Know what changed. Understand what matters.** A public, evidence-first policy intelligence demo built with Next.js, MongoDB Atlas Vector Search and Google Gemini. Upload text-based PDFs, ask grounded questions, compare versions, investigate conflicts and inspect the retrieved source passages. No account is required.

## Setup

1. Install Node.js 20 or newer and run `npm install`.
2. Copy `.env.example` to `.env.local` and set:
   - `MONGODB_URI`: Atlas connection string with access to the database.
   - `MONGODB_DB_NAME`: database name (default `policywatch`).
   - `GEMINI_API_KEY`: Google Gemini API key, kept on the server.
   - `GEMINI_MODEL`: generation model (default `gemini-2.5-flash`).
   - `GEMINI_EMBEDDING_MODEL`: embedding model (default `gemini-embedding-001`; it must support 768-dimensional output).
   - `MONGODB_VECTOR_INDEX_NAME`: search index name (default `vector_index`).
3. Set up the Atlas indexes below. Allow the deployment's network access and give the database user read/write access and permission to list search indexes. Keep credentials out of the repository.
4. Run `npm run dev` and visit http://localhost:3000. `npm run typecheck` and `npm run build` check the production build.

## MongoDB Atlas indexes

On the **chunks** collection in your chosen database, create an **Atlas Vector Search** index named `vector_index` (or the value of `MONGODB_VECTOR_INDEX_NAME`) using this JSON definition:

```json
{
  "fields": [
    {"type":"vector","path":"embedding","numDimensions":768,"similarity":"cosine"},
    {"type":"filter","path":"documentId"},
    {"type":"filter","path":"documentTitle"},
    {"type":"filter","path":"version"},
    {"type":"filter","path":"category"}
  ]
}
```

Wait until the index is **queryable** before asking questions. Retrieval checks index readiness and reports an actionable error rather than pretending it succeeded. Atlas Vector Search requires a supported Atlas deployment. The embedding model and index dimensions must match; changing models requires re-ingestion and potentially a new index.

For keyword retrieval, create a regular MongoDB text index (for example in `mongosh`):

```js
use policywatch
db.chunks.createIndex({ text: "text", documentTitle: "text", version: "text" })
```

Without the text index, semantic retrieval still works. Keyword and vector rankings are combined using reciprocal rank fusion; vector search uses `$vectorSearch` with the configured index, `embedding` path and metadata filters. It retrieves eight fused results by default. The server accepts `filters` on `/api/chat` and `/api/conflicts` for `documentId`, `documentTitle` (policy name), `version`, and `category`.

## How it works

1. PDF.js extracts text in the browser, preserving page numbers. The app sends structured text, not PDF binaries, to the server. PDFs are limited to 5 MB each and 1.5 million extracted characters; scanned/image-only PDFs need external OCR.
2. Ingestion normalizes whitespace, splits each page into approximately 500-word chunks with 100-word overlap, embeds each chunk using Gemini (768 dimensions), and stores the vector alongside the passage and metadata. The document is marked indexed only after all chunks are saved. Failed attempts are marked failed and can be retried; deterministic content IDs prevent duplicate ingestion.
3. A query is embedded and passed to Atlas `$vectorSearch`; optional MongoDB text search results are fused by rank. Gemini receives only retrieved passages and is instructed to cite source IDs and refuse unsupported answers. The server discards claims with unknown citations; comparison and conflict claims additionally require citations from two different documents. Citations open the exact retrieved passage with its original page number.
4. Comparisons retrieve evidence separately from each selected version. The model is instructed to classify changes and avoid treating absence from an excerpt as proof of removal or addition. Conflict analysis does not assume a newer document takes precedence.

### Collections

- `documents`: deterministic `_id`, title, filename, category, version, uploaded time, status, page-numbered extracted text and chunk count.
- `chunks`: `documentId`, `documentTitle`, `version`, `category`, `pageNumber`, `chunkIndex`, `text`, 768-dimensional `embedding`, and `createdAt`.
- `comparisons`: selected document IDs, policy/version labels and creation time (a recent activity log, not a full result archive).


## Deployment on Vercel

Import the repository into Vercel, set the environment variables above in the project settings, and deploy using the default Next.js build. Ensure Atlas network access permits Vercel's outbound connections and the database user has the necessary permissions. The API uses Node.js and requests a 300-second function duration; availability and limits depend on the Vercel plan. Large or slow documents may exceed function or Gemini quotas. Client-side extraction avoids sending binary PDFs, but serverless request body limits still apply.

## Limitations and operational notes

- No credentials are bundled. Atlas and Gemini are external dependencies and incur their own quotas/costs. Health checks verify configuration and database connectivity, not Gemini or index readiness.
- This is a public, unauthenticated demonstration: anyone with access can upload, delete, seed or invoke AI calls. Do not deploy with sensitive documents or an unrestricted production budget. Add authentication, access controls, abuse prevention and rate limiting before production use.
- PDF extraction preserves pages but normalizes whitespace and may not preserve complex layouts, tables or reading order. Image-only and encrypted PDFs are not supported. No original PDF binary is retained.
- Model output is probabilistic. Source IDs are validated, but semantic entailment is not mechanically guaranteed. Always verify citations. Vector retrieval can return irrelevant nearest neighbors; the model's insufficient-evidence behavior is not a formal guarantee.
- Comparison and conflict detection use a bounded set of retrieved chunks, not exhaustive document alignment; missing evidence may result in inconclusive answers or missed changes. Source dates and precedence are reported only if present in passages. Comparison results are not archived, only the activity record.
- Uploading several files uses the same metadata for all files and processes them sequentially; if a later file fails, earlier ones remain indexed. A failed document can be deleted or retried. Embedding work is synchronous and subject to timeout and rate limits.
