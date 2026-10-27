import ZAI from "z-ai-web-dev-sdk";
async function tryModel(model: string) {
  try {
    const zai = await ZAI.create();
    const r = await zai.chat.completions.create({
      model,
      messages: [{ role: "user", content: "say OK" }],
      thinking: { type: "disabled" },
    } as any);
    const c = (r as any)?.choices?.[0]?.message?.content ?? "(no content)";
    console.log(`  ${model}: OK -> ${String(c).slice(0,60)}`);
  } catch (e: any) {
    console.log(`  ${model}: FAIL -> ${e.message.slice(0,100)}`);
  }
}
async function main() {
  for (const m of ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-pro", "gemini-2.5-pro", "glm-4.6", "glm-4.5", "gpt-4o", "claude-3.5-sonnet", "deepseek-v3", "qwen-max"]) {
    await tryModel(m);
  }
}
main();
