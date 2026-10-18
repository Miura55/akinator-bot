'use strict';

const { AkinatorClient, Languages, Themes } = require('akinator-client');

// akinator-client 1.3.0 の start() を現在の HTML に合わせる。
// signature は任意、最初の step は 1。質問タグ内の改行も許容する。
// step を 0 で送ると /answer が KO を返すため、この差し替えが必要。

const DEFAULT_LANGUAGE = Languages.Japanese; // 'jp'

const parseChildMode = (v) => v === true || String(v || '').toLowerCase() === 'true';

const patchedStart = async function start() {
  this._url = `https://${this._language}.akinator.com`;
  await this._get(this._url + '/');
  const res = await this._post(this._url + '/game', { sid: this._theme, cm: this._childMode });
  if (res.statusCode !== 200) throw new Error(`HTTP error starting game: ${res.statusCode}`);

  const html = res.body;
  const session = html.match(/name="session" id="session" value="([^"]+)"/);
  if (!session) throw new Error('Failed to extract session from HTML response.');
  const pick = (re, fallback = '') => (html.match(re) || [, fallback])[1];

  this._session = session[1];
  this._signature = pick(/name="signature" id="signature" value="([^"]+)"/);
  this._question = pick(/id="question-label"[^>]*>(.*?)<\/p>/).trim();
  this._identifiant = pick(/localStorage\.setItem\('identifiant', '([^']+)'\);/);
  this._step = Number(pick(/localStorage\.setItem\('step', '(\d+)'\)/, '1'));
  this._progression = Number(pick(/localStorage\.setItem\('progression', '([\d.]+)'\)/, '0'));
  this._akitude = 'defi.png';
  this._stepLastProposition = '';
  this._started = true;
  this._won = false;
  this._ko = false;

  return {
    won: false,
    ko: false,
    akitude: this._akitude,
    step: this._step,
    progression: this._progression,
    question: this._question,
    answers: this.answers,
  };
};

const patch = (client) => {
  client.start = patchedStart;
  return client;
};

// toJSON() が含めないクッキーも保存し、次のリクエストでセッションを復元する。
const serialize = (client) => ({ ...client.toJSON(), cookies: { ...client._cookies } });

const createAkinatorClient = ({ language = DEFAULT_LANGUAGE, childMode = false, theme = Themes.Character } = {}) =>
  patch(new AkinatorClient({ language, childMode: parseChildMode(childMode), theme }));

const restoreAkinatorClient = (data) => {
  const client = AkinatorClient.fromJSON(data);
  client._cookies = { ...(data.cookies || {}) };
  return patch(client);
};

module.exports = {
  createAkinatorClient,
  restoreAkinatorClient,
  serialize,
};
