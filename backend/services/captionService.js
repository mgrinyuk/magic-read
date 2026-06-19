const SUPADATA_BASE = "https://api.supadata.ai/v1";

class CaptionServiceError extends Error {
  constructor(message) {
    super(message);
    this.code = "SERVICE_ERROR";
  }
}

/**
 * Fetch an existing transcript via Supadata (mode=native — no AI generation).
 *
 * Returns { lines: [{ start, dur, text }], language, availableLangs } on success,
 * or null if no captions exist for this video/language combination.
 * Throws CaptionServiceError for provider outages, rate limits, or credit exhaustion.
 *
 * All timing values in the returned lines are in seconds (Supadata gives ms).
 */
export async function fetchTranscript(videoId, preferredLang) {
  const apiKey = process.env.SUPADATA_API_KEY;
  if (!apiKey) throw new CaptionServiceError("SUPADATA_API_KEY is not configured");

  const params = new URLSearchParams({ url: videoId, text: "false", mode: "native" });
  if (preferredLang) params.set("lang", preferredLang);

  let res;
  try {
    res = await fetch(`${SUPADATA_BASE}/youtube/transcript?${params}`, {
      headers: { "x-api-key": apiKey }
    });
  } catch (err) {
    throw new CaptionServiceError(`Network error reaching transcript provider: ${err.message}`);
  }

  // 206 = transcript unavailable for this video (no captions exist or not in requested lang).
  // Supadata's docs explicitly state this response costs 1 credit ("costs 1 credit" in the 206 row).
  // The negative cache in the route prevents repeat charges on permanently captionless videos.
  if (res.status === 206) {
    console.log(`[Supadata] 206 — videoId=${videoId} lang=${preferredLang ?? "default"}: no transcript. Costs 1 credit per Supadata docs.`);
    return null;
  }
  // 404/403 = video is private, deleted, or restricted — treat as no captions (no credit charged)
  if (res.status === 404 || res.status === 403) return null;

  if (res.status === 402) throw new CaptionServiceError("Transcript provider: credits exhausted");
  if (res.status === 429) throw new CaptionServiceError("Transcript provider: rate limit exceeded");

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new CaptionServiceError(`Transcript provider returned ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();

  // Convert Supadata's offset/duration (ms) to seconds for our normalized shape
  const lines = (data.content ?? [])
    .filter(c => c.text?.trim())
    .map(c => ({
      start: c.offset / 1000,
      dur:   c.duration / 1000,
      text:  c.text.replace(/\n/g, " ").trim()
    }));

  if (!lines.length) return null;

  return {
    lines,
    language:       data.lang ?? preferredLang,
    availableLangs: data.availableLangs ?? []
  };
}
