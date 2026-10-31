# Nyanco for VS Code

NyancoのTextMateシンタックスハイライトと、stdio LSPへの接続を提供します。

## 起動

このフォルダーで依存パッケージをインストールし、開発用拡張として起動します。

```powershell
npm install
code --extensionDevelopmentPath="$PWD"
```

開いた開発用ウィンドウで `.nyan` ファイルを開いてください。リポジトリ内で使う場合、LSPは自動的に `../../lsp.mjs` を使用します。別の場所へ拡張をコピーした場合は、VS Code設定の `nyanco.serverPath` に `lsp.mjs` の絶対パスを指定してください。Node.jsがPATHにない場合は `nyanco.nodePath` も指定できます。設定変更後はウィンドウを再読み込みしてください。

## 色分け

キーワード、数値、文字列、文字、型変数、コンストラクター、関数定義、演算子、スタック参照、フィールド、ラベル、コメントに対応します。文字列補間内も通常の式として色分けし、`\{` と `\}` はエスケープとして扱います。括弧の対応付け・自動補完、`--` による行コメント操作も登録しています。

色は使用中のテーマによって変わります。TextMateによる構文上の分類なので、関数呼び出しと変数参照を型解析によって区別するSemantic Tokensは含みません。構文が未完成でも色分けでき、LSPの起動成功には依存しません。

実装は[VS Codeの公式Syntax Highlight Guide](https://code.visualstudio.com/api/language-extensions/syntax-highlight-guide)のTextMate方式を使用しています。

## 検証

```powershell
npm test
```

実際のTextMate / Onigurumaエンジンで主要なトークンのスコープ、補間の入れ子、エスケープを検証し、リポジトリ内の全サンプルをトークン化します。
