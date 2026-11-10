import type { Permission } from "./tools/tool.ts";

// Asks the user before a tool changes anything. "always" skips the question for
// the rest of the session: for the whole tool, or only for `scope` when the tool
// gives one (run_command passes the exact command). Anything but a clear yes is a no.
export function createPermissions(
  ask: (question: string) => Promise<string>,
  show: (preview: string) => void = console.log,
): Permission {
  const always = new Set<string>();
  return async (tool, preview, scope) => {
    const key = scope === undefined ? tool : `${tool}\0${scope}`;
    if (always.has(key)) return true;
    show(preview);
    const alwaysFor = scope === undefined ? "" : " for this exact command";
    const answer = (await ask(`Allow ${tool}? (y)es / (n)o / (a)lways${alwaysFor}  `).catch(() => "no")).trim().toLowerCase();
    if (answer === "a" || answer === "always") always.add(key);
    return ["y", "yes", "a", "always"].includes(answer);
  };
}
