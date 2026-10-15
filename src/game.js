'use strict';

const { createAkinatorClient, restoreAkinatorClient, serialize } = require('./akinator');

// akinator-client（akinator.com の非公式クライアント）を使うゲームエンジン。
//
// Lambda はステートレスなので、クライアントの内部状態（session / step / progression など）を
// シリアライズして DynamoDB に保存し、次のリクエストで復元して続きを進める。
// 状態: { client, questionCount, phase: 'question' | 'guess', question, guess }
// ターン: { type: 'question', text } | { type: 'guess', name, description, pictureUrl } | { type: 'giveup', text }

const createGame = ({ language, childMode, clientFactory } = {}) => {
  const factory = clientFactory || {
    create: () => createAkinatorClient({ language, childMode }),
    restore: (data) => restoreAkinatorClient(data),
    serialize,
  };

  // クライアントの結果から保存する状態と LINE 用のターンを組み立てる
  const toResult = (client, result, prev = {}) => {
    const base = { ...prev, client: factory.serialize(client), questionCount: result.step };
    if (result.won) {
      const w = client.winResult;
      const guess = { name: w.name, description: w.description, pictureUrl: w.pictureUrl || '' };
      return { state: { ...base, phase: 'guess', guess }, turn: { type: 'guess', ...guess } };
    }
    if (result.ko) {
      return { state: { ...base, phase: 'done', guess: undefined }, turn: { type: 'giveup', text: 'これ以上質問が思いつきません…' } };
    }
    const text = String(result.question || '').trim() || 'もう一度「はい」か「いいえ」で答えてください。';
    return { state: { ...base, phase: 'question', question: text, guess: undefined }, turn: { type: 'question', text } };
  };

  return {
    async start() {
      const client = factory.create();
      return toResult(client, await client.start());
    },

    // 質問への回答。answer は akinator-client の Answers（0〜4）
    async answer(state, answer) {
      const client = factory.restore(state.client);
      return toResult(client, await client.answer(answer), state);
    },

    // 推測が外れたとき。候補を除外して質問を続ける
    async rejectGuess(state) {
      const client = factory.restore(state.client);
      return toResult(client, await client.continue(), state);
    },

    // 推測が当たったとき。Akinator に正解を報告する（失敗しても呼び出し側はゲームを終える）
    async confirmGuess(state) {
      const client = factory.restore(state.client);
      await client.submitWin();
    },
  };
};

module.exports = { createGame };
