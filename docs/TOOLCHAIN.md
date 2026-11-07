# 実行とコード生成

CLIはNode.js 20以降で動作します。このページのコマンドは、リポジトリのルートで実行します。ブラウザで学ぶ場合は[Language Tour](https://wasabi-eater.github.io/Nyanco/)を使えます。

## 実行と型検査

```sh
node cli.mjs main.nyan
node cli.mjs --single-file examples/demo.nyan
node cli.mjs main.nyan --stack
node cli.mjs --check main.nyan
node cli.mjs --types main.nyan
node cli.mjs --type "dup"
node cli.mjs --eval "3; dup; *"
```

通常は、指定したファイルと同じディレクトリの `.nyan` ファイルを同じモジュールとして読み込み、`main` を実行します。独立したサンプルが同じディレクトリにあるときは `--single-file` を指定します。`--stack` は実行後のスタックを表示します。

引数なしの `node cli.mjs` はREPLを開きます。`:type` は式の型、`:stack` は現在のスタックを表示します。`:{` と `:}` で複数行を入力でき、`:load PATH` でソースを読み込みます。その他のコマンドは `:help` で確認できます。`npm link` を実行すると `nyanco` コマンドを使えます。

## ネイティブコード

```sh
node cli.mjs main.nyan --emit-cpp main.cpp
c++ -std=c++20 -O2 -pthread main.cpp -o main
./main
```

WindowsのVisual Studio開発者コマンドプロンプトでは、`cl /std:c++20 /EHsc /utf-8 /O2 /bigobj main.cpp` でビルドできます。

競技プログラミング向けの `--procon` は、ソースパスを省いたC++を標準出力に書き、出力をバッファします。`--emit-cpp main.cpp` を併用するとファイルに直接書き込みます。入力前に出力をflushする必要がある場合は `--interactive-io` を指定します。[解答例とベンチマーク](../examples/atcoder/README.md)を参照してください。

```sh
node cli.mjs main.nyan --emit-go main.go
go build -o main main.go
node cli.mjs main.nyan --build main
```

`--build` はGoで実行ファイルを作ります。Goは実行ファイルをビルドするときに必要です。`--no-source-paths` を付けると、生成コードの診断位置からソースのパスを省けます。

## 型付き中間表現

```sh
node cli.mjs main.nyan --dump-ir
node cli.mjs main.nyan --emit-ir main.ir.json --emit-ir-text main.ir.txt
```

IRには型、入出力、値のID、quotationや分岐の領域、所有権の判定が記録されます。JavaScriptからは `language.mjs` の `compile`、`modules.mjs` の `compileModule`、`cpp-backend.mjs` の `transpileCpp`、`go-backend.mjs` の `transpileGo` を利用できます。

## エディターと開発

[VS Code拡張](../editors/vscode/README.md)と[Language Serverの設定](LANGUAGE_SERVER.md)を参照してください。

テストは `npm test` で実行します。GoとC++の両方のネイティブ出力を検証するには、GoとC++20対応のコンパイラを用意してください。言語実装は `src/frontend/`、型検査は `src/types/`、組み込み処理は `src/runtime/`、中間表現とコード生成は `src/compiler/`、CLIとエディター連携は `src/tooling/` にあります。
