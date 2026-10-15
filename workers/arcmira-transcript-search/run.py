"""Return source-linked transcript search results using Arcmira's public API."""
import json
import os
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def run():
    try:
        inputs = json.loads(Path('inputs.json').read_text(encoding='utf-8'))
        if not isinstance(inputs, dict):
            raise ValueError('inputs.json must contain an object.')
        query = inputs.get('query')
        if not isinstance(query, str) or len(query.strip()) < 2:
            raise ValueError('Provide one topic or phrase in query, at least two characters.')
        limit = inputs.get('limit', 5)
        if type(limit) is not int or not 1 <= limit <= 20:
            raise ValueError('limit must be an integer from 1 to 20.')
        key = os.environ.get('ARCMIRA_API_KEY', '').strip()
        if not key:
            raise ValueError('Configure the ARCMIRA_API_KEY secret.')
        params = {'q': query.strip(), 'limit': limit}
        request = Request('https://api.arcmira.com/v1/search?' + urlencode(params),
                          headers={'Authorization': 'Bearer ' + key, 'Accept': 'application/json'})
        with urlopen(request, timeout=45) as response:
            payload = json.load(response)
        if not isinstance(payload, dict) or not isinstance(payload.get('chunks'), list):
            raise ValueError('Arcmira returned an unexpected response.')
        Path('out').mkdir(exist_ok=True)
        # Keep source, access, freshness and index-health information intact.
        Path('out/results.json').write_text(json.dumps(payload, indent=2) + '\n', encoding='utf-8')
        result = {'status': 'success', 'outputs': {'results': 'out/results.json'},
                  'artifacts': [], 'error': None}
    except HTTPError as exc:
        result = {'status': 'error', 'outputs': {}, 'artifacts': [],
                  'error': f'Arcmira returned HTTP {exc.code}. Check account access, usage limits and API status before retrying.'}
    except (URLError, TimeoutError):
        result = {'status': 'error', 'outputs': {}, 'artifacts': [],
                  'error': 'Arcmira could not be reached. Retry later.'}
    except (ValueError, OSError) as exc:
        result = {'status': 'error', 'outputs': {}, 'artifacts': [], 'error': str(exc)}
    Path('result.json').write_text(json.dumps(result) + '\n', encoding='utf-8')
    return result


if __name__ == '__main__':
    run()
