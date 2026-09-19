import assert from "node:assert/strict";
import test from "node:test";
import { parseRequest } from "../protocol.js";

test("parseRequest keeps legacy GET_STATUS compatible", () => {
  assert.deepEqual(parseRequest('{"request_id":"1","action":"GET_STATUS"}'), { request_id: "1", action: "GET_STATUS" });
});

test("parseRequest keeps legacy UPDATE_AGENT compatible", () => {
  assert.deepEqual(parseRequest('{"request_id":"1","action":"UPDATE_AGENT","version":"1.2.0"}'), {
    request_id: "1",
    action: "UPDATE_AGENT",
    version: "1.2.0",
  });
});

test("parseRequest requires an explicit known type for DEPLOY_AGENT", () => {
  assert.throws(
    () => parseRequest('{"request_id":"1","action":"DEPLOY_AGENT","version":"1.0.9"}'),
    /agent_type is required/,
  );
  assert.throws(
    () => parseRequest('{"request_id":"1","action":"DEPLOY_AGENT","agent_type":"unknown","version":"1.0.9"}'),
    /unsupported agent_type/,
  );
});

test("parseRequest accepts target-aware monitor deployment", () => {
  assert.deepEqual(
    parseRequest('{"request_id":"2","action":"DEPLOY_AGENT","agent_type":"monitor-agent","instance":"i2","version":"1.0.9","environment":{"SENSORSPHERE_URL":"http://ss","SENSORSPHERE_AGENT_TOKEN":"token"}}'),
    {
      request_id: "2",
      action: "DEPLOY_AGENT",
      agent_type: "monitor-agent",
      instance: "i2",
      version: "1.0.9",
      environment: { SENSORSPHERE_URL: "http://ss", SENSORSPHERE_AGENT_TOKEN: "token" },
    },
  );
});

test("parseRequest accepts Supervisor self status and update actions", () => {
  assert.deepEqual(parseRequest('{"request_id":"self-1","action":"GET_SELF_STATUS"}'), {
    request_id: "self-1",
    action: "GET_SELF_STATUS",
  });
  assert.deepEqual(parseRequest('{"request_id":"self-2","action":"UPDATE_SELF","version":"0.3.1"}'), {
    request_id: "self-2",
    action: "UPDATE_SELF",
    version: "0.3.1",
  });
  assert.throws(
    () => parseRequest('{"request_id":"self-3","action":"UPDATE_SELF"}'),
    /version is required/,
  );
});
