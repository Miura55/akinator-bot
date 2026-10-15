'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createHandler } = require('../src/handler');

const SECRET = 'test-secret';
const sign = (body) => crypto.createHmac('sha256', SECRET).update(body).digest('base64');

const lambdaEvent = (payload, { signature } = {}) => {
  const body = JSON.stringify(payload);
  return { headers: { 'x-line-signature': signature ?? sign(body) }, body, isBase64Encoded: false };
};
const textEvent = (text, userId = 'U1') => ({
  type: 'message', replyToken: 'rt', source: { type: 'user', userId }, message: { type: 'text', text },
});
const postbackEvent = (data, userId = 'U1') => ({
  type: 'postback', replyToken: 'rt', source: { type: 'user', userId }, postback: { data },
});

const questionState = (n = 1) => ({ client: { session: 's', step: n }, questionCount: n, phase: 'question', question: `Q${n}` });
const guessState = () => ({
  ...questionState(3),
  phase: 'guess',
  guess: { name: 'ドラえもん', description: 'ネコ型ロボット', pictureUrl: 'https://img.example/d.jpg' },
});

// ゲームエンジンのフェイク。呼ばれたメソッドを記録し、固定のターンを返す。
const fakeGame = (turns = {}) => {
  const calls = [];
  const q = (text) => ({ state: questionState(2), turn: { type: 'question', text } });
  return {
    calls,
    start: async () => { calls.push(['start']); return turns.start || q('Q1'); },
    answer: async (state, answer) => { calls.push(['answer', answer]); return turns.answer || q('Q2'); },
    rejectGuess: async () => { calls.push(['rejectGuess']); return turns.rejectGuess || q('Q3'); },
    confirmGuess: async () => { calls.push(['confirmGuess']); },
  };
};

const setup = ({ saved, turns } = {}) => {
  const db = new Map(saved ? [['U1', saved]] : []);
  const store = {
    get: async (id) => db.get(id) ?? null,
    put: async (id, s) => db.set(id, s),
    delete: async (id) => db.delete(id),
  };
  const replies = [];
  const lineClient = { replyMessage: async (r) => replies.push(r) };
  const game = fakeGame(turns);
  const handler = createHandler({ channelSecret: SECRET, lineClient, store, game, logger: { error: () => {} } });
  return { handler, replies, db, game };
};

test('署名が不正なら 403', async () => {
  const { handler, replies } = setup();
  const res = await handler(lambdaEvent({ events: [textEvent('スタート')] }, { signature: 'bad' }));
  assert.equal(res.statusCode, 403);
  assert.equal(replies.length, 0);
});

