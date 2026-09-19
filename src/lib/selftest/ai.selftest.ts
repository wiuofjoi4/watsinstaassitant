import "dotenv/config";
import {
  coolDownKey,
  isAIConfigured,
  isKeyCooling,
  keyCooldownMs,
  noteKeyFailure,
  noteKeySuccess,
  probeAIHealth,
  rotationOrder,
} from "@/lib/ai/client";
import type { KeyLabel } from "@/lib/ai/client";

let pass = 0;
let fail = 0;

function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Synthetic label that never collides with a real configured key index. */
const SYNTH: KeyLabel = "gemini:999";

async function main(): Promise<void> {
  console.log("[AI selftest] per-key circuit / cooldown layer");

  // --- cooldown set / read / clear -----------------------------------------
  assert("starts healthy", !isKeyCooling(SYNTH) && keyCooldownMs(SYNTH) === 0);
  coolDownKey(SYNTH, 60_000, "selftest");
  assert("cooling after coolDownKey", isKeyCooling(SYNTH) === true);
  const remain = keyCooldownMs(SYNTH);
  assert("keyCooldownMs within window", remain > 0 && remain <= 60_000, `remain=${remain}`);
  coolDownKey(SYNTH, 0, "selftest cleanup");
  assert("coolDownKey(0) clears", !isKeyCooling(SYNTH) && keyCooldownMs(SYNTH) === 0);

  // --- failure streak: threshold (default 3) trips; success resets ---------
  noteKeyFailure(SYNTH);
  noteKeyFailure(SYNTH);
  assert("2 failures below threshold → not cooling", !isKeyCooling(SYNTH));
  noteKeySuccess(SYNTH); // reset the streak
  noteKeyFailure(SYNTH);
  noteKeyFailure(SYNTH);
  assert("streak reset → still below threshold", !isKeyCooling(SYNTH));
  noteKeyFailure(SYNTH);
  assert("third consecutive failure trips cooldown", isKeyCooling(SYNTH) === true);
  coolDownKey(SYNTH, 0, "selftest cleanup");
  noteKeySuccess(SYNTH);
  assert("cleaned after streak trip", !isKeyCooling(SYNTH) && keyCooldownMs(SYNTH) === 0);

  // --- rotation order (pool derives from real env; assertions are relative) -
  const order0 = rotationOrder();
  if (order0.length === 0) {
    console.log("  (no AI keys configured in this environment — rotation tests skipped)");
    assert("rotation empty with no keys", order0.length === 0);
  } else {
    // within-provider indices are ascending
    const grouped = new Map<string, number[]>();
    for (const label of order0) {
      const [provider, idxStr] = label.split(":") as [string, string];
      const arr = grouped.get(provider) ?? [];
      arr.push(Number(idxStr));
      grouped.set(provider, arr);
    }
    for (const [p, idxs] of grouped) {
      const sorted = [...idxs].sort((a, b) => a - b);
      assert(`indices ascending for ${p}`, JSON.stringify(idxs) === JSON.stringify(sorted));
    }

    // cooling one key removes exactly it, preserving the order of the rest
    const first = order0[0] as KeyLabel;
    coolDownKey(first, 60_000, "selftest");
    const order1 = rotationOrder();
    assert(
      "rotation excludes a cooling key",
      !order1.includes(first) &&
        JSON.stringify(order1) === JSON.stringify(order0.filter((l) => l !== first)),
      `first=${first} order0=[${order0}] order1=[${order1}]`
    );
    coolDownKey(first, 0, "selftest cleanup");

    // cooling ALL keys of one provider → that provider falls through
    const geminiLabels = order0.filter((l) => l.startsWith("gemini:"));
    const others = order0.filter((l) => !l.startsWith("gemini:"));
    for (const l of geminiLabels) coolDownKey(l as KeyLabel, 60_000, "selftest");
    const order2 = rotationOrder();
    assert(
      "all-cooled provider falls through to the rest",
      order2.every((l) => !l.startsWith("gemini:")) &&
        others.every((l) => order2.includes(l)) &&
        order2.length === others.length,
      `gemini=[${geminiLabels}] others=[${others}] order2=[${order2}]`
    );
    for (const l of geminiLabels) coolDownKey(l as KeyLabel, 0, "selftest cleanup");

    // cooling EVERYTHING → empty rotation
    for (const l of order0) coolDownKey(l, 60_000, "selftest");
    assert("all keys cooling → empty rotation", rotationOrder().length === 0);
    for (const l of order0) coolDownKey(l, 0, "selftest cleanup");
    assert("rotation healthy again after cleanup", rotationOrder().length === order0.length);
  }

  // --- health probe: network only when explicitly requested -----------------
  if (!isAIConfigured()) {
    const probe = await probeAIHealth();
    assert(
      "probe reports not-configured without keys",
      probe.configured === false && probe.ok === false && probe.provider === null
    );
  } else if (process.env.RUN_LIVE_AI === "1") {
    const probe = await probeAIHealth();
    assert(
      "live probe returns shape",
      probe.configured === true &&
        typeof probe.ok === "boolean" &&
        (typeof probe.keyLabel === "string" || probe.keyLabel === null) &&
        (typeof probe.latencyMs === "number" || probe.latencyMs === undefined),
      JSON.stringify(probe)
    );
    if (probe.ok) {
      console.log(`  [live] provider=${probe.provider} key=${probe.keyLabel ?? "n/a"} latency=${probe.latencyMs}ms`);
    } else {
      console.error(`  [live] probe FAILED provider=${probe.provider} error=${probe.error}`);
    }
  } else {
    console.log("  (AI configured — set RUN_LIVE_AI=1 to run the live probe; skipped by default)");
  }

  const total = pass + fail;
  console.log(`\n[AI selftest] ${pass}/${total} passed`);
  if (fail > 0) {
    console.error(`[AI selftest] ${fail} FAILED`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[AI selftest] crashed:", err);
  process.exit(1);
});