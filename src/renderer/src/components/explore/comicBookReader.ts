export interface ComicBookPage {
  src: string
  story: string
  prompt: string
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

export function comicBookPageCount(prompt: string): number | null {
  const match = prompt.match(/Q: Story length\s*\nA: (\d{1,3}) distinct images/i)
  if (!match) return null
  const count = Number(match[1])
  return Number.isInteger(count) && count >= 10 && count <= 100 ? count : null
}

export function comicBookHeroImage(prompt: string): string | null {
  const match = prompt.match(/Q: Hero reference image\s*\nA: ([^\n]+)/i)
  const value = match?.[1]?.trim()
  return value && value !== 'Not provided' ? value : null
}

export function comicBookTitle(prompt: string): string | null {
  const explicit = prompt.match(/BOOK TITLE:\s*([^\n]+)/i)?.[1]?.trim()
  if (explicit) return explicit.slice(0, 80)
  const brief = prompt.match(/Q: Story brief\s*\nA: ([^\n]+)/i)?.[1]?.trim()
  if (!brief) return null
  return brief.split(/\s+/).slice(0, 8).join(' ').replace(/[.,;:!?]+$/, '') || null
}

export function comicBookPageFromPrompt(prompt: string): Omit<ComicBookPage, 'src'> {
  const story = prompt.match(/PAGE STORY:\s*([\s\S]*?)(?=\n\s*ILLUSTRATION:|$)/i)?.[1]?.trim()
  const illustration = prompt.match(/ILLUSTRATION:\s*([\s\S]*)/i)?.[1]?.trim()
  return {
    story: story || prompt.trim(),
    prompt: illustration || prompt.trim()
  }
}

/** The one offline reader template used for every generated comic book. */
export function buildComicBookReader(
  pages: readonly ComicBookPage[],
  expectedPages: number,
  title = 'Comic Book'
): string {
  const safeExpected = Math.max(1, Math.round(expectedPages))
  const safeTitle = escapeHtml(title)
  const pageMarkup = pages
    .map(
      (page, index) => `<figure class="page" data-page="${index}" aria-label="Page ${index + 1}">
        <div class="page-layout">
          <img src="${escapeHtml(page.src)}" alt="Comic page ${index + 1}" />
          <div class="page-copy">
            <section class="story" aria-label="Story for page ${index + 1}"><span>STORY</span><p>${escapeHtml(page.story)}</p></section>
            <section class="notes" aria-label="Page notes"><span>PAGE NOTES</span><p>${escapeHtml(page.prompt)}</p></section>
            <span class="page-number">PAGE ${index + 1}</span>
          </div>
        </div>
      </figure>`
    )
    .join('\n')
  const thumbnailMarkup = pages
    .map(
      (
        page,
        index
      ) => `<button type="button" data-go="${index}" aria-label="Open page ${index + 1}">
        <img src="${escapeHtml(page.src)}" alt="" /><span>${index + 1}</span>
      </button>`
    )
    .join('\n')
  const startIndex = Math.max(0, pages.length - 1)

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    :root{color-scheme:dark;--bg:#0a0a0a;--surface:#171717;--line:#404040;--text:#f5f5f5;--muted:#a3a3a3;--accent:#34d399}
    *{box-sizing:border-box}html,body{height:100%;margin:0;background:var(--bg);color:var(--text);font:13px Menlo,Monaco,Consolas,monospace}
    body{display:grid;grid-template-rows:auto minmax(0,1fr)}button{font:inherit}
    header{display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--line);padding:8px 12px;background:var(--surface)}
    header strong{font-size:13px;font-weight:400;white-space:nowrap}header>output{margin-left:auto;color:var(--muted);font-size:11px;white-space:nowrap}.speech{display:flex;align-items:end;gap:8px;margin-left:auto}.speech label{display:grid;gap:3px;color:var(--muted);font-size:9px;letter-spacing:.08em}.speech select,.speech button{min-height:28px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text);padding:4px 7px;font:11px Menlo,Monaco,Consolas,monospace}.speech select:focus-visible,.speech button:focus-visible{border-color:var(--accent);outline:none}.speech button{cursor:pointer}.speech button:disabled,.speech select:disabled{opacity:.45;cursor:default}.speech-status{max-width:18ch;color:var(--muted);font-size:9px;line-height:1.3}
    .shell{display:grid;grid-template-columns:92px minmax(0,1fr);min-height:0}.thumbs{overflow:auto;border-right:1px solid var(--line);padding:8px;display:flex;flex-direction:column;gap:8px}
    .thumbs button{position:relative;display:block;width:100%;padding:0;border:1px solid var(--line);border-radius:6px;overflow:hidden;background:var(--surface);color:var(--text);cursor:pointer}
    .thumbs button[aria-current="page"]{border-color:var(--accent)}.thumbs img{display:block;width:100%;aspect-ratio:3/4;object-fit:cover}.thumbs span{position:absolute;right:3px;bottom:3px;background:#000c;padding:2px 4px;border-radius:3px;font-size:10px}
    main{position:relative;min-width:0;min-height:0;display:grid;grid-template-rows:minmax(0,1fr) auto;overflow:hidden}.stage{min-height:0;overflow:hidden;padding:12px;display:grid;place-items:stretch}
    .page{display:none;width:100%;height:100%;min-height:0;margin:0}.page.active{display:block}.page-layout{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(280px,.65fr);gap:12px;width:100%;height:100%;min-height:0;margin:0 auto}.page img{display:block;width:100%;height:100%;min-height:0;object-fit:contain;border:1px solid var(--line);border-radius:8px;background:var(--surface)}
    .page-copy{display:grid;grid-template-rows:minmax(0,.9fr) minmax(0,1.1fr) auto;gap:10px;min-width:0;min-height:0;overflow:hidden}.story,.notes{min-height:0;overflow:hidden;border:1px solid var(--line);border-radius:8px;background:var(--surface);padding:12px;text-align:left}.story>span,.notes>span{color:var(--muted);font-size:9px;letter-spacing:.08em}.story p,.notes p{width:100%;margin:8px 0 0;line-height:1.45;text-align:left;white-space:pre-wrap}.story p{font-size:12px}.notes p{font-size:10px;color:var(--muted)}.page-number{color:var(--muted);font-size:10px;text-align:right}
    nav{display:flex;align-items:center;justify-content:center;gap:8px;border-top:1px solid var(--line);padding:9px;background:var(--surface)}nav button{border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text);padding:6px 10px;cursor:pointer}nav button:hover,nav button:focus-visible{border-color:var(--accent);outline:none}nav button:disabled{opacity:.35;cursor:default}
    .waiting{display:${pages.length ? 'none' : 'grid'};place-items:center;height:100%;color:var(--muted);text-align:center;line-height:1.7}.waiting b{display:block;color:var(--text);font-weight:400}
    @media(max-width:900px){header{align-items:start;flex-wrap:wrap}.speech{order:3;width:100%;margin-left:0}.speech label{flex:1}.speech select{width:100%}.shell{grid-template-columns:1fr}.thumbs{display:none}.stage{padding:8px}.page-layout{grid-template-columns:1fr;grid-template-rows:minmax(0,1.35fr) minmax(0,.65fr);gap:8px}.page-copy{grid-template-columns:1fr 1fr;grid-template-rows:minmax(0,1fr) auto}.page-number{grid-column:1/-1}.story,.notes{padding:8px}}
    @media(prefers-reduced-motion:no-preference){.page.active{animation:reveal .15s ease-out}@keyframes reveal{from{opacity:.4;transform:scale(.995)}to{opacity:1;transform:scale(1)}}}
  </style>
</head>
<body>
  <header>
    <strong>${safeTitle.toUpperCase()}</strong>
    <div class="speech" aria-label="Read aloud controls">
      <label>LANGUAGE<select id="speech-language" disabled><option>LOADING</option></select></label>
      <label>MODEL<select id="speech-model" disabled><option>LOADING</option></select></label>
      <label>VOICE<select id="speech-voice" disabled><option>LOADING</option></select></label>
      <button id="read-aloud" type="button" disabled>READ ALOUD</button>
      <span class="speech-status" id="speech-status" role="status" aria-live="polite"></span>
    </div>
    <output id="progress" aria-live="polite">${pages.length} / ${safeExpected} PAGES</output>
  </header>
  <div class="shell">
    <aside class="thumbs" aria-label="Comic pages">${thumbnailMarkup}</aside>
    <main>
      <div class="stage"><div class="waiting"><div><b>GENERATING PAGE 1</b>The reader updates after each page is ready.</div></div>${pageMarkup}</div>
      <nav aria-label="Page navigation"><button id="previous" type="button">PREVIOUS</button><span id="page-label">${pages.length ? `${startIndex + 1} / ${pages.length}` : `0 / ${safeExpected}`}</span><button id="next" type="button">NEXT</button></nav>
    </main>
  </div>
  <script>
    const pages=[...document.querySelectorAll('.page')];const thumbs=[...document.querySelectorAll('[data-go]')];let current=${startIndex};
    const previous=document.getElementById('previous');const next=document.getElementById('next');const label=document.getElementById('page-label');const language=document.getElementById('speech-language');const model=document.getElementById('speech-model');const voice=document.getElementById('speech-voice');const read=document.getElementById('read-aloud');const speechStatus=document.getElementById('speech-status');let voices=[];let speaking=false;
    function fitCopy(page){page.querySelectorAll('.story p,.notes p').forEach((text)=>{text.style.fontSize='';let size=parseFloat(getComputedStyle(text).fontSize);const box=text.parentElement;while(size>7&&box.scrollHeight>box.clientHeight){size-=.5;text.style.fontSize=size+'px'}})}
    function show(index){if(!pages.length){previous.disabled=true;next.disabled=true;return}current=Math.max(0,Math.min(index,pages.length-1));pages.forEach((page,i)=>page.classList.toggle('active',i===current));thumbs.forEach((thumb,i)=>{if(i===current)thumb.setAttribute('aria-current','page');else thumb.removeAttribute('aria-current')});label.textContent=(current+1)+' / '+pages.length;previous.disabled=current===0;next.disabled=current===pages.length-1;thumbs[current]?.scrollIntoView({block:'nearest'});requestAnimationFrame(()=>fitCopy(pages[current]));if(speaking)parent.postMessage({__ogComicTts:'stop'},'*')}
    function fillVoices(){const matches=voices.filter((item)=>item.language===language.value);voice.innerHTML='';(matches.length?matches:voices).forEach((item)=>{const option=document.createElement('option');option.value=item.id;option.textContent=item.label||item.id;voice.append(option)});voice.disabled=!voices.length;read.disabled=!voices.length||!pages.length}
    function speakCurrent(){const text=pages[current]?.querySelector('.story p')?.textContent?.trim()||pages[current]?.querySelector('.notes p')?.textContent?.trim();if(text)parent.postMessage({__ogComicTts:'speak',text,voice:voice.value},'*')}
    language.addEventListener('change',fillVoices);model.addEventListener('change',()=>parent.postMessage({__ogComicTts:'model',model:model.value},'*'));read.addEventListener('click',()=>{if(speaking){parent.postMessage({__ogComicTts:'stop'},'*');return}speakCurrent()});
    addEventListener('message',(event)=>{const data=event.data;if(!data||data.__ogComicTts!=='status')return;if(data.models){model.innerHTML='';data.models.forEach((item)=>{const option=document.createElement('option');option.value=item.id;option.textContent=item.label;model.append(option)});if(data.activeModel&&[...model.options].some((option)=>option.value===data.activeModel))model.value=data.activeModel;model.disabled=data.models.length<2}if(data.voices){voices=data.voices;const languages=[...new Map(voices.map((item)=>[item.language||'und',item.languageLabel||item.language||'Automatic'])).entries()];language.innerHTML='';languages.forEach(([code,name])=>{const option=document.createElement('option');option.value=code;option.textContent=name;language.append(option)});language.disabled=!languages.length;fillVoices()}if(data.state){speaking=data.state==='loading'||data.state==='playing';read.textContent=speaking?'STOP':'READ ALOUD';if(data.state==='model-loading'){model.disabled=true;speechStatus.textContent=data.message||'SWITCHING MODEL'}else if(data.state==='loading')speechStatus.textContent=data.message||'GENERATING AUDIO';else if(data.state==='playing')speechStatus.textContent='PLAYING';else if(data.state==='error')speechStatus.textContent=data.message||'SPEECH FAILED';else if(data.state==='idle'){speechStatus.textContent='';if(data.reason==='ended'&&current<pages.length-1){show(current+1);requestAnimationFrame(speakCurrent)}}}});
    previous.addEventListener('click',()=>show(current-1));next.addEventListener('click',()=>show(current+1));thumbs.forEach((thumb)=>thumb.addEventListener('click',()=>show(Number(thumb.dataset.go))));addEventListener('keydown',(event)=>{if(event.key==='ArrowLeft'||event.key==='ArrowUp'){event.preventDefault();show(current-1)}if(event.key==='ArrowRight'||event.key==='ArrowDown'){event.preventDefault();show(current+1)}});show(current);
    addEventListener('resize',()=>requestAnimationFrame(()=>fitCopy(pages[current])));parent.postMessage({__ogComicTts:'catalog'},'*');
  </script>
</body>
</html>`
}