test('スタートで新しいゲームを始めて最初の質問を返す', async () => {
  const { handler, replies, db, game } = setup();
  const res = await handler(lambdaEvent({ events: [textEvent('スタート')] }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(game.calls, [['start']]);
  const [intro, question] = replies[0].messages;
  assert.match(intro.text, /質問します/);
  assert.match(question.text, /^Q2\nQ1$/);
  assert.equal(question.quickReply.items.length, 6); // 5 回答 + やめる
  assert.equal(db.get('U1').phase, 'question');
});

test('ゲームがない状態で回答するとスタートを促す', async () => {
  const { handler, replies, game } = setup();
  await handler(lambdaEvent({ events: [postbackEvent('answer=はい')] }));
  assert.match(replies[0].messages[0].text, /スタート/);
  assert.equal(game.calls.length, 0);
});

test('回答ボタンもテキストも Akinator の回答番号に変換してエンジンに渡る', async () => {
  const { handler, game } = setup({ saved: questionState() });
  await handler(lambdaEvent({ events: [postbackEvent('answer=いいえ')] }));
  await handler(lambdaEvent({ events: [textEvent('たぶんそう')] }));
  await handler(lambdaEvent({ events: [textEvent('Yes')] }));
  assert.deepEqual(game.calls, [['answer', 1], ['answer', 3], ['answer', 0]]);
});

test('5 択以外の自由入力は Akinator に送らず、同じ質問を出し直す', async () => {
  const { handler, replies, game, db } = setup({ saved: questionState(4) });
  await handler(lambdaEvent({ events: [textEvent('アニメのキャラです')] }));
  assert.equal(game.calls.length, 0);
  const [hint, question] = replies[0].messages;
  assert.match(hint.text, /はい/);
  assert.match(question.text, /^Q4\nQ4$/);
  assert.equal(question.quickReply.items.length, 6);
  assert.equal(db.get('U1').questionCount, 4);
});

test('推測が返ったら 画像と 正解/違う の quick reply を返す', async () => {
  const turns = { answer: { state: guessState(), turn: { type: 'guess', ...guessState().guess } } };
  const { handler, replies, db } = setup({ saved: questionState(), turns });
  await handler(lambdaEvent({ events: [postbackEvent('answer=はい')] }));
  const [image, m] = replies[0].messages;
  assert.deepEqual(image, { type: 'image', originalContentUrl: 'https://img.example/d.jpg', previewImageUrl: 'https://img.example/d.jpg' });
  assert.match(m.text, /ドラえもん/);
  assert.deepEqual(m.quickReply.items.map((i) => i.action.data), ['guess=yes', 'guess=no', 'quit']);
  assert.equal(db.get('U1').phase, 'guess');
});

test('正解で Akinator に報告し、ゲームが削除される', async () => {
  const { handler, replies, db, game } = setup({ saved: guessState() });
  await handler(lambdaEvent({ events: [postbackEvent('guess=yes')] }));
  assert.deepEqual(game.calls, [['confirmGuess']]);
  assert.match(replies[0].messages[0].text, /正解/);
  assert.equal(db.has('U1'), false);
});

test('正解の報告に失敗してもゲームは終わる', async () => {
  const { handler, replies, db, game } = setup({ saved: guessState() });
  game.confirmGuess = async () => { throw new Error('HTTP error confirming win: 500'); };
  await handler(lambdaEvent({ events: [postbackEvent('guess=yes')] }));
  assert.match(replies[0].messages[0].text, /正解/);
  assert.equal(db.has('U1'), false);
});

test('推測中にテキストで「はい」と答えても正解扱い', async () => {
  const { handler, db } = setup({ saved: guessState() });
  await handler(lambdaEvent({ events: [textEvent('はい')] }));
  assert.equal(db.has('U1'), false);
});

test('違うと答えたら rejectGuess して質問を続ける', async () => {
  const { handler, replies, game } = setup({ saved: guessState() });
  await handler(lambdaEvent({ events: [postbackEvent('guess=no')] }));
  assert.deepEqual(game.calls, [['rejectGuess']]);
  assert.match(replies[0].messages[1].text, /Q3/);
});

test('降参でゲームが削除され、もう一回ボタンが出る', async () => {
  const turns = { answer: { state: { ...questionState(), phase: 'done' }, turn: { type: 'giveup', text: '参りました' } } };
  const { handler, replies, db } = setup({ saved: questionState(), turns });
  await handler(lambdaEvent({ events: [postbackEvent('answer=はい')] }));
  assert.match(replies[0].messages[0].text, /参りました/);
  assert.equal(replies[0].messages[0].quickReply.items[0].action.data, 'start');
  assert.equal(db.has('U1'), false);
});

test('やめるでゲームが削除される', async () => {
  const { handler, db } = setup({ saved: questionState() });
  await handler(lambdaEvent({ events: [textEvent('やめる')] }));
  assert.equal(db.has('U1'), false);
});

test('エンジンがエラーを投げたらゲームを捨ててやり直しを促す', async () => {
  const { handler, replies, db, game } = setup({ saved: questionState() });
  game.answer = async () => { throw new Error('HTTP error answering: 403'); };
  const res = await handler(lambdaEvent({ events: [postbackEvent('answer=はい')] }));
  assert.equal(res.statusCode, 200);
  assert.match(replies[0].messages[0].text, /やり直して/);
  assert.equal(replies[0].messages[0].quickReply.items[0].action.data, 'start');
  assert.equal(db.has('U1'), false);
});
