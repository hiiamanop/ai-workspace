import type { DecideRequest, DecideResponse } from "./types.ts";

export async function decide(
  request: DecideRequest,
  madeUrl: string = process.env.MADE_URL ?? "http://localhost:8000",
  fetchImpl: typeof fetch = fetch
): Promise<DecideResponse> {
  const response = await fetchImpl(`${madeUrl}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });

  if (response.status !== 200) {
    throw new Error(`MADE /decide returned ${response.status}: ${await response.text()}`);
  }

  return (await response.json()) as DecideResponse;
}
