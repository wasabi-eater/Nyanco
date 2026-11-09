# AtCoderの解答と計測

各ディレクトリの `main.nyan` が独立した実行可能な解答です。ABC480・ABC481のA〜Dに加え、ABC438 E、ABC482 C、ABC483 Eを収録しています。

## ABC480 / ABC481

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

# 独自の小規模入力と正解生成器で検査
node --test test/atcoder.test.mjs

# C++に変換して全ケースを検査・計測する
node bench/atcoder.mjs

# 指定した問題だけ計測する
node bench/atcoder.mjs abc481_d

# 複数の問題で最大規模入力を3回ずつ計測する
node bench/atcoder.mjs abc438_e abc480_c abc481_c abc482_c abc483_e-unpacked --rc local --runs 3
```

`--procon` はデフォルトで非対話問題用のバッファ付き入出力を使います。入力前にflushする場合は `--interactive-io` を指定します。`bench/atcoder.mjs` はWindowsではPATH上の `cl`、それ以外では `c++` を使います。MSVCの場合はDeveloper Command PromptまたはDeveloper PowerShellで実行してください。

ABC480 / ABC481のベンチマークは小規模225件と最大規模など10件の計235件で出力を照合します。小規模テストではAの入力を全列挙し、ほかの問題はseed固定のランダム入力を生成します。例えばABC481 Dの小規模の正解生成器は、解答とは別のDijkstra法を使用します。ABC480 Dの最大入力の期待値はJavaScriptの `BigInt` で計算し、64bitの和を検査します。

生成C++・実行ファイル・計測JSONは `native/atcoder/` に保存されます。`results.json` は実行するたびに、今回選択した問題の結果で置き換わります。`--runs` を指定すると最大規模入力の全測定値が `samples`、中央値が `ms` に入ります。小規模入力は一度ずつVMとC++の両方で照合します。不一致・異常終了・タイムアウトはエラーとなり、中央値が問題の制限時間以上の場合は `withinLimit` が `false` になります。

## ABC438 E / ABC482 C

- [ABC438 Eの解答](abc438/e/main.nyan) は `map; vector` でダブリング表を作ります。最大規模は20万要素・20万クエリで、1つの巡回路と自己ループに至る鎖を測ります。小規模入力は1回ずつ遷移をシミュレートして照合します。[問題文](https://atcoder.jp/contests/abc438/tasks/abc438_e)
- [ABC482 Cの解答](abc482/c/main.nyan) は座標を `map; unzip` で読み込み、ソート後に `partitionPoint` を2回使います。最大規模は30万点・30万クエリです。小規模入力は各クエリで全ての点を数えて照合します。[問題文](https://atcoder.jp/contests/abc482/tasks/abc482_c)

WindowsのMSVC C++20 `/O2` とローカル参照カウントで、最大規模の各入力を3回測定しました。表は起動と入出力を含む中央値です。

| 問題 | 入力 | 中央値 |
| --- | --- | ---: |
| ABC438 E | 巡回路 | 1,072 ms |
| ABC438 E | 鎖と自己ループ | 887 ms |
| ABC480 C | 未整列の時刻列 | 102 ms |
| ABC481 C | 名前が全件異なる／名前が重複する | 881 ms / 236 ms |
| ABC482 C | 各行・各列に1点ずつ | 548 ms |

ABC438 Eは同じNyancoソースをコミット `8dd5d62` のコンパイラでも生成し、変更前後を交互に実行しました。変更前の中央値は巡回路が2,337 ms、鎖が2,095 msでした。

## ABC483 E

[main.nyan](abc483/e/main.nyan) は各文字を5ビットに詰め、0〜2文字をマスクした整数をソートします。同じ整数の連続区間から組数を求め、包除原理で重複を補正します。時間計算量は `O(M² N log N)`、追加領域は `O(N + M)` です。[公式解説](https://atcoder.jp/contests/abc483/editorial/28634)

WindowsのMSVC `/O2` で、最大規模のランダム入力は約0.30秒、全件同一は約0.10秒でした。同じランダム入力でNyancoの `counts` を使う辞書版は約7.4秒でした。計測はプロセス起動と入出力を含みます。解答の小規模26件を総当たりと照合し、最大規模3件を別の正解生成器で検査します。

```sh
node cli.mjs examples/atcoder/abc483/e/main.nyan --procon --emit-cpp main.cpp
node bench/atcoder.mjs abc483_e --rc local
```

[バイトvector版](abc483/e-unpacked/main.nyan) は `with` で指定位置を `?` に置き換え、`orderedCounts` でキーごとの出現回数を求めます。C++バックエンドは短いバイトvectorのデータをオブジェクト内に置き、ソートの比較に先頭バイトのキャッシュを使います。型が確定した一部の2要素タプルは、C++のvectorにネイティブの行として格納します。`map` がフィールドだけを使う場合は、タプルを箱詰めせずにフィールドを渡します。

バイトvector版をMSVC `/O2` とローカル参照カウントで3回ずつ測定した中央値は、ランダム入力で2.90秒、全件同一で2.19秒、重複の多い入力で2.55秒でした。streamの変更前後を交互に実行した場合、変更前はそれぞれ2.95秒、2.26秒、2.55秒でした。AtCoderの制限時間は4秒です。

```sh
node cli.mjs examples/atcoder/abc483/e-unpacked/main.nyan --procon --emit-cpp main.cpp
node bench/atcoder.mjs abc483_e-unpacked --rc local
```

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

ABC481 Dには、一次元CSRの `abc481/d/main.nyan` に加えて、隣接リストをvectorのvectorで保持する `abc481/d-jagged/main.nyan` もあります。後者は `graph.[v]` をそのまま走査します。`node bench/graph-performance.mjs` で両方の出力と速度を比較できます。ベンチマークの生成C++には計測用のmainが付くため、提出用のコードは次のように生成してください。

```sh
node cli.mjs examples/atcoder/abc481/d-jagged/main.nyan --procon > main.cpp
```

- vector同士の `zip` は、コルーチン用スレッドを介さず添字で並行走査します。ABC480 Bの最大ケースは、この変更により約1.97秒から約0.04秒になりました。
- 組み込み `repeat` / `repeatWith` は直接ループとして走査します。callbackの実行順序と中断処理は維持します。
- hash trieの更新は共有されていないノードを再利用します。共有された経路だけをコピーし、辞書・集合の過去の値を保持します。hashが衝突した場合はeqで区別します。
- dequeは永続的なノードを共有し、要素の追加ごとに全要素をコピーする処理を取り除きました。
- primitiveなvector・辞書・集合・dequeのmutable更新では、添字と更新式が元の変数を読まず、ユーザー関数も呼ばないと確認できる場合、セルの値を直接移して更新します。別に保存したsnapshotはCOWで保護します。範囲外などの検査を終えてから値を移すため、捕捉された例外でも更新前の値を失いません。
- 既知のscalarだけを持つtupleの分解では、ローカル変数を直接生成します。
- C++で要素型が確定するstreamは、`map`、`filter`、`flatMap`、`take` などの間でネイティブ型の要素を渡します。数値の `fold` や `vector` もそのまま受け取れます。動的なstreamとの境界では従来の値表現に変換します。
- 既知のstreamコールバックは、ローカル値と可変セルをC++のクロージャに直接捕捉します。通常のquotationとして保持する場合も、既知のネイティブ型の捕捉値は型付きスロットに格納します。

これらは、すべての関数・コンテナの `std::any` を除去する変更ではありません。解答側でもABC481 Dの隣接リストを連続したvectorにし、余分な辞書検索やコンテナ生成を減らしています。
