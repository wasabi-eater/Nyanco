# 標準ライブラリ

このページでは、`std.prelude` から使える主な関数を機能別に紹介します。名前の一覧は[preludeの定義](../std/prelude.nyan)にあります。手元のREPLで `:type 関数名` を入力すると、型とエフェクトを確認できます。

## スタックと入出力

`dup` は先頭の値を複製し、`drop` は取り除きます。`swap` は上の2値を入れ替え、`over` は上から2番目の値を複製します。`rot` は上の3値を回転し、`nop` は何も消費・生成しません。`dip` は値を1つ退避してquotationを実行した後、その値を積み直します。

`read` は標準入力から1行を読みます。`put` は文字列を、`print` は値を整形して改行付きで出力します。`show` は整形結果を文字列として返します。`read`、`put`、`print` は `io` エフェクトを伴います。

## Streamと走査

`streem` は順に要素を取り出せる型のクラスです。vector、range、stream、dict、set、deque、heapに標準インスタンスがあります。辞書の `each` は `#(key, value)` を渡します。

| 処理 | 主な関数 |
| --- | --- |
| 現在のスタック上で反復・集約 | `each`、`fold`、`sum`、`product`、`count`、`countIf` |
| 遅延変換 | `map`、`filter`、`flatMap`、`flatten`、`take`、`takeWhile`、`skip`、`skipWhile` |
| 組にする | `zip`、`zipWith`、`unzip` |
| 区間に分ける | `windows`、`chunks`、`chunkBy`、`groupBy` |
| 検索・整列 | `nth`、`reverse`、`sort`、`sortBy`、`maxi`、`mini`、`maxiBy`、`miniBy`、`all`、`any` |
| 生成 | `fromYield`、`repeat`、`repeatWith`、`iterate` |
| 組み合わせ | `permutations`、`combinations`、`combinationsWithReplacement`、`powerset`、`cartesianProduct` |

`each` は各要素を積んでquotationを呼びます。`fold xs init f` は累積値と要素を `f` に渡し、更新された累積値を次の反復へ引き継ぎます。`map` や `filter` が返すstreamは、`each` や `vector` などで消費するときに要素を計算します。`nth xs i` は0始まりの添字に対応する要素を `option` で返します。

`zip` は短い方が尽きたところで止まり、各ペアをtupleにします。`zipWith xs ys f` は各ペアに `f` を適用します。`unzip` はtupleの列を2本のvectorに分けます。

`windows xs n` は重なりのある固定長の窓、`chunks xs n` は重ならないまとまりを返します。`chunks` は末尾の短いまとまりも返します。`chunkBy xs key` はキーが等しい隣接区間に分け、`groupBy xs key` は位置によらず同じキーの要素を辞書にまとめます。

`sortBy`、`maxiBy`、`miniBy` のquotationは比較キーを1つ返します。`reverse`、`sort`、`sortBy` はvector、`maxi` と `mini` の系列は `option` を返します。2値を比較する場合は `max` と `min` を使います。`all` と `any` は判定が確定したところで走査を打ち切ります。

`orderedCounts xs` は異なる値ごとに `#(値, 出現回数)` を作り、元の値の昇順に並べたvectorを返します。`[3, 1, 3, 3, 2, 1]; orderedCounts` の結果は `[#(1, 2), #(2, 1), #(3, 3)]` です。

`fromYield { ... }` は `yield` で渡した値をstreamにします。`repeat x` は同じ値を繰り返し、`repeatWith { ... }` は要素ごとにquotationを実行します。`iterate start next` は最初の状態を `start` で作り、現在の先頭値を生成してから `next` で状態を更新します。

```nyanco
main =
    1 ..= 5; map {_ * _}; filter {> 10}; vector; print -- [16, 25]
    [0, 1, 2, 3]; chunks 3; vector; print             -- [[0, 1, 2], [3]]
    repeat 7; take 3; vector; print                   -- [7, 7, 7]
```

