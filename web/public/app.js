
function showView(name){
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  var el = document.getElementById('view-'+name);
  if(el) el.classList.add('active');
  window.scrollTo(0,0);
}


// ===================== APP SCRIPT =====================


// ---------------------------------------------------------------------------
let state = { workflow:"magnific", file:null, origPreviewURL:null, connected:false, session:null, credits:null, plan:'free' };

const $ = id => document.getElementById(id);
const statusBox = $('statusBox');
const btnRun = $('btnRun');

// ---------------------------------------------------------------------------
// Supabase — real authentication + credit balance
let sb = null;
async function initSupabase(){
  try{
    const cfg = await (await fetch('/api/config')).json();
    if(!cfg.supabaseUrl || !cfg.supabaseAnonKey) return;
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
    sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    sb.auth.onAuthStateChange((_event, session)=>{
      state.session = session;
      if(session) onSignedIn(session);
      else window.appSetLoggedOut();
    });
    const { data } = await sb.auth.getSession();
    state.session = data.session;
    if(data.session) onSignedIn(data.session);
  }catch(e){
    console.warn('Auth init failed:', e);
  }
}
async function onSignedIn(session){
  const email = session.user.email || 'user';
  window.appSetLoggedIn(email);
  // if the user is currently on the login view, show its success screen
  if(document.getElementById('view-login').classList.contains('active') &&
     typeof window.loginShowSuccess === 'function'){
    window.loginShowSuccess(email);
  }
  try{
    const { data } = await sb.from('profiles').select('credits, plan').eq('id', session.user.id).single();
    if(data) setCredits(data.credits, data.plan);
  }catch(e){ /* profile row may lag right after signup */ }
}
function setCredits(credits, plan){
  if(typeof credits !== 'number') return;
  state.credits = credits;
  if(plan) state.plan = plan;
  const planLabel = state.plan.charAt(0).toUpperCase() + state.plan.slice(1);
  $('tokenBalance').textContent = planLabel + ' · ' + credits + ' left';
  const planLine = document.querySelector('#acctPanel .plan-line');
  if(planLine) planLine.textContent = 'Plan · ' + planLabel + ' · ' + credits + ' credits remaining';
}
initSupabase();

// ---------------------------------------------------------------------------
// Account dropdown (mock — no backend auth; login now lives only on the
// dedicated login page/view. This panel just reflects logged-in state.)
const acctBtn = $('acctBtn'), acctPanel = $('acctPanel');
let isLoggedIn = false;

function goToLogin(){
  if(typeof showView === 'function') showView('login');
  else window.location.href = 'login.html';
}

acctBtn.addEventListener('click', (e)=>{
  e.stopPropagation();
  if(!isLoggedIn){ goToLogin(); return; }
  acctPanel.classList.toggle('open');
});
document.addEventListener('click', (e)=>{
  if(!acctPanel.contains(e.target) && e.target !== acctBtn) acctPanel.classList.remove('open');
});

// Called externally (from the login page) once sign-in succeeds.
window.appSetLoggedIn = function(email){
  isLoggedIn = true;
  $('acctEmail').textContent = email;
  $('acctLabel').textContent = email.split('@')[0];
  $('acctAvatar').textContent = email.charAt(0).toUpperCase();
};
window.appSetLoggedOut = function(){
  isLoggedIn = false;
  $('acctLabel').textContent = 'Sign in';
  $('acctAvatar').textContent = '?';
  acctPanel.classList.remove('open');
};

$('btnLogout').addEventListener('click', async ()=>{
  if(sb) await sb.auth.signOut();
  window.appSetLoggedOut();
  goToLogin();
});


function updatePeopleDescVisibility(){
  $('sExtPeopleDescWrap').style.display = $('sExtPeople').value === 'yes' ? '' : 'none';
}

let hiddenPromptCache = '';
const PROMPT_MASK = '🔒 Prompt generated and ready to use — hidden to protect this preset.\nSwitch "Image Type" to Custom if you want to write and view your own prompt.';

