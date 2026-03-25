import { getStore } from "@netlify/blobs";

export async function handler(event) {
  const jobId = event.queryStringParameters?.jobId;
  if (!jobId) return { statusCode: 400, body: JSON.stringify({ error: "Missing jobId" }) };

  const store = getStore("jobs");
  try {
    const data = await store.get(jobId, { type: "json" });
    if (!data) return { statusCode: 200, body: JSON.stringify({ status: "pending" }) };
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) };
  } catch {
    return { statusCode: 200, body: JSON.stringify({ status: "pending" }) };
  }
}
