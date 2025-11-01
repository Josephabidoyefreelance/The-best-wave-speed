import 'dotenv/config';
import express from "express";
import crypto from "crypto";

const {
  PORT = 4000,
  PUBLIC_BASE_URL,
  WAVESPEED_API_KEY,
  AIRTABLE_PAT,
  AIRTABLE_BASE_ID,
  AIRTABLE_TABLE
} = process.env;

if (!PUBLIC_BASE_URL || !WAVESPEED_API_KEY || !AIRTABLE_PAT || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE) {
  console.error("❌ Missing required env vars.");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

// ---------- helpers ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const nowISO = () => new Date().toISOString();

async function urlToDataURL(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Bad image URL ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get("content-type") || "image/png";
  return `data:${type};base64,${buf.toString("base64")}`;
}

// ---------- airtable ----------
const baseURL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}`;
const headers = { Authorization: `Bearer ${AIRTABLE_PAT}`, "Content-Type": "application/json" };

async function createRow(fields) {
  const res = await fetch(baseURL, { method: "POST", headers, body: JSON.stringify({ records: [{ fields }] }) });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Airtable create failed: ${res.status} ${txt}`);
  const data = JSON.parse(txt);
  return data.records?.[0]?.id;
}

async function patchRow(id, fields) {
  const res = await fetch(`${baseURL}/${id}`, { method: "PATCH", headers, body: JSON.stringify({ fields }) });
  if (!res.ok) throw new Error(`Airtable patch ${res.status}: ${await res.text()}`);
}

// ---------- wavespeed ----------
const WAVESPEED_ENDPOINT = "https://api.wavespeed.ai/v4/generations";

async function submitWaveSpeedJob({ prompt, subjectDataUrl, referenceDataUrls, width, height, runId }) {
  const payload = {
    prompt,
    model: "Seedream v4",
    width: Number(width) || 1024,
    height: Number(height) || 1024,
    images: [subjectDataUrl, ...referenceDataUrls],
  };
  const webhook = `${PUBLIC_BASE_URL.replace(/\/+$/, "")}/webhooks/wavespeed`;
  const url = `${WAVESPEED_ENDPOINT}?webhook=${encodeURIComponent(webhook)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${WAVESPEED_API_KEY}`, "Content-Type": "application/json", "x-run-id": runId },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  console.log("🚀 WaveSpeed raw response:", JSON.stringify(data, null, 2));

  // ✅ confirmed key name
  const requestId = data.id;
  if (!requestId) throw new Error("WaveSpeed submit: no id in response");
  return requestId;
}