function applyPromptType(){
  const type = $('sPromptType').value;
  updatePeopleDescVisibility();
  if(type === 'exterior'){
    $('sExtControls').style.display = '';
    $('sIntControls').style.display = 'none';
    $('sPrompt').readOnly = true;
    hiddenPromptCache = ''; // prompt is now built server-side
    $('sPrompt').value = PROMPT_MASK;
  } else if(type === 'semiOutdoor'){
    $('sExtControls').style.display = '';
    $('sIntControls').style.display = 'none';
    $('sPrompt').readOnly = true;
    hiddenPromptCache = ''; // prompt is now built server-side
    $('sPrompt').value = PROMPT_MASK;
  } else if(type === 'interior'){
    $('sExtControls').style.display = 'none';
    $('sIntControls').style.display = '';
    $('sPrompt').readOnly = true;
    hiddenPromptCache = ''; // prompt is now built server-side
    $('sPrompt').value = PROMPT_MASK;
  } else {
    $('sExtControls').style.display = 'none';
    $('sIntControls').style.display = 'none';
    $('sPrompt').readOnly = false;
    if($('sPrompt').value === PROMPT_MASK) $('sPrompt').value = '';
    hiddenPromptCache = '';
  }
}
$('sPromptType').addEventListener('change', applyPromptType);
function refreshExtPrompt(){
  updatePeopleDescVisibility();
  const type = $('sPromptType').value;
  if(type === 'exterior') hiddenPromptCache = ''; // prompt is now built server-side
  else if(type === 'semiOutdoor') hiddenPromptCache = ''; // prompt is now built server-side
}
['sExtTime','sExtClouds','sExtWeather','sExtBackground','sExtView','sExtPeople','sExtPeopleDesc','sExtCars','sExtFocus','sExtExtra'].forEach(id=>{
  $(id).addEventListener('input', refreshExtPrompt);
});
['sIntRoom','sIntLighting','sIntFocus','sIntExtra'].forEach(id=>{
  $(id).addEventListener('input', ()=>{
    if($('sPromptType').value === 'interior') hiddenPromptCache = ''; // prompt is now built server-side
  });
});
try{ applyPromptType(); }catch(e){ console.error('applyPromptType init failed:', e); } // set initial value (Exterior by default)

// ---------------------------------------------------------------------------
// before/after compare slider
const cmpEl = $('cmp');
const cmpRange = $('cmpRange');
function setCmpPercent(pct){
  $('cmpBeforeWrap').style.clipPath = 'inset(0 ' + (100 - pct) + '% 0 0)';
  $('cmpLine').style.left = pct + '%';
  $('cmpDot').style.left = pct + '%';
}
cmpRange.addEventListener('input', ()=> setCmpPercent(cmpRange.value));

function showBeforeOnly(url){
  $('cmpEmpty').style.display = 'none';
  $('cmpAfterImg').style.display = '';
  $('cmpAfterImg').src = url; // show the original as full background until a result exists
  $('cmpBeforeWrap').style.display = 'none';
  $('cmpLabelBefore').style.display = 'none';
  $('cmpLabelAfter').style.display = 'none';
  $('cmpLine').style.display = 'none';
  $('cmpDot').style.display = 'none';
  cmpRange.style.display = 'none';
  $('dlOrigLink').href = url;
}

// The `download` HTML attribute is ignored by browsers for cross-origin URLs
// (ComfyUI's /view endpoint is a different origin than this page), so a plain
// <a download> click just opens the image instead of saving it. Fetch the
// bytes ourselves and trigger the save from a same-origin blob: URL instead.
async function forceDownload(url, filename){
  try{
    const res = await fetch(url);
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(()=>URL.revokeObjectURL(blobUrl), 5000);
  }catch(e){
    console.error('Direct download failed, opening the image in a new tab instead:', e);
    window.open(url, '_blank');
  }
}
$('dlLink').addEventListener('click', (e)=>{
  e.preventDefault();
  forceDownload($('dlLink').href, $('dlLink').download || 'result.png');
});
$('dlOrigLink').addEventListener('click', (e)=>{
  e.preventDefault();
  forceDownload($('dlOrigLink').href, 'original.png');
});

function showCompare(beforeUrl, afterUrl){
  $('cmpEmpty').style.display = 'none';
  $('cmpAfterImg').style.display = '';
  $('cmpAfterImg').src = afterUrl;
  $('cmpBeforeImg').src = beforeUrl;
  $('cmpBeforeWrap').style.display = '';
  $('cmpLabelBefore').style.display = '';
  $('cmpLabelAfter').style.display = '';
  $('cmpLine').style.display = '';
  $('cmpDot').style.display = '';
  cmpRange.style.display = '';
  cmpRange.value = 50;
  setCmpPercent(50);
}

