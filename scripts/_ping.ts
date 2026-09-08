import OpenAI from "openai";
import fs from "fs";

async function main() {
  const secret = String(
    fs.readFileSync("C:/ARDUIN~1/opencode/repli-secrets.txt", "utf8").match(/GATEWAY_SECRET=(\S+)/)?.[1] ?? ""
  );
  const key = String(
    fs.readFileSync(".env.local", "utf8").match(/GEMINI_API_KEY="([^"]+)"/)?.[1] ?? ""
  );
  console.log("gemini key from .env.local:", key.slice(0, 8) + "...");
  const client = new OpenAI({ apiKey: key, baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/" });

  for (const model of ["gemini-3.7-flash", "gemini-3.5-flash", "gemini-3.6-flash", "gemini-flash-latest"]) {
    const t0 = Date.now();
    try {
      const res = await client.chat.completions.create({
        model,
        messages: [{ role: "user", content: "say ping" }],
        max_tokens: 8,
      });
      console.log(`OK  ${model} in ${Date.now() - t0}ms →`, res.choices?.[0]?.message?.content);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const m = msg.match(/retry in (\d+(?:\.\d+)?)s/);
      console.log(`FAIL ${model} in ${Date.now() - t0}ms → ${msg.slice(0, 140)}${m ? ` | retry≈${m[1]}s` : ""}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });