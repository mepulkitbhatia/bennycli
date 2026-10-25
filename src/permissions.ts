import type { Permission } from "./tools/tool.ts";

// Asks the user before a tool changes anything. "always" skips the question
// for that tool for the rest of the session. Anything but a clear yes is a no.
export function createPermissions(
  ask: (question: string) => Promise<string>,
  show: (preview: string) => void = console.log,
): Permission {
  const always = new Set<string>();
  return async (tool, preview) => {
    if (always.has(tool)) return true;
    show(preview);
    const answer = (await ask(`Allow ${tool}? (y)es / (n)o / (a)lways  `).catch(() => "no")).trim().toLowerCase();
    if (answer === "a" || answer === "always") always.add(tool);
    return ["y", "yes", "a", "always"].includes(answer);
  };
}
