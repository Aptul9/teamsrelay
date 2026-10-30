# Message knowledge base test: plan

Planned 2026-10-30. Not built.

## Goal

Measure whether a searchable knowledge base built from Teams messages answers work questions with correct citations to the original messages. The test runs in parallel to teamsrelay: it reads a copy of slot data, writes its own files under `kb/`, and changes nothing in `app/`, the agent, the web app or the deploy.

## Scope

- In: one-off ingest of a `messages.db` copy per company, LLM chunking with noise discard, hybrid search, answers with message citations, evaluation.
- Out: continuous ingest, edits and deletes after ingest, history older than what `messages.db` holds, UI, MCP tool. Each one is considered only after the evaluation passes (section Next).

## Decisions

| Topic | Decision | Reason |
|---|---|---|
| Location | `kb/` at repo root, own `package.json` | `app/` dependencies, CI `Check` and the Docker build stay untouched |
| Language | TypeScript on Node, run as `node src/<file>.ts` (type stripping, Node 26 locally), tests with vitest | same language and test tool as `app/` |
| Source | copy of `data/<slot>/messages.db` per account | no agent change; holds the last 40 messages per chat (`saveChatMessages` in `app/src/agent/store/slot-store.ts`) |
| Message text | stored as written, never rewritten | the LLM cannot introduce wrong facts into the record |
| Chunking | LLM chooses topic boundaries, discards social noise, writes an English title and one English context line per chunk | boundaries follow topics, not fixed windows |
| Discard | only social noise: greetings, birthday and holiday wishes, thanks, emoji-only, bare "ok" | work topics unrelated to tracked projects stay as chunks with no project label |
| Identifiers | extracted by regex before the LLM call, own table, never discardable | ticket numbers and hostnames survive chunking and match exactly |
| Company separation | one KB file per company | a question about one company cannot retrieve another company's messages |
| Search | FTS5 `bm25()` plus vectors (sqlite-vec), merged with Reciprocal Rank Fusion | exact tokens and meaning both count |
| Languages | multilingual embeddings; title and context line always English; BM25 runs on the question as asked and on its English version | an Italian question finds an English chat and the reverse |
| Models | chunking `claude-haiku-5-5`, comparison run `claude-sonnet-5-5`, answers `claude-sonnet-5-5`, judge `claude-opus-5-5` | Haiku first; Sonnet replaces it for chunking only if the judge scores it clearly better |

## Global constraints

- Nothing under `kb/data/` is committed. The root `.gitignore` entry `data/` already matches `kb/data/`. Snapshots, KB files, company config and eval questions hold client content and live there.
- A company is ingested only when `enabled` in `kb/data/companies.json`: its messages are sent to the Anthropic API.
- `app/` is not modified. A merge that touches only `kb/` carries `[skip ci]` in the merge commit subject, since every push to `main` runs the production deploy.
- Every prompt stays under 100K tokens: above that, Haiku 5.5 pricing rises from $0.10 / $0.50 to $0.50 / $2.50 per MTok.
- Chunk cap 1000 tokens (title, context line and message lines together), counted with the embedding model's tokenizer. No minimum size.
- LLM calls return structured output (`output_config.format` with a JSON schema). No forced `tool_choice`: it returns 400 on Sonnet 5.5 and Opus 5.5.

## Source data

`data/<slot>/messages.db`, schema in `app/src/shared/slot-db/schema.ts`. Fields used:

- `chat_messages(chat, idx, mid, author, text, mine, reacts, extra)`. `extra` is JSON shaped as `MessageExtra` in `app/src/shared/slot-db/rows.ts`: `quote` (`author`, `text`), `images`, `files` (`name`, `url`).
- `chats(name, kind)`. `kind` is `one`, `group`, `meeting` or empty.
- `state` row `me`: JSON `Identity` (`app/src/shared/slot-db/state.ts`) with `name`, `email`, `tenant`. Used to confirm which company a snapshot belongs to.
- `mid`: Teams message id, milliseconds since epoch. Ids shaped `x<digits>` (`HAS_TEAMS_ID` in `rows.ts`) come from page reads and carry no time.
- `author` is empty when `mine` is 1: the reader fills in `Identity.name`.

Slot numbers changed with the server rebuild in October 2026. The slot for each company is read from live state (`me.tenant`), never from old notes.