// ---------- UI ----------
app.get("/app", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WaveSpeed Dashboard</title>
<style>
body{
  margin:0;padding:40px;
  font-family:Segoe UI,Roboto,sans-serif;
  background:linear-gradient(135deg,#101820,#06131f);
  color:#f5f5f5;
}
h1{text-align:center;color:#00bcd4;margin-bottom:30px;}
form{
  max-width:720px;margin:auto;
  background:rgba(255,255,255,0.05);
  padding:24px;border-radius:16px;
  box-shadow:0 8px 24px rgba(0,0,0,0.4);
  backdrop-filter:blur(12px);
  transition:transform .2s ease;
}
form:hover{transform:translateY(-3px);}
label{display:block;margin-top:14px;font-weight:600;color:#80deea;}
input,textarea{
  width:100%;padding:10px;margin-top:6px;
  border:none;border-radius:8px;
  background:rgba(255,255,255,0.1);
  color:#fff;font-size:14px;transition:.3s;
}
input:focus,textarea:focus{background:rgba(255,255,255,0.2);outline:none;}
button{
  margin-top:20px;padding:14px;width:100%;
  border:none;border-radius:12px;
  background:#00bcd4;color:#fff;
  font-size:16px;font-weight:600;cursor:pointer;
  transition:.3s;
}
button:hover{background:#0097a7;box-shadow:0 0 12px rgba(0,188,212,.5);}
.hint{text-align:center;margin-top:14px;color:#aaa;font-size:12px;}
#loading{display:none;text-align:center;margin-top:20px;}
</style>
</head>
<body>
<h1>⚡ WaveSpeed Seedream v4 — Batch Runner</h1>
<form id="batchForm">
  <label>Prompt</label>
  <textarea name="prompt" rows="3" required placeholder="Describe your dream image..."></textarea>
  <label>Subject image URL</label>
  <input name="subjectUrl" type="url" required placeholder="https://example.com/subject.png">
  <label>Reference image URLs (comma-separated)</label>
  <input name="referenceUrls" type="text" placeholder="https://ref1.png, https://ref2.png">
  <div style="display:flex;gap:10px;margin-top:10px;">
    <div style="flex:1"><label>Width</label><input name="width" type="number" value="1024"></div>
    <div style="flex:1"><label>Height</label><input name="height" type="number" value="1024"></div>
  </div>
  <label>Batch count</label><input name="count" type="number" value="2" min="1" max="10">
  <button type="submit">🚀 Start Batch</button>
</form>
<div id="loading">Submitting batch... please wait ⏳</div>
<script>
const form=document.getElementById('batchForm');
const loading=document.getElementById('loading');
form.addEventListener('submit',async e=>{
  e.preventDefault();
  loading.style.display='block';
  const data=new URLSearchParams(new FormData(form));
  const res=await fetch('/api/start-batch',{method:'POST',body:data});
  const json=await res.json();
  loading.innerHTML='<pre style="text-align:left;background:#000;padding:12px;border-radius:8px;">'+JSON.stringify(json,null,2)+'</pre>';
});
</script>
</body></html>`);
});

// ---------- API ----------
app.post("/api/start-batch", async (req, res) => {
  try {
    const { prompt, subjectUrl, referenceUrls = "", width = 1024, height = 1024, count = 1 } = req.body;
    if (!prompt || !subjectUrl) return res.status(400).json({ error: "Missing prompt or subject URL" });

    const refs = referenceUrls.split(",").map(s => s.trim()).filter(Boolean);
    const runId = crypto.randomUUID();

    const recordId = await createRow({
      "Prompt": prompt,
      "Subject": [{ url: subjectUrl }],
      "References": refs.map(u => ({ url: u })),
      "Output": [],
      "Output URL": "",
      "Model": "Seedream v4",
      "Size": `${width}x${height}`,
      "Request IDs": "",
      "Seen IDs": "",
      "Failed IDs": "",
      "Status": "processing",
      "Run ID": runId,
      "Created At": nowISO(),
      "Last Update": nowISO(),
      "Completed At": null
    });

    const subjectData = await urlToDataURL(subjectUrl);
    const refData = [];
    for (const r of refs) {
      try { refData.push(await urlToDataURL(r)); } catch {}
    }

    // submit jobs
    const jobPromises=[];
    for(let i=0;i<count;i++){
      const p=(async(delay)=>{
        await sleep(delay);
        const id=await submitWaveSpeedJob({prompt,subjectDataUrl:subjectData,referenceDataUrls:refData,width,height,runId});
        console.log("✅ Job submitted:",id);
        // ✅ Write job ID into Airtable so it starts tracking
        await patchRow(recordId,{
          "Request IDs": id,
          "Last Update": nowISO()
        });
        return id;
      })(i*1200);
      jobPromises.push(p);
    }

    const results=await Promise.allSettled(jobPromises);
    const okIds=results.filter(r=>r.status==="fulfilled").map(r=>r.value);
    res.json({ok:true,parentRecordId:recordId,runId,requestIds:okIds,message:"Batch started. Results will populate this Airtable row as they complete."});
  } catch(e){
    console.error(e);
    res.status(500).json({error:e.message});
  }
});

// ---------- Webhook (when WaveSpeed finishes) ----------
app.post("/webhooks/wavespeed", async (req,res)=>{
  console.log("📩 WaveSpeed webhook:",req.body);
  try {
    const data = req.body;
    const outputUrl = data?.output?.url || data?.image || null;
    const requestId = data?.id;
    if (requestId && outputUrl) {
      // attach output to the record matching this runId if available
      await patchRow(data.runId || data.parentRecordId, {
        "Output": [{ url: outputUrl }],
        "Output URL": outputUrl,
        "Seen IDs": requestId,
        "Completed At": nowISO(),
        "Status": "completed",
        "IG Post": outputUrl,
        "Notes": `Batch completed successfully at ${nowISO()}`,
        "Last Update": nowISO()
      });
    }
  } catch (err) {
    console.error("Webhook error:", err.message);
  }
  res.json({ok:true});
});

app.get("/",(_req,res)=>res.send("WaveSpeed Batch Server running. Visit /app"));

app.listen(PORT,()=>console.log(`✅ Listening on http://localhost:${PORT}`));