function log(msg, cls){
  const line = document.createElement('div');
  if(cls) line.className = cls;
  line.style.whiteSpace = 'pre-wrap';
  line.textContent = msg;
  statusBox.appendChild(line);
  statusBox.scrollTop = statusBox.scrollHeight;
}
function clearLog(){ statusBox.innerHTML = ''; }

async function testConnection(){
  const el = $('connStatus'), txt = $('connText');
  try{
    const res = await fetch('/api/health');
    if(!res.ok) throw new Error('HTTP '+res.status);
    el.className = 'conn ok'; txt.textContent = 'System ready';
    state.connected = true;
  }catch(e){
    el.className = 'conn bad';
    txt.textContent = 'System temporarily unavailable';
    state.connected = false;
  }
  updateRunEnabled();
}
window.addEventListener('load', testConnection);

// workflow selection
document.querySelectorAll('.wf-opt').forEach(el=>{
  el.addEventListener('click', ()=>{
    if(el.classList.contains('disabled')) return;
    document.querySelectorAll('.wf-opt').forEach(o=>o.classList.remove('selected'));
    el.classList.add('selected');
    state.workflow = el.dataset.wf;
    $('paramsCardMagnific').style.display = state.workflow === 'magnific' ? '' : 'none';
    $('paramsCardSSS').style.display = state.workflow === 'sss' ? '' : 'none';
  });
});

// upload handling
const dropZone = $('dropZone'), fileInput = $('fileInput');
dropZone.addEventListener('click', ()=>fileInput.click());
['dragover','dragenter'].forEach(ev=>dropZone.addEventListener(ev, e=>{e.preventDefault();dropZone.classList.add('drag');}));
['dragleave','drop'].forEach(ev=>dropZone.addEventListener(ev, e=>{e.preventDefault();dropZone.classList.remove('drag');}));
dropZone.addEventListener('drop', e=>{
  const f = e.dataTransfer.files[0];
  if(f) handleFile(f);
});
fileInput.addEventListener('change', e=>{
  const f = e.target.files[0];
  if(f) handleFile(f);
});

async function handleFile(file){
  clearLog();
  // local preview — the actual upload happens when Run is pressed
  const url = URL.createObjectURL(file);
  state.origPreviewURL = url;
  state.file = file;
  $('previewImg').src = url;
  $('previewBox').style.display = 'block';
  showBeforeOnly(url);
  log('Image ready: ' + file.name, 'ok');
  updateRunEnabled();
}

function updateRunEnabled(){
  btnRun.disabled = !(state.connected && state.file);
}

$('btnRandSeedMagnific').addEventListener('click', ()=>{
  $('pSeed').value = Math.floor(Math.random()*1_000_000_000);
});
$('btnRandSeedSSS').addEventListener('click', ()=>{
  $('sSeed').value = Math.floor(Math.random()*1_000_000_000);
});

btnRun.addEventListener('click', runWorkflow);

