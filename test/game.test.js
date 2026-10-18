'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Answers } = require('akinator-client');
const { createGame } = require('../src/game');

// akinator-client のフェイク。各メソッドの戻り値をスクリプトで指定する。
const fakeClient = (script, { winResult } = {}) => {
  const calls = [];
  const client = {
    calls,
    winResult: winResult || { name: 'ドラえもん', description: 'ネコ型ロボット', pictureUrl: 'https://img.example/d.jpg' },
    _json: { session: 's', step: 1 },
    toJSON: () => client._json,
  };
  for (const m of ['start', 'answer', 'continue', 'submitWin']) {
    client[m] = async (...args) => {
      calls.push([m, ...args]);
      const next = script.shift();
      if (!next) throw new Error('script exhausted');
      if (next instanceof Error) throw next;
      client._json = { ...client._json, step: next.step ?? client._json.step };
      return next;
    };
  }
  return client;
};

const factoryFor = (client) => {
  const restored = [];
  return {
    restored,
    create: () => client,
    restore: (data) => { restored.push(data); return client; },
    serialize: (c) => ({ ...c.toJSON(), cookies: { a: '1' } }),
  };
};

const question = (step, text) => ({ won: false, ko: false, step, progression: step * 10, question: text, answers: [] });

test('start は最初の質問を question ターンにし、クライアント状態を保存する', async () => {
  const client = fakeClient([question(1, 'Youtuber？')]);
  const game = createGame({ clientFactory: factoryFor(client) });
  const { state, turn } = await game.start();

  assert.deepEqual(turn, { type: 'question', text: 'Youtuber？' });
  assert.equal(state.phase, 'question');
  assert.equal(state.questionCount, 1);
  assert.equal(state.question, 'Youtuber？');
  assert.deepEqual(state.client, { session: 's', step: 1, cookies: { a: '1' } });
  assert.deepEqual(client.calls, [['start']]);
});

test('answer は保存した状態から復元して回答を渡し、次の質問を返す', async () => {
  const client = fakeClient([question(2, '女性?')]);
  const factory = factoryFor(client);
  const game = createGame({ clientFactory: factory });
  const prev = { client: { session: 's', step: 1 }, questionCount: 1, phase: 'question', question: 'Q1' };
  const { state, turn } = await game.answer(prev, Answers.Probably);

  assert.deepEqual(factory.restored, [prev.client]);
  assert.deepEqual(client.calls, [['answer', Answers.Probably]]);
  assert.deepEqual(turn, { type: 'question', text: '女性?' });
  assert.equal(state.questionCount, 2);
  assert.equal(state.client.step, 2);
});

test('推測が返ったら guess ターンになり、phase が guess になる', async () => {
  const client = fakeClient([{ won: true, ko: false, step: 14, progression: 98 }]);
  const game = createGame({ clientFactory: factoryFor(client) });
  const { state, turn } = await game.answer({ client: {}, questionCount: 13, phase: 'question', question: '前の質問' }, Answers.Yes);

  assert.deepEqual(turn, { type: 'guess', name: 'ドラえもん', description: 'ネコ型ロボット', pictureUrl: 'https://img.example/d.jpg' });
  assert.equal(state.phase, 'guess');
  assert.deepEqual(state.guess, { name: 'ドラえもん', description: 'ネコ型ロボット', pictureUrl: 'https://img.example/d.jpg' });
  assert.equal(state.question, undefined);
});

test('rejectGuess は continue() で候補を除外して質問を続ける', async () => {
  const client = fakeClient([question(16, '黄色の生物を連れてる?')]);
  const game = createGame({ clientFactory: factoryFor(client) });
  const prev = { client: {}, questionCount: 14, phase: 'guess', guess: { name: 'X' } };
  const { state, turn } = await game.rejectGuess(prev);

  assert.deepEqual(client.calls, [['continue']]);
  assert.equal(turn.type, 'question');
  assert.equal(state.phase, 'question');
  assert.equal(state.guess, undefined);
});

test('confirmGuess は submitWin() を呼ぶ', async () => {
  const client = fakeClient([{}]);
  const game = createGame({ clientFactory: factoryFor(client) });
  await game.confirmGuess({ client: {}, phase: 'guess' });
  assert.deepEqual(client.calls, [['submitWin']]);
});

test('Akinator が ko を返したら giveup ターンになる', async () => {
  const client = fakeClient([{ won: false, ko: true, step: 80, progression: 0, question: '' }]);
  const game = createGame({ clientFactory: factoryFor(client) });
  const { state, turn } = await game.answer({ client: {}, questionCount: 79, phase: 'question' }, Answers.No);
  assert.equal(turn.type, 'giveup');
  assert.equal(state, undefined);
});

test('クライアントのエラーはそのまま伝わる', async () => {
  const client = fakeClient([new Error('HTTP error starting game: 403')]);
  const game = createGame({ clientFactory: factoryFor(client) });
  await assert.rejects(game.start(), /403/);
});

test('既定ではパッチ済みの akinator-client を日本語で生成する', async () => {
  const { createAkinatorClient, restoreAkinatorClient, serialize } = require('../src/akinator');
  const client = createAkinatorClient({});
  assert.equal(client.language, 'jp');
  assert.deepEqual(client.answers, ['はい', 'いいえ', 'わからない', 'たぶんはい', 'たぶんいいえ']);
  assert.equal(client.start.name, 'start'); // 差し替えた start()

  client._cookies = { SERVERID: 'x' };
  const data = serialize(client);
  assert.deepEqual(data.cookies, { SERVERID: 'x' });
  const restored = restoreAkinatorClient(data);
  assert.deepEqual(restored._cookies, { SERVERID: 'x' });
  assert.equal(restored.language, 'jp');
  assert.equal(restored.start, client.start);
});
