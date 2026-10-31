# Nyanco Language Server

Node.js 20以降で動作する、外部依存なしのstdio Language Serverです。

```sh
node /absolute/path/to/haskstack/cli.mjs --lsp
# または
node /absolute/path/to/haskstack/lsp.mjs
```

LSPクライアントから上記コマンドを子プロセスとして起動してください。標準入力・標準出力はContent-Length付きJSON-RPC専用です。手動起動すると入力待ちになります。

## 対応機能

- ファイルを開いたとき・変更したときの構文エラー、型エラー、W001などの警告。閉じると診断を消去します。
- トップレベル関数の推論型と、組み込み関数の型をホバー表示。
- 関数、組み込み語、コンストラクター、クラスメソッド、effect操作、キーワードの補完候補。
- 同じ文書のトップレベル関数への定義ジャンプ。
- トップレベル関数のドキュメントシンボル（アウトライン）。

`.nyan`を言語ID `nyanco` に関連付けてください。位置指定はUTF-16、変更通知はincremental sync（全体置換も受理）です。ファイルシステムから読み直さず、エディター内の未保存のテキストを解析します。初期化コード・IO・ユーザー関数は実行しません。

各文書を独立したプログラムとして解析します。現在のコンパイラーは最初のエラーで停止するため、エラー診断は一度に1件です。構文解析に成功すれば、型エラーがある間も関数名の補完や定義ジャンプを提供します。

ローカル変数の型表示・定義ジャンプ、文書をまたぐ参照、rename、formatting、semantic tokensはまだ提供していません。ローカル名に対して同名のトップレベル関数の情報を表示しないよう、保守的に結果を省略します。大きな文書も現時点では変更のたびに全体を型検査します。

## Neovim 0.11以降の設定例

`init.lua`に追加し、パスを実際の配置場所に変更します。

```lua
vim.filetype.add({ extension = { nyan = 'nyanco' } })
vim.lsp.config('nyanco', {
  cmd = { 'node', 'C:/path/to/haskstack/lsp.mjs' },
  filetypes = { 'nyanco' },
})
vim.lsp.enable('nyanco')
```

設定APIは[NeovimのLSPドキュメント](https://neovim.io/doc/user/lsp.html)を参照してください。通信仕様は[LSP 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)に沿っています。

## その他のエディター

LSPクライアントに次の値を設定してください。

| 設定 | 値 |
| --- | --- |
| コマンド | `node` |
| 引数 | `[/absolute/path/to/haskstack/lsp.mjs]` |
| 通信 | stdio |
| 言語ID | `nyanco` |
| 対象拡張子 | `.nyan` |

VS Code用の拡張を [`editors/vscode`](editors/vscode/README.md) に用意しています。LSPへの接続に加え、`.nyan`のシンタックスハイライト、括弧の対応付け、行コメント操作に対応しています。起動方法は拡張のREADMEを参照してください。

## 開発用テスト

```sh
node --test test/lsp.test.mjs
```

型検査・補完・ホバー・定義位置・未完成のソースからの復帰に加え、実サーバーへの分割フレーム送信、Unicode、incremental change、古い変更通知の無視、shutdown/exitを検証します。
