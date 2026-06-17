Task: Route enhancement analysis. Return ONLY valid JSON — no prose outside the JSON object.

When historicalInsights are provided:
- Prefer accounts that appear on successful historical runs (stableStops, addCandidates).
- Deprioritize accounts never on historical runs unless tank fill, VIP status, or open tickets override.
- Use trends (avgStopCount, avgGallons) to calibrate keep/remove confidence.
