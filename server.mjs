import 'dotenv/config';
import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import cors from "cors"; 

// --- Configuration Setup ---
const PORT = process.env.PORT || 4000; 
const POLLING_INTERVAL_MS = 60000; // Check every 60 seconds
const STUCK_TIMEOUT_MINUTES = 1; // Check jobs stuck for 1+ minute

// Aggressive cleaning function to remove quotes and whitespace
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

// ---------- Airtable Functions ----------
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

async function getRow(recordId) {
  const res = await fetch(`${baseURL}/${recordId}`, { headers });
  if (!res.ok) throw new Error(`Airtable get failed: ${res.status}`);
  return res.json();
}

async function getPendingRows() {
    // Check for any job stuck in processing
    const filter = `AND({Status}='processing', IS_BEFORE({Last Update}, DATEADD(NOW(), -${STUCK_TIMEOUT_MINUTES}, 'minutes')))`
    const url = `${baseURL}?filterByFormula=${encodeURIComponent(filter)}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Airtable query failed: ${res.status} ${txt}`);
    }
    const data = await res.json();
    return data.records || [];
}


// --- Provider Status Functions (For Polling) ---

async function checkWaveSpeedStatus(requestId) {
    const url = `https://api.wavespeed.ai/api/v3/tasks/${requestId}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${WAVESPEED_API_KEY}` } });
    
    const txt = await res.text();
    if (!res.ok) {
         console.warn(`[POLLING] WaveSpeed check for ${requestId} failed: ${res.status}`);
         return { status: 'failed', error: `WaveSpeed check failed (${res.status})` };
    }

    let data;
    try {
        data = JSON.parse(txt);
    } catch (e) {
        console.error(`[POLLING PARSE ERROR] WaveSpeed response was not JSON: ${txt}`);
        return { status: 'failed', error: 'WaveSpeed response was not JSON' };
    }
    
    if (data.status === 'success' && data.outputs && data.outputs.length > 0) {
        return { status: 'completed', outputUrl: data.outputs.find(s => s.startsWith('http')) };
    }
    if (data.status === 'failed' || data.error) {
        return { status: 'failed', error: data.error || 'Job failed on WaveSpeed side.' };
    }
    return { status: 'processing' };
}

async function checkFalStatus(requestId, modelId) {
    // 🛑 FIX: Include the modelId in the URL. This fixes the "User 'requests' not found" error.
    // Also using /status endpoint which is standard for Fal queue checks.
    const url = `https://queue.fal.run/${modelId}/requests/${requestId}/status`;
    
    const res = await fetch(url, {
        method: 'GET',
        headers: { 
            "Authorization": `Key ${FAL_API_TOKEN}`,
            "Accept": "application/json"
        }
    });
    
    const txt = await res.text();

    if (!res.ok) {
         console.warn(`[POLLING FAIL] Fal ${requestId}: ${res.status} - ${txt}`);
         if (res.status === 404) return { status: 'failed', error: 'Fal Job Not Found (404)' };
         return { status: 'processing', error: `Fal Error ${res.status}` }; 
    }

    try {
        const data = JSON.parse(txt);
        
        // Check for completed status
        if (data.status === 'COMPLETED') {
            // The response_url contains the JSON with the actual image
            const responseUrl = data.response_url;
            if (responseUrl) {
                // We need to fetch the final result from the response_url
                const finalRes = await fetch(responseUrl, { headers: { "Authorization": `Key ${FAL_API_TOKEN}` } });
                const finalData = await finalRes.json();
                const outputUrl = finalData.images?.[0]?.url || finalData.result?.images?.[0]?.url;
                if (outputUrl) return { status: 'completed', outputUrl };
            }
             return { status: 'completed', outputUrl: data.images?.[0]?.url }; // Fallback if image is directly in status
        }
        
        if (data.status === 'IN_QUEUE' || data.status === 'IN_PROGRESS') return { status: 'processing' };
        if (data.status === 'ERROR') return { status: 'failed', error: data.error };
        
        return { status: 'processing' };
    } catch (e) {
        console.error(`[POLLING FAIL] JSON Parse: ${txt}`);
        return { status: 'failed', error: 'JSON Parse Error' };
    }
}


// ---------- Polling Logic ----------

