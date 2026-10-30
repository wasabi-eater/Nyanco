# Nyanco 0.58 — クラス継承と文字変換

型推論、スタック評価、型クラス・関連型、代数的エフェクトを持つconcatenativeな関数型言語です。Node.js 20以降で動作し、Goコードとnative実行ファイルも生成できます。

0.40では複数操作を持つeffectグループを追加しました。組み込み`io`は`read`と`put`からなり、`print`は`put`を使用します。

**0.38は破壊的変更です。** 呼び出し、関数宣言、ADT、型適用、型クラス、instance、effectを前置形式へ統一しました。0.37以前のプログラムをそのまま実行すると意味が変わる場合があります。

## 実行順

空白で2個以上の項を並べると、先頭以外を左から右に実行し、最後に先頭を実行します。引数の個数を見て自動的にグループ分けする規則ではありません。

```haskell
f x y                 -- x → y → f
f (g x) y             -- x → g → y → f
f x y; f2 x2 y2       -- x → y → f → x2 → y2 → f2
f x y, f2 x2 y2       -- 実行順は同じ
```

**変数、数値・文字列・quotationなどのリテラル、括弧付きの式にも同じ規則を適用します。**

```haskell
1 2 3                 -- stack: 2 3 1
1, 2, 3               -- stack: 1 2 3
[1 2 3]               -- [2 3 1]
[1, 2, 3]             -- [1 2 3]
```

先頭が変数またはリテラルの空白列には`W001`警告を出します。警告はエラーではなく、評価順も変えません。値を左から順に評価する意図なら`,`で区切ってください。

関数適用は二項演算子より優先されます。`f x + y`は`(f x) + y`です。二項演算子の語順と優先順位は従来どおりです。各辺は外部スタックから0個消費し1個生産する式である必要があります。

## `,`と`;`、`_`と`$`

優先順位は、強い方から「空白による適用 → 二項演算子 → `,` → `;`」です。`,`と`;`はどちらも左の処理を終えてから右へ進みます。

`;`は新しい節を開始します。`,`は現在の節を継続し、節の入口で捕捉した`_`や`$`を共有します。

```haskell
3, 4; _, _            -- stack: 3 4 4
3 4; _, _             -- stack: 4 3 3（3 4に警告）
3, 4; _; _            -- stack: 3 4
```

`_`は`_0`の略です。節の評価前のトップから指定位置の値を一度だけ取り出します。同じ番号を繰り返すと同じ値を参照します。`$`／`$0`は値を取り除かず参照します。同じ節で同じ番号の`_n`と`$n`は混在できません。

```haskell
square = _ * _
copy = $
3; copy               -- stack: 3 3
```

`()`、`[]`、record、tupleは外側と節を共有し、その内部の`;`でも節が切り替わります。quotation `{...}`の本体は実行されるまで遅延し、独立した節を持ちます。

## 関数と変数

```haskell
square x = x * x
abs = $ < 0; when {0 -}
abs2 = when ($ < 0) {0 -}
sum xs = 0; each xs {+}
sum2 xs = 0, xs; each {+}

square 5               -- 25
sum [1, 2, 3]          -- 6
```

`=`は関数定義専用です。関数内にも定義できます。引数を持つ定義は`名前 パターン... = 本体`です。

変数宣言は`->`を使い、デフォルトはimmutableです。

```haskell
3, 4 -> x y
0 -> mut count
count := 10
count ! (+ 1)
```

`x ! f`は現在のxを積み、fの処理を適用してxを更新します。`;`、`,`、改行、スコープ末尾で代入や束縛を終えられます。複数の処理を代入の右辺に含める場合は括弧で囲んでください。

## quotationと制御

quotationは値で、`call`によって実行します。quotationを先頭に置いただけでは自動実行しません。

```haskell
call {print "hello"}
if True {print "yes"} {print "no"}
when True {print "yes"}
0; while {dup; < 3} {+ 1}
```

`each`はコールバックを呼び出し元のスタック上で実行します。

```haskell
0; each [1, 2, 3] {+}          -- 6
vmap [1, 2, 3] {* 2}           -- [2 4 6]
vfilter [1, 2, 3] {_ % 2 == 0} -- [2]
fold [1, 2, 3] 0 {+}          -- 6
```

`compose q1 q2`はq1の後にq2を実行するquotationを作ります。`++`はvector連結です。

## 値、演算子、パターン

型名は`int`、`bool`、`string`など、小文字始まりです。

```haskell
[1, 2, 3]                    -- vector内は空スタックでコマンドを実行
Push [] 3                    -- [3]
[] :: 3 :: 4                 -- [3 4]。::は末尾追加
[1, 2] ++ [3, 4]
1 .. 4                       -- 終端を含まないrange
1 ..= 4                      -- 終端を含むrange
#(0, "Hoge", [])             -- tuple
{x: 3, name: "demo"}         -- record
```

`r.field`や`t.0`は一つの項として扱います。`.field r`、`.0 t`のようにアクセス関数を前置しても使えます。recordのフィールド区切りの`,`は維持します。フィールド内で複数の処理を書く場合は、括弧でまとめると明確です。

`+ - * / % ^`、比較、`and or`はinfixです。欠けた項はスタックから補います。比較の連鎖と隣接する二項演算子も使えます。

```haskell
3, 4, 5; + *                 -- 23
3 < x <= 4
5; 4 +                       -- 9
```

```haskell
data option 'a = None | Some 'a
data pair 'a 'b = Pair 'a 'b

get (Some x) = x
get None = 0

last = case
  -> Push xs x then x
  -> [] then 0
```

型適用も`option int`、`pair int string`の前置形式です。複数引数の型を他の型の引数にするときは必要に応じて括弧でまとめます。constructorパターンも`Some x`、`Pair x y`の順です。関数のguard、caseのguard、`otherwise nop`、`->`によるパターン束縛は引き続き使用できます。

## 型クラスと関連型

```haskell
class unpack 'c where
  type item
  unpack : 'c -> item

data box 'a = Box 'a
instance unpack (box 'a) where
  item : 'a
  unpack (Box x) = x

unwrap : unpack 'c 'a => 'c -> 'a
unwrap = unpack

instance add 'a => add (box 'a) where
  + (Box x) (Box y) = Box (x + y)
```

