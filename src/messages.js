'use strict';

const { Answers } = require('akinator-client');

// クイックリプライの表示順。添字は akinator-client の Answers（Yes=0, No=1, IDontKnow=2, Probably=3, ProbablyNot=4）と一致させる
const ANSWER_LABELS = ['はい', 'いいえ', 'わからない', 'たぶんそう', 'たぶん違う'];

// テキストで送られてきた言葉を Akinator の回答番号に対応づける
const ANSWER_INDEX = new Map([
  ['はい', Answers.Yes], ['yes', Answers.Yes], ['y', Answers.Yes], ['うん', Answers.Yes], ['そう', Answers.Yes],
  ['いいえ', Answers.No], ['no', Answers.No], ['n', Answers.No], ['違う', Answers.No], ['ちがう', Answers.No],
  ['わからない', Answers.IDontKnow], ['わかんない', Answers.IDontKnow], ['知らない', Answers.IDontKnow],
  ["don't know", Answers.IDontKnow], ['dont know', Answers.IDontKnow],
  ['たぶんそう', Answers.Probably], ['たぶん', Answers.Probably], ['たぶんはい', Answers.Probably], ['probably', Answers.Probably],
  ['たぶん違う', Answers.ProbablyNot], ['たぶんちがう', Answers.ProbablyNot], ['たぶんいいえ', Answers.ProbablyNot],
  ['probably not', Answers.ProbablyNot],
]);

const toAnswerIndex = (text) => {
  const v = ANSWER_INDEX.get(String(text).trim().toLowerCase());
  return v === undefined ? null : v;
};

const START_WORDS = new Set(['スタート', 'すたーと', 'はじめる', '始める', 'start', 'あきねーたー', 'アキネーター']);
const QUIT_WORDS = new Set(['やめる', '終了', 'おわり', '終わり', 'quit', 'stop', 'リセット', 'reset']);

const postbackItem = (label, data) => ({
  type: 'action',
  action: { type: 'postback', label, data, displayText: label },
});

const questionMessage = (state, text) => ({
  type: 'text',
  text: `Q${state.questionCount}\n${text}`,
  quickReply: {
    items: [...ANSWER_LABELS.map((label) => postbackItem(label, `answer=${label}`)), postbackItem('やめる', 'quit')],
  },
});

const guessMessage = (guess) => ({
  type: 'text',
  text: `あなたが思い浮かべているのは…\n\n${guess.name}\n${guess.description}\n\n合っていますか？`,
  quickReply: {
    items: [postbackItem('正解！', 'guess=yes'), postbackItem('違う', 'guess=no'), postbackItem('やめる', 'quit')],
  },
});

// 推測の画像（https の URL があるときだけ）＋ 推測テキスト
const guessMessages = (guess) => [
  ...(/^https:\/\//.test(guess.pictureUrl || '') ? [imageMessage(guess.pictureUrl)] : []),
  guessMessage(guess),
];

const imageMessage = (url) => ({ type: 'image', originalContentUrl: url, previewImageUrl: url });

const textMessage = (text) => ({ type: 'text', text });

const startPrompt = () => ({
  type: 'text',
  text: '有名人やキャラクターを思い浮かべてください。\n「スタート」で魔人が質問を始めます。',
  quickReply: { items: [postbackItem('スタート', 'start')] },
});

const restartPrompt = (text) => ({
  type: 'text',
  text,
  quickReply: { items: [postbackItem('もう一回', 'start')] },
});

module.exports = {
  START_WORDS,
  QUIT_WORDS,
  toAnswerIndex,
  questionMessage,
  guessMessages,
  textMessage,
  startPrompt,
  restartPrompt,
};