async function runWorkflow(){
  if(!sb || !state.session){ showView('login'); return; }
  if(!state.file) return;
  btnRun.disabled = true;
  $('actionsBottom').style.display = 'none';
  if(state.origPreviewURL) showBeforeOnly(state.origPreviewURL);
  clearLog();

  let params;
  if(state.workflow === 'sss'){
    params = {
      workflow:'sss',
      promptType: $('sPromptType').value,
      customPrompt: $('sPromptType').value === 'custom' ? $('sPrompt').value : '',
      time: $('sExtTime').value, clouds: $('sExtClouds').value, weather: $('sExtWeather').value,
      background: $('sExtBackground').value, view: $('sExtView').value,
      people: $('sExtPeople').value, peopleDesc: $('sExtPeopleDesc').value,
      cars: $('sExtCars').value, focus: $('sExtFocus').value, extra: $('sExtExtra').value,
      room: $('sIntRoom').value, lighting: $('sIntLighting').value,
      intFocus: $('sIntFocus').value, intExtra: $('sIntExtra').value,
      turbo: $('sTurbo').value === 'true',
      guidance: parseFloat($('sGuidance').value),
      megapixels: parseFloat($('sMegapixels').value),
      seed: parseInt($('sSeed').value)
    };
  }else{
    params = {
      workflow:'magnific',
      prompt: $('pPrompt').value,
      upscaleBy: parseFloat($('pUpscaleBy').value),
      denoise: parseFloat($('pDenoise').value),
      steps: parseInt($('pSteps').value),
      cfg: parseFloat($('pCfg').value),
      seed: parseInt($('pSeed').value)
    };
  }

  let jobId;
  try{
    log('Uploading image...');
    const ext = (state.file.name.split('.').pop() || 'png').toLowerCase();
    const inputPath = state.session.user.id + '/' + Date.now() + '.' + ext;
    const { error: upError } = await sb.storage.from('inputs').upload(inputPath, state.file);
    if(upError) throw new Error('Upload failed: ' + upError.message);

    log('Submitting job...');
    const res = await fetch('/api/generate', {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        Authorization: 'Bearer ' + state.session.access_token
      },
      body: JSON.stringify({ params, inputPath })
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    jobId = data.jobId;
    if(typeof data.credits === 'number') setCredits(data.credits);
    log('Queued. job = ' + jobId, 'ok');
  }catch(e){
    log('Request failed: ' + e.message, 'err');
    btnRun.disabled = false;
    return;
  }

  const start = Date.now();
  let done = false;
  while(!done){
    await new Promise(r=>setTimeout(r, 3000));
    const elapsed = ((Date.now()-start)/1000).toFixed(0);
    let data = null;
    try{
      const res = await fetch('/api/status/' + jobId, {
        headers:{ Authorization: 'Bearer ' + state.session.access_token }
      });
      data = await res.json();
    }catch(e){
      log('Status check failed: ' + e.message, 'err');
      continue;
    }
    if(data.status === 'COMPLETED'){
      done = true;
      log('Done (' + elapsed + 's)', 'ok');
      showCompare(state.origPreviewURL, data.outputUrl);
      $('dlLink').href = data.outputUrl;
      $('dlLink').download = 'result.png';
      $('actionsBottom').style.display = 'flex';
    }else if(data.status === 'FAILED'){
      done = true;
      log('Job failed: ' + (data.error || 'unknown error') + ' — credit refunded', 'err');
      if(typeof data.credits === 'number') setCredits(data.credits);
    }else{
      log((data.status === 'IN_QUEUE' ? 'Waiting in queue... (' : 'Processing... (') + elapsed + 's)');
    }
    if(!done && Date.now()-start > 15*60*1000){
      done = true;
      log('Timed out (over 15 minutes) — the job may still finish, refresh later', 'err');
    }
  }
  btnRun.disabled = false;
}


// ---------------------------------------------------------------------------
// Tutorial carousel — original copy + hand-drawn SVG diagrams (not derived
// from any uploaded reference material).
function tutCube(mode){
  if(mode === 'outline'){
    return `<svg viewBox="0 0 100 100" width="92" height="92">
      <polygon points="50,10 85,28 50,46 15,28" fill="#ffffff" stroke="#171717" stroke-width="3" stroke-linejoin="round"/>
      <polygon points="15,28 50,46 50,86 15,68" fill="#ffffff" stroke="#171717" stroke-width="3" stroke-linejoin="round"/>
      <polygon points="85,28 50,46 50,86 85,68" fill="#ffffff" stroke="#171717" stroke-width="3" stroke-linejoin="round"/>
    </svg>`;
  }
  if(mode === 'soft'){
    return `<svg viewBox="0 0 100 100" width="92" height="92">
      <polygon points="50,10 85,28 50,46 15,28" fill="#e7e7e7"/>
      <polygon points="15,28 50,46 50,86 15,68" fill="#bdbdbd"/>
      <polygon points="85,28 50,46 50,86 85,68" fill="#8c8c8c"/>
    </svg>`;
  }
  if(mode === 'messy'){
    return `<svg viewBox="0 0 100 100" width="92" height="92">
      <polygon points="48,8 78,22 92,50 74,58 80,82 46,92 20,80 8,52 26,40 18,20" fill="#eeeeee" stroke="#171717" stroke-width="2" stroke-linejoin="round"/>
      <line x1="48" y1="8" x2="80" y2="82" stroke="#171717" stroke-width="1.3"/>
      <line x1="8" y1="52" x2="92" y2="50" stroke="#171717" stroke-width="1.3"/>
      <line x1="18" y1="20" x2="74" y2="58" stroke="#171717" stroke-width="1.3"/>
    </svg>`;
  }
  if(mode === 'clean'){
    return `<svg viewBox="0 0 100 100" width="92" height="92">
      <polygon points="50,10 85,28 50,46 15,28" fill="#f2f2f2" stroke="#171717" stroke-width="1.4" stroke-linejoin="round"/>
      <polygon points="15,28 50,46 50,86 15,68" fill="#d8d8d8" stroke="#171717" stroke-width="1.4" stroke-linejoin="round"/>
      <polygon points="85,28 50,46 50,86 85,68" fill="#bcbcbc" stroke="#171717" stroke-width="1.4" stroke-linejoin="round"/>
    </svg>`;
  }
  if(mode === 'flat'){
    return `<svg viewBox="0 0 100 100" width="92" height="92">
      <rect x="14" y="20" width="72" height="60" rx="3" fill="#c9c9c9"/>
    </svg>`;
  }
  if(mode === 'grain'){
    return `<svg viewBox="0 0 100 100" width="92" height="92">
      <rect x="14" y="20" width="72" height="60" rx="3" fill="#d8d3c9"/>
      <path d="M16 32 Q40 28 50 33 T86 30" stroke="#8a7a63" stroke-width="1.3" fill="none"/>
      <path d="M16 46 Q40 42 50 47 T86 44" stroke="#8a7a63" stroke-width="1.3" fill="none"/>
      <path d="M16 60 Q40 56 50 61 T86 58" stroke="#8a7a63" stroke-width="1.3" fill="none"/>
      <path d="M16 74 Q40 70 50 75 T86 72" stroke="#8a7a63" stroke-width="1.3" fill="none"/>
    </svg>`;
  }
  return '';
}

const TUT_SLIDES = [
  {
    title: 'Check these 5 things before uploading',
    body: [
      'Good results start with a good source image. Run through the checklist below once before you upload — it will save you a lot of re-runs later:',
      '<b>1)</b> Set real materials in the model &nbsp; <b>2)</b> Clean up the geometry &nbsp; <b>3)</b> Reduce heavy outlines &nbsp; <b>4)</b> Use a high-resolution source image &nbsp; <b>5)</b> Match the site options to what you want'
    ]
  },
  {
    title: 'Set real materials in the model from the start',
    body: [
      'The system only interprets what actually exists in the image — <b>it doesn&#39;t guess what material you want</b>. If the surfaces in your model are still plain gray or white, the result will look just as flat.',
      'Apply realistic colors and materials (e.g. wood tone, tile color) while modeling, before you export.'
    ],
    compare: { left:'flat', leftLabel:'No material set', right:'grain', rightLabel:'Real material set' }
  },
  {
    title: 'Good geometry = good results',
    body: [
      'The system mainly follows the shape of your existing model. If the model has odd proportions or messy angles, the result tends to inherit those same odd volumes.',
      'Tidy up proportions and clean the geometry before uploading, especially around the focal point of the shot.'
    ],
    compare: { left:'messy', leftLabel:'Messy geometry', right:'clean', rightLabel:'Clean geometry' }
  },
  {
    title: 'Reduce overly thick outlines',
    body: [
      'Heavy contour/profile lines when exporting from SketchUp often make the image read as an illustration or cartoon rather than a real photo.',
      'Turn off or thin out the outlines before uploading — the smoother your source image looks, the more naturally the system will read it as a photograph.'
    ],
    compare: { left:'outline', leftLabel:'Outline too heavy', right:'soft', rightLabel:'No outline' }
  },
  {
    title: 'Use a high-resolution source image',
    body: [
      'A sharp image with enough resolution gives the system more detail to build on.',
      'Avoid blurry images, ones with watermarks, or heavily compressed images with visible blocking — detail that&#39;s already lost can&#39;t be accurately recreated.'
    ]
  },
  {
    title: 'Match the site options to what you want',
    body: [
      'Before you hit Run, check the options on the left — Time of Day, Clouds, Weather, Background, People/Vehicles, Focus Mode (Exterior) or Room Type/Artificial Lighting (Interior) — and set them to match what you want up front.',
      'Getting the settings right from the start saves a lot of re-runs later.'
    ]
  }
];

let tutIndex = 0;
function tutRender(){
  const s = TUT_SLIDES[tutIndex];
  let html = `<h3>${s.title}</h3>` + s.body.map(p=>`<p>${p}</p>`).join('');
  if(s.compare){
    html += `<div class="tut-compare">
      <div class="col">
        <div class="box">${tutCube(s.compare.left)}</div>
        <div class="tag bad">✕ ${s.compare.leftLabel}</div>
      </div>
      <div class="col">
        <div class="box">${tutCube(s.compare.right)}</div>
        <div class="tag good">✓ ${s.compare.rightLabel}</div>
      </div>
    </div>`;
  }
  $('tutBody').innerHTML = html;
  $('tutBadge').textContent = (tutIndex+1) + '/' + TUT_SLIDES.length;
  $('tutPrev').disabled = tutIndex === 0;
  $('tutNext').textContent = tutIndex === TUT_SLIDES.length - 1 ? 'Done ✓' : 'Next →';
  $('tutDots').innerHTML = TUT_SLIDES.map((_,i)=>`<span class="${i===tutIndex?'active':''}" data-i="${i}"></span>`).join('');
  $('tutDots').querySelectorAll('span').forEach(dot=>{
    dot.addEventListener('click', ()=>{ tutIndex = parseInt(dot.dataset.i); tutRender(); });
  });
}
function tutOpen(){ tutIndex = 0; tutRender(); $('tutOverlay').classList.add('open'); }
function tutClose(){ $('tutOverlay').classList.remove('open'); }
$('tutBtn').addEventListener('click', tutOpen);
$('tutClose').addEventListener('click', tutClose);
$('tutOverlay').addEventListener('click', (e)=>{ if(e.target === $('tutOverlay')) tutClose(); });
$('tutPrev').addEventListener('click', ()=>{ if(tutIndex>0){ tutIndex--; tutRender(); } });
$('tutNext').addEventListener('click', ()=>{
  if(tutIndex < TUT_SLIDES.length-1){ tutIndex++; tutRender(); } else { tutClose(); }
});


// ===================== HOME SCRIPT =====================
(function(){

function cubeSVG(mode){
  if(mode === 'outline') return `<svg viewBox="0 0 100 100" width="56%" height="56%">
    <polygon points="50,10 85,28 50,46 15,28" fill="#ffffff" stroke="#171717" stroke-width="3" stroke-linejoin="round"/>
    <polygon points="15,28 50,46 50,86 15,68" fill="#ffffff" stroke="#171717" stroke-width="3" stroke-linejoin="round"/>
    <polygon points="85,28 50,46 50,86 85,68" fill="#ffffff" stroke="#171717" stroke-width="3" stroke-linejoin="round"/>
  </svg>`;
  return `<svg viewBox="0 0 100 100" width="56%" height="56%">
    <polygon points="50,10 85,28 50,46 15,28" fill="#e7e7e7"/>
    <polygon points="15,28 50,46 50,86 15,68" fill="#bdbdbd"/>
    <polygon points="85,28 50,46 50,86 85,68" fill="#8c8c8c"/>
  </svg>`;
}

// Placeholder examples — swap `before`/`after` for real image URLs once available.
const SHOWCASE = [
  { cat:'Exterior', title:'Weekend house', before: cubeSVG('outline'), after: cubeSVG('soft') },
  { cat:'Interior',  title:'Modern living room', before: cubeSVG('outline'), after: cubeSVG('soft') },
  { cat:'Exterior', title:'Office building', before: cubeSVG('outline'), after: cubeSVG('soft') }
];

const showcase = document.getElementById('showcase');
SHOWCASE.forEach(p=>{
  const card = document.createElement('div');
  card.className = 'scard';
  card.innerHTML = `
    <div class="cmp">
      <div class="after">${p.after}</div>
      <div class="before-wrap" style="clip-path:inset(0 50% 0 0);">${p.before}</div>
      <div class="cmp-line" style="left:50%;"></div>
      <div class="cmp-dot" style="left:50%;">
        <svg width="16" height="9" viewBox="0 0 20 11" fill="none"><path d="M6 1L1 5.5L6 10M14 1L19 5.5L14 10" stroke="#fff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <div class="cmp-label b">Original</div>
      <div class="cmp-label a">Result</div>
    </div>
    <div class="meta">
      <div class="tag">${p.cat}</div>
      <div class="title">${p.title}</div>
    </div>`;
  showcase.appendChild(card);
  initSlider(card.querySelector('.cmp'));
});

function initSlider(el){
  const wrap = el.querySelector('.before-wrap');
  const line = el.querySelector('.cmp-line');
  const dot = el.querySelector('.cmp-dot');
  let dragging = false;
  function setPct(clientX){
    const rect = el.getBoundingClientRect();
    let pct = ((clientX - rect.left) / rect.width) * 100;
    pct = Math.max(0, Math.min(100, pct));
    wrap.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
    line.style.left = pct + '%';
    dot.style.left = pct + '%';
  }
  el.addEventListener('pointerdown', (e)=>{ dragging = true; setPct(e.clientX); });
  window.addEventListener('pointermove', (e)=>{ if(dragging) setPct(e.clientX); });
  window.addEventListener('pointerup', ()=> dragging = false);
}

})();


// ===================== LOGIN SCRIPT (Supabase auth) =====================
(function(){

const $id = id => document.getElementById(id);
function showLoading(text){
  $id('googleBtn').style.display = 'none';
  $id('loginForm').classList.add('hide');
  document.querySelector('#view-login .divider').classList.add('hide');
  $id('statusText').textContent = text;
  $id('status').classList.add('show');
}
function resetForm(message){
  $id('googleBtn').style.display = '';
  $id('loginForm').classList.remove('hide');
  document.querySelector('#view-login .divider').classList.remove('hide');
  $id('status').classList.remove('show');
  if(message) alert(message);
}
function showSuccess(email){
  $id('status').classList.remove('show');
  $id('formArea').style.display = 'none';
  $id('successEmail').textContent = 'Signed in as ' + email;
  $id('successView').classList.add('show');
}
window.loginShowSuccess = showSuccess;

$id('googleBtn').addEventListener('click', async ()=>{
  if(!sb){ alert('Sign-in is not configured yet — please try again later.'); return; }
  showLoading('Connecting to Google...');
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: location.origin }
  });
  if(error) resetForm(error.message);
  // on success the browser redirects to Google and back; session is picked up on return
});

