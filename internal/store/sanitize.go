package store

import (
	"encoding/json"
	"fmt"
)

func sanitizeProp(v any) any {
	switch t := v.(type) {
	case nil:
		return ""
	case map[string]any:
		if b, err := json.Marshal(t); err == nil {
			return string(b)
		}
		return fmt.Sprint(t)
	case []any:
		out := make([]any, len(t))
		for i, e := range t {
			out[i] = sanitizeProp(e)
		}
		return out
	case string, bool, float64:
		return v
	default:
		return fmt.Sprint(v)
	}
}

func sanitizeProps(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = sanitizeProp(v)
	}
	return out
}

func sanitizeTags(m map[string]string) string {
	b, err := json.Marshal(m)
	if err != nil {
		return "{}"
	}
	return string(b)
}
