import { ssrfFetch } from "../src/web";

let cached: string | null = null;
export async function getFeedFixture(): Promise<string> {
  if (cached) return cached;
  const r = await ssrfFetch(`http://127.0.0.1:${PORT}/feed`, { allowPrivate: true });
  cached = r.body;
  return cached;
}

const PORT = 18923;
