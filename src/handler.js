'use strict';

const { validateSignature, messagingApi } = require('@line/bot-sdk');
const { createStore } = require('./store');
const { createGame } = require('./game');
const msg = require('./messages');

// 依存を注入できるようにして、テストでは LINE / DynamoDB / Akinator をモックに差し替える。
const createHandler = ({ channelSecret, lineClient, store, game, logger = console }) => {
  // LINE のイベントを内部アクションに正規化する
  const toAction = (event) => {
    if (event.type === 'postback') {
      const data = event.postback.data;
      if (data === 'start') return { type: 'start' };
      if (data === 'quit') return { type: 'quit' };
      if (data === 'guess=yes') return { type: 'guessYes' };
      if (data === 'guess=no') return { type: 'guessNo' };
      const m = /^answer=(.+)$/.exec(data);
      if (m) return { type: 'answer', text: m[1] };
      return { type: 'unknown' };
    }
    if (event.type === 'message' && event.message.type === 'text') {
      const text = event.message.text.trim();
      const lower = text.toLowerCase();
      if (msg.START_WORDS.has(lower)) return { type: 'start' };
      if (msg.QUIT_WORDS.has(lower)) return { type: 'quit' };
      return { type: 'answer', text };
    }
    if (event.type === 'follow') return { type: 'start-prompt' };
    return null;
  };

  const userKey = (event) => {
    const s = event.source || {};
    return s.userId || s.groupId || s.roomId || null;
  };

  // ゲームエンジンの結果を LINE メッセージに変換し、状態を保存する
  const applyTurn = async (userId, { state, turn }) => {
    switch (turn.type) {
      case 'question':
        await store.put(userId, state);
        return [msg.questionMessage(state, turn.text)];
      case 'guess':
        await store.put(userId, state);
        return msg.guessMessages(turn);
      case 'giveup':
        await store.delete(userId);
        return [msg.restartPrompt(`${turn.text}\n\n降参です…。あなたの勝ちです！`)];
      default:
        throw new Error(`unknown turn type: ${turn.type}`);
    }
  };

  const handleAction = async (userId, action) => {
    const state = await store.get(userId);

    switch (action.type) {
      case 'start-prompt':
        return [msg.startPrompt()];

      case 'start': {
        const result = await game.start();
        return [msg.textMessage('思い浮かべましたね？それでは質問します！'), ...(await applyTurn(userId, result))];
      }

      case 'quit':
        if (state) await store.delete(userId);
        return [msg.textMessage('ゲームを終了しました。また遊ぶときは「スタート」と送ってください。')];

      case 'answer': {
        if (!state) return [msg.startPrompt()];
        if (state.phase === 'guess') {
          // 推測の表示中に はい/いいえ で答えてきた場合
          const lower = action.text.toLowerCase();
          if (['はい', 'yes', 'y', '正解', '正解！'].includes(lower)) return handleAction(userId, { type: 'guessYes' });
          if (['いいえ', 'no', 'n', '違う', 'ちがう'].includes(lower)) return handleAction(userId, { type: 'guessNo' });
          return msg.guessMessages(state.guess);
        }
        // Akinator には 5 択しか渡せないので、それ以外の自由入力は同じ質問を出し直す
        const answer = msg.toAnswerIndex(action.text);
        if (answer === null) {
          return [msg.textMessage('ボタンか「はい」「いいえ」「わからない」「たぶんそう」「たぶん違う」で答えてください。'), msg.questionMessage(state, state.question)];
        }
        return applyTurn(userId, await game.answer(state, answer));
      }

      case 'guessYes': {
        if (!state) return [msg.startPrompt()];
        if (state.phase !== 'guess') return [msg.textMessage('まだ推測していません。質問に答えてください。')];
        // Akinator への正解報告は失敗してもゲームは終える
        await game.confirmGuess(state).catch((err) => logger.error('confirmGuess failed', { userId, err }));
        await store.delete(userId);
        return [msg.restartPrompt(`やった！${state.guess.name} で正解ですね！`)];
      }

      case 'guessNo': {
        if (!state) return [msg.startPrompt()];
        if (state.phase !== 'guess') return [msg.textMessage('まだ推測していません。質問に答えてください。')];
        const result = await game.rejectGuess(state);
        return [msg.textMessage('むむ、違いましたか…。質問を続けます。'), ...(await applyTurn(userId, result))];
      }

      default:
        return state ? [msg.textMessage('「はい」「いいえ」などで答えてください。')] : [msg.startPrompt()];
    }
  };

  const handleEvent = async (event) => {
    const action = toAction(event);
    if (!action || !event.replyToken) return;
    const userId = userKey(event);
    if (!userId) return;

    let messages;
    try {
      messages = await handleAction(userId, action);
    } catch (err) {
      logger.error('game error', { userId, action: action.type, err });
      await store.delete(userId).catch(() => {});
      messages = [msg.restartPrompt('エラーが起きました。最初からやり直してください。')];
    }
    await lineClient.replyMessage({ replyToken: event.replyToken, messages: messages.slice(0, 5) });
  };

  // API Gateway (HTTP API, payload v2) / Lambda Function URL のイベントを受ける
  return async (event) => {
    const headers = event.headers || {};
    const signature = headers['x-line-signature'] || headers['X-Line-Signature'];
    const body = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : event.body || '';

    if (!signature || !validateSignature(body, channelSecret, signature)) {
      return { statusCode: 403, body: 'invalid signature' };
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return { statusCode: 400, body: 'invalid body' };
    }

    // LINE へは必ず 200 を返す（失敗すると LINE 側が再送してくる）
    await Promise.all(
      (payload.events || []).map((e) => handleEvent(e).catch((err) => logger.error('event error', { err }))),
    );
    return { statusCode: 200, body: 'ok' };
  };
};

const requireEnv = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`環境変数 ${name} が設定されていません`);
  return v;
};

let handler;
const lambdaHandler = async (event) => {
  if (!handler) {
    handler = createHandler({
      channelSecret: requireEnv('LINE_CHANNEL_SECRET'),
      lineClient: new messagingApi.MessagingApiClient({
        channelAccessToken: requireEnv('LINE_CHANNEL_ACCESS_TOKEN'),
      }),
      store: createStore({ tableName: requireEnv('GAMES_TABLE') }),
      game: createGame({
        language: process.env.AKINATOR_LANGUAGE || undefined,
        childMode: process.env.AKINATOR_CHILD_MODE,
      }),
    });
  }
  return handler(event);
};

module.exports = { handler: lambdaHandler, createHandler };
