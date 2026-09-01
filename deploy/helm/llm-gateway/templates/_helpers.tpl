{{- define "llm-gateway.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "llm-gateway.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "llm-gateway.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "llm-gateway.labels" -}}
app.kubernetes.io/name: {{ include "llm-gateway.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "llm-gateway.commonEnv" -}}
- name: NODE_ENV
  value: production
- name: GATEWAY_DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret }}
      key: {{ .Values.secretKeys.databaseUrl }}
- name: GATEWAY_DATABASE_SSL_MODE
  value: {{ .Values.databaseSslMode | quote }}
- name: GATEWAY_SESSION_HMAC_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret }}
      key: {{ .Values.secretKeys.sessionHmac }}
- name: GATEWAY_PUBLIC_URL
  value: {{ .Values.publicBaseUrl | quote }}
- name: GATEWAY_LEGACY_BASE_PATH
  value: {{ .Values.legacyBasePath | quote }}
- name: GATEWAY_KEY_WRAPPER
  value: {{ .Values.keyWrapper | quote }}
{{- if eq .Values.keyWrapper "local-rsa" }}
- name: GATEWAY_LOCAL_RSA_KEY_PATH
  value: /run/secrets/llm-gateway/local-rsa.pem
{{- else }}
- name: GATEWAY_AZURE_KEY_VAULT_KEY_ID
  value: {{ .Values.azureKeyVaultKeyId | quote }}
{{- if .Values.azureManagedIdentityClientId }}
- name: AZURE_MANAGED_IDENTITY_CLIENT_ID
  value: {{ .Values.azureManagedIdentityClientId | quote }}
{{- end }}
{{- end }}
{{- if .Values.agentSdk.enabled }}
- name: GATEWAY_ANTHROPIC_AGENT_SDK_URL
  value: {{ required "agentSdk.url is required when agentSdk.enabled=true" .Values.agentSdk.url | quote }}
- name: GATEWAY_ANTHROPIC_AGENT_SDK_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret }}
      key: {{ .Values.agentSdk.apiKeySecretKey }}
- name: GATEWAY_ANTHROPIC_AGENT_SDK_ALLOW_INSECURE
  value: {{ .Values.agentSdk.allowInsecure | quote }}
- name: GATEWAY_ANTHROPIC_AGENT_SDK_MODEL_REWRITES_JSON
  value: {{ .Values.agentSdk.modelRewritesJson | quote }}
{{- end }}
{{- end -}}

{{- define "llm-gateway.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: 1000
runAsGroup: 1000
fsGroup: 1000
fsGroupChangePolicy: OnRootMismatch
{{- end -}}

{{- define "llm-gateway.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
seccompProfile:
  type: RuntimeDefault
{{- end -}}
