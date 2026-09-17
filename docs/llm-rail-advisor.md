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
When Operations is selected, the response contains one structured decision for
each U-Bahn line (U1, U2, U3, U4 and U6), including status, priority, next
verification step, evidence, confidence and limitations. The interface fills
any missing line conservatively as “monitor” so the control-room view is never
silently incomplete.

## Safety and grounding

The secure advisor backend treats map data as untrusted, asks the model to use
only supplied evidence, and uses a strict JSON schema. Operations advice is limited to
monitoring, passenger communication, staffing review and human-reviewed
planning. Signaling, speed, track access, train-hold, routing and dispatch
commands are prohibited. The result is decision support for a qualified human
controller, not an operating instruction or a substitute for the control-room
console.
The interface shows concise evidence and rationale, not hidden chain-of-thought.

OpenAI requests should use `store: false`. The API key must exist only on the
separate secure advisor backend and is never included in the GitHub Pages build. This follows
[OpenAI's API-key guidance](https://developers.openai.com/api/reference/overview)
and uses [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

## Connect an external secure advisor

The website no longer selects the rail-data Worker as its GPT backend. Set the
GitHub Actions repository variable `EXTERNAL_ADVISOR_API_URL` to a separate
secure endpoint implementing the documented `POST /advice` contract. The Pages
workflow passes that value to `VITE_ADVISOR_API_URL`. The feature must also be
explicitly enabled with `VITE_ENABLE_AI_ADVISOR=true`; it is currently set to
`false` in the production workflow. If either setting is missing, the AI
advisor remains disabled.

The existing Cloudflare Worker continues to provide rail-data snapshots and
feed proxying, but the website will not send GPT requests to it unless the
external variable is explicitly pointed there.