関連型はinstanceの対象型から一意に決まります。複数宣言する場合、制約の引数は対象型、関連型の宣言順です。必要な前提制約の欠落や、関連型とメソッド実装の不一致を静的に検査します。

```haskell
data lmap 'c 'a 'b = LMap 'c {'a -> 'b}
instance streem 'c 'a => streem (lmap 'c 'a 'b) where
  item : 'b
  each (LMap c f) g = each c {call f; call g}

0; each (LMap [1, 2, 3] {+ 10}) {+}  -- 36
```

## 代数的エフェクト

```haskell
effect yield 'a: 'a ->
effect ask: -> int
effect fail: string -> !

emit : int -> / {yield int}
emit = yield

main : -> int string / {io}
main = handle
  {emit 3; ask; "done"}
  {yield: {-> value k; print value; resume k},
   ask: {-> k; resume 42 k}}
```

`handle body handlers`はbodyを空スタックで実行し、結果列全体を外側へ戻します。結果の個数は0個でも複数個でも構いません。各handlerの結果列はbodyと同じ型・個数にそろえます。

継続は単発のdeep continuationです。`resume`は操作の戻り値を渡して残りの計算を再開し、その結果列全体を返します。再開しなければ計算を打ち切ります。`!`は正常には戻らない型で、その操作の継続は再開できません。

エフェクト行も`/ {yield int, ask}`の前置形式です。`/ {}`は代数的エフェクトを漏らさない制約、`/ { | 'e}`は未知の行です。`print`は`io`として追跡します。mutable変数への代入はこの集合の対象外です。単独で宣言した型引数付き操作のhandlerには、すべての型に対して実装できることを要求します。グループの型引数は、そのグループの操作間で共有します。

## CLI・REPL・Go生成

言語名は**Nyanco（ニャンコ）**、ソースファイルの拡張子は`.nyan`です。プロジェクト内で`npm link`を実行すると、`nyanco`コマンドを利用できます。Windowsではインストールせずに`.\nyanco.cmd`でも実行できます。

```sh
nyanco examples/demo.nyan
nyanco --check examples/demo.nyan
nyanco examples/demo.nyan --build native/demo.exe
```


```text
node cli.mjs
node cli.mjs examples/prefix.nyan
node cli.mjs --eval "sum [1, 2, 3]"   （sumを定義したファイルを併用）
node cli.mjs --eval "3 4"
node cli.mjs --type "each"
node cli.mjs --check examples/prefix.nyan
node cli.mjs --types examples/prefix.nyan
node cli.mjs examples/prefix.nyan --emit-go native/prefix.go --build native/prefix.exe
```

REPLは`:type`、`:stack`、`:clear`、`:words`、`:load PATH`、`:q`を使えます。複数行定義は`:{`と`:}`で囲みます。警告はstderrへ出力し、通常の結果はstdoutへ出力します。

Go生成後はNode.js不要です。生成コードには言語の評価スタックを持たせず、値をGoのローカル変数と引数・戻り値へ展開します。

## 旧ソースの移行とテスト

0.37のバックアップZIPはワークスペースの`backups/`にあります。旧サンプル24個は新構文へ変換済みで、変更前との出力一致を検証しています。

```text
node migrate-v037.mjs old.nyan new.nyan
node cli.mjs --check new.nyan
```

移行補助は旧ソースを解析して順序を明示する`,`などへ変換し、新しい型検査を通してから保存します。コメントや元のレイアウトは保持しません。出力を確認してから使用してください。旧parserは`migration/v037/`に隔離し、通常のコンパイル・実行には読み込みません。

`npm test`で全テストを実行します。旧構文の回帰fixtureは専用adapterから現在の型検査・VM・Go生成へASTを渡し、既存機能の後退を検出します。新構文は`test/prefix-syntax.test.mjs`、`test/prefix-native.test.mjs`で直接検証します。

詳細は[型システム](TYPE_SYSTEM.md)、変更前の記述は[migration/v037/README.md](migration/v037/README.md)を参照してください。


## エフェクトグループ（0.40）

```haskell
effect state 'a where
    ask : -> 'a
    write : 'a ->

work = write 3; ask                -- -> int / {state int}

main : -> int / {}
main =
    0 -> mut value;
    handle {work}
      {ask: {-> k; resume value k},
       write: {-> x k; value := x; resume k}}
```

操作名はグローバルです。ハンドラーのフィールドにはグループ名ではなく`ask`や`write`を指定します。型のエフェクト行は`/ {state int}`となり、各操作で同じ型引数を共有します。グループ内の一部の操作だけをハンドルした場合、未処理の操作は外側へ伝わります。

従来の`effect yield 'a : 'a ->`も使えます。この単独宣言は各呼び出しで異なる型を使える多相操作です。一方、グループの型引数は一つのエフェクト行内で統一されるので、`write 3; write "text"`は型エラーです。

## 組み込みI/O

以下のグループが組み込まれています（ソースで再宣言する必要はありません）。

```haskell
effect io where
    read : -> string
    put : string ->
```

`read`は標準入力から1行を読み、改行を除いた文字列を返します。EOFは空文字列です。`put`は文字列を改行付きで出力します。`print`は任意の値を文字列に整形して`put`を呼びます。`io`自体は関数ではありません。

```haskell
put read                      -- 入力した1行を出力
print 42                      -- 型には / {io}

quiet : -> / {}
quiet = handle {print 42} {put: {-> text k; resume k}}

mock : -> string / {}
mock = handle {read} {read: {-> k; resume "sample" k}}
```

CLI・REPL・VM・native実行には最外側の標準I/Oハンドラーがあり、明示的なhandleなしでも入出力できます。標準ハンドラーの存在は関数型から`io`を消しません。`/ {}`の関数では必要な操作を内部で処理してください。

推論で使われる操作が分かる場合は、その操作だけのハンドラーで`io`を除けます。明示的な`/ {io}`という注釈は両操作を許す契約なので、それだけを手掛かりに処理する場合には`read`・`put`の両方を扱ってください。

ハンドラー内で`put text`などを実行すると外側へ転送されます。継続を再開しなければ残りの計算を中止できます。VMには`input: () => string`と`output: text => ...`を渡せます。非同期の入力には`evaluateAsync`／`executeAsync`を使用します。

