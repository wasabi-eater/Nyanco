# Nyanco

Nyanco（ニャンコ）は、スタックを使って処理をつなぐ静的型付きの関数型言語です。型推論、パターンマッチ、型クラス、代数的エフェクトを備えています。実験段階のため、構文や標準ライブラリは変わることがあります。

**[ブラウザでNyancoを試す](https://wasabi-eater.github.io/Nyanco/)**

Language Tourでは、インストール不要でサンプルを編集・実行しながら学べます。

Codex製です。ドキュメント等もCodexで書かれているので読みにくかったらすみません。

## はじめのプログラム

Node.js 20以降で動きます。リポジトリのルートに `hello.nyan` を作り、次のコードを保存してください。

```nyanco
main =
    1 ..= 5; filter {% 2 == 1}; map {_ * _}; sum; print
```

```sh
node cli.mjs --single-file hello.nyan
```

奇数の二乗和 `35` が表示されます。`;` で処理をつなぐと、スタックに残った値を次の処理が受け取ります。`node cli.mjs` だけで実行するとREPLが開きます。

## ドキュメント

- [言語リファレンス](docs/LANGUAGE.md)と[型システム](docs/TYPE_SYSTEM.md)
- [標準ライブラリ](docs/STANDARD_LIBRARY.md)
- [CLI・C++20・Goによる実行とコード生成](docs/TOOLCHAIN.md)
- [VS Code拡張](editors/vscode/README.md)と[Language Server](docs/LANGUAGE_SERVER.md)
- [サンプル集](examples/)と[競技プログラミングの解答例](examples/atcoder/README.md)

[MITライセンス](LICENSE)
