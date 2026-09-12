import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import pg from 'pg';
import Parser from 'rss-parser';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 10000);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized:false } : false, max: 5 });
const parser = new Parser({ timeout: 12000, headers: { 'User-Agent':'LightWatch-NG/2.0 (+https://lightwatch.ng)' } });

const STATES = ["Abia","Adamawa","Akwa Ibom","Anambra","Bauchi","Bayelsa","Benue","Borno","Cross River","Delta","Ebonyi","Edo","Ekiti","Enugu","FCT (Abuja)","Gombe","Imo","Jigawa","Kaduna","Kano","Katsina","Kebbi","Kogi","Kwara","Lagos","Nasarawa","Niger","Ogun","Ondo","Osun","Oyo","Plateau","Rivers","Sokoto","Taraba","Yobe","Zamfara"];
const DISCO = {Lagos:'Ikeja Electric / Eko Electricity Distribution', 'FCT (Abuja)':'AEDC', Rivers:'PHED', 'Akwa Ibom':'PHED', 'Cross River':'PHED', Delta:'BEDC', Edo:'BEDC', Ondo:'BEDC', Abia:'EEDC', Anambra:'EEDC', Ebonyi:'EEDC', Enugu:'EEDC', Imo:'EEDC', Ogun:'IBEDC', Oyo:'IBEDC', Osun:'IBEDC', Kwara:'IBEDC', Kaduna:'KAEDCO', Kano:'KEDCO', Katsina:'KEDCO', Kebbi:'KAEDCO', Sokoto:'KAEDCO', Zamfara:'KAEDCO', Adamawa:'YEDC', Borno:'YEDC', Taraba:'YEDC', Yobe:'YEDC', Bauchi:'JED', Benue:'JED', Gombe:'JED', Plateau:'JED', Jigawa:'KEDCO', Kogi:'AEDC', Nasarawa:'AEDC', Niger:'AEDC', Bayelsa:'PHED', Ekiti:'IBEDC' };
const TERMS = ['transformer','power outage','electricity outage','blackout','power supply','PHCN','DisCo','disco','Ikeja Electric','EKEDC','AEDC','IBEDC','EEDC','PHED','BEDC','KEDCO','KAEDCO','YEDC','JED','TCN','gas supply','gas shortage','transmission','feeder','power restored','electricity restored'];