### Snapshot

The database runs in WAL mode, so a plain copy of the file can miss recent writes. The copy uses SQLite's online backup from inside the web app container, which mounts the host's `/opt/teamsrelay/data` at `/data`. `PROD` is the ssh destination of the production server.

```bash
ssh "$PROD" docker exec -i teams-webapp node - <<'EOF'
require("better-sqlite3")("/data/1/messages.db", { readonly: true }).backup("/data/kb-snap-1.db").then(() => console.log("ok"));
EOF
scp "$PROD:/opt/teamsrelay/data/kb-snap-1.db" kb/data/snap/1.db
ssh "$PROD" rm /opt/teamsrelay/data/kb-snap-1.db
```

Expected output of the first command: `ok`. On `Cannot find module 'better-sqlite3'`, add `-w <dir>` to `docker exec` with the directory that holds the web app's `node_modules`.

## Target layout

```
kb/
  PLAN.md
  package.json
  companies.example.json   template for kb/data/companies.json
  src/
    source.ts              reads a snapshot: identity, chats, messages
    ids.ts                 identifier regex
    embed.ts               embedding model and tokenizer
    store.ts               KB schema, inserts, searches, rank fusion
    chunk.ts               chunking call: prompt and response schema
    check.ts               coverage, identifier and size checks
    ingest.ts              CLI: snapshot to KB file
    ask.ts                 CLI: question to answer with citations
    eval.ts                CLI: eval questions, judge, discard sample
  test/                    vitest, fixtures built in memory
  data/                    not committed
    companies.json
    snap/<slot>.db
    kb-<company>-<model>.db
    failed.json
    eval/questions-<company>.json
    eval/<date>-<company>-<model>.json
```

Imports between `src/` files carry the `.ts` extension, as Node type stripping requires.

## KB schema

One file per company and chunking model, `kb/data/kb-<company>-<model>.db`, so the Haiku and Sonnet runs sit side by side.

```sql
CREATE TABLE messages(mid TEXT PRIMARY KEY, chat TEXT, ts INTEGER, author TEXT, text TEXT, quote TEXT, files TEXT);
CREATE TABLE chunks(id INTEGER PRIMARY KEY, chat TEXT, part INTEGER, title TEXT, context TEXT, projects TEXT, people TEXT, t_start INTEGER, t_end INTEGER, body TEXT);
CREATE TABLE chunk_messages(chunk INTEGER, mid TEXT, PRIMARY KEY(chunk, mid));
CREATE TABLE discarded(mid TEXT PRIMARY KEY, reason TEXT);
CREATE TABLE ids(id TEXT, mid TEXT, PRIMARY KEY(id, mid));
CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);
CREATE VIRTUAL TABLE chunks_fts USING fts5(title, context, body, tokenize='unicode61');
CREATE VIRTUAL TABLE chunks_vec USING vec0(embedding float[1024]);
```

- `chunks_fts` and `chunks_vec` rows use the chunk `id` as rowid.
- `body`: one line per message, `YYYY-MM-DD HH:MM <author>: <text>`, file names appended as `[file: <name>]`. Quoted text is stored in `messages.quote` and left out of `body`, so a quote is not indexed twice.
- `projects`, `people`, `files`: JSON arrays.
- `t_start`, `t_end`: from the chunk's Teams ids; null when every message has an `x` id.
- `meta`: company, snapshot path, chunking model, embedding model, ingest time.
- `unicode61` keeps `RITM0123456` as one token and splits `CSA-2285` into `csa` and `2285`. Phrase queries match both; the `ids` table covers exact lookups.

## Identifiers

`kb/src/ids.ts`:

```ts
export const ID_PATTERNS = [
  /\b(?:RITM|INC|CHG|REQ|SCTASK|PRB|TASK)\d{7}\b/g, // ServiceNow
  /\b[A-Z][A-Z0-9]+-\d+\b/g, // Jira keys
  /\bhttps?:\/\/\S+/g, // URLs
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, // IPv4
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+){2,}\b/gi, // hostnames with three or more labels
];

export function findIds(text: string): string[] {
  return [...new Set(ID_PATTERNS.flatMap((p) => text.match(p) ?? []))];
}
```

