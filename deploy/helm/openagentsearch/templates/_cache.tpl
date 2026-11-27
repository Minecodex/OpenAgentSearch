{{- define "oas.cache.env" -}}
{{- $c := .Values.cache -}}
{{- if $c.enabled }}
- {name: OAS_CACHE_HANDLER, value: {{ $c.handler | quote }}}
{{- if eq $c.handler "v2" }}
- {name: OAS_CACHE_MATCHER_URL, value: {{ ternary (printf "http://%s-cache-matcher:8092/v1/cache/match" .Release.Name) $c.matcher.url $c.matcher.enabled | quote }}}
- {name: OAS_CACHE_MATCHER_PROFILE, value: {{ $c.matcher.profile | quote }}}
{{- if $c.matcher.existingSecret }}
- name: OAS_CACHE_MATCHER_API_KEY
  valueFrom: {secretKeyRef: {name: {{ $c.matcher.existingSecret }}, key: {{ $c.matcher.secretKey }}}}
{{- end }}
{{- end }}
- {name: OAS_CACHE_LOOKUP_TIMEOUT_MS, value: {{ $c.lookupTimeoutMs | quote }}}
- {name: OAS_CACHE_LIST_TTL_SECS, value: {{ $c.listTtlSeconds | quote }}}
- {name: OAS_CACHE_CONTENT_TTL_SECS, value: {{ $c.contentTtlSeconds | quote }}}
- {name: OAS_CACHE_TASK_TTL_SECS, value: {{ $c.taskTtlSeconds | quote }}}
- {name: OAS_CACHE_TASK_MAX_ATTEMPTS, value: {{ $c.taskMaxAttempts | quote }}}
- {name: OAS_CACHE_QUEUE_CAPACITY, value: {{ $c.queueCapacity | quote }}}
- {name: OAS_CACHE_SUMMARY_MAX_INPUT_TOKENS, value: {{ $c.summaryMaxInputTokens | quote }}}
- {name: OAS_CACHE_MAX_OBJECT_BYTES, value: {{ $c.maxObjectBytes | quote }}}
- {name: OAS_CACHE_MAX_SNAPSHOTS, value: {{ $c.maxSnapshots | quote }}}
- {name: OAS_CACHE_EMBEDDING_BASE_URL, value: {{ $c.embedding.baseUrl | quote }}}
- {name: OAS_CACHE_EMBEDDING_MODEL, value: {{ $c.embedding.model | quote }}}
- {name: OAS_CACHE_EMBEDDING_DIMENSIONS, value: {{ $c.embedding.dimensions | quote }}}
- {name: OAS_CACHE_EMBEDDING_VERSION, value: {{ $c.embedding.version | quote }}}
{{- if $c.embedding.existingSecret }}
- name: OAS_CACHE_EMBEDDING_API_KEY
  valueFrom: {secretKeyRef: {name: {{ $c.embedding.existingSecret }}, key: {{ $c.embedding.secretKey }}}}
{{- else if $c.embedding.apiKey }}
- name: OAS_CACHE_EMBEDDING_API_KEY
  valueFrom: {secretKeyRef: {name: {{ default (printf "%s-cache-credentials" .Release.Name) $c.existingSecret }}, key: embedding-api-key}}
{{- end }}
- {name: OAS_CACHE_QDRANT_URL, value: {{ ternary (printf "http://%s-cache-qdrant:6333" .Release.Name) $c.qdrant.url $c.qdrant.enabled | quote }}}
- {name: OAS_CACHE_QDRANT_SHARDS, value: {{ $c.qdrant.shards | quote }}}
- {name: OAS_CACHE_QDRANT_REPLICATION_FACTOR, value: {{ $c.qdrant.replicationFactor | quote }}}
{{- if or $c.qdrant.enabled $c.qdrant.apiKey $c.existingSecret }}
- name: OAS_CACHE_QDRANT_API_KEY
  valueFrom: {secretKeyRef: {name: {{ default (printf "%s-cache-credentials" .Release.Name) $c.existingSecret }}, key: qdrant-api-key}}
{{- end }}
- {name: OAS_CACHE_VALKEY_URL, value: {{ ternary (printf "redis://%s-cache-valkey:6379" .Release.Name) $c.valkey.url $c.valkey.enabled | quote }}}
{{- if $c.valkey.clusterNodes }}
- {name: OAS_CACHE_VALKEY_CLUSTER_NODES, value: {{ join "," $c.valkey.clusterNodes | quote }}}
{{- end }}
{{- if or $c.valkey.enabled $c.valkey.password $c.existingSecret }}
- name: OAS_CACHE_VALKEY_PASSWORD
  valueFrom: {secretKeyRef: {name: {{ default (printf "%s-cache-credentials" .Release.Name) $c.existingSecret }}, key: valkey-password}}
{{- end }}
- {name: OAS_CACHE_S3_ENDPOINT, value: {{ ternary (printf "http://%s-cache-objects:8333" .Release.Name) $c.objects.endpoint $c.objects.enabled | quote }}}
- {name: OAS_CACHE_S3_BUCKET, value: {{ $c.objects.bucket | quote }}}
- {name: OAS_CACHE_S3_REGION, value: {{ $c.objects.region | quote }}}
- name: OAS_CACHE_S3_ACCESS_KEY
  valueFrom: {secretKeyRef: {name: {{ default (printf "%s-cache-credentials" .Release.Name) $c.existingSecret }}, key: s3-access-key}}
- name: OAS_CACHE_S3_SECRET_KEY
  valueFrom: {secretKeyRef: {name: {{ default (printf "%s-cache-credentials" .Release.Name) $c.existingSecret }}, key: s3-secret-key}}
{{- end }}
{{- end }}