REPLのプロンプト、警告、型表示や`--stack`の表示は実行環境の表示であり、言語のハンドラーの対象外です。

[出力の実行例](examples/io-effects.nyan)・[stateの実行例](examples/effect-groups.nyan)

## vectorのインデックスアクセス（0.41）

```haskell
[10,20,30] -> x;
x.[1]                       -- 20（0始まり）
x.[1 + 1]                   -- 30
```

`.[i]`はvectorを消費して要素を返す関数としても使えます。添字の式は0消費1生産で、型はintです。`x.[i].[j]`や`record.items.[i]`のように連結できます。`[]`内は外側の節の`_`・`$`を共有し、`;`で新しい節になります。

アクセスは`/ {exn}`を伴います。負数、整数でない値、vector長以上の添字は例外です。組み込みの非復帰エフェクト`exn : string -> !`が例外メッセージを渡します。

```haskell
safe : -> int / {}
safe = handle {[10,20].[9]} {exn: {-> message k; 0}}
```

この例は0を返します。`exn`の継続は再開できず、ハンドラーの結果がhandle全体の結果になります。未処理のexnは実行をエラーで終了します。`exn "message"`で明示的に例外を発生させることもできます。

[実行例](examples/list-index.nyan)

## optionを返すvectorアクセス（0.42）

```haskell
[10,20,30] -> x;
x.?[1]                      -- Some 20
x.?[9]                      -- None
```

`x.?[i]`は0始まりの添字で、有効なら`Some`、範囲外・負数・非整数なら`None`を返します。`.?[i]`単独でもアクセサーとして使用できます。アクセス自体はexnを発生させず、型は`['a] -> (option 'a)`です。添字の式のエフェクトは通常どおり伝播します。

`option 'a = None | Some 'a`は標準で利用できます。明示的に同じ形で定義している既存のファイルでも使用できます。

```haskell
valueOr fallback (Some value) = value
valueOr fallback None = fallback
main = print (valueOr 0 ([10,20].?[9]))
```

`x.[i]`の例外を投げる挙動は変わりません。

## eachと遅延処理（0.43）

`toVector`はstreemインスタンスの要素を順に集めます。vector、range、ユーザー定義のstreemインスタンス、遅延streamに使えます。`vmap`・`vfilter`も同じ入力に対応し、従来どおり直ちに走査してvectorを返します。

```haskell
toVector (1 ..= 4)                      -- [1 2 3 4]
vmap (1 ..= 3) {* 2}                   -- [2 4 6]
```

遅延版は`map`と`filter`です。結果はeachに対応するstreamで、構築時には走査やコールバックの実行をしません。

```haskell
filter (map (1 ..= 5) {* 2}) {> 5} -> xs;
toVector xs                             -- [6 8 10]
0; each xs {+}                        -- 24
```

mapのブロックは1要素を消費して1値を返し、filterのブロックは1要素を消費してboolを返します。eachのブロックは従来どおり周囲のスタックを引き継ぐため、合計などの畳み込みに使えます。

### yieldするブロックから作る

`fromYield`は、入力を消費しないブロックを遅延streamに変換します。`yield : 'a ->`は標準で利用でき、従来の`effect yield 'a : 'a ->`という明示的な宣言も使えます。

```haskell
fromYield {
    yield 10;
    yield 20;
    yield 30
} -> xs;
toVector xs                             -- [10 20 30]
```

yieldした値はすべて同じ型である必要があります。ブロックの最終的な結果スタックは捨てます。各yieldの時点で消費側の処理を呼び、終わってから生成を再開するため、中間vectorを作りません。消費側が例外などで中断すると生成も中断し、残りの処理を実行しません。

streamは結果をキャッシュせず、走査するたびに再実行します。キャプチャしたmutable変数は走査時点の値を参照します。値を固定したい場合はtoVectorでvectorにしてください。

### 遅延処理のエフェクト

```haskell
logged : -> (stream int { -> / {io} }) / {}
logged = map [1,2,3] {dup; print}

main : -> [int] / {io}
main = toVector logged
```

streamの型は`stream 要素型 { -> / エフェクト行 }`です。構築自体は純粋で、ブロックや元streamのエフェクトはeach・toVectorなどで走査した時に発生します。fromYieldはyieldだけを内部で処理し、他のエフェクトは走査時に外側へ伝えます。

[実行例](examples/lazy-iteration.nyan)

## break・ラベル付きエフェクト・mask（0.44）

組み込みの`break : -> !`は、最も内側のループを終了するエフェクトです。while・each・vmap・vfilter・fold・toVector・reverse・sort・sortByが処理します。各ループから漏れないbreakは、外側のエフェクト行から除かれます。

```haskell
0; each [1,2,3] {
    when ($ == 2) {break};
    +
}
-- 1
```

反復の途中でbreakすると、その反復は未完了として持ち越しスタックをチェックポイントへ戻します。each/vmap/vfilter/foldでは反復開始時、whileの本体では条件がTrueを返した直後です。whileの条件内でbreakした場合は条件の評価前へ戻します。完了済みの反復の結果は残ります。mutable変数への代入や出力など、実行済みの副作用は戻しません。

### 宛先を名前で指定する

```haskell
@outer each (1 ..= 3) {
    -> x;
    each (1 ..= 3) {
        -> y;
        when (x + y > 4) {break@outer};
        print #(x,y)
    }
}
```

`@name`は直後のwhile・each・vmap・vfilter・fold・toVector・reverse・sort・sortBy・handle・fromYieldにラベルを付けます。ラベルの範囲はその呼び出し式です。セミコロンやカンマで終わるため、引数の中でラベルを付ける場合は`(@name handle ... ...)`のように括弧で囲めます。

一般の操作にも`operation@name`が使えます。

```haskell
effect ask : -> int
main = @outer handle {
    handle {ask@outer} {ask: {-> k; resume 2 k}}
} {ask: {-> k; resume 1 k}}
-- 1
```

fromYieldにもラベルを付けられます。例えば内側の生成ブロックから`yield@outer 10`を呼ぶと、`@outer fromYield`へ値を渡します。ラベルは字句スコープで解決され、内側に同名ラベルがあればそちらを指します。

