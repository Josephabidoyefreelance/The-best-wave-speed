import 'dotenv/config';
import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import cors from "cors";

// --- Config ---
const PORT = process.env.PORT || 4000;
const POLLING_INTERVAL_MS = 60000;
const STUCK_TIMEOUT_MINUTES = 3;

const trimAndUnquote = (key) => {
  if (!key) return null;
  let value = key.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.substring(1, value.length - 1);
  }
  return value;
};

let PUBLIC_BASE_URL = trimAndUnquote(process.env.PUBLIC_BASE_URL);
let WAVESPEED_API_KEY = trimAndUnquote(process.env.WAVESPEED_API_KEY);
let FAL_API_TOKEN = trimAndUnquote(process.env.FAL_API_TOKEN);
let AIRTABLE_PAT = trimAndUnquote(process.env.AIRTABLE_PAT);
let AIRTABLE_BASE_ID = trimAndUnquote(process.env.AIRTABLE_BASE_ID);
let AIRTABLE_TABLE = trimAndUnquote(process.env.AIRTABLE_TABLE);

if (!PUBLIC_BASE_URL || !WAVESPEED_API_KEY || !AIRTABLE_PAT || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE || !FAL_API_TOKEN) {
  console.error("❌ Missing required env vars. Check your .env file.");
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

const nowISO = () => new Date().toISOString();

// ---------- Airtable ----------
const baseURL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}`;
const headers = { Authorization: `Bearer ${AIRTABLE_PAT}`, "Content-Type": "application/json" };

async function createRow(fields) {
  const res = await fetch(baseURL, { method: "POST", headers, body: JSON.stringify({ records: [{ fields }] }) });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Airtable create failed: ${txt}`);
  const data = JSON.parse(txt);
  return data.records?.[0]?.id;
}

async function patchRow(id, fields) {
  const res = await fetch(`${baseURL}/${id}`, { method: "PATCH", headers, body: JSON.stringify({ fields }) });
  if (!res.ok) throw new Error(`Airtable patch ${res.status}: ${await res.text()}`);
}

async function getRow(recordId) {
  const res = await fetch(`${baseURL}/${recordId}`, { headers });
  if (!res.ok) throw new Error(`Airtable get failed: ${res.status}`);
  return res.json();
}

async function getPendingRows() {
  const filter = `Status='processing'`;
  const url = `${baseURL}?filterByFormula=${encodeURIComponent(filter)}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Airtable query failed: ${res.status} ${txt}`);
  }
  const data = await res.json();
  return data.records || [];
}

// ---------- Provider Checkers ----------
async function checkWaveSpeedStatus(requestId) {
  const url = `https://api.wavespeed.ai/api/v3/tasks/${requestId}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${WAVESPEED_API_KEY}` } });
  const data = await res.json();
  if (data.status === 'success' && data.outputs && data.outputs.length > 0) {
    return { status: 'completed', outputUrl: data.outputs.find(s => s.startsWith('http')) };
  }
  if (data.status === 'failed' || data.error) {
    return { status: 'failed', error: data.error || 'Job failed on WaveSpeed side.' };
  }
  return { status: 'processing' };
}

async function checkFalStatus(requestId) {
  const url = `https://api.fal.ai/v1/requests/${requestId}/status`;
  const res = await fetch(url, {
    headers: { Authorization: `Key ${FAL_API_TOKEN}`, "Content-Type": "application/json" }
  });
  const data = await res.json();
  if (data.status === 'COMPLETED' && data.result?.images?.[0]?.url) {
    return { status: 'completed', outputUrl: data.result.images[0].url };
  }
  if (data.status === 'ERROR' || data.error) {
    return { status: 'failed', error: data.error || 'Job failed on Fal side.' };
  }
  return { status: 'processing' };
}

// ---------- Polling ----------
async function pollStuckJobs() {
  console.log(`[POLLING] Checking for jobs stuck in 'processing' (>${STUCK_TIMEOUT_MINUTES} mins)...`);
  try {
    const rows = await getPendingRows();
    for (const record of rows) {
      const { id: recordId, fields } = record;
      const provider = fields.Provider;
      const requestIds = (fields["Request IDs"] || "").split(",").map(s => s.trim()).filter(Boolean);
      const seenIds = (fields["Seen IDs"] || "").split(",").map(s => s.trim()).filter(Boolean);
      const pendingIds = requestIds.filter(id => !seenIds.includes(id));

      for (const requestId of pendingIds) {
        let statusCheck;
        if (provider === 'WaveSpeed') statusCheck = await checkWaveSpeedStatus(requestId);
        else if (provider === 'Fal') statusCheck = await checkFalStatus(requestId);
        else continue;

        if (statusCheck.status === 'completed') {
          await processCompletedJob(recordId, requestId, statusCheck.outputUrl, provider);
        } else if (statusCheck.status === 'failed') {
          await patchRow(recordId, { Status: "failed", "Last Update": nowISO(), Note: `❌ Job ${requestId} failed.` });
        }
      }
    }
  } catch (e) {
    console.error("[POLLING ERROR]", e.message);
  }
}

