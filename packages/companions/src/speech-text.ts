/** Strip multiline fences only at line boundaries, plus the legacy inline code-block form. */
export function stripSpeechCode(text: string): string {
  const lines: string[] = [];
  let fence: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) {
        fence = undefined;
      }
      continue;
    }
    // A same-line closing marker belongs to the supported inline form, not a multiline block.
    if (marker && !marker[2]!.includes(marker[1]!)) {
      fence = marker[1];
      continue;
    }
    lines.push(line);
  }
  return lines.join("\n").replace(/(`{3,}|~{3,})[\s\S]*?(?:\1|$)/g, " ");
}
