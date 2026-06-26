import assert from "node:assert/strict";
import test from "node:test";

import { reviewBody, type Review } from "./review-body.js";

test("reviewBody includes the reviewed changed file count", () => {
  const review: Review = {
    verdict: "approve",
    summary: "The change looks safe.",
    findings: [],
  };

  assert.match(
    reviewBody(review, 3),
    /The change looks safe\.\n\nReviewed 3 changed file\(s\)\.\n\n\*\*Findings\*\*/,
  );
});