$id('emailBtn').addEventListener('click', async ()=>{
  if(!sb){ alert('Sign-in is not configured yet — please try again later.'); return; }
  const email = $id('email').value.trim();
  const pass = $id('pass').value;
  if(!email || !pass){ alert('Please enter your email and password.'); return; }
  showLoading('Signing in...');
  const { error } = await sb.auth.signInWithPassword({ email, password: pass });
  if(!error){ showSuccess(email); return; }
  if(/invalid login credentials/i.test(error.message)){
    // no account with this email yet — create one
    const { data, error: signUpError } = await sb.auth.signUp({ email, password: pass });
    if(signUpError){ resetForm(signUpError.message); return; }
    if(data.session){ showSuccess(email); return; }
    resetForm('Account created — check your email to confirm, then sign in again.');
    return;
  }
  resetForm(error.message);
});

})();


// ===================== UPGRADE SCRIPT =====================
(function(){

const $ = id => document.getElementById(id);
$('tglMonthly').addEventListener('click', ()=> setBilling('m'));
$('tglYearly').addEventListener('click', ()=> setBilling('y'));
function setBilling(mode){
  $('tglMonthly').classList.toggle('active', mode === 'm');
  $('tglYearly').classList.toggle('active', mode === 'y');
  document.querySelectorAll('.pprice[data-m]').forEach(el=>{
    const val = mode === 'm' ? el.dataset.m : el.dataset.y;
    const suffix = mode === 'm' ? '/mo' : '/mo billed yearly';
    el.innerHTML = '฿' + Number(val).toLocaleString() + '<span>' + suffix + '</span>';
  });
}

})();


