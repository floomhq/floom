# Emily Candidate Search Contract

Emily treats candidate search workers as asynchronous jobs.

## Call Sequence

1. `start_candidate_search`
   - Start the worker run with the full search mandate.
   - Persist the returned `run_id`.

2. `get_candidate_results`
   - Poll with the `run_id` until the run reaches a terminal status.
   - Read `status`, `outputs`, and candidate IDs from the run detail response.

3. Render shortlist
   - Show the shortlist only from returned run outputs.
   - Preserve each returned `candidate_id` in the UI/action payloads.

4. `record_candidate_feedback`
   - When available, record feedback with the selected `candidate_id`, `run_id`,
     decision, and comment.
   - Do not invent feedback state from chat text alone; persist it through the tool.

The backend contract smoke for this flow is
`apps/api/tests/test_emily_worker_async_contract.py`: `POST /workers/{worker_id}/runs`
returns a `run_id`, and `GET /runs/{run_id}` returns the persisted status, inputs,
and outputs used by Emily's polling step.
