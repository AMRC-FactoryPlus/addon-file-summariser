{{- define "addon-file-summariser.image" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion -}}
{{ .Values.image.registry }}/{{ .Values.image.repository }}:{{ $tag }}
{{- end -}}