// ===================== GALLERY SCRIPT =====================
(function(){

function cubeSVG(mode){
  if(mode === 'outline') return `<svg viewBox="0 0 100 100" width="56%" height="56%">
    <polygon points="50,10 85,28 50,46 15,28" fill="#ffffff" stroke="#171717" stroke-width="3" stroke-linejoin="round"/>
    <polygon points="15,28 50,46 50,86 15,68" fill="#ffffff" stroke="#171717" stroke-width="3" stroke-linejoin="round"/>
    <polygon points="85,28 50,46 50,86 85,68" fill="#ffffff" stroke="#171717" stroke-width="3" stroke-linejoin="round"/>
  </svg>`;
  return `<svg viewBox="0 0 100 100" width="56%" height="56%">
    <polygon points="50,10 85,28 50,46 15,28" fill="#e7e7e7"/>
    <polygon points="15,28 50,46 50,86 15,68" fill="#bdbdbd"/>
    <polygon points="85,28 50,46 50,86 85,68" fill="#8c8c8c"/>
  </svg>`;
}

// Placeholder project data — replace `before`/`after` with real image URLs when available.
const PROJECTS = [
  { cat:'exterior', title:'Vacation House', before: cubeSVG('outline'), after: cubeSVG('soft') },
  { cat:'interior', title:'Modern Living Room', before: cubeSVG('outline'), after: cubeSVG('soft') },
  { cat:'exterior', title:'Office Building', before: cubeSVG('outline'), after: cubeSVG('soft') },
  { cat:'interior', title:'Minimalist Bedroom', before: cubeSVG('outline'), after: cubeSVG('soft') },
  { cat:'exterior', title:'Two-Storey Townhome', before: cubeSVG('outline'), after: cubeSVG('soft') },
  { cat:'interior', title:'Loft-Style Kitchen', before: cubeSVG('outline'), after: cubeSVG('soft') }
];

const grid = document.getElementById('grid');

function render(filter){
  grid.innerHTML = '';
  PROJECTS.filter(p => filter === 'all' || p.cat === filter).forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'gcard';
    card.innerHTML = `
      <div class="gcmp" data-i="${i}">
        <div class="after">${p.after}</div>
        <div class="before-wrap" style="clip-path:inset(0 50% 0 0);">${p.before}</div>
        <div class="gcmp-line" style="left:50%;"></div>
        <div class="gcmp-dot" style="left:50%;">
          <svg width="16" height="9" viewBox="0 0 20 11" fill="none"><path d="M6 1L1 5.5L6 10M14 1L19 5.5L14 10" stroke="#fff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <div class="gcmp-label b">Original</div>
        <div class="gcmp-label a">Result</div>
      </div>
      <div class="meta">
        <div class="tag">${p.cat === 'exterior' ? 'Exterior' : 'Interior'}</div>
        <div class="title">${p.title}</div>
      </div>`;
    grid.appendChild(card);
    initSlider(card.querySelector('.gcmp'));
  });
}

