import ZAI from "z-ai-web-dev-sdk";

async function tryModel(model: string) {
  if (!model || typeof model !== "string") {
    console.log(`  ${model}: FAIL -> Invalid model name`);
    return;
  }

  try {
    const zai = await ZAI.create();
    const r = await zai.chat.completions.create({
      model,
      messages: [{ role: "user", content: "say OK" }],
      thinking: { type: "disabled" },
    });
    
    // Safely access content without unsafe casting
    const content = r?.choices?.[0]?.message?.content;
    const c = content ?? "(no content)";
    
    console.log(`  ${model}: OK -> ${String(c).slice(0,60)}`);
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    // Added model context to the failure log for better debugging
    console.log(`  ${model}: FAIL -> ${errorMessage.slice(0,100)}`);
  }
}

async function main() {
  const models = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-pro", "gemini-2.5-pro", "glm-4.6", "glm-4.5", "gpt-4o", "claude-3.5-sonnet", "deepseek-v3", "qwen-max"];
  await Promise.all(models.map(m => tryModel(m)));
}

main();