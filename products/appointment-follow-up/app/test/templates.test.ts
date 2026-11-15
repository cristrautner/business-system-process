import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_TEMPLATES, render, unknownNames } from "../src/templates.ts";
import { encrypt, decrypt } from "../src/crypto.ts";
import { randomBytes } from "node:crypto";

const base = {
  first_name: "Linda",
  sender_name: "Dusty",
  business_name: "Sandhill Roofing",
  phone: "(555) 010-0199",
  estimate_due: "Thursday, November 20",
};

describe("render", () => {
  it("fills the inspection email", () => {
    const out = render(DEFAULT_TEMPLATES.inspection, { ...base, estimate_photos: true });
    assert.equal(out.subject, "Your roof inspection with Sandhill Roofing");
    assert.match(out.body, /^Hi Linda,/);
    assert.match(out.body, /by Thursday, November 20\. It'll include photos/);
    assert.match(out.body, /Thanks again,\nDusty\nSandhill Roofing\n\(555\) 010-0199$/);
  });

  it("drops optional parts that are switched off", () => {
    const out = render(DEFAULT_TEMPLATES.inspection, { ...base, estimate_photos: false });
    assert.doesNotMatch(out.body, /photos/);
    assert.match(out.body, /by Thursday, November 20\.\n\nIf any questions/);
  });

  it("removes empty optional lines without leaving gaps", () => {
    const out = render(DEFAULT_TEMPLATES.job_complete, { ...base, warranty_note: "", review_link: "" });
    assert.doesNotMatch(out.body, /review|\n\n\n/);
    assert.match(out.body, /come back out\.\n\nThanks again,/);
  });

  it("keeps optional lines that have values", () => {
    const out = render(DEFAULT_TEMPLATES.job_complete, {
      ...base,
      warranty_note: "Your warranty paperwork will come by email within a week.",
      review_link: "https://g.page/r/example",
    });
    assert.match(out.body, /warranty paperwork/);
    assert.match(out.body, /Google review .*https:\/\/g\.page\/r\/example/);
  });

  it("greets “there” when the first name is unknown", () => {
    assert.match(render(DEFAULT_TEMPLATES.general, { ...base, first_name: "" }).body, /^Hi there,/);
  });

  it("uses only known names in every default template", () => {
    for (const template of Object.values(DEFAULT_TEMPLATES)) assert.deepEqual(unknownNames(template), []);
  });

  it("flags unknown names", () => {
    assert.deepEqual(unknownNames({ subject: "Hi {{frist_name}}", body: "[[photos: x]]" }), ["frist_name", "photos"]);
  });
});

describe("crypto", () => {
  it("round-trips and rejects tampering", () => {
    const key = randomBytes(32);
    const sealed = encrypt("refresh-token", key);
    assert.equal(decrypt(sealed, key), "refresh-token");
    const tampered = sealed.slice(0, -2) + (sealed.endsWith("A") ? "BB" : "AA");
    assert.throws(() => decrypt(tampered, key));
    assert.throws(() => decrypt(sealed, randomBytes(32)));
  });
});
