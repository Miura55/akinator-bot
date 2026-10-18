# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Akinator LINE bot: the real akinator.com plays the guesser, reached through the unofficial
`akinator-client` npm package. Runs on AWS Lambda (API Gateway HTTP API + DynamoDB), deployed with AWS SAM.
Plain CommonJS Node.js, no build step, no TypeScript, no linter. Tests use the built-in `node:test` runner.
Lambda runtime is `nodejs24.x`; use Node.js 24 or later for local development and tests.

History: the project started on `aki-api` (blocked by Cloudflare), then used Bedrock models (Claude on
Bedrock was unavailable for this account; Amazon Nova Pro via the Converse API worked but guessed poorly).
On 2026-10-15 the engine moved to `akinator-client` 1.3.0, which passes Cloudflare via `got-scraping`.

## Commands

```bash
npm install
npm test                                  # node --test test/
node --test test/game.test.js             # one file
node --test test/ --test-name-pattern "署名"   # by test name
sam validate --lint
npm run build                             # sam build
npm run logs                              # sam logs --tail for WebhookFunction
```

### Deploy

```bash
sam build
sam deploy --guided --parameter-overrides \
  LineChannelSecret=<channel secret> \
  LineChannelAccessToken=<channel access token>
```

Stack name is `akinator-line-bot` (samconfig.toml), so later deploys are just `npm run deploy`. On an
existing stack, parameters left out of `--parameter-overrides` keep their previous value (SAM uses
`UsePreviousValue`), not the template default. Parameters are `AkinatorLanguage` (default `jp`) and
`AkinatorChildMode` (default `false`). After deploy, set the `WebhookUrl` stack output as the Webhook URL in
the LINE Developers console. End-to-end verification only happens against the real akinator.com (after
deploying, or locally via `createGame()` from `src/game.js`): the unit tests inject fakes for LINE,
DynamoDB, and akinator-client. The user's corporate network (Cato proxy) blocks akinator.com with a 403
"Games" category page, so local runs need another network.

## How the bot plays

User sends 「スタート」(or taps the quick-reply button) → bot starts an Akinator game and relays the first
question → user answers with one of 5 quick-reply buttons (はい / いいえ / わからない / たぶんそう /
たぶん違う) or by typing those words (`messages.toAnswerIndex` maps them to `Answers` 0–4); any other free
text is not sent to Akinator, the bot re-asks the same question → when Akinator guesses, bot shows the
picture + name + description and asks 正解！/ 違う → 正解 calls `submitWin()` and ends the game (state
deleted), 違う calls `continue()` and resumes questions → Akinator's `KO` ends the game as a give-up with a
retry button. 「やめる」 ends the game. Word tables live in `src/messages.js`.

## Architecture

- `src/handler.js` — Lambda entrypoint. `createHandler({channelSecret, lineClient, store, game})` builds the
  handler with injectable deps; the exported `handler` wires the real ones lazily from env vars
  (`LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `GAMES_TABLE`, `AKINATOR_LANGUAGE`,
  `AKINATOR_CHILD_MODE`). Flow per request: verify `x-line-signature` (403 on failure) → normalize each LINE
  event into an action (`start`, `answer`, `quit`, `guessYes`, `guessNo`) → load state → call the game
  engine → `applyTurn` saves/deletes state and builds LINE messages → `replyMessage`. Always returns 200 to
  LINE once the signature is valid; per-event errors are logged, the user's game is deleted, and a retry
  prompt is replied. `confirmGuess` failures are logged but still end the game.
- `src/game.js` — game engine over akinator-client. State is `{client, questionCount, phase, question,
  guess}` where `client` is the serialized akinator-client (its `toJSON()` plus cookies). Engine methods:
  `start()`, `answer(state, answerIndex)`, `rejectGuess(state)` (→ `continue()`), `confirmGuess(state)`
  (→ `submitWin()`); all but the last return `{state, turn}` with turn `question | guess | giveup`.
  `questionCount` is Akinator's `step` (1-based; it can skip numbers after `continue()`). A
  `clientFactory` `{create, restore, serialize}` is injectable for tests.
- `src/akinator.js` — creates/restores the akinator-client and patches its `start()` on the instance.
  akinator-client 1.3.0 is out of date with akinator.com in three ways: the `signature` hidden input no
  longer exists (only `session` is sent), the first question is `step` 1 not 0 (sending 0 to `/answer`
  returns `{"completion":"KO"}`), and the `<p id="question-label">` tag contains a newline. `toJSON()`
  omits cookies, so `serialize()` adds them. Check for a newer package version before touching this.
- `src/store.js` — DynamoDB document store keyed by LINE `userId` (falls back to group/room ID), 1-hour TTL.
  The DynamoDB `@aws-sdk/*` packages are devDependencies on purpose (the Lambda runtime bundles SDK v3);
  `akinator-client` (and its `got-scraping` dependency, loaded via dynamic `import()`) is a regular dependency.
- `src/messages.js` — LINE message builders and the Japanese word tables. Quick-reply postbacks are
  `answer=<label>`, `quit`, `start`, `guess=yes|no`. `ANSWER_LABELS` order must match akinator-client's
  `Answers` enum (Yes, No, IDontKnow, Probably, ProbablyNot). Guesses include an image message when
  `pictureUrl` is https.
- `template.yaml` — `WebhookFunction` (arm64, 29s timeout, 512MB) on `POST /webhook`, `GamesTable` with TTL,
  parameters `AkinatorLanguage` / `AkinatorChildMode`. Secrets are `NoEcho`. No Bedrock IAM anymore.
