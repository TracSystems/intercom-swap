import test from 'node:test';
import assert from 'node:assert/strict';

import { headersForUrl, resetHttpHeadersCache } from '../src/net/httpHeaders.js';

test('http headers: inject by url prefix from HTTP_HEADERS_JSON map', (t) => {
  const prevJson = process.env.HTTP_HEADERS_JSON;
  const prevFile = process.env.HTTP_HEADERS_FILE;
  t.after(() => {
    if (prevJson === undefined) delete process.env.HTTP_HEADERS_JSON;
    else process.env.HTTP_HEADERS_JSON = prevJson;
    if (prevFile === undefined) delete process.env.HTTP_HEADERS_FILE;
    else process.env.HTTP_HEADERS_FILE = prevFile;
    resetHttpHeadersCache();
  });

  process.env.HTTP_HEADERS_FILE = '';
  process.env.HTTP_HEADERS_JSON = JSON.stringify({
    'https://api.example.com/': { Authorization: 'Bearer abc', 'X-Api-Key': 'k1' },
  });
  resetHttpHeadersCache();

  assert.deepEqual(headersForUrl('https://api.example.com/v1/ticker'), {
    Authorization: 'Bearer abc',
    'X-Api-Key': 'k1',
  });
  assert.deepEqual(headersForUrl('https://other.example.com/v1'), {});
});

test('http headers: wildcard + longer prefix override', (t) => {
  const prevJson = process.env.HTTP_HEADERS_JSON;
  const prevFile = process.env.HTTP_HEADERS_FILE;
  t.after(() => {
    if (prevJson === undefined) delete process.env.HTTP_HEADERS_JSON;
    else process.env.HTTP_HEADERS_JSON = prevJson;
    if (prevFile === undefined) delete process.env.HTTP_HEADERS_FILE;
    else process.env.HTTP_HEADERS_FILE = prevFile;
    resetHttpHeadersCache();
  });

  process.env.HTTP_HEADERS_FILE = '';
  process.env.HTTP_HEADERS_JSON = JSON.stringify({
    rules: [
      { match: '*', headers: { 'User-Agent': 'intercomswap-test' } },
      { match: 'https://rpc.example.com/', headers: { Authorization: 'Bearer base' } },
      { match: 'https://rpc.example.com/special/', headers: { Authorization: 'Bearer special' } },
    ],
  });
  resetHttpHeadersCache();

  assert.deepEqual(headersForUrl('https://rpc.example.com/'), {
    'User-Agent': 'intercomswap-test',
    Authorization: 'Bearer base',
  });
  assert.deepEqual(headersForUrl('https://rpc.example.com/special/x'), {
    'User-Agent': 'intercomswap-test',
    Authorization: 'Bearer special',
  });
});

