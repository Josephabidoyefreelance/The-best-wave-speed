import 'dotenv/config';
import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import cors from "cors"; 

// --- Configuration Setup ---
const PORT = process.env.PORT || 4000; 
const POLLING_INTERVAL_MS = 60000; // Check every 60 seconds
const STUCK_TIMEOUT_MINUTES = 3; // Start polling if stuck for 3 minutes

// Aggressive cleaning function to remove quotes and whitespace
const trimAndUnquote = (key) => {
  if (!key) return null;
  let value = key.trim();
  // Remove quotes if they are at the beginning AND end
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.substring(1, value.length - 1);
  }
  return value;
};

// Use 'let' to allow trimming and unquoting
let PUBLIC_BASE_URL = trimAndUnquote(process.env.PUBLIC_BASE_URL);
let WAVESPEED_API_KEY = trimAndUnquote(process.env.WAVESPEED_API_KEY);
let FAL_API_TOKEN = trimAndUnquote(process.env.FAL_API_TOKEN); // Key for Fal
let AIRTABLE_PAT = trimAndUnquote(process.env.AIRTABLE_PAT);
let AIRTABLE_BASE_ID = trimAndUnquote(process.env.AIRTABLE_BASE_ID);
let AIRTABLE_TABLE = trimAndUnquote(process.env.AIRTABLE_TABLE);

// Check for required environment variables
// This check now ONLY looks for the keys in your new .env file
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
    const filter = `AND(Status='processing', IS_BEFORE(Last Update, DATEADD(NOW(), -${STUCK_TIMEOUT_MINUTES}, 'minutes')))`
    const url = `${baseURL}?filterByFormula=${encodeURIComponent(filter)}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Airtable query failed: ${res.status}`);
    const data = await res.json();
    return data.records || [];
}

// --- Provider Status Functions (For Polling) ---

async function checkWaveSpeedStatus(requestId) {
    const url = `https://api.wavespeed.ai/api/v3/tasks/${requestId}`;
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${WAVESPEED_API_KEY}` }
    });
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
        headers: { 
            Authorization: `Key ${FAL_API_TOKEN}`,
            "Content-Type": "application/json"
        }
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

// ---------- Polling Logic (The Final Fix for "Stuck in Processing") ----------

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
                
                if (provider === 'WaveSpeed') {
                    statusCheck = await checkWaveSpeedStatus(requestId);
                } else if (provider === 'Fal') {
                    statusCheck = await checkFalStatus(requestId);
                } else {
                    continue; 
                }

                if (statusCheck.status === 'completed') {
                    console.log(`[POLLING SUCCESS] Found completed job ${requestId}. Manually updating Airtable.`);
                    await processCompletedJob(recordId, requestId, statusCheck.outputUrl, provider);
                } else if (statusCheck.status === 'failed') {
                    console.log(`[POLLING FAIL] Found failed job ${requestId}. Manually updating Airtable.`);
                    await patchRow(recordId, { 
                        "Status": "failed",
                        "Last Update": nowISO(),
                        "Note": `❌ Job ${requestId} failed (via Polling). ${statusCheck.error}`
                    });
                }
            }
        }
    } catch (e) {
        console.error("[POLLING ERROR] Failed to check stuck jobs:", e.message);
    }
}

// Start the polling interval
setInterval(pollStuckJobs, POLLING_INTERVAL_MS);

// --- Image Fetching & Submission Code ---

async function urlToDataURL(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch image: ${url} (Status: ${res.status})`);
    const type = res.headers.get("content-type") || "image/png";
    const buffer = Buffer.from(await res.arrayBuffer());
    console.log(`[WaveSpeed Prep] Image size: ${(buffer.length / 1024 / 1024).toFixed(2)}MB.`);
    return `data:${type};base64,${buffer.toString("base64")}`;
  } catch (error) {
    console.error(`Error in urlToDataURL for ${url}:`, error.message);
    return null; 
  }
}

// ---------- WaveSpeed Submission (Seedream v4 - T2I + Image Condition) ----------
async function submitWaveSpeedJob({ prompt, subjectDataUrl, referenceDataUrls, width, height, runId, recordId }) {
    const modelPath = "bytedance/seedream-v4"; 
    const payload = {
        prompt, 
        model: modelPath, 
        width: Number(width) || 1024,
        height: Number(height) || 1024,
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
    if (!requestId) throw new Error("WaveSpeed submit: no id in response");
    console.log(`🚀 WaveSpeed job submitted: ${requestId}`);
    return requestId;
}

// ---------- Fal Submission ----------
async function submitFalJob({ prompt, subjectUrl, width, height, runId, recordId }) {
    const modelId = "fal-ai/stable-diffusion-xl"; 
    const webhook = `${PUBLIC_BASE_URL.replace(/\/+$/, "")}/webhooks/fal?record_id=${encodeURIComponent(recordId)}&run_id=${encodeURIComponent(runId)}`;
    const payload = {
        prompt, 
        image_url: subjectUrl || null, 
        width: Number(width), 
        height: Number(height),
    };
    const url = `https://api.fal.ai/v1/models/${modelId}/generate?webhook=${encodeURIComponent(webhook)}`;
    
    // The trimAndUnquote function at the top of the file cleans the key
    const res = await fetch(url, {
        method: "POST",
        headers: { "Authorization": `Key ${FAL_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    
    const txt = await res.text();
    if (!res.ok) throw new Error(`Fal API Error (${res.status}): ${txt}`);
    const responseData = JSON.parse(txt);
    const requestId = responseData.request_id;
    if (!requestId) throw new Error("Fal submit: no id in response");
    console.log(`🚀 Fal job submitted: ${requestId}`);
    return requestId;
}

// --- Common Webhook/Polling Completion Logic ---
async function processCompletedJob(recordId, requestId, outputUrl, provider) {
    const current = await getRow(recordId);
    const fields = current.fields || {};
    
    const prevOutputs = Array.isArray(fields["Output"]) ? fields["Output"] : [];
    const prevSeen = (fields["Seen IDs"] || "").split(",").map(s => s.trim()).filter(Boolean);
    const allRequests = (fields["Request IDs"] || "").split(",").map(s => s.trim()).filter(Boolean);

    if (prevSeen.includes(requestId)) {
        console.log(`[DUPLICATE] Job ${requestId} already processed. Skipping.`);
        return; 
    }

    const updatedOutputs = [...prevOutputs, { url: outputUrl }];
    const updatedSeen = Array.from(new Set([...prevSeen, requestId]));
    const isComplete = allRequests.length > 0 && updatedSeen.length >= allRequests.length;
    
    const fieldsToUpdate = {
      "Output": updatedOutputs,
      "Output URL": outputUrl, 
      "Seen IDs": updatedSeen.join(","), 
      "Last Update": nowISO(),
      "Note": `✅ ${provider}: Received image ${updatedSeen.length} of ${allRequests.length}`,
    };

    if (isComplete) {
      fieldsToUpdate["Status"] = "completed"; 
      fieldsToUpdate["Completed At"] = nowISO();
      fieldsToUpdate["Note"] = `✅ ${provider} batch complete. Received ${updatedSeen.length} images.`;
    }

    await patchRow(recordId, fieldsToUpdate);
    console.log(`✅ Airtable updated for ${provider} record ${recordId}. Status: ${fieldsToUpdate.Status}`);
}

// ---------- UI (Includes WaveSpeed and Fal) ----------
app.get("/app", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI Provider Dashboard</title>
<style>
body{margin:0;padding:40px;font-family:Segoe UI,Roboto,sans-serif;background:linear-gradient(135deg,#101820,#06131f);color:#f5f5f5;}
h1{text-align:center;color:#00bcd4;margin-bottom:30px;}
form{max-width:720px;margin:auto;background:rgba(255,255,255,0.05);padding:24px;border-radius:16px;box-shadow:0 8px 24px rgba(0,0,0,0.4);backdrop-filter:blur(12px);transition:transform .2s ease;}
form:hover{transform:translateY(-3px);}
label{display:block;margin-top:14px;font-weight:600;color:#80deea;}
input,textarea,select{width:100%;padding:10px;margin-top:6px;border:none;border-radius:8px;background:rgba(255,255,255,0.1);color:#fff;font-size:14px;transition:.3s;appearance: none; background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24" 24"><path fill="rgba(255,255,255,0.7)" d="M7 10l5 5 5-5z"/></svg>');background-repeat: no-repeat;background-position: right 10px center;padding-right: 30px;}
input:focus,textarea:focus,select:focus{background:rgba(255,255,255,0.2);outline:none;}
button{margin-top:20px;padding:14px;width:100%;border:none;border-radius:12px;background:#00bcd4;color:#fff;font-size:16px;font-weight:600;cursor:pointer;transition:.3s;}
button:hover{background:#0097a7;box-shadow:0 0 12px rgba(0,188,212,.5);}
#loading{display:none;text-align:center;margin-top:20px;}
</style>
</head>
<body>
<h1>⚡ Multi-Provider Runner (WaveSpeed/Fal)</h1>
<form id="batchForm">
  <label>Provider</label>
  <select name="provider">
    <option value="WaveSpeed">WaveSpeed (Seedream v4 T2I + Image Condition)</option>
    <option value="Fal">Fal (Stable Diffusion XL)</option>
  </select>

  <label>Prompt</label>
  <textarea name="prompt" rows="3" required placeholder="Describe your dream image..."></textarea>
  <label>Subject image URL (Optional)</label>
  <input name="subjectUrl" type="url" placeholder="https://example.com/subject.png">
  <label>Reference image URLs (comma-separated, Optional - Used by WaveSpeed only)</label>
  <input name="referenceUrls" type="text" placeholder="https://ref1.png, https://ref2.png">
  <div style="display:flex;gap:10px;margin-top:10px;">
    <div style="flex:1"><label>Width</label><input name="width" type="number" value="1024"></div>
    <div style="flex:1"><label>Height</label><input name="height" type="number" value="1024"></div>
  </div>
  <label>Batch count</label><input name="count" type="number" value="1" min="1" max="10">
  <button type="submit">🚀 Start Batch</button>
</form>
<div id="loading">Submitting batch... please wait ⏳</div>
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
</script>
</body></html>`);
});

// ---------- API (CENTRAL DISPATCHER) ----------
app.post("/api/start-batch", async (req, res) => {
  try {
    const { prompt, subjectUrl = "", referenceUrls = "", width = 1024, height = 1024, count = 1 } = req.body;
    const provider = String(req.body.provider || 'WaveSpeed').trim();
    
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });

    const refs = referenceUrls.split(",").map(s => s.trim()).filter(Boolean);
    const runId = crypto.randomUUID();
    
    let submissionData = { prompt, width, height, runId, subjectUrl, recordId: null };
    let modelName = "";
    let dataUrls = null; 
    
    if (provider === 'WaveSpeed') {
        dataUrls = {
            subjectDataUrl: subjectUrl ? await urlToDataURL(subjectUrl) : null,
            referenceDataUrls: await Promise.all(refs.map(urlToDataURL)),
        };
        modelName = "WaveSpeed (Seedream v4 T2I + Image Condition)";
    } else if (provider === 'Fal') {
        modelName = "Fal (Stable Diffusion XL)";
    } else {
        return res.status(400).json({ error: "Invalid provider selected" });
    }

    const recordId = await createRow({
      "Provider": provider, "Prompt": prompt,
      "Subject": subjectUrl ? [{ url: subjectUrl }] : [],
      "References": refs.map(u => ({ url: u })), "Model": modelName, 
      "Size": `${width}x${height}`, "Status": "pending", "Run ID": runId,
      "Created At": nowISO(), "Last Update": nowISO(),
    });
    submissionData.recordId = recordId; 

    const jobPromises = [];
    for (let i = 0; i < count; i++) {
      const p = (async () => {
        if (provider === 'WaveSpeed') return await submitWaveSpeedJob({ ...submissionData, ...dataUrls });
        if (provider === 'Fal') return await submitFalJob(submissionData);
      })();
      jobPromises.push(p);
    }

    const results = await Promise.allSettled(jobPromises);
    const requestIds = [];
    const failedMessages = [];

    results.forEach(r => {
      if (r.status === 'fulfilled') requestIds.push(r.value);
      else failedMessages.push(r.reason.message);
    });

    await patchRow(recordId, {
      "Request IDs": requestIds.join(","),
      "Failed IDs": failedMessages.join(","),
      "Status": requestIds.length > 0 ? "processing" : "failed",
      "Last Update": nowISO(),
      "Note": `🟢 Batch started. Submitted: ${requestIds.length}. Failed: ${failedMessages.length}.`
    });

    res.json({ 
        ok: true, parentRecordId: recordId, runId, 
        message: `Batch started on ${provider}. Submitted: ${requestIds.length}. Failed: ${failedMessages.length > 0 ? failedMessages.join("; ") : "None"}` 
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- Webhook Handler: WaveSpeed ----------
app.post("/webhooks/wavespeed", async (req, res) => {
  const recordId = req.query.record_id;
  if (!recordId) return res.status(400).json({ ok: false, error: "Missing record_id" });
  
  try {
    console.log(`[WEBHOOK] WaveSpeed received for ${recordId}`);
    const data = req.body || {};
    const requestId = data.id || data.requestId || "";
    if (data.status === 'failed' || data.error) {
      await patchRow(recordId, { "Status": "failed", "Note": `❌ Job ${requestId} failed.`, "Last Update": nowISO() });
      return res.json({ ok: true, message: "Logged failure." });
    }
    const outputUrl = data.outputs?.find(s => typeof s === 'string' && s.startsWith('http')) || null;
    if (outputUrl) {
      await processCompletedJob(recordId, requestId, outputUrl, 'WaveSpeed');
    } else {
      console.warn(`[WEBHOOK] WaveSpeed for ${recordId} had no output URL.`);
    }
    res.json({ ok: true }); 
  } catch (err) {
    console.error(`❌ WaveSpeed webhook error for ${recordId}:`, err.message);
    res.status(500).json({ ok: false, error: "Internal server error" }); 
  }
});

// ---------- Webhook Handler: Fal ----------
app.post("/webhooks/fal", async (req, res) => {
  const recordId = req.query.record_id;
  if (!recordId) return res.status(400).json({ ok: false, error: "Missing record_id" });

  try {
    console.log(`[WEBHOOK] Fal received for ${recordId}`);
    const data = req.body || {};
    const requestId = data.request_id || "";
    if (data.status === 'ERROR' || data.error) {
      await patchRow(recordId, { "Status": "failed", "Note": `❌ Job ${requestId} failed.`, "Last Update": nowISO() });
      return res.json({ ok: true, message: "Logged failure." });
    }
    const outputUrl = data.result?.images?.[0]?.url || null; 
    if (outputUrl) {
      await processCompletedJob(recordId, requestId, outputUrl, 'Fal');
    } else {
      console.warn(`[WEBHOOK] Fal for ${recordId} had no output URL.`);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(`❌ Fal webhook error for ${recordId}:`, err.message);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

app.get("/", (_req, res) => res.send("Multi-Provider Batch Server running. Visit /app"));
app.listen(PORT, () => console.log(`✅ Listening on port ${PORT}. Polling enabled for jobs stuck >${STUCK_TIMEOUT_MINUTES} mins.`));

