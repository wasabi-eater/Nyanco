import {lessons} from './lessons.mjs';
import {renderHighlight} from './runtime/syntax-highlight.mjs';

const escape = text => text.replace(/[&<>]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[ch]));
const toc = document.querySelector('#toc');
const content = document.querySelector('#lessons');
document.querySelector('#lesson-count').textContent = String(lessons.length).padStart(2,'0');

const chapters = new Map();
for (const lesson of lessons) {
  if (chapters.has(lesson.chapter)) continue;
  const group = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = lesson.chapter;
  const list = document.createElement('ol');
  group.append(summary,list);
  toc.append(group);
  chapters.set(lesson.chapter,{group,list,index:chapters.size+1});
}

let currentChapter;
for (const [index, lesson] of lessons.entries()) {
  const number = String(index+1).padStart(2,'0');
  const item = document.createElement('li');
  item.innerHTML = `<a href="#${lesson.id}"><span>${number}</span>${escape(lesson.title)}</a>`;
  const chapter=chapters.get(lesson.chapter);
  chapter.list.append(item);
  if (currentChapter!==lesson.chapter) {
    currentChapter=lesson.chapter;
    const heading=document.createElement('header');
    heading.className='chapter-heading';
    heading.innerHTML='<span>CHAPTER '+String(chapter.index).padStart(2,'0')+'</span><h2>'+escape(currentChapter)+'</h2>';
    content.append(heading);
  }
  const startingFiles={'/sample.nyan':lesson.source,...lesson.files};
  const section = document.createElement('section');
  section.className = 'lesson';
  section.id = lesson.id;
  section.innerHTML = `
    <div class="lesson-head"><span class="index">${number}</span><h3>${escape(lesson.title)}</h3></div>
    ${lesson.explanation.map(paragraph=>`<p class="explanation">${escape(paragraph)}</p>`).join('')}
    <div class="playground">
      <div class="toolbar"><span class="filename">${lesson.files ? '<label>ファイル <select class="file-select"></select></label>' : 'sample.nyan'}</span><div class="actions">
        <button type="button" class="reset">リセット</button><button type="button" class="run">▶ 実行</button>
      </div></div>
      <div class="editor"><pre aria-hidden="true"></pre><textarea aria-label="サンプルコード" wrap="off" maxlength="16000" spellcheck="false" autocapitalize="off"></textarea></div>
      ${lesson.input === undefined ? '' : '<label class="stdin"><span class="stdin-label">標準入力</span><textarea rows="1" spellcheck="false"></textarea></label>'}
      <div class="console"><div class="console-label">実行結果</div><output aria-live="polite">実行ボタンを押すと、ここに結果が表示されます。</output></div>
    </div>
    <p class="exercise"><strong>試してみる</strong>${escape(lesson.exercise)}</p>`;
  content.append(section);

  const editor = section.querySelector('.editor textarea'), preview = section.querySelector('pre');
  const input = section.querySelector('.stdin textarea'), output = section.querySelector('output');
  const run = section.querySelector('.run'), fileSelect=section.querySelector('.file-select');
  let worker, timer, files, activeFile='/sample.nyan';
  if(fileSelect)for(const file of Object.keys(startingFiles))fileSelect.add(new Option(file.slice(1),file));
  fileSelect?.addEventListener('change',()=>{
    files[activeFile]=editor.value;
    activeFile=fileSelect.value;
    editor.value=files[activeFile];
    repaint();
  });
  function alignScroll() {
    preview.scrollLeft=editor.scrollLeft;
    preview.scrollTop=editor.scrollTop;
  }
  function repaint() {
    preview.innerHTML = renderHighlight(editor.value,(kind,text) => kind
      ? `<span class="syn-${kind}">${escape(text)}</span>` : escape(text)) + '\n';
    editor.rows=Math.min(18,Math.max(3,editor.value.split('\n').length+1));
    alignScroll();
  }
  function finish() {
    clearTimeout(timer);
    worker?.terminate();
    worker=undefined;
    run.disabled=false;
  }
  function append(kind,text) {
    const line=document.createElement('div');
    line.className=kind;
    line.textContent=kind==='stack'?'stack: '+text:text;
    output.append(line);
  }
  function reset() {
    finish();
    files={...startingFiles};
    activeFile='/sample.nyan';
    if(fileSelect)fileSelect.value=activeFile;
    editor.value=files[activeFile];
    if(input)input.value=lesson.input;
    output.textContent='実行ボタンを押すと、ここに結果が表示されます。';
    repaint();
  }
  function execute() {
    finish();
    output.textContent='';
    run.disabled=true;
    try {
      worker=new Worker(new URL('./worker.mjs',import.meta.url),{type:'module'});
    } catch (error) {
      append('error',error.message);
      finish();
      return;
    }
    worker.onmessage=({data:{kind,text}})=>{
      if(kind==='done'){
        if(!output.childNodes.length)append('output','実行が完了しました。');
        finish();
      }else{
        append(kind,text);
        if(kind==='error')finish();
      }
    };
    worker.onerror=()=>{
      append('error','実行環境を読み込めませんでした。ページを再読み込みしてお試しください。');
      finish();
    };
    timer=setTimeout(()=>{append('error','実行時間の上限に達しました。');finish();},4000);
    files[activeFile]=editor.value;
    worker.postMessage({source:files['/sample.nyan'],files,input:input?.value ?? ''});
  }
  editor.addEventListener('input',repaint);
  editor.addEventListener('scroll',alignScroll);
  editor.addEventListener('keydown', event=>{
    if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();execute();}
  });
  section.querySelector('.reset').addEventListener('click',reset);
  run.addEventListener('click',execute);
  reset();
}

const sections=[...content.querySelectorAll('.lesson')];
let navChapter;
function setCurrent() {
  const active=sections.findLast(section=>section.getBoundingClientRect().top<160) || sections[0];
  const chapter=chapters.get(lessons[sections.indexOf(active)].chapter);
  if(chapter!==navChapter){
    chapter.group.open=true;
    navChapter=chapter;
  }
  for(const link of toc.querySelectorAll('a')){
    if(link.hash==='#'+active.id)link.setAttribute('aria-current','location');
    else link.removeAttribute('aria-current');
  }
}
let scrolling=false;
window.addEventListener('scroll',()=>{
  if(scrolling)return;
  scrolling=true;
  requestAnimationFrame(()=>{setCurrent();scrolling=false;});
},{passive:true});
const initial=sections.find(section=>'#'+section.id===location.hash);
if(initial)initial.scrollIntoView();
setCurrent();