走査の中断については[エフェクトとハンドラー](LANGUAGE.md#エフェクトとハンドラー)を参照してください。

## コンテナ

| 型 | 生成と操作 |
| --- | --- |
| `[a]` | リテラル `[]`、変換 `vector`、末尾追加 `vpush`、`head`、`tail`、`length` |
| `dict k v` | リテラル `[:]`、tuple列からの変換 `dict`、`values`、`counts`、`countsBy` |
| `set a` | `set`、`sinsert`、`sremove`、`scontains`、`sunion`、`sintersection`、`sdifference` |
| `deque a` | `deque`、`qpush`、`qpushFront`、`qpopFront`、`qpopBack`、`qpeek`、`qpeekBack` |
| `heap a` | `heap`、`hpush`、`hpop`、`hpeek` |

`vector`、`dict`、`set`、`deque`、`heap` は入力を走査してコンテナに変換します。空のsetやdequeは `set []`、`deque []` と書きます。辞書のキーとsetの要素には `hash` 制約が必要です。辞書で同じキーを挿入すると値を置き換えます。辞書・setの走査順には依存できません。`values` は辞書の値のstreamを返します。

`vmap`、`vfilter`、`vflatMap`、`vflatten`、`vtake`、`vskip`、`vzip` は結果をvectorにまとめます。`vreplicate n x` は値を `n` 個並べ、`vscan xs init f` は初期値を含む累積結果を返します。

`partitionPoint xs predicate` は、真が先・偽が後になる境界の添字を返します。ソート済みのvectorに対する `binarySearch xs key` と `binarySearchBy xs key project` は、一致した添字を `Ok`、見つからない場合の挿入位置を `Err` で返します。

`qpopFront`、`qpopBack`、`hpop` は `option 'a`、更新後のコンテナの順に返します。空なら取り出した要素は `None` です。前端を取り出す操作は `std.deque.popFront` としても呼べます。`qpop` は `qpopFront` の別名です。heapは最大値を先に取り出し、比較には `ord` が必要です。`peek` 系は `option` だけを返します。

### エフェクト経由のコンテナ操作

`std.worklist.push x` は要素を追加し、`std.worklist.pop` は次の要素を取り出します。`std.worklist.peek` は次の要素を残したまま参照します。`pop` と `peek` は空の場合に `None` を返します。型注釈では3つの操作を `std.worklist 'a` とまとめて書けます。

`withHeap initial { ... }` は最大値を先に、`withDeque initial { ... }` は追加した順に取り出します。どちらも初期コンテナを受け取り、空のスタックでquotationを実行して、その結果を呼び出し元に積みます。他のエフェクトは外へ伝わります。直接操作する `hpush` や `qpush` も使えます。

```nyanco
drain =
    std.worklist.push 3
    std.worklist.push 7
    loop {std.worklist.pop; ?? cancel; print}

main =
    withHeap (heap []) {drain}    -- 7, 3
    withDeque (deque []) {drain}  -- 3, 7
```

## Option、Result、例外

`option 'a` は `None` と `Some 'a`、`result 'a 'err` は `Ok 'a` と `Err 'err` からなります。`omap`、`ofilter`、`oflatMap`、`oflatten`、`ozip` と、`rmap`、`rflatMap`、`rflatten`、`rzip` で中身を処理できます。

`unwrap` は `Some` や `Ok` の値を取り出し、失敗時には `exn` を起こします。`unwrapOr x default` は既定値を先に評価し、`unwrapOrElse x {default}` や `x ?? default` は失敗した場合だけ既定値を評価します。`option` と `result` に対する `||` は、左が成功なら右辺を評価しません。`.|.` は両辺を評価します。

`catch { ... }` は入力を必要とせず値を1つ返すquotationを実行し、`exn` を捕まえて `result 'a string` を返します。`io` やほかのエフェクトは外へ伝わります。

## 文字列、数値、ビット

`split text separator` は分割結果を文字列のstreamとして返し、`join xs separator` は文字列の列を結合します。`chars` はUnicodeスカラー値のstream、`bytes` はUTF-8バイトのstreamを作ります。vectorとして受け取るには `vchars`、`vbytes` を使います。

`parseInt` と `parseFloat` は文字列を数値に変換し、失敗時には `exn` を起こします。型名と同名の `int`、`float`、`byte`、`char` は型変換関数としても使えます。`from` は入力と出力の型から `into` インスタンスを選びます。

`.&.`、`.|.`、`xor`、`.<<.`、`.>>.` でビット演算ができます。`testBit`、`setBit`、`clearBit` のビット位置は最下位を0とします。
