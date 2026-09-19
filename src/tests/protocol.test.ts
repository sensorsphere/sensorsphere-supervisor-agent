import assert from "node:assert/strict";
import test from "node:test";
import { parseRequest } from "../protocol.js";

test("parseRequest accepts GET_STATUS", () => {
  assert.deepEqual(parseRequest('{"request_id":"1","action":"GET_STATUS"}'), { request_id: "1", action: "GET_STATUS" });
});

test("parseRequest requires a version for UPDATE_AGENT", () => {
  assert.throws(() => parseRequest('{"request_id":"1","action":"UPDATE_AGENT"}'), /version is required/);
});