存在しないラベル、対象が処理しない操作、エフェクトでない関数への修飾、ラベル参照を持つブロックの外部への返却やmutable変数への持ち出しは型エラーです。fromYieldが自身のラベルを内部に持つstreamは保存・再走査できます。ラベルは走査中だけ有効になります。

### mask

```haskell
mask ask {call action}          -- askの最も内側のハンドラーを1個飛ばす
mask ask@outer {call action}    -- outerのaskハンドラーへ送る
```

maskの対象は操作名です。関数やブロックから外へ出てくる、その操作だけを転送します。ブロック内に新しく設けたハンドラーは通常どおり機能し、すでに`ask@other`のように宛先を指定した操作は変更しません。maskを入れ子にすると飛ばすハンドラーの数が増えます。maskのブロックは実行され、通常のquotationと同じく独立した節から始まります。

`break@outer`は`mask break@outer {break}`に相当します。未処理のbreakや、maskで宛先を失った操作は実行エラーです。型推論は操作の宛先とmaskの深さを追跡するため、内側のハンドラーだけで処理済みとは見なしません。

[実行例](examples/labeled-effects.nyan)

## streemクラスと列変換（0.45）

走査できる型の制約名を`each`から**`streem`**へ変更しました。メソッド名は`each`、遅延値の型名は`stream`のままです。`lmap`・`lfilter`は`map`・`filter`へ改名しました。古い関数名やクラス名は通常のソースでは使用できません。

```haskell
data box 'a = Box ['a]
instance streem (box 'a) where
    item : 'a
    each (Box xs) f = each xs f

collect : streem 'c 'a => 'c -> ['a] / { | 'e}
collect xs = toVector xs
```

| 遅延streamを返す | vectorを返す | 動作 |
|---|---|---|
| `map xs f` | `vmap xs f` | 要素を変換 |
| `filter xs p` | `vfilter xs p` | 条件を満たす要素を残す |
| `take xs n` | `vtake xs n` | 先頭から最大n個 |
| `skip xs n` | `vskip xs n` | 先頭のn個を飛ばす |
| `takeWhile xs p` | `vtakeWhile xs p` | 条件を満たす間だけ取る |
| `skipWhile xs p` | `vskipWhile xs p` | 条件を満たす間だけ飛ばす |
| `flatMap xs f` | `vflatMap xs f` | 要素を列へ変換して1段平坦化 |
| `flatten xss` | `vflatten xss` | 列の列を1段平坦化 |

どちらの列も、入力にはvectorに限らずstreemインスタンスを受け取れます。vflatMapのブロックが返す値やvflattenの内側の値もstreemであればよく、rangeやユーザー定義の型にも対応します。

```haskell
toVector (take (map (1 ..= 10) {* 2}) 3)    -- [2 4 6]
vtakeWhile [1,2,3,1] {< 3}                 -- [1 2]
vskipWhile [1,2,3,1] {< 3}                 -- [3 1]
vflatMap [1,2] {-> n; [n,n + 10]}          -- [1 11 2 12]
vflatten [[1,2],[],[3]]                     -- [1 2 3]
```

nは非負の安全な整数です。負数・小数・安全な整数の範囲外ならexnを発生させます。遅延版でも個数の検証は構築時に行います。vtakeのnが0なら生成元は開始しません。vtakeはn番目を渡した直後に止まり、次の要素やその間の副作用を先読みしません。vtakeWhileは最初にFalseとなった要素を消費して止まり、その要素を結果には含めません。vskipWhileは最初のFalse以降、述語を呼ばず残りを渡します。

### breakとの組み合わせ

すべての変換は、走査中のbreakを処理します。処理済みの要素は残し、未完了の要素以降を捨てます。遅延版のbreakハンドラーは走査時に有効になり、名前を付けることもできます。

```haskell
toVector (@mapped map [1,2,3] {
    when ($ == 2) {break@mapped};
    * 10
})
-- [10]
```

変換を重ねた場合、breakは対応する最も内側の操作を止めます。下流のeachで起きたbreakを上流の変換が捕まえることはありません。`mask break {…}`や`break@outer`で外側を対象にすることもできます。vtakeの個数制限による停止は内部のキャンセルであり、ユーザーのbreakハンドラーには届きません。

遅延変換のブロックは1要素を消費して1値を返します。新設したvector版の述語・vflatMapブロックも同じです。既存のvmap・vfilter・eachが持つ周囲のスタックを引き継ぐ機能は維持しています。遅延変換は走査ごとに再実行され、結果をキャッシュしません。

[実行例](examples/streem-transforms.nyan)


## 出力型からのinstance選択（0.46）

クラスの型引数はメソッドの入力に直接現れる必要がなくなりました。戻り値だけに現れるメソッドや、vector・ADTなどの内側に現れるメソッドも定義できます。

```haskell
class zero 'a where
  zero : -> 'a

instance zero int where
  zero = 0

instance zero string where
  zero = ""

origin : -> int
origin = zero

emptyText : -> string
emptyText = zero

getZero = zero
main = print origin; print emptyText; print (getZero; + 1)
```

`getZero`の推論型は`zero 'a => ..s -- ..s 'a`です。呼び出しごとに、型注釈や後続の処理から決まる型でinstanceを選びます。多相関数、quotation、遅延streamを経由しても制約を引き継ぎます。Go生成もこの方式に対応しています。

`zero`だけを実行したり、`zero; drop`と書いたりすると、対象型が決まらないため`Ambiguous class method`になります。instanceが一つしかなくても自動選択はしません。`:type zero`は実行しないため制約付きの型を表示できます。`{zero}`を作るだけなら実行時のinstance選択は不要です。

関連型は引き続きinstanceの対象型から決まります。関連型の結果だけから対象型を逆算する規則や、instanceの重複を認める規則は追加していません。サンプルは`examples/result-dispatch.nyan`です。


## 複数代入・mutable引数・定義区切り（0.47）

`!`の右辺は新しい節です。更新前の対象変数を左から右に積んだスタックに対して、`_`・`$`を捕捉してから右辺を実行します。

```haskell
3 -> mut x
x ! _ * _                      -- x = 9

2 -> mut x; 3 -> mut y
x, y := y, x + y               -- x = 3, y = 5
-- 同じ初期値に対して以下も同じ更新
x, y ! _, _1 + _
```

複数代入は右辺の結果をすべて求めてから、左から順に書き込みます。右辺の結果数は対象変数の数と一致する必要があります。対象はすべてmutableで、同じ変数を二度指定することはできません。複数代入・更新の後に別の処理を書く場合は`;`または改行で区切ります。右辺自体で複数の節を使う場合は`x ! ($; *)`のように括弧で囲みます。

関数引数にも`mut`を付けられます。呼び出し側の変数そのものを変更する参照渡しではなく、関数内にmutableな束縛を作ります。

```haskell
square mut x = x ! _ * _; x
fib mut x mut y = each (1 ..= 6) {drop; x, y ! _, _1 + _}; #(x, y)
```

`;;`は定義の終わりを明示します。同じ行に複数の定義を書けます。ローカル定義で明示的な`;;`を使うと、その手前の`;`は関数本体の節区切りです。従来の改行・インデントによる定義も使えます。

```haskell
one = 1;; two = 2;; main = one, two
main = (f mut x = x ! + 1; x;; f 4)
```

0.57から`//`とfloorDivは廃止しました。整数の`/`は0方向に切り捨てます。数値型とnumクラスについては末尾の0.57の節を参照してください。


## withによるコピー更新（0.48）

`with`は指定した部分だけを書き換えた新しい値を返します。元のrecord・tuple・listや、同じ値を参照している別の変数は変更しません。複数の更新は`;`で区切り、左から順に適用します。

```haskell
{x: 10, y: 5} -> r
r with {.x = 20; .y ! + 2} -> r2
#(1, 2, 3) with {.1 = 5}
[0, 1, 2] with {.[1] = 3}
{x: {y: [0, 1, 2]}} with {.x.y.[2] ! + 10}
```

`=`は新しい値を指定します。`!`は選択した部分の現在値を積んだ新しい節で右辺を実行し、1つの結果で置き換えます。`with {.x ! _ * _}`や`with {.x ! ($; *)}`とも書けます。後者のように更新の右辺で複数の節を使う場合は括弧で囲んでください。

左辺を省略した`with {...}`はスタックの値を1つ受け取って更新結果を返します。関数定義やquotationで使えます。

```haskell
move = with {.x ! + 2; .y ! + 1}
main = {x: 0, y: 0}; move
```

mutable変数のパスには再代入の糖衣構文があります。

```haskell
{x: {y: [1, 2, 3]}} -> mut r
r.x.y.[1] := 10  -- r := r with {.x.y.[1] = 10}
r.x.y.[1] ! + 2  -- r := r with {.x.y.[1] ! + 2}
```

存在する部分の更新だけを許します。recordの未定義フィールド、tupleの範囲外、非数値のlist添字は型エラーです。listの範囲外・負数・小数の添字は`exn`を発生させます。添字は各更新につき一度だけ評価し、更新先の検査後に右辺を評価します。

immutableなコピー更新ではrecordフィールドやtuple要素の型を変えられます。listの要素型は均一のままで、mutable変数への再代入では変数全体の型も維持する必要があります。その他のrecordフィールドはrow polymorphismで保持します。

サンプル: `examples/with-update.nyan`。

## vectorとstream（0.49・破壊的変更）

コレクションの公開名をvectorにしました。`[int]`と`vector int`は同じ型です。実体はVMではJavaScriptの動的配列、Goでは連続領域を持つsliceです。`push`は末尾へ値を追加します。

```haskell
[0, 1, 2]; push 3; push 4  -- [0 1 2 3 4]
```

見かけ上のimmutableな動作は維持します。flow解析で新しく生成したvectorやローカル変数の最後の参照を追跡し、別の参照から観測されないと証明できる`push`・前置`concat`・vector直下の添字更新ではストレージを再利用します。Goのappendは容量が足りる場合に既存領域を使い、足りなければ拡張します。

別名、closure、record、streamへの保存、mutable cell、REPLの永続変数、外部から渡された値など、所有権を証明できない場合はコピーします。関数の境界や複雑な制御フローも保守的に扱います。所有権のための注釈や明示的なmoveは不要です。

```haskell
[1] -> xs
push xs 2      -- [1 2]
xs             -- [1]のまま
```

命名を以下のように変更しました。元の関数名で意味が変わるものがあるため、既存コードの移行が必要です。付属examplesは移行済みです。

| 0.48以前 | 0.49以降 | 動作 |
| --- | --- | --- |
| smap / sfilter | map / filter | 遅延stream |
| stake / sskip | take / skip | 遅延stream |
| stakeWhile / sskipWhile | takeWhile / skipWhile | 遅延stream |
| sflatMap / sflatten | flatMap / flatten | 遅延stream |
| map / filter | vmap / vfilter | 即時にvectorを生成 |
| take / skip | vtake / vskip | 即時にvectorを生成 |
| takeWhile / skipWhile | vtakeWhile / vskipWhile | 即時にvectorを生成 |
| flatMap / flatten | vflatMap / vflatten | 即時にvectorを生成 |
| toList | toVector | streemからvectorへ収集 |

```haskell
map [1, 2, 3] {* 2}; take 2; toVector  -- [2 4]
vmap [1, 2, 3] {* 2}                  -- [2 4 6]
```

各変換は引き続きstreem実装型を入力にでき、breakにも対応します。`each`や`fold`などの消費処理、`Push`・`::`・`++`の既存の値とパターンの意味は維持しています。新しいvector型と衝突するため、旧サンプルのユーザー定義型vectorはvec2へ改名しました。

0.38〜0.48のソースは`node migrate-v048.mjs OLD.nyan NEW.nyan`で組み込み関数名を移行できます。元ファイルと既存の出力ファイルは上書きしません。独自のvector型を宣言している場合は、予約型との衝突を避けるため先に別名へ変更してください。


### ループが処理するeffectの型表示

`:type while`では、条件・本体の両blockに`break`を明示します。呼び出し全体のeffect行からはbreakを除きます。

```text
..s1 { ..s1 -- ..s bool / {break | 'e1} } { ..s -- ..s1 / {break | 'e} } -- ..s / { | 'e, 'e1}
```

このbreakは、そのコールバックで使用でき、whileが処理する操作を表します。純粋なblockがbreakを実際に発生させるという意味ではありません。`loop = while {True} _`などのラッパーにも型情報を保持します。ユーザー定義関数に渡すblockにも、次節の`@label {...}`形式でラベルを指定できます。