async function pollStuckJobs() {
    console.log("[POLLING] Checking for stuck jobs...");
    try {
        const rows = await getPendingRows();
        if (rows.length === 0) {
            console.log("[POLLING] No stuck jobs found.");
            return;
        }
        
        console.log(`[POLLING] Found ${rows.length} stuck job(s). Checking status...`);
        for (const record of rows) {
            const { id: recordId, fields } = record;
            const provider = fields.Provider;
            const model = fields.Model || "fal-ai/fast-sdxl"; // Get the model from Airtable
            const requestIds = (fields["Request IDs"] || "").split(",").map(s => s.trim()).filter(Boolean);
            const seenIds = (fields["Seen IDs"] || "").split(",").map(s => s.trim()).filter(Boolean);
            const pendingIds = requestIds.filter(id => !seenIds.includes(id));

            for (const requestId of pendingIds) {
                let result;
                if (provider.includes('WaveSpeed')) result = await checkWaveSpeedStatus(requestId);
                else if (provider.includes('Fal')) result = await checkFalStatus(requestId, model); // Pass model
                else continue; 

                if (result.status === 'completed' && result.outputUrl) {
                    console.log(`[POLLING SUCCESS] ${provider} ${requestId} completed.`);
                    await processCompletedJob(recordId, requestId, result.outputUrl, provider);
                } else if (result.status === 'failed') {
                    console.log(`[POLLING FAILED] ${provider} ${requestId}: ${result.error}`);
                    await patchRow(recordId, { "Status": "failed", "Note": `❌ Failed: ${result.error}`, "Last Update": nowISO() });
                }
            }
        }
    } catch (e) { console.error("[POLLING ERROR]", e.message); }
}
setInterval(pollStuckJobs, POLLING_INTERVAL_MS);


// --- Image Fetching ---

