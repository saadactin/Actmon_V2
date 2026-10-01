/* Validates the Knowledge Centre against the brief's hard layout rules. */
const fs=require('fs'),path=require('path');
const {JSDOM,VirtualConsole}=require('E:/ACTMON V1/frontend/node_modules/jsdom');
const DIR='E:/ACTMON V1/docs/interactive';
let pass=0,fail=0;
const ok=(c,m)=>{if(c){pass++;console.log('  PASS  '+m);}else{fail++;console.log('  FAIL  '+m);}};
const errors=[];
const vc=new VirtualConsole();
vc.on('jsdomError',e=>errors.push(e.message));
vc.on('warn',(...a)=>errors.push('warn: '+a.join(' ')));
const raw=fs.readFileSync(path.join(DIR,'actmon-knowledge.html'),'utf8');
const html=raw.replace(/<script src="https:[^"]*"><\/script>/g,'');
const dom=new JSDOM(html,{runScripts:'dangerously',virtualConsole:vc,pretendToBeVisual:true,url:'http://localhost/'});
const {window}=dom,doc=window.document;
window.matchMedia=q=>({matches:false,media:q,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}});
window.IntersectionObserver=class{constructor(){}observe(){}disconnect(){}};
window.scrollTo=()=>{};
window.Element.prototype.scrollIntoView=function(){ window.__lastScroll=this.id; };
function inject(){for(const f of ['actmon-data.js','actmon-samples.js','actmon-engines.js','actmon-metrics.js','actmon-scene.js','actmon-page.js']){const s=doc.createElement('script');s.textContent=fs.readFileSync(path.join(DIR,f),'utf8');doc.body.appendChild(s);}}
if(doc.readyState==='loading') window.addEventListener('DOMContentLoaded',inject); else inject();
const $=s=>doc.querySelector(s),$$=s=>[...doc.querySelectorAll(s)];
setTimeout(()=>{
  console.log('=== LAYOUT CONTRACT (the brief\'s hard rules) ===');
  const heroTop=$('#hero'), docMain=$('#doc');
  ok(!!heroTop&&!!docMain,'hero and document both exist');
  ok(doc.body.innerHTML.indexOf('id="hero"')<doc.body.innerHTML.indexOf('id="doc"'),
     'documentation comes AFTER the 3D hero in the DOM, not beside it');
  const banned=[/id="panel"/,/class="[^"]*drawer/,/position:fixed[^}]*right:0[^}]*width:min\(4/];
  ok(!banned.some(re=>re.test(raw)),'no side drawer / fixed right-hand panel in the markup or CSS');
  ok(!/Enter Cloud Monitoring/i.test(raw),'no "Enter Cloud Monitoring" button');
  ok(!/<dialog|role="dialog"/i.test(raw),'no modal used as the documentation surface');
  const sects=$$('.sect');
  ok(sects.length>=10,'documentation is split into stacked full-width sections ('+sects.length+')');
  ok(/\.s-wrap\{max-width:var\(--wrap\)/.test(raw),'sections use the full content width, not a column beside the 3D');

  console.log('\n=== CLICK A NODE -> PAGE SCROLLS TO ITS SECTION ===');
  ok(/scrollIntoView/.test(fs.readFileSync(path.join(DIR,'actmon-page.js'),'utf8')),'selection scrolls the page');
  const navBtns=$$('#secNav .sn');
  ok(navBtns.length===sects.length,'one nav entry per section ('+navBtns.length+')');
  navBtns.find(b=>/Cloud/.test(b.textContent)).dispatchEvent(new window.Event('click',{bubbles:true}));
  ok(window.__lastScroll==='sec-cloud','clicking Cloud scrolled to sec-cloud (got '+window.__lastScroll+')');
  navBtns.find(b=>/Database/.test(b.textContent)).dispatchEvent(new window.Event('click',{bubbles:true}));
  ok(window.__lastScroll==='sec-database','clicking Database scrolled to sec-database');

  console.log('\n=== CONTENT DEPTH ===');
  const MX=window.ACTMON_METRICS;
  ok(MX.METRICS.length>=13,'metric dictionary covers the dashboard ('+MX.METRICS.length+' metrics)');
  const required=['business','technical','scope','source','collection','formula','units','window','aggregation','interpretation','example','verify','troubleshooting','evidence','status'];
  const thin=[];
  MX.METRICS.forEach(m=>required.forEach(f=>{ if(!m[f]||(Array.isArray(m[f])&&!m[f].length)) thin.push(m.id+'.'+f); }));
  ok(thin.length===0,'every metric completes the full template'+(thin.length?' ['+thin.slice(0,6).join(', ')+']':''));
  const cpu=MX.METRICS.find(m=>m.id==='avg-cpu');
  ok(!!cpu,'Avg. CPU Usage is documented');
  ok(/filter\(v => v > 0\)/.test(cpu.formula),'its real formula is shown, including the >0 filter');
  ok(/useDashboardData\.js:141/.test(cpu.formulaRef),'the formula names its file and line');
  ok(cpu.findings.length>=4,'the CPU trace carries its findings ('+cpu.findings.length+')');
  ok(cpu.findings.some(f=>/[Oo]ffline hosts are included/.test(f.title)),'the offline-host discrepancy is stated');
  ok(/ILLUSTRATIVE/.test(cpu.example),'its worked example is labelled illustrative');
  ok(MX.UNVERIFIED.length>0,'unverified items are listed rather than guessed ('+MX.UNVERIFIED.length+')');
  ok(MX.UNVERIFIED.every(u=>u.read),'each unverified item names where to look next');

  const text=docMain.textContent;
  ok(text.length>24000,'the page carries substantial documentation ('+text.length+' chars)');
  ok(/Logins/.test(text)&&/Always On/.test(text),'engine vocabulary survives into the page');
  ok(/Not implemented/.test(text)&&/Google Cloud/.test(text),'GCP is named as not implemented');
  ok(/Redis/.test(text),'Redis is covered');

  console.log('\n=== ACCESSIBILITY & UTILITIES ===');
  ok($$('#toTop').length===1,'back-to-top control exists');
  ok($$('.s-top').length===sects.length,'every section has its own back-to-top');
  ok(!!$('#find'),'search exists');
  ok(/@media print/.test(raw),'a print stylesheet is defined');
  ok(/prefers-reduced-motion/.test(raw),'reduced motion is honoured');
  ok(sects.every(s=>s.getAttribute('tabindex')==='-1'),'sections are focusable for keyboard/screen-reader landing');
  ok(/colour is never the only signal|Colour is never the only signal/i.test(text),'status is conveyed by word as well as colour');

  console.log('\n=== SAFETY ===');
  const all=['actmon-data.js','actmon-samples.js','actmon-engines.js','actmon-metrics.js','actmon-scene.js','actmon-page.js']
    .map(f=>fs.readFileSync(path.join(DIR,f),'utf8')).join('')+raw;
  ok(!/password\s*[:=]\s*['"][^'"]{3,}/i.test(all)&&!/xox[baprs]-/.test(all)&&!/postgresql:\/\/[^\s'"]*:[^\s'"@]*@/.test(all),
     'no credential-shaped strings anywhere');

  const real=errors.filter(e=>!/getContext\(\) method: without installing the canvas/.test(e));
  ok(real.length===0,'no runtime errors'+(real.length?': '+real.slice(0,3).join(' | '):''));

  console.log('\n'+'='.repeat(56));
  console.log('  '+pass+' passed, '+fail+' failed');
  console.log('='.repeat(56));
  process.exit(fail?1:0);
},2200);
