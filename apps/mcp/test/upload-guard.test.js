import assert from "node:assert/strict";
import test from "node:test";

import {
  assertBase64WithinLimit,
  decodeBase64Strict,
  estimateBase64DecodedSize,
} from "../dist/server.js";

test("estimateBase64DecodedSize handles canonical padding shapes", () => {
  assert.equal(estimateBase64DecodedSize(""), 0);
  assert.equal(estimateBase64DecodedSize("YWJj"), 3);
  assert.equal(estimateBase64DecodedSize("YWI="), 2);
  assert.equal(estimateBase64DecodedSize("YQ=="), 1);
});

test("assertBase64WithinLimit rejects oversized decoded content", () => {
  assert.doesNotThrow(() => assertBase64WithinLimit("YQ==", 1));
  assert.throws(() => assertBase64WithinLimit("YWI=", 1), /exceeds 1 byte limit/);
});

test("decodeBase64Strict rejects malformed input and decodes canonical base64", () => {
  assert.throws(() => decodeBase64Strict("not base64!!"), /not valid canonical base64/);
  assert.throws(() => decodeBase64Strict("Y=WI"), /not valid canonical base64/);
  assert.throws(() => decodeBase64Strict("YQ="), /not valid canonical base64/);

  const valid = "AAEC/f7/";
  assert.deepEqual(decodeBase64Strict(valid), Buffer.from(valid, "base64"));
});
