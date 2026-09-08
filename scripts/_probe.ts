import fs from "fs";

const KEY = String(
  process.env.PROBE_API_KEY ?? fs.readFileSync(".env.local", "utf8").match(/GEMINI_API_KEY="([^"]+)"/)?.[1] ?? ""
);

async function probe(name: string, url: string, options: RequestInit) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
    const text = (await res.text()).slice(0, 400);
    console.log(`${name} → ${res.status} in ${Date.now() - t0}ms\n  ${text}`);
  } catch (e) {
    console.log(`${name} → ERR ${Date.now() - t0}ms: ${e instanceof Error ? e.message : e}`);
  }
}

async function main() {
  await probe(
    "gemini-rest-models",
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(KEY)}`,
    { method: "GET" }
  );
  await probe(
    "openai-models",
    "https://api.openai.com/v1/models",
    { method: "GET", headers: { Authorization: `Bearer ${KEY}` } }
  );
  await probe(
    "anthropic-models",
    "https://api.anthropic.com/v1/models",
    { method: "GET", headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01" } }
  );
}
main().catch((e) => { console.error(e); process.exit(1); });