## blockのラベル（0.50）

`@name { ... }`はblockにラベルを付けます。ラベルはblockを実行するたびに、その呼び出し位置のエフェクト処理環境に結び付きます。関数の内部実装を調べてhandlerを選ぶ処理はありません。

```haskell
loop = while {True} _
main = 1; loop @a {
  * 2
  print $
  when ($ > 2000) {break@a}
}
```

`break@a`はblock内に作られたloopを通過し、blockの呼び出し位置から外側にある最寄りのbreak handlerへ届きます。`ask@a`や`yield@a`も同じ規則です。ラベルなしの操作は従来どおり、その操作位置から最寄りのhandlerを使います。

```haskell
effect ask : -> int
main = handle @outer {
  handle @inner {
    print ask@inner -- 20
    print ask@outer -- 10
  } {ask: {-> k; resume 20 k}}
} {ask: {-> k; resume 10 k}}
```

同じラベルでも、操作ごとに呼び出し位置から対応するhandlerを探します。例えばaskとputを別々の外側handlerで処理できます。対応するhandlerがなければ、その操作は関数のエフェクト型に残ります。

ラベルの名前はblock内の字句スコープで解決します。ラベル付きblock自体は変数に保存して再利用でき、呼び出すたびに新しい宛先に結び付きます。ただし、実行中のラベルを参照する内側のblockを返したり、外側のmutable変数へ保存したりすることはできません。`fromYield @a {yield@a 1; yield@a 2}`はstreamの走査ごとにラベルを結び直すため、保存・再走査できます。

旧形式の`@name while ...`なども引き続き使えます。`mask break { ... }`はhandlerを一つ飛ばし、`mask break@a { ... }`はblockのラベルへ転送します。

[実行例](examples/block-labels.nyan)


## streamの集約・整列（0.51）

`fold`はvector専用ではなく、`streem`を実装するすべての型に使えます。vector、range、遅延stream、ユーザー定義のstreemを同じように処理します。引数の順序は`fold xs 初期値 block`です。blockには累積値、要素の順に渡し、返された値を次の累積値にします。

```haskell
fold (map (1 ..= 5) {* 2}) 0 {+} -- 30
```

次の関数は入力を走査し、結果を新しいvectorとして返します。入力のvectorを変更しません。

| 関数 | 動作 |
| --- | --- |
| `reverse xs` | 要素を逆順に並べる |
| `sort xs` | 要素の`ord`インスタンスの`<`で昇順に並べる |
| `sortBy xs key` | `key`が返す値の`ord`インスタンスの`<`で昇順に並べる |

```haskell
reverse (1 ..= 4)                         -- [4, 3, 2, 1]
sort [3, 1, 2, 1]                        -- [1, 1, 2, 3]
sortBy [{score: 3}, {score: 1}] {.score} -- [{score: 1}, {score: 3}]
sortBy [1, 3, 2] {0 -}                  -- [3, 2, 1]
```

`sort`と`sortBy`は安定ソートです。同じキーの要素の順序を保ち、`sortBy`のkey blockは各要素に対して一度だけ実行します。key blockは1消費1生産で、IOなどのエフェクトは関数の型に反映されます。数値のほか、`ord`を定義したADTもキーに使えます。

これらは`break`に対応します。`fold`では処理を完了した最後の累積値を返します。収集中やキー評価中のbreakでは、それまでに収集できた要素を逆順化・整列して返します。外側のblockラベル宛てのbreakは外側へ転送します。

値の表示も現在の前置構文に合わせました。REPL・`show`・`print`・Go native実行で、vectorは`[1, 2, 3]`、コンストラクタは`(Some 1)`や`(Node (Leaf 1) (Leaf 2))`のように表示します。引数のない`None`などの表示はそのままです。

[実行例](examples/stream-collect.nyan)


## 文字列とshowクラス（0.52）

`++`はvectorと文字列の両方に使えます。文字列同士を連結する組み込みの`append string`を追加しました。`concat`は引き続きvector用です。

```haskell
"hello" ++ ", " ++ "world" -- "hello, world"
```

| 関数 | 結果 |
| --- | --- |
| `split text separator` | 区切り文字列で分割する遅延`stream string` |
| `join xs separator` | `streem`の文字列要素を区切り文字列で結合した`string` |
| `toNum text` | 数値なら`Some int`、失敗なら`None` |
| `parseNum text` | 数値なら`int`、失敗なら`exn` |

```haskell
toVector (split "a,,b," ",")      -- ["a", "", "b", ""]
join (split "a,b,c" ",") " / "   -- "a / b / c"
join (map (1 ..= 3) {show}) ", " -- "1, 2, 3"
toNum " -1.25e2 "               -- (Some -125)
toNum "oops"                    -- None
parseNum ".5"                   -- 0.5
```

区切りは正規表現ではなく文字列として扱い、複数文字も指定できます。先頭・末尾・連続する区切りで生じる空要素を保持します。空の区切り`""`はUnicodeコードポイント単位の分割で、`split "" ""`は空のstreamです。非空の区切りでは`split "" ","`は空文字列1個を返します。streamは再走査でき、`take`などで途中まで読むこともできます。

`join`はvector・range以外も含むstreem実装型を受け取れますが、要素の型はstringでなければなりません。空の入力は`""`です。`break`に対応し、途中で終了した場合はそれまでの要素を結合して返します。走査時のエフェクトも推論されます。

数値変換は前後のASCII空白を取り除き、符号付き10進数・小数・指数表記を受け付けます。空文字、途中に余計な文字があるもの、16進数、NaN、Infinity、有限範囲を超える値は失敗します。`parseNum`の失敗は`handle`で処理できます。

```haskell
handle {parseNum "bad"} {exn: {-> message k; 0}} -- 0
```

`show`は次に相当する組み込みクラスになりました。

```haskell
class show 'a where
  show : 'a -> string
```

標準の構造表示をデフォルトとして提供し、instanceがあればその型の表示に使います。関数`f = show`の型には`show 'a`制約が現れます。instanceはstringを返す純粋な関数として検査されます。

```haskell
data person = Person string int
instance show person where
  show (Person name age) = name ++ ":" ++ (show age)

main = print (show (Person "Ada" 37)) -- Ada:37
```

