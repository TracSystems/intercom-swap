import { request } from "undici";

export async function httpJson(url, opts = {}) {
  const res = await request(url, opts);
  const text = await res.body.text();

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON response");
  }

  if (res.statusCode >= 400) {
    throw new Error(JSON.stringify(json));
  }

  return json;
}
