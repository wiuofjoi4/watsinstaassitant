import "dotenv/config";
import {
  checkMenuAvailability,
  findMenuPrice,
  SCRIPT_AVAILABILITY_ASK,
  SCRIPT_RESTAURANT_CONFIRM,
} from "@/lib/agent/engine";

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

const MENU = [
  "كباب عربي — 25000",
  "شاورما دجاج — 15000",
  "قمه بمبه — 7000",
  "رز بامية — 10000",
  "بيتي فور — 8000",
].join("\n");

const PUNCT = ["عدكم شاورما؟", "عندكم كباب؟", "أكو رز بامية؟", "موجود عندكم قمه بمبه؟"];
const NO_PUNCT = ["عدكم شاورما", "عندكم كباب", "أكو رز بامية", "عندك بيتيفور"];

async function main(): Promise<void> {
  console.log("[agent selftest] dictionary (القاموس) script rules");

  // --- Dictionary rule 2: restaurant-confirm patterns -----------------------
  for (const s of [
    "العفو انت مطعم البيت؟",
    "هذا مطعم بيتنا؟",
    "اهلا انتوا مطعم",
    "هلا انتم مطعم شامي؟",
  ]) {
    assert(`restaurant-confirm matches: ${s}`, SCRIPT_RESTAURANT_CONFIRM.test(s));
  }
  for (const s of ["السلام عليكم", "بيش الكباب", "عندكم شاورما؟", "طلبي وصل؟"]) {
    assert(
      `restaurant-confirm does NOT match: ${s}`,
      !SCRIPT_RESTAURANT_CONFIRM.test(s)
    );
  }

  // --- Dictionary rule 3: availability ask detection ------------------------
  for (const s of [...PUNCT, ...NO_PUNCT]) {
    assert(`availability ask detected: ${s}`, SCRIPT_AVAILABILITY_ASK.test(s));
  }
  for (const s of ["موجود", "عندكم؟", "سلام عليكم", "بيش الشاورما"]) {
    assert(
      `availability ask NOT matched (no item / price ask): ${s}`,
      !SCRIPT_AVAILABILITY_ASK.test(s),
      `matched unexpectedly: ${s}`
    );
  }

  // --- Dictionary rule 3: availability lookup against the menu --------------
  const hit = checkMenuAvailability("عدكم شاورما؟", MENU);
  assert("availability: شاورما present", hit.available === true, JSON.stringify(hit));
  assert("availability: price attached", hit.price === 15000, `price=${hit.price}`);

  const hit2 = checkMenuAvailability("عندكم رز بامية؟", MENU);
  assert("availability: رز بامية present", hit2.available === true);

  const miss = checkMenuAvailability("عدكم بيتزا؟", MENU);
  assert("availability: بيتزا NOT present", miss.available === false);

  const miss2 = checkMenuAvailability("أكو إيس كريم؟", MENU);
  assert("availability: إيس كريم NOT present", miss2.available === false);

  const empty = checkMenuAvailability("عدكم؟", MENU);
  assert("availability: bare عدكم؟ NOT matched", empty.available === false);

  // --- Price lookup (shared tokenizer) --------------------------------------
  const p = findMenuPrice("بيش الكباب؟", MENU);
  assert(
    "price: بيش الكباب؟ resolves",
    p != null && p.item.includes("كباب") && p.price === 25000,
    JSON.stringify(p)
  );
  const np = findMenuPrice("بيش الشاورما؟", MENU);
  assert(
    "price: بيش الشاورما؟ resolves",
    np != null && np.item.includes("شاورما") && np.price === 15000,
    JSON.stringify(np)
  );

  if (fail > 0) {
    throw new Error(`${fail} agent.selftest assertion(s) failed`);
  }
  console.log(`\n[agent selftest] ${pass}/${pass + fail} passed`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`FAIL agent.selftest: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });