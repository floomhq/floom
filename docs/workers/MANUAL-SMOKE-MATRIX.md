# Manual Smoke Matrix

Use this matrix for run-form and manual smoke passes.

| Worker | Input mode | Manual UI path |
| --- | --- | --- |
| `node-smoke-test` | No inputs | Click `Run worker`; there is no sample-fill step. |
| `github-digest` | No manual inputs, GitHub connection required | Run tab is enabled when the GitHub connection status is active, valid, or connected. |
| `csv_enricher` | File upload plus scalar input | `Fill with sample input` synthesizes `csv_file` from inline CSV content and fills `instruction`; API smoke may upload `sample_candidates.csv`. |
| `cv_writeup` | File upload plus scalar inputs | `Fill with sample input` synthesizes `cv_file` from inline TXT content and fills the scalar fields; API smoke may upload `sample_cv.txt`. |
| `reverse_match_crm` | File upload plus scalar inputs | API smoke uploads `sample_crm.csv`; manual UI upload remains required unless inline file content is added to the worker sample. |
| Other stock workers | Scalar sample input | Click `Fill with sample input`, then `Run worker`. |

Required fields are validated in the Run tab before creating a run; the backend run boundary also rejects missing required inputs.
