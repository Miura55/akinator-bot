# akinator-bot

AWS Lambda 上で動く、アキネーターの LINE bot です。思い浮かべた有名人やキャラクターを、本家 [akinator.com](https://jp.akinator.com/) が質問を重ねて当てます。akinator.com とのやり取りには非公式クライアントの [akinator-client](https://www.npmjs.com/package/akinator-client) を使います。

## 構成

- **AWS Lambda** (Node.js 20, arm64): LINE の Webhook を受けて akinator.com と会話します
- **akinator-client**: akinator.com の非公式クライアント。Cloudflare の確認ページを `got-scraping` で通過します
- **API Gateway (HTTP API)**: `POST /webhook` を Lambda に渡します
- **DynamoDB**: LINE ユーザーごとのゲーム状態（Akinator のセッション）を保存します（TTL 1 時間）
- **AWS SAM**: 上記をまとめてデプロイします
- [@line/bot-sdk](https://www.npmjs.com/package/@line/bot-sdk): LINE Messaging API クライアント

```
LINE ユーザー ──► LINE Platform ──► API Gateway ──► Lambda ──► akinator.com
                                                     │
                                                     └──► DynamoDB（ゲーム状態）
```

Lambda はリクエスト間で状態を持てないため、akinator-client の内部状態（`session` / `step` / `progression` / クッキーなど）をシリアライズして DynamoDB に保存し、次のメッセージで復元して続きを進めます。

### akinator-client へのパッチ

akinator-client 1.3.0 の `start()` は現在の akinator.com と 3 点ずれているため、`src/akinator.js` でインスタンスの `start()` だけ差し替えています（`answer` / `continue` / `submitWin` はそのまま）。

1. `<input name="signature">` が廃止された（ページ自身も `session` しか送らない）
2. 最初の質問の `step` が 0 ではなく 1。`step: 0` で `/answer` を叩くと `{"completion":"KO"}` が返る
3. 質問文の `<p>` タグ内に改行が入る

また `toJSON()` にクッキーが含まれないので、保存時に足しています。

## 遊び方

1. bot に「スタート」と送る（またはボタンをタップ）
2. 質問に対してクイックリプライの 5 択で答える
   - はい / いいえ / わからない / たぶんそう / たぶん違う
   - 同じ言葉（`yes` / `no` / `たぶん` など）をテキストで送っても答えられます。それ以外の自由入力は Akinator に渡せないので、同じ質問を出し直します
3. Akinator が推測すると画像と名前・説明が送られてくるので「正解！」か「違う」を選ぶ
   - 正解なら Akinator に報告してゲーム終了、違うならその候補を除外して質問が続きます
4. 「やめる」でゲーム終了

## 必要なもの

- Node.js 20 以上
- [AWS CLI](https://docs.aws.amazon.com/cli/) と認証情報
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-cli-install.html)
- LINE Developers で作成した Messaging API チャネル
  - チャネルシークレット
  - チャネルアクセストークン（長期）

## セットアップ

```bash
npm install
npm test
```

## デプロイ

初回は `--guided` でリージョンなどを対話的に設定します。

```bash
sam build
sam deploy --guided --parameter-overrides \
  LineChannelSecret=<チャネルシークレット> \
  LineChannelAccessToken=<チャネルアクセストークン>
```

デプロイが終わると `WebhookUrl` が出力されます。これを LINE Developers コンソールの
「Messaging API 設定 > Webhook URL」に設定し、「Webhook の利用」をオンにしてください。
あわせて「応答メッセージ」はオフにしておくと、bot の返信だけが届きます。

2 回目以降はスタック名が `samconfig.toml` に保存されているので、次で済みます。

```bash
npm run build
npm run deploy
```

ログを追うには次を使います。

```bash
npm run logs
```

### パラメータ

| パラメータ | 既定値 | 説明 |
| --- | --- | --- |
| `LineChannelSecret` | なし（必須） | LINE チャネルシークレット |
| `LineChannelAccessToken` | なし（必須） | LINE チャネルアクセストークン |
| `AkinatorLanguage` | `jp` | Akinator の言語コード（`jp` / `en` など） |
| `AkinatorChildMode` | `false` | チャイルドモード（露骨な内容を避ける） |

**注意**: 既存スタックへの `sam deploy` では、`--parameter-overrides` に含めなかったパラメータはテンプレートの既定値ではなく「前回デプロイ時の値」が引き継がれます。以前 Bedrock 版をデプロイしたスタックには `BedrockModelId` などが残っていますが、テンプレートから消えたパラメータは次回デプロイで無視されます。現在の値は次で確認できます。

```bash
aws cloudformation describe-stacks --stack-name akinator-line-bot \
  --query "Stacks[0].Parameters[?!starts_with(ParameterKey,'Line')]" --output table
```

## 開発

```bash
npm test                                  # 全テスト
node --test test/game.test.js             # ファイル単位
node --test --test-name-pattern "署名" test/*.test.js   # テスト名で絞り込み
sam validate --lint                       # テンプレートの検証
```

テストは LINE クライアント、DynamoDB、akinator-client をすべてフェイクに差し替えて動くので、ネットワークも AWS 認証情報も不要です。

本物の akinator.com に対する確認はデプロイ後に行うか、ローカルで `src/game.js` の `createGame()` を直接呼んで行います。社内ネットワークなど akinator.com（カテゴリ「Games」）を遮断する環境では 403 になるので、別の回線を使ってください。

### ディレクトリ

```
src/
  handler.js    Lambda エントリポイント。署名検証、イベント処理、返信
  game.js       akinator-client を使うゲームエンジン（状態の保存・復元、ターンの組み立て）
  akinator.js   akinator-client の生成とパッチ（start() の差し替え、クッキーの保存）
  store.js      DynamoDB ストア（userId キー、TTL 付き）
  messages.js   LINE メッセージの組み立てと回答語のテーブル
test/
  game.test.js
  handler.test.js
template.yaml   SAM テンプレート
samconfig.toml  SAM の既定設定（スタック名など）
```

### 注意

- akinator.com への各リクエストは 0.3〜1.5 秒程度です。Lambda のタイムアウトは 29 秒で、akinator-client は失敗時に最大 3 回リトライします。
- Akinator が `{"completion":"KO"}` を返した場合（質問が尽きた、またはセッションが無効）は「降参」として扱い、ゲームを終了します。
- `@aws-sdk/client-dynamodb` と `@aws-sdk/lib-dynamodb` は Lambda の Node.js 20 ランタイムに同梱されているため devDependencies にしています。
- 以前は Amazon Bedrock（Converse API + Amazon Nova Pro）をアキネーター役にしていました。本家 Akinator のほうが精度が高いため置き換えています。