型引数を持つ型にも定義できます。

```haskell
data box 'a = Box 'a
instance show 'a => show (box 'a) where
  show (Box x) = "box(" ++ (show x) ++ ")"
```

instanceは`show`を適用した値の型に対して選びます。デフォルトの構造表示は内部要素を構造的に表示するため、内部要素にもカスタムinstanceを使いたい場合は、上のboxのように明示的に`show`を呼び出します。文字列のデフォルト`show`は引用符付きです。

REPLのstack表示と`print`は従来の汎用表示を維持します。任意の型を受け取るeffect handlerでも利用でき、カスタム表示を出力したい箇所では`print (show value)`と書けます。

[実行例](examples/strings-show.nyan)


## 文字列補間（0.53）

```haskell
"{} {}" 3 4          -- "3 4"
"3 * 4 = {3 * 4}"   -- "3 * 4 = 12"
"\{\}"              -- "{}"
```

空の`{}`の個数だけスタックから値をまとめて取り出し、左から右に対応させます。式のある箇所は0消費1生産の式として左から右へ評価します。ローカル変数、record、入れ子の文字列、エフェクトも使えます。`_`・`$`は外側の節と共有し、補間内の`;`は新しい節を開始します。

値にはshowを適用し、stringのデフォルト表示は引用符を外して埋め込みます。カスタムshow instanceにも対応します。波括弧そのものは`\{`・`\}`と書きます。従来の改行・引用符・バックスラッシュのescapeも使えます。

## 組み合わせstream（0.54）

| 関数 | 要素の型・内容 |
| --- | --- |
| `permutations xs k` | 異なる入力位置からk要素を選ぶ順列。要素はvector |
| `combinations xs k` | 入力順を保ってk要素を選ぶ組み合わせ。要素はvector |
| `combinationsWithReplacement xs k` | 同じ入力位置を繰り返し選べる組み合わせ。要素はvector |
| `cartesianProduct xs ys` | 直積。要素は`#(左要素, 右要素)` |
| `powerset xs` | 全部分集合。要素はvector、要素数の少ない順 |

```haskell
toVector (combinations [1,2,3] 2) -- [[1, 2], [1, 3], [2, 3]]
toVector (permutations [1,2] 2)   -- [[1, 2], [2, 1]]
toVector (combinationsWithReplacement [1,2] 2) -- [[1, 1], [1, 2], [2, 2]]
toVector (cartesianProduct [1,2] ["a"]) -- [#(1 "a"), #(2 "a")]
toVector (powerset [1,2])         -- [[], [1], [2], [1, 2]]
```

入力はstreem実装型です。各走査の開始時に有限の入力を収集し、結果を一件ずつ生成します。全結果を事前生成しないため、`take`や`break`で途中終了できます。入力に無限streamを直接渡す場合は、先にtakeなどで有限にしてください。再走査すると入力も再走査し、走査時のエフェクトが再実行されます。

k=0では空vectorを1個返します。kが入力数を超える順列・通常の組み合わせは空streamです。負数・小数・安全な整数でないkは構築時にexnを発生させます。同じ値が複数の入力位置にあれば、同じ値の結果も複数回生成します。入力走査のbreakはそこまでの入力を採用し、結果を読む側のbreakは生成を終了します。

[実行例](examples/combinatorics.nyan)


## 標準のloopとiterate（0.55）

`loop body`は`while {True} body`に相当し、breakするまでblockを繰り返します。スタック上の状態を次の反復へ引き継ぎます。

`iterate start cont`は遅延streamです。どちらの引数もblockで、startは空のスタックから状態を作り、contはその状態を更新します。状態は複数の値でも構いません。startの実行後に先頭の値をpeekして最初の要素を生成し、その後はcontで更新してから次の要素を生成します。

```haskell
toVector (take (iterate {1, 0} {_1 + _, _1}) 8)
-- [0, 1, 1, 2, 3, 5, 8, 13]

toVector (iterate {0} {when ($ >= 3) {break}; + 1})
-- [0, 1, 2, 3]

toVector (iterate {break} {+ 1})
-- []

0; loop {when ($ >= 3) {break}; + 1} -- 3
```

startとcontのどちらもbreakに対応します。start中のbreakは生成前に終了し、cont中のbreakはそれまでに生成した要素を残して終了します。blockラベルも使えます。`iterate @s {...} @c {...}`で、start内部の`break@s`、cont内部の`break@c`をそれぞれの反復境界へ届けられます。外側のラベルへのbreakは外側へ転送します。

contは状態の個数・型を維持し、少なくとも生成する先頭の値を残す必要があります。start・contのエフェクトはstreamの潜在エフェクトとして推論されます。走査するたびにstartから実行し直します。takeやbreakで必要な分だけ走査できます。

これらは通常の標準関数として提供し、利用側で同名の関数を定義することもできます。

[実行例](examples/iterate.nyan)


## 外側のスタックcapture（0.56）

`_`・`$`を繰り返すと、quotation blockの外側のスタックをcaptureします。2文字なら1つ外側、3文字なら2つ外側です。underscoreはpop、dollarはpeekです。添字を省略すると0（先頭）になります。

```haskell
3; {__} -> q     -- 3を取り出してqへcapture
call q          -- 3
call q          -- 3（繰り返し呼べる）

3; {$$}; call   -- stack: 3, 3
3; {{___}}; call; call -- stack: 3
10, 20; {__1 + __}; call -- 30
```

外側の参照も、対象の節が始まる時点のスタックから束縛します。blockが実行された時点の呼び出し元スタックを読む仕組みではありません。同じ対象・添字の参照は節内で同じ値を使い、popは1回です。`__ * __`は外側の同じ値を2乗します。通常の`_0`と外側からの`__0`が同じ節を対象にする場合も同じスナップショットを使います。同じ対象の節・添字でpopとpeekを混在させるとエラーです。

`_`はblock実行時の内部スタック、`__`は外側のblockを作る節のスタック、`___`はさらに外側を参照します。対応する外側のblockがない場合は構文エラーです。括弧・vector・record・文字列補間はblockの深さを増やしません。

captureした値はclosureの環境に保存され、blockを返した後やREPLの次の入力からでも利用できます。型はcapture時に推論し、Goではローカル変数からclosure環境へ直接保存します。

