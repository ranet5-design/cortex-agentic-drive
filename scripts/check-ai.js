/**
 * Quick check that the live LLM connection works.
 *   ANTHROPIC_API_KEY=... npm run check-ai
 * Runs one structured (JSON) call and one long-form call, the two kinds every agent uses.
 */
import * as llm from "../lib/llm.js";

if (!llm.enabled) {
  console.error("No ANTHROPIC_API_KEY set — set it first, e.g.  $env:ANTHROPIC_API_KEY=\"sk-ant-...\"; npm run check-ai");
  process.exit(1);
}

console.log(`Model: ${llm.MODEL}`);
try {
  let t = Date.now();
  const r = await llm.json({
    system: "Classify the document type.",
    prompt: "INVOICE\nFrom: EventSpace Co\nInvoice No: INV-0387\nTotal Due: $12,300.00",
    schema: llm.obj({ docType: llm.enumOf(["invoice", "contract", "meeting-notes", "other"]), total: llm.str() }),
  });
  console.log(`✓ Structured call (${Date.now() - t} ms):`, r);
  t = Date.now();
  const text = await llm.write({ system: "Answer in one sentence.", prompt: "What does an agentic drive do?", effort: "low", maxTokens: 2000 });
  console.log(`✓ Writing call (${Date.now() - t} ms):`, text.trim());
  console.log("\nLive AI mode works. Start the app with npm start — the header will show the model name.");
} catch (err) {
  console.error("✗ Live AI check failed:", err.message);
  process.exit(1);
}
