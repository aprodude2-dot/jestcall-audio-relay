import { QueueClient } from "@vercel/queue";
import { get, put } from "@vercel/blob";

const { handleNodeCallback } = new QueueClient();

async function readJob(path) {
  const g = await get(path, { access: "private", useCache: false });
  if (!g || !g.stream) return null;
  const chunks = [];
  for await (const c of g.stream) chunks.push(Buffer.from(c));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function saveJob(path, job) {
  await put(path, JSON.stringify(job), {
    access: "private",
    allowOverwrite: true,
    contentType: "application/json"
  });
}

async function processJob(message) {
  const path = String(message?.path || "");
  if (!/^zilos-schedule\/\d{13}-[a-f0-9-]{36}\.json$/i.test(path)) return;

  const job = await readJob(path);
  if (!job || job.status !== "scheduled") return;

  const scheduled = Number(job.scheduled_ms || Date.parse(job.scheduled_for));
  if (Number.isFinite(scheduled) && Date.now() - scheduled > 120000) {
    job.status = "missed";
    job.completed_at = new Date().toISOString();
    job.error = "Scheduled call was not placed because its scheduled time had already passed.";
    await saveJob(path, job);
    return;
  }

  job.status = "running";
  job.started_at = new Date().toISOString();
  await saveJob(path, job);
  try {
    const body = {
      ...job.payload,
      access_code: String(process.env.CALL_ACCESS_CODE || ""),
      authorized: true
    };
    const isVonage = job.payload?.provider === "vonage";
    if (isVonage) body.action = "vonage-call";
    const url = isVonage
      ? "https://zilostools.vercel.app/api/audio-config"
      : "https://zilostools.vercel.app/api/call";
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000)
    });
    const replyText = await r.text();
    let reply = {};
    try { reply = JSON.parse(replyText); } catch {}
    if (!r.ok || reply.error) {
      throw new Error(String(reply.error || reply.message || "Outbound call request failed (HTTP " + r.status + ")"));
    }
    job.status = "completed";
    job.call_id = String(reply.call_id || reply.id || "");
    job.completed_at = new Date().toISOString();
    delete job.error;
    await saveJob(path, job);
    console.info("zilos_scheduled_call_placed", path);
  } catch (error) {
    job.status = "failed";
    job.completed_at = new Date().toISOString();
    job.error = String(error?.message || error);
    await saveJob(path, job);
    console.error("zilos_scheduled_call_failed", path, job.error);
    throw error;
  }
}

export default handleNodeCallback(async (message) => {
  await processJob(message);
});