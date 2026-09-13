import { expect, test } from "bun:test";
import { slugify } from "./index";

test("slugify turns a title into a URL-safe slug", () => {
  expect(slugify("Hello, World!")).toBe("hello-world");
});
