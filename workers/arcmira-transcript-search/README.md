# Arcmira transcript search

Find spoken passages about one topic in indexed YouTube and podcast transcripts. The JSON output preserves timestamps, source links, transcript source, account-access notices and index-health information.

Configure `ARCMIRA_API_KEY` as a Floom secret. Use the example inputs to request five passages. `limit` accepts integers from 1 to 20.

```json
{"query": "video editing", "limit": 5}
```

The worker makes one request to `GET https://api.arcmira.com/v1/search` and saves the response to `out/results.json`. It does not download media, generate transcripts or use a model. Empty results mean no matches in the searched catalog and account window, not that the topic has never been discussed.

Account access limits apply. A paid read uses credits from your plan, then your on-demand budget. API errors stop the worker without an automatic retry. Floom hosting costs are separate.

[Arcmira](https://arcmira.com) · [API documentation](https://arcmira.com/docs)
