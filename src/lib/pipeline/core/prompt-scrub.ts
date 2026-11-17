/**
 * Prompt-injection defense for memory content injected into LLM prompts.
 *
 * The system stores its own failure analyses (postmortems), learned lessons,
 * ancestral context, and rejected transforms, then injects these into the
 * LLM prompts that generate code mutations. The writers of those stores are
 * protected files, but the CONTENT stored in them is LLM-authored in prior
 * cycles — and a sufficiently clever prior cycle could plant a lesson whose
 * `content` contains the section's close-delimiter (e.g.
 * `--- END LEARNED LESSONS ---`) followed by injected instructions. When that
 * lesson is later concatenated into a mutation prompt, the injected text
 * closes the lessons section and becomes instructions. This is the
 * "compounding-injection" risk: the attack compounds across every cycle
 * because the poisoned lesson survives in the store.
 *
 * `scrubSectionMarkers` closes that hole by neutralizing any exact
 * occurrence of the section's open/close markers INSIDE the injected
 * content, so the content can never close the section it lives in. It
 * mirrors the fence-and-collapse technique debate-llm.ts uses for code
 * blocks (4-backtick fence + collapse 4+ backticks to 3), adapted for the
 * `--- MARKER ---` delimiter convention the memory blocks use.
 *
 * This is defense-in-depth: the memory stores are protected-writer, the
 * LLM that authors lessons is instructed not to emit delimiters, and the
 * prompts frame the blocks as data. The scrub is the last line — if a
 * delimiter slips through despite those, it can't break the section.
 */

/**
 * Replace any exact occurrence of the given marker strings inside
 * `content` with a visually-similar but non-matching form (hyphens →
 * en-dashes). The LLM still reads the marker as "this looks like a
 * section boundary", but it no longer matches the literal delimiter the
 * prompt assembler uses, so it can't close the section.
 *
 * Uses split/join (no regex) so markers containing regex-special
 * characters (dashes are fine, but this is safest) are handled literally.
 */
export function scrubSectionMarkers(content: string, ...markers: string[]): string {
  if (!content) return content;
  let out = content;
  for (const m of markers) {
    if (!m) continue;
    if (!out.includes(m)) continue;
    // Hyphen → en-dash (\u2013). Visually close to the original; breaks
    // the exact-string match the prompt assembler relies on. We don't
    // strip the marker entirely (that would lose the LLM's cue that
    // something boundary-like was here) — we just make it inert.
    const neutralized = m.replace(/-/g, "\u2013");
    out = out.split(m).join(neutralized);
  }
  return out;
}