app.use(express.json({limit:'1mb'}));
// CORS: the Android app (PHCN Alert) loads its HTML from a local/app origin,
// not from lightwatch-ng.onrender.com, so cross-origin API calls need these
// headers or the WebView silently blocks the response. The public web
// version doesn't need this (same-origin), but it's harmless there too.
app.use((req,res,next)=>{
  res.header('Access-Control-Allow-Origin','*');
  res.header('Access-Control-Allow-Headers','Content-Type, x-scan-secret');
  res.header('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  if(req.method==='OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(ROOT_PUBLIC()));

function ROOT_PUBLIC(){ return path.join(__dirname, 'public'); }
async function q(text, params=[]){ return pool.query(text, params); }
async function initDb(){
  if(!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required on Render.');
  await q(`CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, state TEXT NOT NULL, city TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());`);
  await q(`CREATE TABLE IF NOT EXISTS surveys (profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE, answers JSONB NOT NULL DEFAULT '{}'::jsonb, submitted_at TIMESTAMPTZ DEFAULT now());`);
  await q(`CREATE TABLE IF NOT EXISTS observations (id BIGSERIAL PRIMARY KEY, profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL, state TEXT NOT NULL, city TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('outage','restored','still_out')), observed_at TIMESTAMPTZ NOT NULL DEFAULT now(), duration_minutes INTEGER, source TEXT DEFAULT 'user');`);
  await q(`CREATE INDEX IF NOT EXISTS observations_state_city_time ON observations(state,city,observed_at DESC);`);
  await q(`CREATE INDEX IF NOT EXISTS observations_state_time ON observations(state,observed_at DESC);`);
  await q(`CREATE TABLE IF NOT EXISTS knowledge_items (id BIGSERIAL PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, title TEXT NOT NULL, summary TEXT, source_name TEXT, url TEXT, published_at TIMESTAMPTZ, discovered_at TIMESTAMPTZ DEFAULT now(), state TEXT, city TEXT, category TEXT, severity TEXT DEFAULT 'info', keywords TEXT[] DEFAULT '{}', raw JSONB DEFAULT '{}'::jsonb);`);
  await q(`CREATE INDEX IF NOT EXISTS knowledge_area_time ON knowledge_items(state,city,published_at DESC);`);
  await q(`CREATE TABLE IF NOT EXISTS alert_preferences (profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE, enabled BOOLEAN DEFAULT true, updated_at TIMESTAMPTZ DEFAULT now());`);
}
function clean(v){ return String(v ?? '').trim(); }
function localId(v){ return /^[a-zA-Z0-9_-]{16,80}$/.test(v) ? v : null; }
function areaParams(body){ return { id:localId(body.profileId), state:clean(body.state), city:clean(body.city) }; }
function ensureArea(state,city){ if(!STATES.includes(state) || !city) throw new Error('Valid state and city are required.'); }
function predictionFromRows({survey, stateStats, areaStats, currentOut, now=new Date()}){
  const q1 = survey?.q1;
  const baseByHours = {'<4':230,'4-8':195,'8-12':165,'12-16':135,'16-20':100,'20-24':70};
  let duration = baseByHours[q1] ?? 150;
  const stateBand = ['A','B','C','D','E'].find(x => String(survey?.band||'').startsWith(x));
  duration += ({A:-25,B:-10,C:0,D:20,E:35}[stateBand] ?? 10);
  const observed = [...areaStats.durations,...stateStats.durations].filter(n=>Number.isFinite(n)&&n>0);
  if(observed.length >= 3){ observed.sort((a,b)=>a-b); duration = Math.round((duration*0.35 + observed[Math.floor(observed.length/2)]*0.65)); }
  if(currentOut){ duration = Math.max(20, Math.min(720,duration)); }
  else duration = Math.max(30, Math.min(720, duration*0.55));

  const sample = stateStats.surveys + areaStats.surveys;
  const sampleBoost = Math.min(25, Math.log2(Math.max(1,stateStats.surveys)+1)*6);
  const areaBoost = Math.min(25, Math.log2(Math.max(1,areaStats.surveys)+1)*8);
  const historyBoost = Math.min(20, observed.length*2);
  const confidenceScore = Math.round(Math.min(96, 28 + sampleBoost + areaBoost + historyBoost));

  let commonOffHour = null;
  if(stateStats.offHours?.length){ const counts={}; for(const h of stateStats.offHours) counts[h]=(counts[h]||0)+1; commonOffHour=Number(Object.entries(counts).sort((a,b)=>b[1]-a[1])[0][0]); }
  const target = new Date(now.getTime() + duration*60000);
  let likelyOffWindow = null;
  if (commonOffHour != null) {
    const d = new Date(now); d.setMinutes(0,0,0); d.setHours(commonOffHour);
    if (d <= now) d.setDate(d.getDate()+1);
    likelyOffWindow = d;
  } else if (survey?.q4 === 'night' && survey?.q5time) {
    const [hh,mm] = survey.q5time.split(':').map(Number);
    if (Number.isFinite(hh)) { const d=new Date(now); d.setHours(hh,Number.isFinite(mm)?mm:0,0,0); if(d<=now)d.setDate(d.getDate()+1); likelyOffWindow=d; }
  }
  return { target, durationMinutes:duration, confidenceScore, confidence: confidenceScore>=75?'High':confidenceScore>=55?'Medium':'Low', stateSurveyCount:stateStats.surveys, areaSurveyCount:areaStats.surveys, commonOffHour, likelyOffWindow, sampleSize:sample };
}
async function getPrediction(state,city,profileId){
  const surveyR = await q('SELECT answers FROM surveys WHERE profile_id=$1',[profileId]);
  const survey = surveyR.rows[0]?.answers || {};
  const areaSurveys = await q(`SELECT count(*)::int n FROM profiles p JOIN surveys s ON s.profile_id=p.id WHERE p.state=$1 AND lower(p.city)=lower($2)`,[state,city]);
  const stateSurveys = await q(`SELECT count(*)::int n FROM profiles p JOIN surveys s ON s.profile_id=p.id WHERE p.state=$1`,[state]);
  const areaObs = await q(`SELECT type,duration_minutes,observed_at FROM observations WHERE state=$1 AND lower(city)=lower($2) AND observed_at>now()-interval '90 days' ORDER BY observed_at DESC LIMIT 1000`,[state,city]);
  const stateObs = await q(`SELECT type,duration_minutes,observed_at FROM observations WHERE state=$1 AND observed_at>now()-interval '90 days' ORDER BY observed_at DESC LIMIT 3000`,[state]);
  const stats = rows => ({ durations:rows.map(r=>Number(r.duration_minutes)).filter(Boolean), offHours:rows.filter(r=>r.type==='outage').map(r=>new Date(r.observed_at).getHours()) });
  const current = areaObs.rows[0]?.type === 'outage';
  const p = predictionFromRows({survey,stateStats:{...stats(stateObs.rows),surveys:stateSurveys.rows[0].n},areaStats:{...stats(areaObs.rows),surveys:areaSurveys.rows[0].n},currentOut:current});
  return { ...p, lightOn:!current, state, city };
}

app.get('/api/health', async (_req,res)=>{ try { await q('SELECT 1'); res.json({ok:true,service:'LightWatch NG Render API',database:true,newsScanner:true}); } catch(e){ res.status(503).json({ok:false,error:e.message}); } });

app.post('/api/profile', async (req,res)=>{ try { const {id,state,city}=areaParams(req.body); ensureArea(state,city); const pid=id||crypto.randomUUID(); await q(`INSERT INTO profiles(id,state,city) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET state=excluded.state, city=excluded.city, updated_at=now()`,[pid,state,city]); res.json({ok:true,profileId:pid}); } catch(e){ res.status(400).json({error:e.message}); } });
app.post('/api/survey', async (req,res)=>{ try { const {id,state,city}=areaParams(req.body); ensureArea(state,city); if(!id) throw new Error('profileId required'); await q(`INSERT INTO profiles(id,state,city) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET state=excluded.state,city=excluded.city,updated_at=now()`,[id,state,city]); await q(`INSERT INTO surveys(profile_id,answers) VALUES($1,$2) ON CONFLICT(profile_id) DO UPDATE SET answers=excluded.answers,submitted_at=now()`,[id,JSON.stringify(req.body.survey||{})]); res.json({ok:true}); } catch(e){ res.status(400).json({error:e.message}); } });
app.post('/api/report', async (req,res)=>{ try { const {id,state,city}=areaParams(req.body); ensureArea(state,city); if(!id) throw new Error('profileId required'); const type=['outage','restored','still_out'].includes(req.body.type)?req.body.type:null; if(!type) throw new Error('Invalid report type'); const duration=Number.isFinite(Number(req.body.durationMinutes))?Math.round(Number(req.body.durationMinutes)):null; await q(`INSERT INTO profiles(id,state,city) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING`,[id,state,city]); await q(`INSERT INTO observations(profile_id,state,city,type,duration_minutes,source) VALUES($1,$2,$3,$4,$5,'user')`,[id,state,city,type,duration]); res.json({ok:true}); } catch(e){ res.status(400).json({error:e.message}); } });
app.get('/api/area', async (req,res)=>{ try { const state=clean(req.query.state), city=clean(req.query.city); ensureArea(state,city); const r=await q(`SELECT type,observed_at,duration_minutes FROM observations WHERE state=$1 AND lower(city)=lower($2) ORDER BY observed_at DESC LIMIT 30`,[state,city]); const s=await q(`SELECT count(*)::int n FROM profiles p JOIN surveys sv ON sv.profile_id=p.id WHERE p.state=$1 AND lower(p.city)=lower($2)`,[state,city]); const st=await q(`SELECT count(*)::int n FROM profiles p JOIN surveys sv ON sv.profile_id=p.id WHERE p.state=$1`,[state]); res.json({ok:true,area:{state,city,disco:DISCO[state]||'Local DisCo',surveyCount:s.rows[0].n,stateSurveyCount:st.rows[0].n,reports:r.rows}}); } catch(e){ res.status(400).json({error:e.message}); } });
app.get('/api/prediction', async (req,res)=>{ try { const state=clean(req.query.state),city=clean(req.query.city),profileId=localId(req.query.profileId); ensureArea(state,city); if(!profileId) throw new Error('profileId required'); res.json({ok:true,prediction:await getPrediction(state,city,profileId)}); } catch(e){ res.status(400).json({error:e.message}); } });
app.post('/api/alert', async (req,res)=>{ try { const id=localId(req.body.profileId); if(!id) throw new Error('profileId required'); await q(`INSERT INTO alert_preferences(profile_id,enabled) VALUES($1,$2) ON CONFLICT(profile_id) DO UPDATE SET enabled=excluded.enabled,updated_at=now()`,[id,!!req.body.enabled]); res.json({ok:true}); } catch(e){ res.status(400).json({error:e.message}); } });
app.get('/api/intel', async (req,res)=>{ try { const state=clean(req.query.state),city=clean(req.query.city); ensureArea(state,city); const r=await q(`SELECT id,title,summary,source_name,url,published_at,state,city,category,severity,discovered_at FROM knowledge_items WHERE (state IS NULL OR state=$1 OR lower(city)=lower($2)) AND published_at>now()-interval '30 days' ORDER BY published_at DESC NULLS LAST LIMIT 50`,[state,city]); res.json({ok:true,items:r.rows}); } catch(e){ res.status(400).json({error:e.message}); } });

export async function scanNews(){
  const queries = [];
  for(const state of STATES){ queries.push({state, q:`${state} (${DISCO[state]||'electricity'} OR PHCN OR TCN) (power OR electricity OR outage OR transformer OR blackout OR restored OR gas)`}); }
  const now=Date.now(); let saved=0;
  for(const item of queries){
    const url='https://news.google.com/rss/search?q='+encodeURIComponent(item.q+' when:7d')+'&hl=en-NG&gl=NG&ceid=NG:en';
    let feed; try{ feed=await parser.parseURL(url); }catch{ continue; }
    for(const x of (feed.items||[]).slice(0,15)){
      const title=clean(x.title); const link=x.link; if(!title||!link) continue;
      const text=(title+' '+clean(x.contentSnippet)).toLowerCase();
      if(!TERMS.some(t=>text.includes(t.toLowerCase()))) continue;
      const category = /transformer|feeder|line|substation|tower|vandal/i.test(text)?'infrastructure':/gas|generation|plant/i.test(text)?'generation':/restored|restoration|back/i.test(text)?'restoration':'outage';
      const severity = /collapse|major blackout|months|destroyed|explosion|vandal/i.test(text)?'high':/outage|fault|transformer|gas shortage/i.test(text)?'medium':'info';
      const pub = x.isoDate ? new Date(x.isoDate) : new Date();
      const fp=crypto.createHash('sha256').update(link+'|'+title).digest('hex');
      const summary=clean(x.contentSnippet).slice(0,900);
      const source=clean(x.creator||x.source?.title||'News source');
      try { const r=await q(`INSERT INTO knowledge_items(fingerprint,title,summary,source_name,url,published_at,state,category,severity,keywords,raw) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(fingerprint) DO NOTHING`,[fp,title,summary,source,link,isNaN(pub.getTime())?new Date():pub,item.state,null,category,severity,TERMS.filter(t=>text.includes(t.toLowerCase())),JSON.stringify({query:item.q})]); saved+=r.rowCount; } catch{}
    }
  }
  await q(`DELETE FROM knowledge_items WHERE discovered_at < now()-interval '180 days'`);
  return {saved,ranAt:new Date(now).toISOString()};
}
app.post('/api/intel/scan', async (req,res)=>{ if(process.env.SCAN_SECRET && req.get('x-scan-secret')!==process.env.SCAN_SECRET) return res.status(401).json({error:'Unauthorized'}); try{res.json({ok:true,...await scanNews()});}catch(e){res.status(500).json({error:e.message});} });

app.get(/.*/, (req,res,next)=>{ if(req.path.startsWith('/api/')) return next(); res.sendFile(path.join(ROOT_PUBLIC(),'index.html')); });

await initDb();
if (process.env.SCAN_ONLY === 'true') { const result = await scanNews(); console.log(JSON.stringify(result)); await pool.end(); process.exit(0); }
app.listen(port,'0.0.0.0',()=>console.log(`LightWatch NG listening on ${port}`));

// No separate paid Cron Job service is used (Render Cron Jobs cannot run on
// the free compute plan). Instead, this free web service scans for news on
// its own timer whenever it is awake. Free web services spin down after ~15
// minutes of no traffic, so this interval only fires while something is
// actively using the app. To also catch periods of inactivity, point a free
// external scheduler (e.g. cron-job.org) at POST /api/intel/scan with the
// x-scan-secret header — see DEPLOY.md. That external ping is a bonus: it
// also acts as the traffic that keeps the free service from spinning down.
const SCAN_INTERVAL_MS = 30 * 60 * 1000;
setInterval(() => { scanNews().then(r => console.log('[scanner]', JSON.stringify(r))).catch(e => console.error('[scanner] failed:', e.message)); }, SCAN_INTERVAL_MS);