function initSlider(el){
  const wrap = el.querySelector('.before-wrap');
  const line = el.querySelector('.gcmp-line');
  const dot = el.querySelector('.gcmp-dot');
  let dragging = false;

  function setPct(clientX){
    const rect = el.getBoundingClientRect();
    let pct = ((clientX - rect.left) / rect.width) * 100;
    pct = Math.max(0, Math.min(100, pct));
    wrap.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
    line.style.left = pct + '%';
    dot.style.left = pct + '%';
  }
  el.addEventListener('pointerdown', (e)=>{ dragging = true; setPct(e.clientX); });
  window.addEventListener('pointermove', (e)=>{ if(dragging) setPct(e.clientX); });
  window.addEventListener('pointerup', ()=> dragging = false);
}

document.querySelectorAll('.tab').forEach(tab=>{
  tab.addEventListener('click', ()=>{
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    tab.classList.add('active');
    render(tab.dataset.f);
  });
});

render('all');

})();

// ===================== DARK MODE TOGGLE (global) =====================
(function(){
  const btn = document.getElementById('themeToggle');
  const iconMoon = 'M9 1.5V3.3M9 14.7V16.5M16.5 9H14.7M3.3 9H1.5M14.1 3.9L12.8 5.2M5.2 12.8L3.9 14.1M14.1 14.1L12.8 12.8M5.2 5.2L3.9 3.9';
  const iconRays = document.getElementById('themeIcon').querySelector('path');
  const iconCircle = document.getElementById('themeIcon').querySelector('circle');
  btn.addEventListener('click', ()=>{
    const isDark = document.body.classList.toggle('dark');
    const stroke = isDark ? '#f0f0f0' : '#171717';
    iconCircle.setAttribute('stroke', stroke);
    if(isDark){
      // moon icon
      iconRays.setAttribute('d', 'M14.5 10.2A6 6 0 1 1 7.8 3.5A5 5 0 0 0 14.5 10.2Z');
      iconCircle.setAttribute('stroke', 'none');
      iconCircle.setAttribute('fill', stroke);
      iconRays.setAttribute('stroke', 'none');
      iconRays.setAttribute('fill', stroke);
    } else {
      iconRays.setAttribute('d', iconMoon);
      iconRays.setAttribute('fill', 'none');
      iconRays.setAttribute('stroke', stroke);
      iconCircle.setAttribute('fill', 'none');
      iconCircle.setAttribute('stroke', stroke);
    }
  });
})();

