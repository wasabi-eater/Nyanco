function chapter(chapterTitle, rows) {
  return rows.map(([id,title,explanation,source,expected,exercise,extra]) =>
    ({id,title,explanation,source,expected,exercise,chapter:chapterTitle,...extra}));
}

export const lessons = [
...chapter('はじめての Nyanco', [
['stack','セミコロンで値をつなぐ',[
  'プログラムは main から始まります。スタックは値を積み重ねておく場所です。数を書くとその値が一番上（トップ）に積まれ、次の処理がそこから値を受け取れます。',
  'メソッドチェーンのように ; の左から右へ読めます。5 を積み、+ 3 が 8 に置き換え、* 2 が 16 に置き換えます。最後の print が 16 を取り出して表示します。'
],`main =
    5; + 3; * 2; print`,['16'],'+ 3 と * 2 の順番を入れ替え、結果を比べてください。'],
['stack-steps','スタックに二つ以上の値を置く',[
  'コンマで区切った 10, 3 は、10 を下に、3 を上に積みます。dup はトップを複製します。引数を省いた * や + は、上の二つの値を取り出して結果を一つ積みます。',
  'コメントの [10, 3, 3] は、スタックを下から上へ書いたものです。* が二つの 3 を掛けている間も、一番下の 10 は残っています。-- から行末まではコメントです。'
],`main =
    10, 3; dup  -- [10, 3, 3]
    *           -- [10, 9]
    +; print    -- 19 を表示し、スタックは空に`,['19'],'3 を 4 に変え、各処理の後にスタックに何が残るか追ってください。'],
['calls','呼び出しの順序',[
  '空白で並べた呼び出しは、先頭が実行する語、残りが引数です。print 7 は、7 を積んでから print を実行します。',
  '引数は左から右へ評価されます。9, 4; subtract では、コンマで二つの値を順に積み、; の後で subtract がその二つを受け取ります。'
],`subtract x y = x - y
main =
    subtract 9 4; print
    9, 4; subtract; print`,['5','5'],'引数の順を逆にするとどうなるでしょうか。'],
['clauses','改行・セミコロン・コンマ',[
  '改行と ; は命令を順に実行し、新しい節を始めます。コンマも命令を順に実行しますが、同じ節の中にとどまります。',
  '同じ節で $ が何度出ても、節の開始時のトップを参照します。最初の行では 10 が二度表示され、次の行では 20 と 30 が別々の節のトップになります。',
  '行末に \\ を書くと改行を無視し、次の行へ続けられます。最後の例では print の引数が次の行に続きます。行継続だけでは新しい節にならず、_ や $ の参照先も切り替わりません。'
],`main =
    10; print $, 20, print $; drop; drop
    20; print $; drop; 30; print
    print \\
        (2 + 3)`,['10','10','20','30','5'],'行継続の \\ を外すと、print の受け取る値がどう変わるか確認してください。'],
['operators','二項演算と優先順位',[
  '二つの値を取る演算は 2 + 3 * 4 のように中置で書けます。乗算が先に評価されます。括弧を使うと評価のまとまりを変えられます。',
  '関数呼び出しは二項演算より強く結合します。比較を連ねると、真ん中の値を一度評価し、左右の条件を両方調べます。'
],`double n = n * 2
main =
    2 + 3 * 4; print
    (2 + 3) * 4; print
    double 3 + 1; print
    3 < 4 <= 5; print`,['14','20','7','True'],'最後の 5 を 3 に変えてください。'],
['sections','演算子の項を省略する',[
  '演算子の項を省略すると、実行時に足りない値をスタックから補います。10; + 2 は 10 + 2 と同じ結果です。',
  '両辺がない + なら二つの値を取り出します。演算子が連なる場合も、優先順位を使って式を組み立てます。'
],`main =
    10; + 2; print
    3, 4; +; print
    3, 4, 5; + *; print`,['12','7','23'],'+ * を + + に変えて計算結果を比べてください。'],
['references','スタック参照 _ と $',[
  '_ はトップを取り出し、$ はトップを残したまま値を参照します。_1 や $1 はトップの一つ下です。添字は節の実行開始時点を基準に数えます。',
  '同じ添字の _ を何度書いても取り出すのは一度だけです。同じ節で、同じ位置の _ と $ を混ぜるとエラーになります。'
],`main =
    5; _ * _; print
    3, 4; print $1; print; print
    3, 4; print _1; print`,['25','3','4','3','3','4'],'_1 を _ に変えると、どちらの値がスタックに残るか見てください。'],
['logic','真偽値と短絡評価',[
  '真偽値は True と False です。&& は左辺が False なら、|| は左辺が True なら右辺を評価しません。',
  '右辺の括弧内には複数の命令が書けます。右辺が必要になったときだけ、print の出力が現れます。'
],`main =
    print (False && (print "右辺"; True))
    print (True && (print "右辺"; False))
    print (True || False)`,['False','右辺','False','True'],'最初の False を True にして、表示される行を確かめてください。'],
]),
...chapter('関数・束縛・型', [
['functions','引数を持つ関数',[
  'square x = … は、一つの引数に x という名前を付ける関数定義です。呼び出し側の square 7 が、7 を x に渡します。',
  'square : int -> int は一つの int を消費して一つの int を返す型注釈です。注釈がなくても、処理系は本体と使い方を型検査します。'
],`square : int -> int
square x = x * x

main = 7; square; print`,['49'],'平方の計算を三乗に変えてください。'],
['chain-functions','チェーンの一部を関数にする',[
  '関数の本体も、スタックに対する処理のチェーンとして書けます。doubleThenAdd は、呼び出し元が積んだ値を * 2 で二倍にしてから + 1 します。',
  '呼び出した関数が残した値は、そのまま次の処理に渡ります。ここでは 4 が 9 になり、もう一度同じ関数を通ると 19 になります。'
],`doubleThenAdd = * 2; + 1

main =
    4; doubleThenAdd; doubleThenAdd; print`,['19'],'doubleThenAdd の前に + 1 を入れるとどうなるか試してください。'],
['infer','型推論と多相関数',[
  "id の引数と戻り値は同じ型ですが、具体的な型は固定していません。型変数 'a は呼び出しごとに別の型で使えます。",
  '整数リテラルは文脈から型が決まらなければ int になります。1.5 のように小数点がある値は float です。異なる数値型を混ぜるときは明示的に変換します。'
],`id : 'a -> 'a
id x = x
main =
    7; id; print
    "猫"; id; print
    2; float; + 0.5; print`,['7','猫','2.5'],'float を外して型エラーを読んでください。'],
['stack-row','スタック行と複数の戻り値',[
  'Nyanco では値を二つ以上返せます。右側の \'a \'a は、同じ型の二つの値を積むという意味です。',
  'スタック行 ..s は、処理の手前にある任意のスタック部分を表します。両側に同じ ..s があるので、copy が操作するのは最後の一つだけです。'
],`copy : ..s 'a -> ..s 'a 'a
copy = dup
main =
    "手前", 4; copy
    print; print; print`,['4','4','手前'],'copy を二度実行して、print も一つ増やしてください。'],
['bindings','変数宣言と束縛',[
  '式で得られた値に名前を付けるには x <- 式、または 式 -> x を使います。どちらも、評価後にスタック上の値を取り出して名前と結びつけます。',
  '同じ行で次の命令を書くときは ; で束縛を終えます。複数の名前はコンマで区切れます。普通の変数は変更できません。'
],`main =
    x <- 5
    6, 7 -> y, z; print (x + y + z)
    a, b <- 1, 2
    print [a, b]`,['18','[1, 2]'],'y と z を入れ替えて束縛し、[y, z] を表示してください。'],
['mutable','可変変数と再代入',[
  '宣言に mut を付けると、後から同じ型の値に更新できます。x <<- 式 は左に更新先を書き、式 ->> x は右に更新先を書きます。',
  'x ! は現在の値を積んでから右の処理を実行し、その結果を書き戻します。複数更新では右辺を先に評価するので、入れ替えができます。'
],`main =
    mut x, mut y <- 3, 4
    x, y <<- y, x
    x ! + 2, * 3
    9 ->> y
    print #(x, y)`,['#(18 9)'],'x ! の + と * の順番を入れ替えてください。'],
['local','ローカル関数と ;;',[
  '等号による関数定義を、別の関数の本体にも書けます。内側の関数は、その場所で見えている変数を参照できます。',
  '同じ行でローカル関数の定義を閉じて処理を続けるには ;; を使います。通常の ; は定義内の命令を区切ります。'
],`main =
    offset <- 10
    addOffset x = x + offset;;
    print (addOffset 5)`,['15'],'offset を変えてローカル関数の結果を確認してください。'],
['guards','定義の複数節とガード',[
  '同じ名前で複数の定義を書けます。引数のパターンが合う節を上から試します。| の後ろにガードを書くと、条件が True の節だけが選ばれます。',
  'otherwise は条件付きの節で最後に使える既定の分岐です。ガード内で使う n は関数の引数から束縛されています。'
],`sign n
    | n < 0 = "負"
    | n == 0 = "ゼロ"
    | otherwise = "正"

main =
    print (sign -3)
    print (sign 0)
    print (sign 3)`,['負','ゼロ','正'],'別のラベルを返す節を追加してください。'],
]),
...chapter('処理を値として渡す', [
['quotation','quotation と call',[
  '{…} は処理を包んだ値で、quotation と呼びます。quotation を積むだけでは中身は実行されません。call がその処理を取り出して実行します。',
  'quotation は現在のスタックに作用できます。この例では 7 を置いてから plusTwo を実行するので、+ 2 が 7 を受け取ります。'
],`main =
    plusTwo <- {+ 2}
    7; call plusTwo; print`,['9'],'同じ quotation を別の数に対して実行してください。'],
['blocks','do とインデント',[
  'do の後に深くインデントした行を書くと、波括弧と同じように quotation を作れます。本文より浅い位置へ戻ったところで quotation が閉じます。',
  'each は列から一つずつ値を積み、quotation を実行します。do -> x の -> x がその要素を取り出して束縛します。完了の表示はループの外です。'
],`main =
    each [1, 2, 3, 4] do -> x
        when (x > 2) {print (x * x)}
    print "完了"`,['9','16','完了'],'when の条件を変えて表示される値を調べてください。'],
['branches','if と when',[
  'if は真偽値と二つの quotation を取り、真なら一つ目、偽なら二つ目を実行します。when は真のときだけ quotation を実行します。',
  'dup で元の数を残しておくので、if で文字列を選んで print したあと、同じ数を /= 0 でも調べられます。'
],`main =
    -3; dup; < 0; if {"負"} {"非負"}; print
    /= 0; when {print "ゼロではありません"}`,['負','ゼロではありません'],'-3 を 0 にして、when の出力も確認してください。'],
['below','後続を取り込む below',[
  '呼び出しの引数に below を置くと、改行または ; の後から現在のブロックの末尾までが quotation になります。その quotation が below の位置に渡されます。',
  'この例の each は x の束縛から末尾までを受け取ります。内側の when の below は、さらにその後ろの print を取り込みます。'
],`main =
    each [1, 2, 3] below; -> x
    when (x > 1) below
    print x`,['2','3'],'when の条件を x % 2 == 1 に変えてください。'],
['capture','外側のスタックを捕まえる',[
  'quotation 内の _ や $ は、その quotation の実行時のスタックを指します。__ や $$ と二つ並べると、一つ外の節のスタックを作成時に参照します。',
  '$$ は外の値を残し、__ は取り出します。三つ並べると二つ外です。変数を参照する quotation は、変数の束縛を保持します。'
],`main =
    3; {$$} -> saved
    9; call saved; print
    print; print`,['3','9','3'],'$$ を __ に替え、外側に残る 3 のための最後の print を外してください。'],
['while','while とスタックをまたぐ反復',[
  'while の最初の quotation は条件を計算して bool を積みます。真なら bool を取り出して二番目の quotation を実行し、再び条件を調べます。',
  'このループでは数値一つが反復の状態です。条件の $ は状態を保持し、本文の + 1 が次の状態を積みます。'
],`main =
    0; while {$ < 3} {print $; + 1}
    print`,['0','1','2','3'],'上限を 5 に変えて、ループ後の値を確認してください。'],
]),
...chapter('値のかたちとパターン', [
['scalars','整数・浮動小数点・文字・バイト',[
  '整数は int、小数点や指数を含む数値は float です。int の / は小数部分を切り捨てます。byte は 0 から 255 の値です。',
  "char は '猫' のように一つの Unicode スカラー値を表します。文字列は UTF-8 のバイト列として添字を付けられます。vchars と vbytes は別々の見方を vector にします。"
],`main =
    print (7 / 2)
    print (7.0 / 2)
    print (vchars "猫")
    print (vbytes "猫")
    print (char 65)`,['3','3.5',"['猫']",'[231, 140, 171]',"'A'"],'猫を絵文字に替えて、バイト数を見てください。'],
['text','文字列・補間・連結',[
  '文字列は二重引用符で囲み、++ で連結できます。文字列の中の {式} は、その式の結果を文字列にして埋め込みます。',
  '補間の式からは一つの値が得られるようにします。波括弧を文字として出したいときはバックスラッシュでエスケープできます。'
],`main =
    name <- "Nyanco"
    print ("hello " ++ name)
    print "{name}: 3 × 4 = {3 * 4}"`,['hello Nyanco','Nyanco: 3 × 4 = 12'],'名前や補間の計算を書き換えてください。'],
['vectors','vector のリテラルと添字',[
  'vector は同じ型の要素を順に並べた値です。[] の中は空のスタックで実行され、最後に残った値が vector の要素になります。',
  '添字は 0 から始まります。.[i] は範囲外なら exn を投げ、.?[i] は Some または None を返します。vpush で末尾に要素を追加できます。'
],`main =
    xs <- [1, 2 + 3, 9]
    print xs
    print xs.[1]
    print xs.?[8]
    print (vpush xs 11)`,['[1, 5, 9]','5','None','[1, 5, 9, 11]'],'.?[8] を .?[0] に変えてください。'],
['slices','末尾を含む slice',[
  'xs.[開始:末尾] は両端を含む部分vectorを返します。開始を省くと先頭から、末尾を省くと最後までになります。両方を省いた .[:] は書けません。',
  '三つの形式は slice クラスの sliceBetween、sliceFrom、sliceTo という操作です。範囲外の添字は exn になります。部分vectorはストレージを共有し、後から更新するときに必要なコピーを行います。'
],`main =
    xs <- [0, 1, 2, 3]
    xs.[1:2]; print
    xs.[1:]; print
    xs.[:2]; print
    xs; sliceBetween 1 2; vmap {* 10}; print`,['[1, 2]','[1, 2, 3]','[0, 1, 2]','[10, 20]'],'開始と末尾を同じ添字にすると、要素は幾つ残るでしょうか。'],
['concat-patterns','++ で前後を分解する',[
  'パターンでも ++ を使えます。[1, 2] ++ rest ++ [3] は前後の要素を確認し、残りの部分vectorを rest に束縛します。',
  '[x, y] のようなvectorパターンは長さが確定しています。長さが未確定な部分は一つまでなので、a ++ b は書けません。部分vectorはviewとして共有され、vmapや更新で得た値を独立して使えます。'
],`middle ([1, 2] ++ rest ++ [3]) = rest
main =
    [1, 2, 4, 5, 3]; middle; vmap {* 2}; print
    [1, 2, 3] -> [first] ++ restValues
    restValues; print`,['[8, 10]','[2, 3]'],'middle に [1, 2, 3] を渡し、rest が空でも一致することを確認してください。'],
['tuples','タプルと分解',[
  '#(…) は異なる型を一つにまとめるタプルです。普通の括弧は式をまとめますが、# が付いた括弧はタプルを一つ積みます。',
  'タプルの要素には .0、.1 のようにアクセスできます。-> の右に同じ形のパターンを書けば、各要素を別の名前へ束縛できます。'
],`main =
    pair <- #(2, "猫")
    print pair.1
    pair -> #(n, name)
    print "{name}: {n}"`,['猫','猫: 2'],'三番目の要素を追加し、パターンと表示も更新してください。'],
['records','record・フィールド・省略形',[
  'record は名前付きのフィールドを持つ値です。r.name は name を取り出し、.name は record を受け取って同じ操作を行う関数として書けます。',
  '{:name, :age} は {name: name, age: age} の省略形です。パターンで一部のフィールドだけを指定すると、余分なフィールドがある record にも一致します。'
],`say {name: who} = print who
main =
    name, age <- "ミケ", 3
    r <- {:name, :age}
    print r.age
    say r
    r; .name; print`,['3','ミケ','ミケ'],'r に city フィールドを足しても say を使えることを確認してください。'],
['with','値をコピーして更新する with',[
  'with は指定した箇所を更新した値を作ります。フィールド、タプルの位置、vector や辞書の添字を指定できます。',
  '一つなら波括弧を省けます。複数箇所は {…} に入れ、; で区切ります。! はその場所の古い値をスタックに載せてから右の処理を実行します。'
],`main =
    original <- {score: 3, xs: [1, 2]}
    changed <- original with {score ! + 4; xs[0] = 9}
    print original
    print changed`,['{score: 3, xs: [1, 2]}','{score: 7, xs: [9, 2]}'],'score を文字列へ置き換えてください。record のフィールド型は更新で変えられます。'],
['dicts','辞書と条件付き更新',[
  '辞書はキーから値を引くためのデータ構造です。[キー: 値, …] と書き、空の辞書は [:] と書きます。',
  'with [k] ??= 値 は、キーがまだない場合だけ値を追加します。with ?[k] ! 処理 はキーが存在する場合だけ更新します。'
],`main =
    d <- ["猫": 3]
    d2 <- d with ["犬"] ??= 2
    d3 <- d2 with ?["猫"] ! + 1
    print d3.["猫"]
    print d3.?["犬"]
    print d3.?["鳥"]`,['4','(Some 2)','None'],'?["猫"] を ?["鳥"] に変更してください。'],
['adt','data で独自の型を作る',[
  'data は、値が取り得る形をコンストラクターで列挙します。shape の値は Circle か Rect で、| が二つの候補を区切ります。',
  'コンストラクターは引数を持てます。Rect 3 4 を分解するパターン Rect w h では、二つの値が w と h に入ります。'
],`data shape = Circle int | Rect int int
area (Circle r) = r * r * 3
area (Rect w h) = w * h

main =
    print (area (Circle 2))
    print (area (Rect 3 4))`,['12','12'],'Square int を追加し、area の節も一つ増やしてください。'],
['type-alias','型引数・type・deriving',[
  "型引数を持つ data を定義すると、箱の中身の型を後から決められます。box int と box string は同じ形ですが、中の型が異なります。",
  'type は型の別名を作ります。deriving は中身に必要な実装があれば、eq や show などの実装をコンストラクターに基づいて生成します。'
],`data box 'a = Box 'a deriving eq, show
type numberBox = box int
same : numberBox numberBox -> bool
same = ==

main =
    print (same (Box 3) (Box 3))
    print (show (Box "猫"))`,['True','(Box "猫")'],'二つ目の Box 3 を Box 4 にして比較してください。'],
['patterns','case と OR パターン',[
  'case はスタック上の値を複数の分岐で調べます。-> の後がパターン、? の後がその分岐の処理です。失敗したパターンはスタックの値を取り出しません。',
  'p || q は左から最初に一致するパターンを使います。左右で束縛する名前と型は同じにします。otherwise の中では、元の入力を必要なら drop します。'
],`edge = case
    -> [x, 0] || [0, x] ? x
    otherwise drop; 0

main =
    print (edge [0, 6])
    print (edge [8, 3])`,['6','0'],'[8, 3] を [8, 0] に変えてください。'],
['pattern-stack','ワイルドカードと ~',[
  '_ はパターン内ではワイルドカードになり、一致した部分を捨てます。式の中のスタック参照とは役割が違います。',
  '~ は一致した値を名前に束縛せずスタックに置きます。Some(~) を使えば、後続の print がその値を直接受け取れます。'
],`showItem Some(~) = print
showItem None = print "空"

main =
    showItem (Some 7)
    showItem None
    #(2, 9) -> #(_, ~); print`,['7','空','9'],'タプルの _ と ~ を逆にしてみましょう。'],
]),
...chapter('型クラス・変換・操作', [
['option','option と ??',[
  '見つからない可能性を値で表す型が option です。Some x は値あり、None は値なしです。unwrapOr は値がなければ指定した既定値を返します。',
  'x ?? 式 は、値がない場合にだけ式を実行します。右側で出力してみると、Some の場合は実行されないと分かります。'
],`main =
    print (unwrapOr (Some 4) 9)
    print (None ?? (print "既定値を計算"; 9))
    print (Some 4 ?? (print "ここは実行しない"; 9))`,['4','既定値を計算','9','4'],'二つ目の None を Some 2 に変えてください。'],
['classes','class・instance・制約',[
  'class は型ごとに実装できる共通操作を宣言します。instance は具体的な型でその操作を実装します。ここでは person が label という操作を持ちます。',
  "制約 labelable 'a => を付けると、任意の型 'a のうち labelable を実装した型だけを受け取ると明示できます。"
],`class labelable 'a where
    label : 'a -> string
data person = Person string
instance labelable person where
    label (Person name) = "名前: " ++ name

describe : labelable 'a => 'a -> string
describe = label
main = print (describe (Person "ミケ"))`,['名前: ミケ'],'別の data を作り、同じ class の instance を追加してください。'],
['associated','型引数付き instance と関連型',[
  'class の type item は、実装ごとに決まる関連型です。box の中身を取り出すとき、その結果型を item で表せます。',
  "instance unpackable (box 'a) は、どんな 'a の箱にも適用されます。item : 'a で箱の中身の型と戻り値を結びつけます。"
],`data box 'a = Box 'a
class unpackable 'c where
    type item
    extract : 'c -> item
instance unpackable (box 'a) where
    item : 'a
    extract (Box value) = value

main =
    print (extract (Box 7))
    print (extract (Box "猫"))`,['7','猫'],'二つ目の箱に bool を入れてください。'],
['superclasses','クラス継承と演算子の instance',[
  "class show 'a => named 'a は、named を実装する型が show も実装することを要求します。どちらのメソッドも同じ instance で定義できます。",
  '演算子にもクラスがあり、たとえば (+) は add のメソッドです。型に対して add を実装すれば、その型の値を + で足せます。'
],`data score = Score int
class show 'a => named 'a where
    nameOf : 'a -> string
instance named score where
    nameOf (Score _) = "得点"
    show (Score n) = "{n} 点"
instance add score where
    (+) (Score x) (Score y) = Score (x + y)

main =
    total <- (Score 2) + (Score 3)
    print "{nameOf total}: {show total}"`,['得点: 5 点'],'show の表示形式を変えてください。'],
['conversion','into と変換',[
  'int、float、byte、char は変換先を名前に含む関数です。たとえば int に float を渡すと小数部分が切り捨てられます。',
  'from は into クラスを使い、入力型と文脈から変換先を決めます。変換先が曖昧なときは、型注釈で指定します。'
],`asByte : int -> byte / {exn}
asByte = from
main =
    print (asByte 65)
    print (char 65)
    print (int 3.8)`,['65',"'A'",'3'],'asByte に 256 を渡してエラーを見てください。'],
['bitwise','ビット演算',[
  '.&. と .|. はビットごとの AND と OR、.<<. と .>>. はシフトです。短絡評価をする &&・|| とは評価方法が違います。',
  'testBit、setBit、clearBit のビット位置は 0 から数えます。0 は一番右のビットです。'
],`main =
    print (6 .&. 3)
    print (6 .|. 3)
    print (1 .<<. 3)
    print (testBit 8 3)
    print (clearBit 7 1)`,['2','7','8','True','5'],'シフト幅を 4 に変更してください。'],
['borrow','一時的な可変借用',[
  'borrow mut x as r {…} は、ブロック内だけ変数への可変アクセスを r に預けます。readRef は現在値を読み、writeRef は新しい値を書き込みます。',
  '借用中は元の x を直接使えません。参照を外に持ち出すこともできません。型に現れる borrowMut は、どの借用に対する操作かを追跡します。'
],`main =
    mut value <- 10
    borrow mut value as r {
        writeRef r (readRef r + 2)
    }
    print value`,['12'],'借用中に print value を追加し、型検査のメッセージを読んでください。'],
]),
...chapter('列を作る・変換する・集約する', [
['ranges','範囲 .. と ..=',[
  '.. は右端を含まない範囲、..= は右端を含む範囲を作ります。範囲は数を順に取り出せる値です。',
  'そのまま each や fold に渡せます。ここでは vector で要素を見える形に変換します。左端が右端より大きければ降順になります。'
],`main =
    1 .. 4; vector; print
    1 ..= 4; vector; print
    4 ..= 1; vector; print`,['[1, 2, 3]','[1, 2, 3, 4]','[4, 3, 2, 1]'],'両端を同じ値にして .. と ..= を比べてください。'],
['streams','map・filter・take',[
  'map は各要素を変換し、filter は条件を満たす要素だけを残します。どちらも遅延 stream を返すので、定義した時点では要素を処理しません。',
  '範囲から始め、map、filter、take にその時点の列を渡します。take 3 は結果を最大三つに絞ります。vector まで進むと、実際に要素が計算されて vector に集まります。'
],`main =
    1 ..= 10; map {_ * _}; filter {% 2 == 1}; take 3; vector; print
    [1, 2, 3]; vmap {* 2}; print`,['[1, 9, 25]','[2, 4, 6]'],'take を filter の前に移し、どの段階で個数を絞るかによって結果が変わることを確かめてください。'],
['repeat','無限 stream を必要な分だけ読む',[
  'repeat は同じ値を繰り返し、repeatWith は要素を要求されるたびに quotation を実行します。後者は、入力なしで値を一つ返す処理を受け取ります。',
  '無限 stream を vector にする前に take などで上限を付けます。take 0 なら repeatWith の quotation は実行されません。'
],`main =
    repeat "猫"; take 3; vector; print
    mut n <- 0
    xs <- repeatWith {n ! + 1; n}
    xs; take 0; vector; print
    xs; take 3; vector; print`,['["猫", "猫", "猫"]','[]','[1, 2, 3]'],'最後の take を 5 に変更してください。'],
['fold','each・fold・countIf',[
  'each は要素ごとに quotation を実行します。元のスタックと共有されるので、要素以外の値を累積状態として使えます。',
  'fold には初期値を渡します。quotation は累積値と要素を受け取り、次の累積値を一つ返します。countIf は真になる要素の個数を返します。',
  'sum と product は列の合計と積を返します。初期値は fromInt で要素型に変換するため、floatやユーザー定義の数値型にも使えます。空の列ではそれぞれ0と1の変換結果を返します。'
],`main =
    0; each [1, 2, 3] {+}; print
    1 ..= 4; fold 1 {*}; print
    1 ..= 6; countIf {% 2 == 0}; print
    [1.5, 2.5]; sum; print
    1 ..= 4; product; print`,['6','24','3','4','24'],'最初の each を [1, 2, 3]; fold 0 {+} に書き換えてください。'],
['zip','zip・flatMap・nth',[
  'zip は二つの列を同時に読み、要素のペアを返します。短い方が終わった時点で走査を止めます。vzip は結果を vector にします。',
  'flatMap は要素ごとに別の列を作って順につなぎます。nth は 0 から数えた位置を読み、見つからなければ None を返します。'
],`main =
    [1, 2, 3]; vzip ["a", "b"]; print
    [1, 2]; flatMap {-> x; [x, x * 10]}; vector; print
    1 ..= 5; nth 2; print`,['[#(1 "a"), #(2 "b")]','[1, 10, 2, 20]','(Some 3)'],'nth の位置を 20 に変えてください。'],
['chunks','windows と chunks',[
  'windows は指定の長さで一つずつずらした重なる区間を作ります。長さが足りない最後の部分は含みません。',
  'chunks は重ならない区間に分けます。最後の区間だけ短くても含まれます。どちらも各区間は vector です。'
],`main =
    [0, 1, 2, 3]; windows 3; vector; print
    [0, 1, 2, 3]; chunks 3; vector; print`,['[[0, 1, 2], [1, 2, 3]]','[[0, 1, 2], [3]]'],'長さを 2 にして結果を比べてください。'],
['counts','辞書で集計する',[
  'counts は値ごとの出現回数を int で記録します。countsBy にはキーを作る quotation を渡せます。キーには hash の実装が必要です。',
  'groupBy は同じキーに属する要素を vector にまとめます。辞書の走査順には頼らず、キーを指定して結果を取り出します。'
],`main =
    c <- countsBy [0, 1, 2, 3, 4] {% 2}
    g <- groupBy [0, 1, 2, 3, 4] {% 2}
    print c.[0]
    print g.[1]`,['3','[1, 3]'],'最後の 4 を 5 に変えて偶数の個数を確認してください。'],
['sort','順序・ソート・最大値',[
  'sort は列の値を比較し、整列済みの vector を返します。sortBy は、要素から比較に使うキーを取り出す quotation を受け取ります。',
  'maxi は列全体から最大値を選び、空なら None を返します。二つの値だけを比べる max とは入力の形が異なります。'
],`main =
    [4, 1, 3]; sort; print
    [{n: 4}, {n: 1}]; sortBy {.n}; print
    [4, 1, 3]; maxi; print`,['[1, 3, 4]','[{n: 1}, {n: 4}]','(Some 4)'],'sortBy のキーを {.n; 0 -} にして降順にしてください。'],
]),
...chapter('エフェクトと安全な中断', [
['effects','操作を宣言して handle する',[
  'effect ask : -> int は、引数なしで int を求める操作を宣言します。ask は、対応するハンドラへ処理を引き渡します。',
  'handle のハンドラ record には操作名と処理を書きます。k は残りの計算を表す継続です。resume 7 k で ask に 7 が返ったところから処理を再開します。'
],`effect ask : -> int

main =
    handle below {ask: {-> k; resume 7 k}}
    print (ask + 1)`,['8'],'resume が渡す値を 20 に変えてください。'],
['effect-groups','where で操作をまとめる',[
  '一つの effect に関連する操作をまとめられます。state の ask と write は、同じ型引数を使います。エフェクト行には操作名でなくグループ名が現れます。',
  'write のハンドラには、渡された値と継続の二つが積まれます。ここでは mutable 変数へ書き込んでから継続を再開します。'
],`effect state 'a where
    ask : -> 'a
    write : 'a ->

main =
    mut value <- 0
    handle {write 3; print ask} {ask: {-> k; resume value k},
       write: {-> x, k; value <<- x; resume k}}`,['3'],'write をもう一度呼び、どの値が読み出されるか調べてください。'],
['effect-rows','型に書くエフェクト行',[
  '型注釈の / {io} は、処理が入出力を要求できることを表します。/ {} は外へ伝わるエフェクトがない型です。',
  "行変数 'e を使うと、引数の quotation が要求するエフェクトをそのまま伝える関数を表現できます。run 自体が許可を増やすわけではありません。"
],`run : {-> / {'e}} -> / {'e}
run q = call q
hello : -> / {io}
hello = print "こんにちは"
main = run {hello}`,['こんにちは'],'hello の型注釈を / {} に変えて型エラーを確認してください。'],
['bottom','戻らない操作と !',[
  '-> ! は、通常の戻り値が存在しないことを表します。引数を持つ場合は string -> ! のように書けます。',
  'abort のハンドラは残りの計算を再開せず、代わりに自分の値を返します。したがって abort の後ろにある処理は実行されません。'
],`effect abort : string -> !
main =
    print (handle {abort "停止"; 9} {abort: {-> msg, k; print msg; 0}})`,['停止','0'],'ハンドラが返す 0 を 42 に変えてください。'],
['yield','yield で stream を組み立てる',[
  'yield x は、生成した値を走査側に一つ渡します。fromYield が yield を処理して、quotation を stream に変換します。',
  'stream を走査すると生成側が必要な分だけ進みます。take 2 なら最初の二つを受け取った時点で走査を終えます。'
],`main =
    xs <- fromYield {yield 3; yield 5; yield 8}
    print (vector (take xs 2))
    print (vector xs)`,['[3, 5]','[3, 5, 8]'],'yield を一回増やしてください。'],
['break','break と cancel',[
  'break は現在のスタックを結果としてループを抜けます。cancel は中断し、その反復の前の状態に戻します。',
  '両方とも普通の値を積む命令ではなく、ループに捕まるエフェクトです。次の二つのループは、同じ時点で抜けても結果が異なります。'
],`main =
    0; while {True} {+ 1; when ($ > 3) {break}}; print
    0; while {True} {+ 1; when ($ > 3) {cancel}}; print`,['4','3'],'条件を $ > 5 に変えて差が残ることを確認してください。'],
['labels','エフェクトをラベルで届ける',[
  'ハンドラに渡す quotation に @outer のようなラベルを付けられます。ask@outer は、そのラベルが付いたブロックを扱うハンドラへ操作を送ります。',
  '内側にも ask のハンドラがある場合、普通の ask と ask@outer は別の宛先を選びます。'
],`effect ask : -> int
main =
    handle @outer {
        handle {print ask; print ask@outer} {ask: {-> k; resume 20 k}}
    } {ask: {-> k; resume 10 k}}`,['20','10'],'ask@outer の @outer を外してください。'],
['mask','mask で一段外へ届ける',[
  'mask ask {…} の中の ask は、最も内側の対応ハンドラを一段飛ばします。内側の処理から同じ操作を外へ委ねるときに使えます。',
  'この例では普通の ask が 20、mask した ask が外側から 10 を受け取ります。'
],`effect ask : -> int
main =
    handle {
        handle {print ask; mask ask {print ask}} {ask: {-> k; resume 20 k}}
    } {ask: {-> k; resume 10 k}}`,['20','10'],'mask ask を外し、波括弧内の print ask を直接実行してください。'],
['input','標準入力と result',[
  'read は標準入力から一行を受け取り、parseInt はそれを整数に変換します。整数に変換できないと exn が発生します。',
  'catch は成功を Ok、例外を Err に包みます。入力欄は実行ごとに先頭から読み直します。'
],`readInt =
    catch below
    parseInt read

main = print readInt`,['(Ok 42)'],'入力欄を hello に変えて Err を確認してください。',{input:'42'}],
]),
...chapter('モジュールと実践', [
['std-module','標準ライブラリを修飾名で使う',[
  '標準ライブラリは std の下に分かれています。たとえば std.vector.map は、入力の vector を変換して新しい vector を返します。',
  'std.prelude は暗黙に読み込まれます。vmap は std.vector.map の別名で、map は遅延 stream を返す別の関数です。'
],`main =
    print (std.vector.map [1, 2, 3] {* 2})
    print (vmap [1, 2, 3] {* 2})
    print (vector (std.stream.map [1, 2, 3] {* 2}))`,['[2, 4, 6]','[2, 4, 6]','[2, 4, 6]'],'std.vector.map を vmap に置き換えてください。'],
['imports','ディレクトリを import する',[
  'Nyanco は同じディレクトリにある .nyan ファイルを一つのモジュールとして扱います。import "./math" は隣の math ディレクトリを読み込みます。',
  '公開する関数は pub を付け、型注釈を書きます。ここでは math の square を m.square で呼び出します。エディター上のファイル選択で、両方のファイルを編集できます。'
],`import "./math" as m
main = print (m.square 7)`,['49'],'math/api.nyan を選び、square の本体を変更してください。',{files:{'/math/api.nyan':`pub square : int -> int
square x = x * x`}}],
['exports','pub・open と公開範囲',[
  'pub data で公開した型は、外のモジュールから型名を使えます。コンストラクターはモジュール内に留まるので、公開した関数を経由して値を作ります。',
  'コンストラクターを直接使わせる場合は open data と書きます。pub type は別名の中身を隠し、open type はその中身まで公開します。'
],`import "./model"
main =
    print (model.amount (model.make 7))
    print (model.Visible 9)`,['7','(Visible 9)'],'model/api.nyan の pub data を open data にし、外から Hidden を作ってみてください。',{files:{'/model/api.nyan':`pub data secret = Hidden int
open data visible = Visible int
pub make : int -> secret
make = Hidden
pub amount : secret -> int
amount (Hidden n) = n`}}],
['reexports','選択 import と再エクスポート',[
  'import の {…} に名前を並べると、指定した名前をモジュール修飾なしで使えます。as を付けると、その名前を別名で読み込めます。',
  'pub import は読み込んだ名前を他のモジュールにも再公開します。api/exports.nyan では、vector の map を doubleAll として公開しています。'
],`import "./api" {doubleAll as transform}
main = print (transform [1, 2, 3] {* 2})`,['[2, 4, 6]'],'transform の名前を変更し、呼び出し側も揃えてください。',{files:{'/api/exports.nyan':`pub import "std.vector" {map as doubleAll}`}}],
['push-pattern',':: と末尾の分解',[
  'xs :: x は xs の末尾に x を追加する式です。パターンとして使うと、空でない vector を先頭部分と最後の一要素へ分解できます。',
  'Push という名前でも同じ構築・分解ができます。空の vector を扱う場合は [] の節を用意します。'
],`last (xs :: x) = Some x
last [] = None
main =
    print ([] :: 1 :: 2)
    print (last [3, 4])
    print (last [])`,['[1, 2]','(Some 4)','None'],'last の実装を、先頭部分を返す関数に書き換えてください。'],
['updates','添字・フィールドへの再代入',[
  'mutable な record や vector では、r.n <<- 値 や xs.[i] ! 処理 のように、値の一部を指定して更新できます。',
  'この記法は、更新した値を作って元の変数へ書き戻す省略形です。更新前の値を別の名前に保存しておけば、その内容を引き続き使えます。'
],`main =
    mut xs <- [1, 2]
    old <- xs
    xs.[0] ! + 4
    mut r <- {n: 1}
    r.n <<- 8
    print old
    print xs
    print r.n`,['[1, 2]','[5, 2]','8'],'xs.[0] を xs.[1] に変えてください。'],
['collections','deque と heap',[
  'deque は両端から操作できる列です。qpush と qpushFront は追加する端が異なります。qpeek は端にある値を option で返します。',
  'heap は順序を持つ値を効率よく取り出すための構造です。hpush で追加し、hpeek で一番大きい値を確認できます。'
],`main =
    deque []; qpush 2; qpushFront 1; qpeek; print
    heap []; hpush 2; hpush 1; hpeek; print
    [3, 1, 2]; deque; heap; vector; sort; print`,['(Some 1)','(Some 2)','[1, 2, 3]'],'heap のあとを hpeek; print に替え、最大値を確かめてください。'],
['text-streams','文字列と stream の往復',[
  'chars は Unicode の文字を、bytes は UTF-8 のバイトを一つずつ返します。文字数とバイト数は一致しないことがあります。',
  'split は区切り文字列で分割した結果を stream にします。join は文字列の列の間に区切りを入れて、一つの文字列に戻します。'
],`main =
    "猫🐾"; chars; count; print
    "猫🐾"; bytes; count; print
    "赤,緑,青"; split ","; join " / "; print`,['2','7','赤 / 緑 / 青'],'絵文字を ASCII の文字にして個数を比べてください。'],
['practice','実践　入力から集計まで',[
  'read から split、map、countIf までを ; でつなぎます。一行の文字列が、分割した文字列の列、整数の列、条件を満たした個数の順に変わります。',
  'countIf が実際に stream を走査し、偶数を数えます。catch の中で変換するので、整数にできない要素があれば Err が返ります。'
],`main =
    catch {read; split " "; map {parseInt}; countIf {% 2 == 0}}; print`,['(Ok 2)'],'奇数を数えるよう変えたり、入力に数字以外を混ぜたりしてください。',{input:'1 2 3 4 5'}],
]),
];
