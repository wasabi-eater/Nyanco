# ABC480 / ABC481 の解答と計測

各ディレクトリの `main.nyan` が独立した実行可能な解答です。対象は、終了済みの [ABC480](https://atcoder.jp/contests/abc480/tasks) と [ABC481](https://atcoder.jp/contests/abc481/tasks) の A〜D です。

| 問題 | 解答 | 方針 | 最大規模ケースの時間 |
| --- | --- | --- | ---: |
| ABC480 A | [main.nyan](abc480/a/main.nyan) | 行・列を集合にして A と D の隣接を調べる | 38 ms |
| ABC480 B | [main.nyan](abc480/b/main.nyan) | 完全一致を優先し、それ以外は文字の差が1個の候補を数える | 59 ms |
| ABC480 C | [main.nyan](abc480/c/main.nyan) | 時刻をソートし、給水されない隙間を貪欲に埋める | 191 ms |
| ABC480 D | [main.nyan](abc480/d/main.nyan) | 二重の累積和と二分探索で各区間和を求める | 333 ms |
| ABC481 A | [main.nyan](abc481/a/main.nyan) | 和を文字列にして桁数を数える | 28 ms |
| ABC481 B | [main.nyan](abc481/b/main.nyan) | 一致する頂点と、頂点以外で交差する辺を数える | 37 ms |
| ABC481 C | [main.nyan](abc481/c/main.nyan) | 名前から番号への辞書を保持する | 723 ms / 349 ms |
| ABC481 D | [main.nyan](abc481/d/main.nyan) | 連続した隣接辺vectorとdequeによる0–1 BFS | 1663 ms / 1671 ms |

2026-11-06、Windows上のMSVC C++20 `/O2`、Node.js v24.15.0で計測しました。Cの2値は全件異なる名前／重複する名前、Dの2値は鎖状／星状グラフです。プロセス起動・入出力を含む1回の実時間で、コンパイル時間は含みません。両コンテストの対象問題の制限時間は2秒です。これは手元の入力での結果であり、AtCoderに提出してACを確認したものではありません。

ABC480 Cは N=200,000、ABC480 Dは N=Q=100,000、ABC481 Cは Q=200,000、ABC481 Dは N=M=200,000 の入力を生成します。小さい問題も制約上限の入力を含みます。最大ケースは10件で、入力の全形状を網羅するものではありません。

## 実行・再計測

リポジトリのルートで実行します。

```sh
# VMで実行する場合
node cli.mjs examples/atcoder/abc480/a/main.nyan

# パスを含まないC++をファイルに生成する場合
node cli.mjs examples/atcoder/abc481/d/main.nyan --procon --emit-cpp main.cpp

# g++などで実行ファイルにする場合
c++ -std=c++20 -O2 -pthread main.cpp -o main

# MSVCのDeveloper Command Promptでは
cl /nologo /std:c++20 /EHsc /utf-8 /O2 main.cpp /Fe:main.exe

# 8問の公式サンプルと小規模の独立した正解生成器による検査
node --test test/atcoder.test.mjs

# C++に変換して全ケースを検査・計測する
node bench/atcoder.mjs

# 指定した問題だけ計測する
node bench/atcoder.mjs abc481_d
```

`--procon` はデフォルトで非対話問題用のバッファ付き入出力を使います。入力前にflushする場合は `--interactive-io` を指定します。`bench/atcoder.mjs` はWindowsではPATH上の `cl`、それ以外では `c++` を使います。MSVCの場合はDeveloper Command PromptまたはDeveloper PowerShellで実行してください。

ベンチマークは公式サンプル20件、小規模225件、最大規模など10件の計255件で出力を照合します。Aは小さい入力を全列挙し、残りはseed固定のランダム入力です。例えばABC481 Dの小規模の正解生成器は、解答とは別のDijkstra法を使用します。ABC480 Dの最大入力の期待値はJavaScriptの `BigInt` で計算し、64bitの和を検査します。

生成C++・実行ファイル・計測JSONは `native/atcoder/` に保存されます。`results.json` は実行するたびに、今回選択した問題の結果で置き換わります。不一致・異常終了・タイムアウトはエラーとなり、2秒を超えた場合は各結果の `withinLimit` が `false` になります。

## 追加した標準関数

いずれもVMとC++で利用できます。`std.prelude` から暗黙的に公開されます。`set 'a` の要素には `hash 'a` と `eq 'a` が必要です。集合の走査順には依存しないでください。

| 名前 | 用途 |
| --- | --- |
| `set xs` | `streem` を実装する値を走査し、重複を除いて集合を作る。空集合は `set []` |
| `toSet xs` | `set xs` の互換エイリアス |
| `sinsert xs x` | 要素を追加した集合を返す |
| `sremove xs x` | 要素を削除した集合を返す。存在しない場合は変更なし |
| `scontains xs x` | 含まれているかをboolで返す |
| `slength xs` / `sisEmpty xs` | 要素数／空かどうかを返す |
| `sunion xs ys` | 集合 `xs` に `ys` の要素を追加する |
| `sintersection xs ys` | `xs` のうち集合 `ys` に含まれる要素の集合を返す |
| `sdifference xs ys` | `xs` のうち集合 `ys` に含まれない要素の集合を返す |
| `vscan xs init f` | 初期値を含む累積結果のvectorを返す。Haskellの `scanl` 相当 |
| `vreplicate n x` | `x` を `n` 個持つvectorを返す。負の個数は `exn` |

`std.set.insert` / `remove` / `contains` / `length` / `isEmpty` / `union` / `intersection` / `difference` は、対応する `s` 付き関数の別名です。`std.vector.scan` / `replicate` は `vscan` / `vreplicate` の別名です。`vscan` はcallbackと入力streamのエフェクトを伝え、`cancel` と結果付き `break` を処理します。

```nyanco
main =
    [3, 1, 3, 2]; set -> xs
    xs; sinsert 4; sremove 1; vector; sort; print -- [2, 3, 4]
    xs; slength; print                                 -- 3
    [1, 2, 3]; vscan 0 {+}; print                      -- [0, 1, 3, 6]
    vreplicate 4 0; print                              -- [0, 0, 0, 0]
```

## C++生成の改善

- vector同士の `zip` は、コルーチン用スレッドを介さず添字で並行走査します。ABC480 Bの最大ケースは、この変更により約1.97秒から約0.04秒になりました。
- 組み込み `repeat` / `repeatWith` は直接ループとして走査します。callbackの実行順序と中断処理は維持します。
- hash trieの更新は共有されていないノードを再利用します。共有された経路だけをコピーし、辞書・集合の過去の値を保持します。hashが衝突した場合はeqで区別します。
- dequeは永続的なノードを共有し、要素の追加ごとに全要素をコピーする処理を取り除きました。
- primitiveなvector・辞書・集合・dequeのmutable更新では、添字と更新式が元の変数を読まず、ユーザー関数も呼ばないと確認できる場合、セルの値を直接移して更新します。別に保存したsnapshotはCOWで保護します。範囲外などの検査を終えてから値を移すため、捕捉された例外でも更新前の値を失いません。
- 既知のscalarだけを持つtupleの分解では、ローカル変数を直接生成します。

これらは、すべての関数・コンテナの `std::any` を除去する変更ではありません。解答側でもABC481 Dの隣接リストを連続したvectorにし、余分な辞書検索やコンテナ生成を減らしています。
