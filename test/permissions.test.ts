import { expect, test } from "vitest";
import { createPermissions } from "../src/permissions.ts";

// A user who answers from a script, so each test controls the replies.
function user(...answers: string[]) {
  const shown: string[] = [];
  const questions: string[] = [];
  const permission = createPermissions(
    async (question) => {
      questions.push(question);
      return answers.shift() ?? "";
    },
    (preview) => shown.push(preview),
  );
  return { permission, shown, questions };
}

test("yes allows and no refuses; the preview is shown first", async () => {
  const { permission, shown, questions } = user("y", "n");
  expect(await permission("edit_file", "-old\n+new")).toBe(true);
  expect(await permission("edit_file", "-x\n+y")).toBe(false);
  expect(shown).toEqual(["-old\n+new", "-x\n+y"]);
  expect(questions[0]).toContain("edit_file");
});

test("anything unclear counts as no", async () => {
  const { permission } = user("", "maybe", "Y");
  expect(await permission("write_file", "p")).toBe(false);
  expect(await permission("write_file", "p")).toBe(false);
  expect(await permission("write_file", "p")).toBe(true); // case does not matter
});

test("always stops asking for that tool only", async () => {
  const { permission, questions } = user("a", "n");
  expect(await permission("edit_file", "p1")).toBe(true);
  expect(await permission("edit_file", "p2")).toBe(true); // not asked again
  expect(await permission("write_file", "p3")).toBe(false); // a different tool still asks
  expect(questions).toHaveLength(2);
});

test("a question that is cancelled (Ctrl+C) counts as no", async () => {
  const permission = createPermissions(async () => {
    throw new Error("AbortError");
  }, () => {});
  expect(await permission("edit_file", "p")).toBe(false);
});
