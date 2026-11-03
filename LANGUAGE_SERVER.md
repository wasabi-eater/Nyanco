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
- トップレベル関数・組み込み関数のホバーに、定義時の多相型と使用箇所で具体化された型を表示。周囲の引数・戻り値の制約を反映します。さらに「型変数の対応」に `'a = int` など、定義時の型変数が使用箇所でどの型になったかを表示します（名前も型も変わらない変数は省略）。型検査が完了しない場合は、取得できた定義時の型のみ表示します。
- 変数や関数の引数は、宣言箇所と使用箇所のホバーで型を表示します。`_`、`$1`、`$$` などのスタック参照も、ホバーで参照先の値の型を表示します。
- 型注釈を省略した関数は、定義の上にCodeLensで推論したシグネチャを表示します。複数の節がある場合は先頭の節に表示します。VS Codeでは `editor.codeLens` で表示を切り替えられます。
- 関数、組み込み語、コンストラクター、クラスメソッド、effect操作、キーワードの補完候補。
- 同じ文書のトップレベル関数への定義ジャンプ。
- トップレベル関数のドキュメントシンボル（アウトライン）。
- 各行の実行後のstack型を行末に表示するinlay hint。stackの底からトップへ左から右に並べ、空の場合や既知の値がないstack rowだけの場合は表示しません。

`.nyan`を言語ID `nyanco` に関連付けてください。位置指定はUTF-16、変更通知はincremental sync（全体置換も受理）です。ファイルシステムから読み直さず、エディター内の未保存のテキストを解析します。初期化コード・IO・ユーザー関数は実行しません。

各文書を独立したプログラムとして解析します。現在のコンパイラーは最初のエラーで停止するため、エラー診断は一度に1件です。構文解析に成功すれば、型エラーがある間も関数名の補完や定義ジャンプを提供します。

## 行末のstack型

LSPの`textDocument/inlayHint`に対応しています。たとえば次のコードでは、右側の注記に相当する型がエディターのinlay hintとして表示されます。注記はファイルへ書き込まれません。

```nyanco
main =
    1       -- : ..s int
    dup     -- : ..s int int
    +       -- : ..s int
    print   -- stackが空になるので表示なし
```

同じ行に複数の節があれば最後の結果を表示します。関数の定義内では多相型を保ち、後続の式から決まる型も反映します。quotation内はその本体のstackを表示し、複数行にまたがる呼び出しの結果は閉じ括弧の行に表示します。宣言だけの行、コメントだけの行、型検査に失敗した文書には表示しません。IOを含め、プログラムは実行しません。

VS Codeでは既存のNyanco拡張から利用できます。更新後にウィンドウを再読み込みしてください。表示されない場合は設定の`editor.inlayHints.enabled`を`on`にします。色はエディターのテーマに従います。NeovimではLSP接続後に`vim.lsp.inlay_hint.enable(true)`で有効にできます。

ローカル変数の定義ジャンプ、文書をまたぐ参照、rename、formatting、semantic tokensはまだ提供していません。大きな文書も現時点では変更のたびに全体を型検査します。

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


moduleでは同じディレクトリのソースとimport先を合わせて型検査します。未保存のファイルも参照し、`pub`／`open`の公開範囲に従って補完と定義ジャンプを提供します。VS Code拡張は`.nyan`の追加・変更・削除も監視します。

エラー診断は発生したファイルとtokenの範囲に表示します。Windowsのドライブ文字の大小、URIのエンコード、symlinkによる表記の違いは同じファイルとして扱います。依存moduleや同じmoduleの別ファイル内のエラーは、そのファイルへ診断を通知し、修正すると消去します。