The Jira pattern also matches strings such as `UTF-8`. A false match only keeps a message out of the discard list and adds a row to `ids`.

## Chunking call

One call per chat. A snapshot chat holds at most 40 messages, about 1-2K tokens, so no chat is split across calls.

Input:

- Message lines `<mid> | <YYYY-MM-DD HH:MM> | <author> | <text>`.
- The identifiers found in the chat (section Identifiers).
- The company's project list from `kb/data/companies.json`: slug and one line each.

Rules given to the model:

- Group messages by topic. A message may belong to more than one chunk.
- Discard only social noise: greetings, birthday and holiday wishes, thanks, emoji-only messages, a bare "ok" that refers to nothing. Work topics unrelated to the listed projects stay as chunks with an empty `projects` list.
- A message that contains a listed identifier is never discarded.
- Do not rewrite messages. Output only mids, titles, context lines and labels.
- Title and context line in English, whatever the chat language. The context line names the company, the system or ticket and the subject.

Response schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["chunks", "discarded"],
  "properties": {
    "chunks": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["title", "context", "projects", "mids"],
        "properties": {
          "title": { "type": "string" },
          "context": { "type": "string" },
          "projects": { "type": "array", "items": { "type": "string" } },
          "mids": { "type": "array", "items": { "type": "string" } }
        }
      }
    },
    "discarded": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["mid", "reason"],
        "properties": {
          "mid": { "type": "string" },
          "reason": { "type": "string", "enum": ["noise"] }
        }
      }
    }
  }
}
```

Checks in code after every call (`check.ts`):

1. Every input mid sits in at least one chunk or in `discarded`.
2. No output mid is missing from the input.
3. No discarded message contains an identifier.
4. No project slug outside the company's list.
5. A chunk over the cap is split by code into consecutive parts with the same title, `part` numbered from 1.

A failed check retries the call once with the list of errors appended. A second failure writes the chat and its errors to `kb/data/failed.json`, and the ingest moves on.

The full pass runs through the Message Batches API (half price, results keyed by `custom_id` = `<company>:<chat index>`). Development runs use direct calls on a few chats.

## Embeddings

- Model `BAAI/bge-m3` (1024 dimensions, 8192-token input) through `@huggingface/transformers`, ONNX on CPU.
- Text embedded per chunk: title, context line and body, separated by newlines.
- Fallback when `bge-m3` does not load in transformers.js: `intfloat/multilingual-e5-large` (1024 dimensions, 512-token input, prefixes `query: ` and `passage: `). The chunk cap then drops to 450 tokens.

## Search and answer

`node src/ask.ts --company <slug> [--model <chunking model>] [--project <slug>] "<question>"`

1. English version of the question: one Haiku call. Skipped when the question is already English.
2. Identifier lookup: identifiers in the question (same regex), chunks through `ids` and `chunk_messages`. These rank first.
3. BM25: FTS5 on the original question and on the English version, top 20 each, ordered by `bm25(chunks_fts)`. Each term is wrapped in double quotes and joined with `OR`, so FTS5 syntax characters in a question cannot break the query.
4. Vectors: embedding of the original question, top 20 from `chunks_vec`.
5. Fusion: each chunk scores `1 / (60 + rank)` in each list it appears in, summed. Top 8 chunks.
6. `--project` filters chunks whose `projects` contain the slug, before fusion.
7. Answer: `claude-sonnet-5-5` with the 8 chunks. Reply in the language of the question, cite `[mid]` after each claim, say plainly when the chunks do not contain the answer.
8. Citation check in code: every cited mid belongs to a retrieved chunk. The output lists each citation with chat, time, author and the message text.

## Evaluation

`node src/eval.ts --company <slug> --model <chunking model>`

- Questions: `kb/data/eval/questions-<company>.json`, 20 per company with known answers, taken from the vault project logs. Shape `{ "q": "...", "lang": "it", "expect_chats": ["..."], "expect_answer": "..." }`. At least 5 of the 20 are asked in a language different from the chat's.
- Retrieval: hit@5, an expected chat among the top 5 chunks.
- Answers: judge `claude-opus-5-5` compares each answer with `expect_answer`: correct, partial or wrong.
- Discard misses: judge reads 100 random discarded messages with two neighbours each and marks whether any carries work content.
- Model comparison: the same chats chunked by Haiku and Sonnet. The judge sees both chunkings of each chat without the model names and picks the better one. Both KBs also run the questions.
- Each run writes `kb/data/eval/<date>-<company>-<model>.json` with every answer, citation and verdict.

Initial pass bar, per company:

| Metric | Bar |
|---|---|
| hit@5 | at least 80 % |
| correct answers | at least 70 %, wrong at most 10 % |
| discard misses | at most 2 of 100 |
| cross-language hit@5 | within 10 points of same-language |

## Tasks

### Task 1: package and embeddings

Files: `kb/package.json`, `kb/src/embed.ts`, `kb/test/embed.test.ts`

Interface:

```ts
export async function embed(texts: string[], kind: "query" | "passage"): Promise<Float32Array[]>;
export async function countTokens(text: string): Promise<number>;
export const DIMENSIONS = 1024;
```

- [ ] `kb/package.json`: `"type": "module"`, dependencies `better-sqlite3` `13.0.3` (same as `app/`), `sqlite-vec`, `@anthropic-ai/sdk`, `@huggingface/transformers`; dev dependency `vitest` `5.0.2`. `npm install` in `kb/`.
- [ ] Test: vectors have length 1024; cosine("certificato scaduto", "certificate expired") is greater than cosine("certificato scaduto", "pizza recipe"); `countTokens` of a 40-message chat is under 8192.
- [ ] `npx vitest run test/embed.test.ts` in `kb/` fails before `embed.ts` exists, passes after.
- [ ] `bge-m3` fails to load: switch to the fallback model (section Embeddings) and set the chunk cap to 450.
- [ ] Commit `feat(kb): multilingual embedding wrapper`.

### Task 2: snapshot reader and identifiers

Files: `kb/src/source.ts`, `kb/src/ids.ts`, `kb/test/source.test.ts`, `kb/test/ids.test.ts`

Interface:

```ts
export type SourceMessage = { mid: string; chat: string; ts: number | null; author: string; text: string; quote: string; files: string[] };
export type Snapshot = { me: { name: string; email: string; tenant: string }; chats: { name: string; kind: string }[]; messages: SourceMessage[] };
export function readSnapshot(path: string): Snapshot;
export function findIds(text: string): string[];
```

- [ ] Fixture: an in-memory database with the `chat_messages`, `chats` and `state` tables from `app/src/shared/slot-db/schema.ts`, rows covering a `mine` message, an `x` id, an `extra` with `quote` and `files`, and a `me` state row.
- [ ] Tests: `mine` author becomes `me.name`; `ts` equals `Number(mid)` for Teams ids and is null for `x` ids; quote text lands in `quote`, not in `text`; file names land in `files`; messages come out in `idx` order per chat.
- [ ] Tests for `findIds`: `"RITM0123456 done"` gives `["RITM0123456"]`; `"see CSA-2285"` gives `["CSA-2285"]`; `"CHG0107933 on cert2.i3otgem.example.com"` gives both; `"buongiorno"` gives `[]`.
- [ ] Tests fail first, pass after the implementation.
- [ ] Commit `feat(kb): snapshot reader and identifier extraction`.

### Task 3: KB store and search

Files: `kb/src/store.ts`, `kb/test/store.test.ts`

Interface:

```ts
export type KbChunk = { chat: string; part: number; title: string; context: string; projects: string[]; people: string[]; tStart: number | null; tEnd: number | null; body: string };
export function openKb(path: string): Database.Database; // creates the schema, loads sqlite-vec
export function saveMessages(db: Database.Database, messages: SourceMessage[]): void;
export function saveChunk(db: Database.Database, chunk: KbChunk, mids: string[], vector: Float32Array): number;
export function saveDiscarded(db: Database.Database, rows: { mid: string; reason: string }[]): void;
export function saveIds(db: Database.Database, rows: { id: string; mid: string }[]): void;
export function ftsQuery(text: string): string;
export function searchBm25(db: Database.Database, text: string, k: number): number[];
export function searchVec(db: Database.Database, vector: Float32Array, k: number): number[];
export function searchIds(db: Database.Database, ids: string[]): number[];
export function rrf(lists: number[][], k?: number): number[];
```

- [ ] Tests: `rrf([[1, 2, 3], [3, 1]])` returns `[1, 3, 2]`; `searchBm25` finds the chunk whose body holds `RITM0123456`; `searchVec` returns the stored vector nearest to the query first; `ftsQuery("what's \"x\" AND (y")` produces a query FTS5 accepts; `searchIds` returns the chunk linked through `chunk_messages`.
- [ ] Tests fail first, pass after the implementation.
- [ ] Commit `feat(kb): sqlite store with bm25, vector and id search`.

### Task 4: chunking call and checks

Files: `kb/src/chunk.ts`, `kb/src/check.ts`, `kb/test/check.test.ts`

Interface:

```ts
export type Company = { slug: string; slot: number; tenant: string; enabled: boolean; projects: { slug: string; about: string }[] };
export type ChunkPlan = { chunks: { title: string; context: string; projects: string[]; mids: string[] }[]; discarded: { mid: string; reason: "noise" }[] };
export async function planChat(chat: string, messages: SourceMessage[], company: Company, model: string, errors?: string[]): Promise<ChunkPlan>;
export function checkPlan(plan: ChunkPlan, messages: SourceMessage[], company: Company): string[]; // empty when valid
export async function splitByCap(chunk: KbChunk, cap: number): Promise<KbChunk[]>;
```

- [ ] Tests for `checkPlan`: a mid in no chunk and not discarded gives an error; an unknown mid gives an error; a discarded message containing `RITM0123456` gives an error; an unknown project slug gives an error; a valid plan gives `[]`.
- [ ] Test for `splitByCap`: a body over the cap returns parts with the same title, `part` 1 and 2, every message line kept once.
- [ ] `planChat` sends the prompt and schema from section Chunking call. Live run on 5 chats of one snapshot prints the plans; read them by hand for boundaries and discards.
- [ ] Commit `feat(kb): llm chunking with coverage checks`.

### Task 5: ingest

Files: `kb/src/ingest.ts`, `kb/companies.example.json`

`node src/ingest.ts --company <slug> [--model claude-haiku-5-5] [--batch]`

- [ ] `companies.example.json` holds one sample company with `slot`, `tenant`, `enabled: false` and two sample projects. The real file is `kb/data/companies.json`.
- [ ] Ingest refuses a company that is not `enabled`, and a snapshot whose `me.tenant` differs from the configured `tenant`.
- [ ] Flow per chat: identifiers, `planChat`, `checkPlan`, one retry, `splitByCap`, `embed`, save. Messages, discards and identifiers are saved for every chat, including failed ones.
- [ ] Output at the end: counts of messages, chunks, discarded, identifiers, failed chats, and coverage (mids in a chunk or discarded, over all mids) at 100 % for chats that did not fail.
- [ ] `--batch` submits all chats as one Message Batch, waits for it to end, then runs the same checks; chats that fail checks get one direct retry.
- [ ] Commit `feat(kb): ingest cli`.

### Task 6: ask

Files: `kb/src/ask.ts`, `kb/test/ask.test.ts`

- [ ] Flow as section Search and answer.
- [ ] Test: the citation check flags a cited mid that is not in the retrieved chunks and passes one that is.
- [ ] Live run: three questions on one company, one with a ticket number, one in Italian about an English chat. Answers cite real messages.
- [ ] Commit `feat(kb): question answering with message citations`.

### Task 7: evaluation

Files: `kb/src/eval.ts`

- [ ] Flow as section Evaluation, writing the result file.
- [ ] Question file for the first company written from the vault logs.
- [ ] Runs for Haiku and Sonnet chunking on the same snapshot; metrics compared with the pass bar.
- [ ] Commit `feat(kb): evaluation runner`.

## Done

- Evaluation results for at least one company with both chunking models, read against the pass bar.
- The outcome and the chosen chunking model recorded in the vault project note.

## Next, only after the evaluation passes

- History older than 40 messages per chat: chatsvc paging through the response's `_metadata.backwardLink`, not used in the code yet and not verified live. The account behind Defender for Cloud Apps (`*.mcas.ms`) gets chatsvc 401 and can only be read from the page.
- Conversation id as chat key in place of the chat name.
- Continuous ingest from the agent, with edits and deletes as upserts.
- `search_messages` tool on the existing `/mcp` server, so an MCP client runs the search and answer loop itself.