setInterval(pollStuckJobs, POLLING_INTERVAL_MS);

// ---------- Utility ----------
async function urlToDataURL(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch image: ${url}`);
    const type = res.headers.get("content-type") || "image/png";
    const buffer = Buffer.from(await res.arrayBuffer());
    console.log(`[WaveSpeed Prep] Image size: ${(buffer.length / 1024 / 1024).toFixed(2)}MB.`);
    return `data:${type};base64,${buffer.toString("base64")}`;
  } catch (err) {
    console.error("urlToDataURL error:", err.message);
    return null;
  }
}

// ---------- Submissions ----------
async function submitWaveSpeedJob({ prompt, subjectDataUrl, referenceDataUrls, width, height, runId, recordId }) {
  const modelPath = "bytedance/seedream-v4";
  const payload = { prompt, model: modelPath, width, height, images: [subjectDataUrl, ...(referenceDataUrls || [])].filter(Boolean) };
  const webhook = `${PUBLIC_BASE_URL.replace(/\/+$/, "")}/webhooks/wavespeed?record_id=${recordId}&run_id=${runId}`;
  const url = `https://api.wavespeed.ai/api/v3/${modelPath}?webhook=${encodeURIComponent(webhook)}`;
  const res = await fetch(url, { method: "POST", headers: { "Authorization": `Bearer ${WAVESPEED_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const txt = await res.text();
  if (!res.ok) throw new Error(`WaveSpeed error: ${txt}`);
  const responseData = JSON.parse(txt);
  const requestId = responseData.data?.id || responseData.data?.request_id;
  console.log(`🚀 WaveSpeed job submitted: ${requestId}`);
  return requestId;
}

async function submitFalJob({ prompt, subjectUrl, width, height, runId, recordId }) {
  const modelId = "fal-ai/stable-diffusion-xl";
  const webhook = `${PUBLIC_BASE_URL.replace(/\/+$/, "")}/webhooks/fal?record_id=${recordId}&run_id=${runId}`;
  const payload = { prompt, image_url: subjectUrl || null, width, height };
  const url = `https://api.fal.ai/v1/models/${modelId}/generate?webhook=${encodeURIComponent(webhook)}`;
  const res = await fetch(url, { method: "POST", headers: { "Authorization": `Key ${FAL_API_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Fal error: ${txt}`);
  const data = JSON.parse(txt);
  console.log(`🚀 Fal job submitted: ${data.request_id}`);
  return data.request_id;
}

// ---------- Process Job ----------
async function processCompletedJob(recordId, requestId, outputUrl, provider) {
  const current = await getRow(recordId);
  const fields = current.fields || {};
  const prevOutputs = Array.isArray(fields["Output"]) ? fields["Output"] : [];
  const prevSeen = (fields["Seen IDs"] || "").split(",").map(s => s.trim()).filter(Boolean);
  const allRequests = (fields["Request IDs"] || "").split(",").map(s => s.trim()).filter(Boolean);

  if (prevSeen.includes(requestId)) return;

  const updatedOutputs = [...prevOutputs, { url: outputUrl }];
  const updatedSeen = Array.from(new Set([...prevSeen, requestId]));
  const complete = allRequests.length > 0 && updatedSeen.length >= allRequests.length;

  // ✅ Add Output URL support
  const prevUrls = (fields["Output URL"] || "").split(",").map(s => s.trim()).filter(Boolean);
  const updatedUrls = Array.from(new Set([...prevUrls, outputUrl]));

  const update = {
    "Output": updatedOutputs,
    "Output URL": updatedUrls.join(", "),
    "Seen IDs": updatedSeen.join(","),
    "Last Update": nowISO(),
    "Model": provider === "WaveSpeed" ? "bytedance/seedream-v4" : "fal-ai/stable-diffusion-xl",
    "Completed At": complete ? nowISO() : null,
    "Status": complete ? "completed" : "processing",
    "Note": complete
      ? `✅ ${provider} batch complete. Received ${updatedSeen.length} images.`
      : `✅ ${provider} received ${updatedSeen.length}/${allRequests.length}`
  };
  await patchRow(recordId, update);
  console.log(`✅ Airtable updated for ${recordId}: ${update.Status}`);
}

// ---------- Interface ----------
app.get("/app", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Provider Dashboard</title>
<style>
body{margin:0;padding:40px;font-family:Segoe UI,Roboto,sans-serif;background:linear-gradient(135deg,#101820,#06131f);color:#f5f5f5;}
h1{text-align:center;color:#00bcd4;margin-bottom:30px;}
form{max-width:720px;margin:auto;background:rgba(255,255,255,0.05);padding:24px;border-radius:16px;box-shadow:0 8px 24px rgba(0,0,0,0.4);}
label{display:block;margin-top:14px;font-weight:600;color:#80deea;}
input,textarea,select{width:100%;padding:10px;margin-top:6px;border:none;border-radius:8px;background:rgba(255,255,255,0.1);color:#fff;font-size:14px;}
button{margin-top:20px;padding:14px;width:100%;border:none;border-radius:12px;background:#00bcd4;color:#fff;font-size:16px;font-weight:600;cursor:pointer;}
button:hover{background:#0097a7;}
#loading{display:none;text-align:center;margin-top:20px;}
</style></head>
<body><h1>⚡ Multi-Provider Runner (WaveSpeed/Fal)</h1>
<form id="batchForm">
  <label>Provider</label>
  <select name="provider">
    <option value="WaveSpeed">WaveSpeed</option>
    <option value="Fal">Fal</option>
  </select>
  <label>Prompt</label><textarea name="prompt" rows="3" required></textarea>
  <label>Subject image URL (optional)</label><input name="subjectUrl" type="url">
  <label>Reference image URLs (optional, comma separated)</label><input name="referenceUrls" type="text">
  <label>Width</label><input name="width" type="number" value="1024">
  <label>Height</label><input name="height" type="number" value="1024">
  <label>Batch count</label><input name="count" type="number" value="1">
  <button type="submit">🚀 Start Batch</button>
</form>
<div id="loading">Submitting batch...</div>
<script>
const form=document.getElementById('batchForm');
const loading=document.getElementById('loading');
form.addEventListener('submit',async e=>{
  e.preventDefault();
  loading.style.display='block';
  loading.innerHTML='Submitting batch... please wait ⏳';
  const data=new URLSearchParams(new FormData(form));
  const res=await fetch('/api/start-batch',{method:'POST',body:data});
  const json=await res.json();
  loading.innerHTML='<pre style="text-align:left;background:#000;padding:12px;border-radius:8px;">'+JSON.stringify(json,null,2)+'</pre>';
});
</script></body></html>`);
});

// ---------- API ----------
app.post("/api/start-batch", async (req, res) => {
  try {
    const { prompt, subjectUrl = "", referenceUrls = "", width = 1024, height = 1024, count = 1 } = req.body;
    const provider = String(req.body.provider || 'WaveSpeed').trim();
    const refs = referenceUrls.split(",").map(s => s.trim()).filter(Boolean);
    const runId = crypto.randomUUID();

    const recordId = await createRow({
      Provider: provider,
      Prompt: prompt,
      Subject: subjectUrl ? [{ url: subjectUrl }] : [],
      References: refs.map(u => ({ url: u })),
      Size: `${width}x${height}`,
      Status: "pending",
      "Run ID": runId,
      "Created At": nowISO(),
      "Last Update": nowISO(),
    });

    let submissionData = { prompt, width, height, runId, recordId, subjectUrl };
    if (provider === 'WaveSpeed') {
      submissionData.subjectDataUrl = subjectUrl ? await urlToDataURL(subjectUrl) : null;
      submissionData.referenceDataUrls = await Promise.all(refs.map(urlToDataURL));
    }

    const jobPromises = Array.from({ length: count }, async () =>
      provider === 'WaveSpeed'
        ? await submitWaveSpeedJob(submissionData)
        : await submitFalJob(submissionData)
    );

    const results = await Promise.allSettled(jobPromises);
    const requestIds = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    const failedMessages = results.filter(r => r.status === 'rejected').map(r => r.reason.message);

    await patchRow(recordId, {
      "Request IDs": requestIds.join(","),
      "Failed IDs": failedMessages.join(","),
      "Status": requestIds.length > 0 ? "processing" : "failed",
      "Last Update": nowISO(),
      "Note": `🟢 Batch started: ${requestIds.length} ok, ${failedMessages.length} failed.`
    });

    res.json({ ok: true, parentRecordId: recordId, runId, message: "Batch started." });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- Webhooks ----------
app.post("/webhooks/wavespeed", async (req, res) => {
  const recordId = req.query.record_id;
  try {
    const data = req.body || {};
    const requestId = data.id || data.requestId || "";
    const outputUrl = data.outputs?.find(s => typeof s === "string" && s.startsWith("http")) || null;
    if (outputUrl) await processCompletedJob(recordId, requestId, outputUrl, "WaveSpeed");
    res.json({ ok: true });
  } catch (err) {
    console.error("WaveSpeed webhook error:", err.message);
    res.status(500).json({ ok: false });
  }
});

app.post("/webhooks/fal", async (req, res) => {
  const recordId = req.query.record_id;
  try {
    const data = req.body || {};
    const requestId = data.request_id || "";
    const outputUrl = data.result?.images?.[0]?.url || null;
    if (outputUrl) await processCompletedJob(recordId, requestId, outputUrl, "Fal");
    res.json({ ok: true });
  } catch (err) {
    console.error("Fal webhook error:", err.message);
    res.status(500).json({ ok: false });
  }
});

app.get("/", (_req, res) => res.send("Server running. Visit /app"));
app.listen(PORT, () => console.log(`✅ Listening on port ${PORT}`));
