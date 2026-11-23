"""Validate OpenAPI and live response shapes. Install tests/requirements.txt first."""
import json
import os
import time
from datetime import datetime,timedelta,timezone
from urllib.parse import urlencode
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import yaml
from functools import lru_cache
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012
from openapi_spec_validator import validate

CONTRACTS = Path(__file__).resolve().parent.parent / 'docs/plan1/contracts'
BASE = os.environ.get('OAS_TEST_API', 'http://127.0.0.1:18080')
CACHE = {}

def authenticated_response(request):
    for attempt in range(2):
        try:
            return urlopen(request, timeout=10)
        except HTTPError as error:
            if error.code != 429 or attempt:
                raise
            value = json.load(error)
            if value.get('error', {}).get('code') != 'RATE_LIMITED':
                raise
            delay = min(60, max(1, int(error.headers.get('Retry-After', '60'))))
            print(f'Waiting {delay}s for the login rate window before contract validation', flush=True)
            time.sleep(delay)

def document(path):
    path = path.resolve()
    if path not in CACHE:
        CACHE[path] = yaml.safe_load(path.read_text(encoding='utf-8'))
    return CACHE[path]

@lru_cache
def contract_registry():
    return Registry().with_resources(
        (path.as_uri(), Resource.from_contents(document(path), default_specification=DRAFT202012))
        for path in CONTRACTS.glob("*.yaml")
    )

@lru_cache
def schema_validator(schema):
    root = (CONTRACTS / 'management.openapi.yaml').as_uri()
    return Draft202012Validator({"$ref": f"{root}#/components/schemas/{schema}"},
                                registry=contract_registry(), format_checker=FormatChecker())

def check(schema, value, name):
    errors = list(schema_validator(schema).iter_errors(value))
    if errors:
        raise AssertionError(name + ': ' + '\n'.join(str(list(e.path)) + ': ' + e.message[:600] for e in errors[:8]))

def run():
    for group in ['business', 'management']:
        path = CONTRACTS / (group + '.openapi.yaml')
        validate(document(path), base_uri=path.as_uri())
    if os.environ.get('OAS_CONTRACTS_OFFLINE') == '1':
        print('OpenAPI documents valid')
        return
    path = CONTRACTS / 'management.openapi.yaml'
    schemas = document(path)['components']['schemas']
    login = Request(BASE + '/admin/v1/session', data=json.dumps({'username': 'admin', 'password': os.environ.get('OAS_TEST_PASSWORD', 'admin123')}).encode(),
                    headers={'Content-Type': 'application/json', 'Origin': BASE})
    with authenticated_response(login) as response:
        cookie = response.headers['Set-Cookie'].split(';')[0]
        check('Session', json.load(response)['data'], 'session')
    def get(path):
        with urlopen(Request(BASE + '/admin/v1/' + path, headers={'Cookie': cookie}), timeout=15) as response:
            return json.load(response)['data']
    count = 1
    since=os.environ.get('OAS_TEST_SINCE',(datetime.now(timezone.utc)-timedelta(minutes=30)).isoformat())
    for endpoint, schema in [('projects', 'ProjectView'), ('endpoints', 'EndpointView'), ('proxies', 'ProxyView'), ('proxy-pools', 'PoolView'), ('requests', 'RequestRecord'), ('endpoint-calls', 'Call')]:
        for item in get(endpoint + '?'+urlencode({'limit':100,**({'from':since} if endpoint in ['requests','endpoint-calls'] else {})}))['items']:
            check(schema, item, endpoint)
            count += 1
    for endpoint, schema in [('settings/retention', 'RetentionSettings'), ('language-routes', 'LanguageRoutes'), ('requests/aggregates', 'Aggregates'), ('endpoint-statistics', 'Statistics')]:
        if schema not in schemas:
            schema = next(key for key in schemas if key.startswith('Retention') and key != 'RetentionWrite') if endpoint.startswith('settings') else schema
        check(schema, get(endpoint), endpoint)
        count += 1
    for record in get('requests?limit=8')['items']:
        rid = record['request_id']
        detail = get('requests/' + rid)
        check('RequestDetail', detail, 'detail')
        check('Evidence', get('requests/' + rid + '/evidence'), 'evidence')
        check('Export', get('requests/' + rid + '/export'), 'export')
        for span in detail['spans']:
            check('SpanDetail', get('requests/' + rid + '/spans/' + span['span_id']), 'span')
        count += 3 + len(detail['spans'])
    print(f'OpenAPI and {count} live objects valid')

if __name__ == '__main__':
    run()