async function urlToDataURL(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch image: ${url}`);
    const type = res.headers.get("content-type") || "image/png";
    const buffer = Buffer.from(await res.arrayBuffer());
    return `data:${type};base64,${buffer.toString("base64")}`;
  } catch (error) { return null; }
}

// ---------- WaveSpeed Submission ----------
async function submitWaveSpeedJob({ prompt, subjectDataUrl, referenceDataUrls, width, height, runId, recordId }) {
    const modelPath = "bytedance/seedream-v4"; 
    const payload = {
        prompt, model: modelPath, width: Number(width) || 1024, height: Number(height) || 1024,
        images: [subjectDataUrl, ...(referenceDataUrls || [])].filter(Boolean), 
    };
    const webhook = `${PUBLIC_BASE_URL.replace(/\/+$/, "")}/webhooks/wavespeed?record_id=${encodeURIComponent(recordId)}&run_id=${encodeURIComponent(runId)}`;
    const url = `https://api.wavespeed.ai/api/v3/${modelPath}`; 

    const res = await fetch(`${url}?webhook=${encodeURIComponent(webhook)}`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${WAVESPEED_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    const txt = await res.text();
    if (!res.ok) throw new Error(`WaveSpeed API Error (${res.status}): ${txt}`);
    const responseData = JSON.parse(txt);
    const requestId = responseData.data?.id || responseData.data?.request_id;
    if (!requestId) throw new Error("WaveSpeed submit: no id");
    return requestId;
}

// ---------- Fal Submission ----------
async function submitFalJob({ prompt, subjectUrl, width, height, runId, recordId, selectedModel }) {
    const modelId = selectedModel || "fal-ai/fast-sdxl"; 
    
    const webhook = `${PUBLIC_BASE_URL.replace(/\/+$/, "")}/webhooks/fal?record_id=${encodeURIComponent(recordId)}&run_id=${encodeURIComponent(runId)}`;
    const payload = {
        prompt, 
        image_url: subjectUrl || null, 
        image_size: { width: Number(width) || 1024, height: Number(height) || 1024 }
    };

    const url = `https://queue.fal.run/${modelId}?webhook_url=${encodeURIComponent(webhook)}`;
    
    const res = await fetch(url, {
        method: "POST",
        headers: { "Authorization": `Key ${FAL_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    
    const txt = await res.text();
    if (!res.ok) throw new Error(`Fal API Error (${res.status}): ${txt}`);

    const responseData = JSON.parse(txt);
    const requestId = responseData.request_id;
    if (!requestId) throw new Error("Fal submit: no request_id");
    console.log(`🚀 Fal job submitted (${modelId}): ${requestId}`);
    return requestId;
}


// --- Completion Logic ---
async function processCompletedJob(recordId, requestId, outputUrl, provider) {
    const current = await getRow(recordId);
    const fields = current.fields || {};
    const prevOutputs = Array.isArray(fields["Output"]) ? fields["Output"] : [];
    const prevSeen = (fields["Seen IDs"] || "").split(",").map(s => s.trim()).filter(Boolean);
    const allRequests = (fields["Request IDs"] || "").split(",").map(s => s.trim()).filter(Boolean);

    if (prevSeen.includes(requestId)) return; 

    const updatedOutputs = [...prevOutputs, { url: outputUrl }];
    const updatedSeen = Array.from(new Set([...prevSeen, requestId]));
    const isComplete = allRequests.length > 0 && updatedSeen.length >= allRequests.length;
    
    const fieldsToUpdate = {
      "Output": updatedOutputs, "Output URL": outputUrl, "Seen IDs": updatedSeen.join(","), "Last Update": nowISO(),
      "Note": `✅ ${provider}: Received image ${updatedSeen.length} of ${allRequests.length}`,
    };
    if (isComplete) {
      fieldsToUpdate["Status"] = "completed"; fieldsToUpdate["Completed At"] = nowISO();
    }
    await patchRow(recordId, fieldsToUpdate);
    console.log(`✅ Airtable updated for ${provider} record ${recordId}.`);
}


// ---------- UI (YOUR UNCHANGED INTERFACE) ----------
app.get("/app", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI Provider Dashboard</title>
<style>
body{margin:0;padding:40px;font-family:Segoe UI,Roboto,sans-serif;background:linear-gradient(135deg,#101820,#06131f);color:#f5f5ff;}
h1{text-align:center;color:#00bcd4;margin-bottom:30px;}
form{max-width:720px;margin:auto;background:rgba(255,255,255,0.05);padding:24px;border-radius:16px;box-shadow:0 8px 24px rgba(0,0,0,0.4);backdrop-filter:blur(12px);transition:transform .2s ease;}
label{display:block;margin-top:14px;font-weight:600;color:#80deea;}
input,textarea{width:100%;padding:10px;margin-top:6px;border:none;border-radius:8px;background:rgba(255,255,255,0.1);color:#fff;font-size:14px;appearance:none;}

select {
    width:100%;padding:10px;margin-top:6px;
    border: 1px solid rgba(0, 188, 212, 0.3); 
    border-radius:8px;
    background: rgba(0, 188, 212, 0.15); /* Light Blue Tint */
    color:#fff;font-size:14px;
    appearance:none;
    transition: background 0.3s, border-color 0.3s;
    cursor: pointer;
}
select:hover {
    background: rgba(0, 188, 212, 0.25);
    border-color: rgba(0, 188, 212, 0.6);
}

button{margin-top:20px;padding:14px;width:100%;border:none;border-radius:12px;background:#00bcd4;color:#fff;font-size:16px;font-weight:600;cursor:pointer;}
#loading{display:none;text-align:center;margin-top:20px;}
</style>
</head>
<body>
<h1>⚡ Multi-Provider Runner</h1>
<form id="batchForm">
  <label>Provider & Model</label>
  <select name="provider">
    <option value="WaveSpeed">WaveSpeed (Seedream v4)</option>
    <option value="Fal:fal-ai/fast-sdxl">Fal (Fast SDXL)</option>
    <!-- 🛑 REMOVED a "Fal (Flux Schnell)" line here -->
  </select>

  <label>Prompt</label><textarea name="prompt" rows="3" required placeholder="Describe your dream image..."></textarea>
  
  <label>Subject image URL (Optional)</label>
  <input name="subjectUrl" type="url" placeholder="https://example.com/subject.png">
  
  <label>Reference image URLs (comma-separated, Optional - Used by WaveSpeed)</label>
  <input name="referenceUrls" type="text" placeholder="https://ref1.png, https://ref2.png">

  <div style="display:flex;gap:10px;margin-top:10px;">
    <div style="flex:1"><label>Width</label><input name="width" type="number" value="1024"></div>
    <div style="flex:1"><label>Height</label><input name="height" type="number" value="1024"></div>
  </div>

  <label>Batch count</label><input name="count" type="number" value="1" min="1" max="10">
  
  <button type="submit">🚀 Start Batch</button>
</form>
<div id="loading">Submitting...</div>
<script>
const form=document.getElementById('batchForm');
const loading=document.getElementById('loading');
form.addEventListener('submit',async e=>{
  e.preventDefault();
  loading.style.display='block';
  const data=new URLSearchParams(new FormData(form));
  
  const res=await fetch('/api/start-batch',{method:'POST',body:data}); 
  
  const json=await res.json();
  loading.innerHTML='<pre style="text-align:left;background:#000;padding:12px;border-radius:8px;">'+JSON.stringify(json,null,2);
});
</script>
</body></html>`);
});

// ---------- API DISPATCHER ----------
app.post("/api/start-batch", async (req, res) => {
  try {
    const { prompt, subjectUrl, referenceUrls, width, height, count = 1 } = req.body;
    let selection = String(req.body.provider || 'WaveSpeed');
    
    let provider = selection.split(':')[0];
    let specificModel = selection.split(':')[1] || null;

    const runId = crypto.randomUUID();
    let dataUrls = null;
    let refArray = []; // Store clean reference URLs
    
    if (provider === 'WaveSpeed') {
        refArray = referenceUrls ? referenceUrls.split(',').map(s => s.trim()) : [];
        dataUrls = { 
            subjectDataUrl: subjectUrl ? await urlToDataURL(subjectUrl) : null,
            referenceDataUrls: await Promise.all(refArray.map(urlToDataURL))
        };
    }
    
    const recordId = await createRow({
      "Provider": provider, 
      "Prompt": prompt, 
      "Model": specificModel || "Seedream v4",
      "Subject": subjectUrl ? [{ url: subjectUrl }] : [],
      "References": refArray.map(u => ({ url: u })),
      "Size": `${width || 1024}x${height || 1024}`,
      "Status": "pending", 
      "Run ID": runId, "Created At": nowISO(), "Last Update": nowISO()
    });

    const jobPromises = [];
    for (let i = 0; i < count; i++) {
      jobPromises.push((async () => {
        if (provider === 'WaveSpeed') return await submitWaveSpeedJob({ prompt, subjectDataUrl: dataUrls?.subjectDataUrl, referenceDataUrls: dataUrls?.referenceDataUrls, width, height, runId, recordId });
        if (provider === 'Fal') return await submitFalJob({ prompt, subjectUrl, width, height, runId, recordId, selectedModel: specificModel });
      })());
    }

    const results = await Promise.allSettled(jobPromises);
    const requestIds = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    const failedMsgs = results.filter(r => r.status === 'rejected').map(r => r.reason.message);

    await patchRow(recordId, {
      "Request IDs": requestIds.join(","), "Failed IDs": failedMsgs.join(","),
      "Status": requestIds.length > 0 ? "processing" : "failed", 
      "Last Update": nowISO(), // CRITICAL: Update this field so polling works
      "Note": `Started ${provider}. OK: ${requestIds.length}. Fail: ${failedMsgs.length}`
    });

    res.json({ ok: true, message: `Batch started. Submitted: ${requestIds.length}. Failed: ${failedMsgs.length > 0 ? failedMsgs.join("; ") : "None"}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- WEBHOOKS ----------

app.post("/webhooks/wavespeed", async (req, res) => {
  const recordId = req.query.record_id;
  if (!recordId) return res.status(400).json({ ok: false });
  try {
    const data = req.body || {};
    const outputUrl = data.outputs?.find(s => typeof s === 'string' && s.startsWith('http')) || null;
    if (outputUrl) {
        console.log(`[WEBHOOK] WaveSpeed received for ${recordId}`);
        await processCompletedJob(recordId, data.id || "unknown_ws_id", outputUrl, 'WaveSpeed');
    }
    res.json({ ok: true });
  } catch (e) { 
    console.error(`[WEBHOOK ERROR] WaveSpeed: ${e.message}`);
    res.status(500).json({ ok: false }); 
  }
});

app.post("/webhooks/fal", async (req, res) => {
  const recordId = req.query.record_id;
  if (!recordId) return res.status(400).json({ ok: false });
  try {
    const data = req.body || {};
    const outputUrl = data.images?.[0]?.url || data.result?.images?.[0]?.url; 
    if (outputUrl) {
        console.log(`[WEBHOOK] Fal received for ${recordId}`);
        await processCompletedJob(recordId, data.request_id, outputUrl, 'Fal');
    }
    res.json({ ok: true });
  } catch (e) { 
    console.error(`[WEBHOOK ERROR] Fal: ${e.message}`);
    res.status(500).json({ ok: false }); 
  }
});

app.get("/", (_req, res) => res.send("Batch Server running. Visit /app"));
app.listen(PORT, () => console.log(`✅ Listening on port ${PORT}. Polling enabled.`));