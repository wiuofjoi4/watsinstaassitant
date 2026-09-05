import { db } from "@/lib/db";
import { agentConfigs, restaurants } from "@/lib/db/schema";
import { newId } from "@/lib/utils";

async function main() {
  const id = "seed-restaurant-1";
  const now = new Date();

  await db
    .insert(restaurants)
    .values({
      id,
      name: "Shawarma House",
      createdAt: now,
      agentEnabled: true,
      activatedAt: now,
      whatsappStatus: "disconnected",
      instagramStatus: "disconnected",
    })
    .onConflictDoNothing();

  await db
    .insert(agentConfigs)
    .values({
      id: newId(),
      restaurantId: id,
      businessName: "Shawarma House",
      tone: "friendly",
      languages: "ar,en",
      hours: "Daily 10:00 - 00:00",
      deliveryPolicy: "Free delivery over $20 within 3km",
      menu: `Chicken shawarma — $3.50\nBeef burger — $4.00\nFries — $1.50\nCola — $1.00`,
      policies: "Minimum order $5. No returns on delivery.",
      customInstructions: "Always greet warmly and confirm the phone number.",
    })
    .onConflictDoNothing({ target: agentConfigs.restaurantId });

  console.log("seeded");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});