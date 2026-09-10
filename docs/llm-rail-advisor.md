# LLM rail advisor

The experimental advisor converts a compact snapshot of the map's live and
model-derived evidence into passenger or operations suggestions. It is an
advisory layer, not a train-control system.

## What it uses

- Wiener Linien headway anomalies and official disruption messages
- inferred live U-Bahn arrival delays aggregated by line
- the delay model's predictions and published holdout metrics
- irregularity-propagation and passenger-pressure proxies
- accessibility impacts and the on-device reliability summary

The request deliberately excludes device location, vehicle identifiers and raw
API responses. It explicitly tells the model that U-Bahn positions are inferred,
S-Bahn positions are scheduled, and passenger pressure is not measured occupancy.

## Safety and grounding

The Worker treats map data as untrusted, asks the model to use only supplied
evidence, and uses a strict JSON schema. Operations advice is limited to
monitoring, passenger communication, staffing review and human-reviewed
planning. Signaling, speed, track access and dispatch commands are prohibited.
The interface shows concise evidence and rationale, not hidden chain-of-thought.

OpenAI requests use `store: false`. The API key exists only as a Cloudflare
Worker secret and is never included in the GitHub Pages build. This follows
[OpenAI's API-key guidance](https://developers.openai.com/api/reference/overview)
and uses [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

## Deploy the secure Worker

1. Log in to Cloudflare from a trusted computer:

   ```bash
   npx wrangler login
   ```

2. Add the OpenAI key as an encrypted Worker secret. Enter it only at the
   Wrangler prompt—never in source code or chat:

   ```bash
   npx wrangler secret put OPENAI_API_KEY --config worker/wrangler.jsonc
   ```

3. Deploy:

   ```bash
   npx wrangler deploy --config worker/wrangler.jsonc
   ```

   The Worker can be created before the secret is present, but it will return
   a configuration error until step 2 is completed. This keeps the first
   deployment from requiring an API key in a file or shell history.

4. The deployed Worker URL is the production default in the website. You can
   override it with the GitHub Actions variable `ADVISOR_API_URL` if you later
   move the Worker to another hostname, then run the Pages workflow again.

For local development, create an ignored `worker/.dev.vars` containing the
secret and run `npx wrangler dev --config worker/wrangler.jsonc`. Cloudflare's
[secrets documentation](https://developers.cloudflare.com/workers/configuration/secrets/)
explains the production and local-secret mechanisms.

The default model is `gpt-5.4-mini`, selected for lower latency and cost while
retaining reasoning and Structured Outputs. It can be changed using the
`OPENAI_MODEL` Worker variable. Each analysis is explicitly button-triggered to
control spending.