iterateは0.56.1から初期状態を最初に生成します。takeで最初の要素だけ取得する場合、contは実行しません。


## Gitでの管理

このフォルダーがGitリポジトリのルートです。ソース・テスト・サンプル・migration・仕様書を記録します。`native/`内の生成済みGoソースと実行ファイル、依存パッケージ、ローカル設定は`.gitignore`で除外します。

```sh
git status
git diff
git add <変更したファイル>
git commit -m "変更の説明"
```

検証は`npm test`で実行できます。GoのnativeテストにはGoのインストールが必要です。


## 数値型・char・byte・indexer（0.57、破壊的変更）

従来の浮動小数点型numは`float`へ変更しました。整数は`int`、8bit符号なし整数は`byte`、Unicodeスカラー値1個は`char`です。`num`は値の型ではなく数値型クラスになりました。

| 型 | 内容 |
| --- | --- |
| `int` | Go nativeでは符号付き64bit整数。REPLではJavaScriptのNumberによる整数で、厳密な整数精度は53bitまで |
| `float` | 64bit浮動小数点 |
| `byte` | 0〜255の整数 |
| `char` | Unicodeスカラー値（`'a'`、`'あ'`、`'😀'`） |

`3`などの整数リテラルは未確定ならintになります。必要な文脈があればbyteまたはfloatとして扱います。小数点・指数を含む`3.0`・`3e0`はfloatです。byteに推論する整数リテラルは0〜255でなければなりません。確定済みの異なる数値型を混ぜる演算は型エラーです。

```haskell
b : -> byte
b = 250
f : -> float
f = 3
main = print (b + 5); print (f / 2)
-- 255
-- 1.5
```

`//`は廃止しました。`7 / 2`は3、`-7 / 2`は-3となり、整数の除算は0方向へ切り捨てます。`7.0 / 2.0`は3.5です。0.58では`+ - * / % ^`はそれぞれadd・sub・mul・div・mod・powクラスのメソッドです。`f = +`の型には`add 'a`制約が付きます。numはこれらを継承します。数値型には既定のinstanceがあり、ADTにもnum instanceを実装できます。比較のordは別のクラスで、charの比較にも対応します。charは数値型ではありません。

`toInt`・`toFloat`・`toByte`は数値型間の明示的なキャストです。整数へは0方向へ小数部分を切り捨てます。変換先の範囲を超える値はexnです。byteの演算結果が0〜255を超えた場合は実行エラーになります。Goのint演算は64bitの整数演算です。

```haskell
toInt 3.9                 -- 3
toFloat 3 / 2             -- 1.5
toByte 42                 -- byteの42
toInt 1 + toFloat 2       -- 型エラー
```

文字列はUTF-8として添字を解釈し、結果はbyteになります。`chars : string -> [char]`はUnicodeスカラー値のvectorを返します。

```haskell
"あ".[0]                 -- byteの227
"あ".[1]                 -- byteの129
"あ".[2]                 -- byteの130
chars "日本😀"           -- ['日', '本', '😀']
"abc" with {.[1] = 100}  -- "adc"（100はbyteに推論）
```

読み取りは`indexGet`クラスの`at`、更新は`indexSet`クラスの`setAt`を使います。keyとitemは関連型です。vectorはintをキー、要素型をitemとして実装し、stringはintをキー、byteをitemとして両方を実装します。

```haskell
data box 'a = Box ['a]
instance indexGet (box 'a) where
  key : int
  item : 'a
  at (Box xs) i = at xs i
instance indexSet (box 'a) where
  key : int
  item : 'a
  setAt (Box xs) i x = Box (setAt xs i x)
```

`xs.[i]`はat、`with {.[i] = x}`・`xs.[i] := x`・`xs.[i] ! f`はsetAtのinstanceで処理します。どちらも永続的な更新で、元の値への別の参照は保持されます。読み取りだけを実装する型も作れます。`xs.?[i]`は読み取り時のexnをNoneに変換します。

添字の型はvector・stringではintです。floatの添字は型エラー、範囲外はexnになります。stringの更新結果が正しいUTF-8でなければexnとなり、元の変数は変更されません。

既存のtoNum・parseNumはfloatを読み取る互換名として残しています。旧ソースの型注釈numは用途に応じてfloatまたはintへ変更してください。

[実行例](examples/scalars-indexers.nyan)


## クラス継承・toChar・bytes（0.58）

`class 親制約, 親制約 => 子クラス 'a where`で継承します。親には子と同じ型引数を渡します。子の制約があれば親のメソッドも使えます。

```haskell
class show 'a => named 'a where
  name : 'a -> string

data person = Person string
instance named person where
  name (Person x) = x
  show (Person x) = "person:" ++ x

render : named 'a => 'a -> string
render = show
```

instanceでは継承したメソッドもまとめて実装できます。親のinstanceを別に定義済みならその実装を再利用するので、同じメソッドを重ねて定義する必要はありません。再利用する親の文脈制約も満たす必要があります。親の実装と異なる上書き、循環継承、無関係な親同士で衝突する関連型は型エラーになります。関連型も継承され、子のinstanceで指定します。

numはadd・sub・mul・div・mod・pow・toInt・toFloat・toByte・toCharを継承する標準クラスです。変換関数もそれぞれ同名のクラスメソッドになりました。int・float・byteには全ての標準instanceがあります。`num 'a`制約から四則演算や変換を呼べますが、`+`だけを使う関数の推論結果は最小限の`add 'a`制約です。

```haskell
asFloat : num 'a => 'a -> float / {exn}
asFloat = toFloat

toChar 65          -- 'A'
toChar 128512      -- '😀'
toChar 'あ'        -- 'あ'
bytes "あ"         -- [227, 129, 130] : [byte]
chars "あ"         -- ['あ'] : [char]
```

`toChar : toChar 'a => 'a -> char / {exn}`は数値をUnicodeスカラー値として解釈します。floatは0方向へ切り捨て、0〜0x10FFFFの範囲外やサロゲート領域0xD800〜0xDFFFはexnになります。charに対するtoCharはその文字を返します。ADTにも変換のinstanceを実装できます。`bytes : string -> [byte]`はUTF-8の各byteをvectorにします。

[実行例](examples/class-inheritance.nyan)
