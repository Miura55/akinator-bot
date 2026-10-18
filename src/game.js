'use strict';

const { createAkinatorClient, restoreAkinatorClient, serialize } = require('./akinator');

// クライアントを保存・復元してリクエスト間でゲームを継続する。
// 質問中は question、推測中は guess を状態に持たせ、降参時は状態を返さない。

const createGame = ({ language, childMode, clientFactory } = {}) => {
  const factory = clientFactory || {
    create: () => createAkinatorClient({ language, childMode }),
    restore: restoreAkinatorClient,
    serialize,
  };

  // クライアントの結果から保存する状態と LINE 用のターンを組み立てる
  const toResult = (client, result) => {
    if (result.ko) {
      return { turn: { type: 'giveup', text: 'これ以上質問が思いつきません…' } };
    }
    const base = { client: factory.serialize(client), questionCount: result.step };
    if (result.won) {
      const w = client.winResult;
      const guess = { name: w.name, description: w.description, pictureUrl: w.pictureUrl || '' };
      return { state: { ...base, phase: 'guess', guess }, turn: { type: 'guess', ...guess } };
    }
    const text = String(result.question || '').trim() || 'もう一度「はい」か「いいえ」で答えてください。';
    return { state: { ...base, phase: 'question', question: text }, turn: { type: 'question', text } };
  };

  return {
    async start() {
      const client = factory.create();
      return toResult(client, await client.start());
    },

    // 質問への回答。answer は akinator-client の Answers（0〜4）
    async answer(state, answer) {
      const client = factory.restore(state.client);
      return toResult(client, await client.answer(answer));
    },

    // 推測が外れたとき。候補を除外して質問を続ける
    async rejectGuess(state) {
      const client = factory.restore(state.client);
      return toResult(client, await client.continue());
    },

    // 推測が当たったとき。Akinator に正解を報告する（失敗しても呼び出し側はゲームを終える）
    async confirmGuess(state) {
      const client = factory.restore(state.client);
      await client.submitWin();
    },
  };
};

module.exports = { createGame };
